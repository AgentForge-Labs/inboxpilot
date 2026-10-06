import type {
  CanonicalMessage,
  ClassificationState,
} from "../domain/email-model.js";
import {
  classifierResultToClassificationState,
  parseClassifierResult,
  type CanonicalClassifierResult,
} from "./classifier-contract.js";
import {
  scoreDeterministicImportance,
  type DeterministicImportanceResult,
} from "./importance-engine.js";
import {
  buildSemanticClassifierPrompt,
} from "./semantic-prompt.js";
import type {
  SemanticBatchResult,
  SemanticClassificationResult,
  SemanticClassifierConfig,
  SemanticClassifyInput,
  SemanticCostEvent,
  SemanticCostTelemetry,
  SemanticModelClient,
  SemanticModelRequest,
  SemanticModelResponse,
  SemanticQuotaLedger,
} from "./semantic-types.js";

interface ResolvedConfig {
  primaryModel: string;
  fallbackModel?: string;
  confidenceThreshold: number;
  maxBodyChars: number;
  maxThreadContextChars: number;
  maxOutputTokens: number;
  maxAttemptsPerModel: number;
  maxBatchSize: number;
  priceMicrosPerMillionInputTokens: Readonly<Record<string, number>>;
  priceMicrosPerMillionOutputTokens: Readonly<Record<string, number>>;
}

interface Candidate {
  input: SemanticClassifyInput;
  deterministic: DeterministicImportanceResult;
  quotaCharged: boolean;
  prompt: { system: string; input: string };
}

function resolveConfig(config: SemanticClassifierConfig): ResolvedConfig {
  if (!config.primaryModel.trim()) {
    throw new TypeError("primaryModel is required");
  }
  const confidenceThreshold = config.confidenceThreshold ?? 0.75;
  if (
    !Number.isFinite(confidenceThreshold) ||
    confidenceThreshold < 0 ||
    confidenceThreshold > 1
  ) {
    throw new RangeError(
      "confidenceThreshold must be between 0 and 1",
    );
  }

  return {
    primaryModel: config.primaryModel,
    ...(config.fallbackModel?.trim()
      ? { fallbackModel: config.fallbackModel.trim() }
      : {}),
    confidenceThreshold,
    maxBodyChars: Math.max(
      1000,
      Math.min(config.maxBodyChars ?? 20_000, 100_000),
    ),
    maxThreadContextChars: Math.max(
      0,
      Math.min(
        config.maxThreadContextChars ?? 24_000,
        120_000,
      ),
    ),
    maxOutputTokens: Math.max(
      128,
      Math.min(config.maxOutputTokens ?? 1200, 4096),
    ),
    maxAttemptsPerModel: Math.max(
      1,
      Math.min(config.maxAttemptsPerModel ?? 2, 4),
    ),
    maxBatchSize: Math.max(
      1,
      Math.min(config.maxBatchSize ?? 8, 32),
    ),
    priceMicrosPerMillionInputTokens:
      config.priceMicrosPerMillionInputTokens ?? {},
    priceMicrosPerMillionOutputTokens:
      config.priceMicrosPerMillionOutputTokens ?? {},
  };
}

function estimatedCostMicros(
  model: string,
  response: SemanticModelResponse,
  config: ResolvedConfig,
): number {
  const inputRate =
    config.priceMicrosPerMillionInputTokens[model] ?? 0;
  const outputRate =
    config.priceMicrosPerMillionOutputTokens[model] ?? 0;

  return Math.round(
    (response.usage.inputTokens * inputRate) / 1_000_000 +
      (response.usage.outputTokens * outputRate) / 1_000_000,
  );
}

function modelRequest(
  model: string,
  prompt: { system: string; input: string },
  config: ResolvedConfig,
): SemanticModelRequest {
  return {
    model,
    schemaName: "inboxpilot_classifier_output_v1",
    system: prompt.system,
    input: prompt.input,
    maxOutputTokens: config.maxOutputTokens,
  };
}

function needsReviewState(
  result: CanonicalClassifierResult,
): ClassificationState {
  return {
    ...classifierResultToClassificationState(result),
    status: "needs_review",
  };
}

function semanticState(
  result: CanonicalClassifierResult,
  threshold: number,
): ClassificationState {
  return result.confidence >= threshold
    ? classifierResultToClassificationState(result)
    : needsReviewState(result);
}

function messageScope(
  message: CanonicalMessage,
): Pick<
  SemanticCostEvent,
  "tenantId" | "accountId" | "providerMessageId"
> {
  return {
    tenantId: message.tenantId,
    accountId: message.accountId,
    providerMessageId: message.provider.messageId,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 500);
  return "Unknown model error";
}

export class SemanticClassifier {
  private readonly config: ResolvedConfig;

  constructor(
    private readonly client: SemanticModelClient,
    private readonly telemetry: SemanticCostTelemetry,
    private readonly quota: SemanticQuotaLedger,
    config: SemanticClassifierConfig,
  ) {
    this.config = resolveConfig(config);
  }

  async classify(
    input: SemanticClassifyInput,
  ): Promise<SemanticClassificationResult> {
    const candidate = await this.prepareCandidate(input);
    if (!candidate.deterministic.needsLlm) {
      return {
        route: "deterministic",
        deterministic: candidate.deterministic,
        needsReview: false,
        quotaCharged: candidate.quotaCharged,
        attempts: 0,
      };
    }

    return this.classifyCandidate(candidate);
  }

  async classifyMany(
    inputs: readonly SemanticClassifyInput[],
  ): Promise<SemanticBatchResult> {
    const prepared = await Promise.all(
      inputs.map((input) => this.prepareCandidate(input)),
    );

    const results: Array<SemanticClassificationResult | undefined> =
      new Array(prepared.length);
    const semanticIndexes: number[] = [];

    prepared.forEach((candidate, index) => {
      if (!candidate.deterministic.needsLlm) {
        results[index] = {
          route: "deterministic",
          deterministic: candidate.deterministic,
          needsReview: false,
          quotaCharged: candidate.quotaCharged,
          attempts: 0,
        };
      } else {
        semanticIndexes.push(index);
      }
    });

    let batchedRequests = 0;

    if (
      this.client.completeBatch &&
      semanticIndexes.length > 1
    ) {
      for (
        let offset = 0;
        offset < semanticIndexes.length;
        offset += this.config.maxBatchSize
      ) {
        const chunk = semanticIndexes.slice(
          offset,
          offset + this.config.maxBatchSize,
        );
        const requests = chunk.map((index) =>
          modelRequest(
            this.config.primaryModel,
            prepared[index]!.prompt,
            this.config,
          ),
        );

        try {
          const responses =
            await this.client.completeBatch(requests);
          if (responses.length !== chunk.length) {
            throw new Error(
              "Batch model response count does not match request count",
            );
          }
          batchedRequests += 1;

          for (let i = 0; i < chunk.length; i += 1) {
            const index = chunk[i]!;
            const response = responses[i]!;
            const candidate = prepared[index]!;
            const parsed = await this.acceptResponse(
              candidate,
              response,
              this.config.primaryModel,
              1,
              "primary",
            );

            if (
              parsed &&
              parsed.confidence >= this.config.confidenceThreshold
            ) {
              results[index] = this.resultFromSemantic(
                candidate,
                parsed,
                this.config.primaryModel,
                1,
              );
            } else {
              results[index] = await this.classifyCandidate(
                candidate,
                {
                  skipPrimaryFirstAttempt: true,
                  firstPrimaryResponse: parsed,
                },
              );
            }
          }
        } catch {
          for (const index of chunk) {
            results[index] = await this.classifyCandidate(
              prepared[index]!,
            );
          }
        }
      }
    } else {
      for (const index of semanticIndexes) {
        results[index] = await this.classifyCandidate(
          prepared[index]!,
        );
      }
    }

    return {
      results: results.map((result) => {
        if (!result) {
          throw new Error(
            "Semantic batch result was not populated",
          );
        }
        return result;
      }),
      semanticCandidates: semanticIndexes.length,
      batchedRequests,
    };
  }

  private async prepareCandidate(
    input: SemanticClassifyInput,
  ): Promise<Candidate> {
    const deterministic = scoreDeterministicImportance(
      input.message,
      input.history,
    );
    const quotaCharged =
      await this.quota.chargeUnique(input.message);
    const prompt = buildSemanticClassifierPrompt(
      input.message,
      deterministic,
      input.threadContext ?? [],
      {
        maxBodyChars: this.config.maxBodyChars,
        maxThreadContextChars:
          this.config.maxThreadContextChars,
      },
    );
    return {
      input,
      deterministic,
      quotaCharged,
      prompt,
    };
  }

  private resultFromSemantic(
    candidate: Candidate,
    semantic: CanonicalClassifierResult,
    model: string,
    attempts: number,
  ): SemanticClassificationResult {
    const classification = semanticState(
      semantic,
      this.config.confidenceThreshold,
    );
    return {
      route: "semantic",
      deterministic: candidate.deterministic,
      semantic,
      classification,
      needsReview: classification.status === "needs_review",
      quotaCharged: candidate.quotaCharged,
      model,
      attempts,
    };
  }

  private async classifyCandidate(
    candidate: Candidate,
    options: {
      skipPrimaryFirstAttempt?: boolean;
      firstPrimaryResponse?: CanonicalClassifierResult | null;
    } = {},
  ): Promise<SemanticClassificationResult> {
    const models: Array<{
      model: string;
      phase: "primary" | "fallback";
    }> = [
      {
        model: this.config.primaryModel,
        phase: "primary",
      },
      ...(this.config.fallbackModel &&
      this.config.fallbackModel !== this.config.primaryModel
        ? [
            {
              model: this.config.fallbackModel,
              phase: "fallback" as const,
            },
          ]
        : []),
    ];

    let attempts = options.skipPrimaryFirstAttempt ? 1 : 0;
    let bestLowConfidence =
      options.firstPrimaryResponse ?? undefined;
    let bestModel = this.config.primaryModel;

    for (const entry of models) {
      let startAttempt =
        entry.phase === "primary" &&
        options.skipPrimaryFirstAttempt
          ? 2
          : 1;

      for (
        let attempt = startAttempt;
        attempt <= this.config.maxAttemptsPerModel;
        attempt += 1
      ) {
        attempts += 1;
        let response: SemanticModelResponse;
        try {
          response = await this.client.complete(
            modelRequest(
              entry.model,
              candidate.prompt,
              this.config,
            ),
          );
        } catch (error) {
          await this.telemetry.append({
            ...messageScope(candidate.input.message),
            model: entry.model,
            attempt,
            phase: entry.phase,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostMicros: 0,
            outcome: "error",
            error: errorMessage(error),
            timestamp: new Date().toISOString(),
          });
          continue;
        }

        const parsed = await this.acceptResponse(
          candidate,
          response,
          entry.model,
          attempt,
          entry.phase,
        );
        if (!parsed) continue;

        if (
          !bestLowConfidence ||
          parsed.confidence > bestLowConfidence.confidence
        ) {
          bestLowConfidence = parsed;
          bestModel = entry.model;
        }

        if (
          parsed.confidence >=
          this.config.confidenceThreshold
        ) {
          return this.resultFromSemantic(
            candidate,
            parsed,
            entry.model,
            attempts,
          );
        }
      }
    }

    if (bestLowConfidence) {
      return this.resultFromSemantic(
        candidate,
        bestLowConfidence,
        bestModel,
        attempts,
      );
    }

    return {
      route: "semantic",
      deterministic: candidate.deterministic,
      classification: {
        status: "failed",
        categories: [
          ...candidate.deterministic.categoryHints,
        ],
        importanceScore:
          candidate.deterministic.importanceScore,
        priority: candidate.deterministic.priority,
        confidence: candidate.deterministic.confidence,
        actionRequired:
          candidate.deterministic.actionRequiredHint,
        replyRequired:
          candidate.deterministic.replyRequiredHint,
        reason:
          "Semantic classifier failed to produce a valid structured result.",
        classifiedAt: new Date().toISOString(),
      },
      needsReview: true,
      quotaCharged: candidate.quotaCharged,
      attempts,
    };
  }

  private async acceptResponse(
    candidate: Candidate,
    response: SemanticModelResponse,
    model: string,
    attempt: number,
    phase: "primary" | "fallback",
  ): Promise<CanonicalClassifierResult | null> {
    let parsed: CanonicalClassifierResult;
    try {
      parsed = parseClassifierResult(response.output);
    } catch (error) {
      await this.telemetry.append({
        ...messageScope(candidate.input.message),
        model,
        attempt,
        phase,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        estimatedCostMicros: estimatedCostMicros(
          model,
          response,
          this.config,
        ),
        outcome: "invalid_output",
        ...(response.requestId
          ? { requestId: response.requestId }
          : {}),
        error: errorMessage(error),
        timestamp: new Date().toISOString(),
      });
      return null;
    }

    const lowConfidence =
      parsed.confidence < this.config.confidenceThreshold;

    await this.telemetry.append({
      ...messageScope(candidate.input.message),
      model,
      attempt,
      phase,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      estimatedCostMicros: estimatedCostMicros(
        model,
        response,
        this.config,
      ),
      outcome: lowConfidence
        ? "low_confidence"
        : "success",
      ...(response.requestId
        ? { requestId: response.requestId }
        : {}),
      timestamp: new Date().toISOString(),
    });

    return parsed;
  }
}
