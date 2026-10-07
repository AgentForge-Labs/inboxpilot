import type {
  CanonicalMessage,
  ClassificationState,
} from "../domain/email-model.js";
import type {
  CanonicalClassifierResult,
} from "./classifier-contract.js";
import type {
  DeterministicImportanceResult,
  ImportanceHistoryContext,
} from "./importance-engine.js";
import type {
  AttachmentEnrichmentSummary,
} from "./attachments/attachment-types.js";

export interface SemanticModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SemanticModelResponse {
  output: unknown;
  usage: SemanticModelUsage;
  requestId?: string;
}

export interface SemanticModelRequest {
  model: string;
  schemaName: string;
  system: string;
  input: string;
  maxOutputTokens: number;
}

export interface SemanticModelClient {
  complete(request: SemanticModelRequest): Promise<SemanticModelResponse>;
  completeBatch?(
    requests: readonly SemanticModelRequest[],
  ): Promise<SemanticModelResponse[]>;
}

export interface SemanticCostEvent {
  tenantId: string;
  accountId: string;
  providerMessageId: string;
  model: string;
  attempt: number;
  phase: "primary" | "fallback";
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicros: number;
  outcome: "success" | "invalid_output" | "low_confidence" | "error";
  requestId?: string;
  error?: string;
  timestamp: string;
}

export interface SemanticCostTelemetry {
  append(event: SemanticCostEvent): Promise<void>;
}

export interface SemanticQuotaLedger {
  chargeUnique(message: CanonicalMessage): Promise<boolean>;
}

export interface SemanticClassifierConfig {
  primaryModel: string;
  fallbackModel?: string;
  confidenceThreshold?: number;
  maxBodyChars?: number;
  maxThreadContextChars?: number;
  maxOutputTokens?: number;
  maxAttemptsPerModel?: number;
  maxBatchSize?: number;
  priceMicrosPerMillionInputTokens?: Readonly<Record<string, number>>;
  priceMicrosPerMillionOutputTokens?: Readonly<Record<string, number>>;
}

export interface SemanticClassifyInput {
  message: CanonicalMessage;
  history: ImportanceHistoryContext;
  threadContext?: readonly CanonicalMessage[];
}

export interface SemanticClassificationResult {
  route: "deterministic" | "semantic";
  deterministic: DeterministicImportanceResult;
  semantic?: CanonicalClassifierResult;
  classification?: ClassificationState;
  needsReview: boolean;
  quotaCharged: boolean;
  model?: string;
  attempts: number;
  attachmentEnrichment?: AttachmentEnrichmentSummary;
}

export interface SemanticBatchResult {
  results: SemanticClassificationResult[];
  semanticCandidates: number;
  batchedRequests: number;
}
