import { createHash } from "node:crypto";
import type {
  ActionExecutionContext,
  MailboxActionPlan,
} from "../actions/action-types.js";
import type {
  ActionExecutionResult,
} from "../actions/action-executor.js";
import type {
  PolicyDecision,
  PolicyEngineInput,
} from "../policy/policy-types.js";
import {
  EXPLAINABILITY_AUDIT_VERSION,
  type ExplainabilityActor,
  type ExplainabilityAuditEvent,
  type ExplainabilityAuditOutcome,
  type ExplainabilityAuditStore,
  type ManualDecisionAuditInput,
  type PolicyDecisionAuditInput,
} from "./audit-types.js";
import { sanitizeAuditText } from "./audit-sanitizer.js";

function eventId(material: unknown): string {
  return (
    "audit_" +
    createHash("sha256")
      .update(JSON.stringify(material))
      .digest("hex")
      .slice(0, 40)
  );
}

function classifierSnapshot(input: PolicyEngineInput) {
  const value = input.classification;
  return {
    ...(value.modelVersion
      ? { modelVersion: value.modelVersion }
      : {}),
    importanceScore: value.importanceScore,
    priority: value.priority,
    categories: [...value.categories],
    confidence: value.confidence,
    reason: sanitizeAuditText(value.reason),
    recommendedAction: value.recommendedAction,
    actionRequired: value.actionRequired,
    replyRequired: value.replyRequired,
    spamRisk: value.spamRisk,
    phishingRisk: value.phishingRisk,
  };
}

function actorOrSystem(
  actor?: ExplainabilityActor,
): ExplainabilityActor {
  return actor ?? {
    type: "system",
    id: "policy-engine",
  };
}

export class ExplainabilityAuditRecorder {
  constructor(
    private readonly store: ExplainabilityAuditStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordPolicyDecision(
    input: PolicyEngineInput,
    decision: PolicyDecision,
    options: PolicyDecisionAuditInput = {},
  ): Promise<ExplainabilityAuditEvent> {
    const timestamp =
      options.timestamp ?? this.now().toISOString();
    const actor = actorOrSystem(options.actor);
    const plan = decision.plan;
    const matchedOverride = decision.matchedOverride;

    const event: ExplainabilityAuditEvent = {
      version: EXPLAINABILITY_AUDIT_VERSION,
      eventId: eventId({
        kind: "policy_decision",
        tenantId: input.message.tenantId,
        accountId: input.message.accountId,
        providerMessageId:
          input.message.provider.messageId,
        policyId: input.policyId,
        updatedAt: input.message.updatedAt,
        outcome: options.outcomeOverride ?? decision.outcome,
        planId: plan?.planId ?? null,
      }),
      kind: "policy_decision",
      tenantId: input.message.tenantId,
      accountId: input.message.accountId,
      canonicalMessageId: input.message.id,
      provider: input.message.provider.kind,
      providerMessageId:
        input.message.provider.messageId,
      ...(input.message.internetMessageId
        ? {
            internetMessageId:
              input.message.internetMessageId,
          }
        : {}),
      actor,
      timestamp,
      classifier: classifierSnapshot(input),
      signals: [
        ...(options.signals ?? []).map((signal) => ({
          code: signal.code,
          weight: signal.weight,
          reason: sanitizeAuditText(signal.reason, 500),
        })),
        ...decision.reasons.map((reason) => ({
          code: "policy:" + reason,
        })),
        ...(input.neverAutoDelete?.reasons ?? []).map(
          (reason) => ({
            code: "safeguard:" + reason.code,
            reason: sanitizeAuditText(
              reason.description,
              500,
            ),
          }),
        ),
      ],
      matchedRule: {
        policyId: input.policyId,
        ...(matchedOverride
          ? {
              overrideId: matchedOverride.id,
              overrideScope: matchedOverride.scope,
              overrideAction: matchedOverride.action,
            }
          : {}),
      },
      policyOutcome: decision.outcome,
      policyReasons: [...decision.reasons],
      ...(plan
        ? {
            requestedAction: {
              type: plan.action.type,
              planId: plan.planId,
              idempotencyKey: plan.idempotencyKey,
              source: plan.source,
            },
          }
        : {}),
      outcome:
        options.outcomeOverride ?? decision.outcome,
      metadata: {
        effectiveImportanceScore:
          decision.effectiveImportanceScore,
        protected: decision.protected,
      },
    };

    await this.store.append(event);
    return event;
  }

  async recordActionExecution(
    plan: MailboxActionPlan,
    context: ActionExecutionContext,
    result: ActionExecutionResult,
    outcome: "succeeded" | "deduplicated" = "succeeded",
    timestamp = this.now().toISOString(),
  ): Promise<ExplainabilityAuditEvent> {
    const event: ExplainabilityAuditEvent = {
      version: EXPLAINABILITY_AUDIT_VERSION,
      eventId: eventId({
        kind: "action_execution",
        planId: plan.planId,
        idempotencyKey: plan.idempotencyKey,
        outcome,
        attempts: result.attempts,
      }),
      kind: "action_execution",
      tenantId: plan.tenantId,
      accountId: plan.accountId,
      canonicalMessageId:
        result.beforeState.canonicalMessageId,
      provider: plan.provider,
      providerMessageId: plan.providerMessageId,
      actor: {
        type: context.actorType,
        ...(context.actorId
          ? { id: context.actorId }
          : {}),
      },
      timestamp,
      signals: [],
      ...(plan.destructiveAuthorization?.policyId
        ? {
            matchedRule: {
              policyId:
                plan.destructiveAuthorization.policyId,
            },
          }
        : {}),
      policyReasons: [],
      requestedAction: {
        type: plan.action.type,
        planId: plan.planId,
        idempotencyKey: plan.idempotencyKey,
        source: plan.source,
      },
      executedAction: {
        type: plan.action.type,
        planId: plan.planId,
        idempotencyKey: plan.idempotencyKey,
        source: plan.source,
      },
      outcome,
      beforeState: structuredClone(result.beforeState),
      afterState:
        result.afterState === null
          ? null
          : structuredClone(result.afterState),
      afterStateStatus: result.afterStateStatus,
      metadata: {
        attempts: result.attempts,
      },
    };

    await this.store.append(event);
    return event;
  }

  async recordActionFailure(
    plan: MailboxActionPlan,
    context: ActionExecutionContext,
    beforeState: ActionExecutionResult["beforeState"],
    error: {
      code: string;
      category?: string;
      message: string;
    },
    timestamp = this.now().toISOString(),
  ): Promise<ExplainabilityAuditEvent> {
    const event: ExplainabilityAuditEvent = {
      version: EXPLAINABILITY_AUDIT_VERSION,
      eventId: eventId({
        kind: "action_execution",
        planId: plan.planId,
        idempotencyKey: plan.idempotencyKey,
        outcome: "failed",
        errorCode: error.code,
        timestamp,
      }),
      kind: "action_execution",
      tenantId: plan.tenantId,
      accountId: plan.accountId,
      canonicalMessageId:
        beforeState.canonicalMessageId,
      provider: plan.provider,
      providerMessageId: plan.providerMessageId,
      actor: {
        type: context.actorType,
        ...(context.actorId
          ? { id: context.actorId }
          : {}),
      },
      timestamp,
      signals: [],
      ...(plan.destructiveAuthorization?.policyId
        ? {
            matchedRule: {
              policyId:
                plan.destructiveAuthorization.policyId,
            },
          }
        : {}),
      policyReasons: [],
      requestedAction: {
        type: plan.action.type,
        planId: plan.planId,
        idempotencyKey: plan.idempotencyKey,
        source: plan.source,
      },
      outcome: "failed",
      beforeState: structuredClone(beforeState),
      error: {
        code: error.code,
        ...(error.category
          ? { category: error.category }
          : {}),
        message: sanitizeAuditText(
          error.message,
          500,
        ),
      },
    };

    await this.store.append(event);
    return event;
  }

  async recordManualDecision(
    input: ManualDecisionAuditInput,
  ): Promise<ExplainabilityAuditEvent> {
    const timestamp =
      input.timestamp ?? this.now().toISOString();

    const event: ExplainabilityAuditEvent = {
      version: EXPLAINABILITY_AUDIT_VERSION,
      eventId: eventId({
        kind: "manual_decision",
        tenantId: input.tenantId,
        accountId: input.accountId,
        providerMessageId: input.providerMessageId,
        requestedAction: input.requestedAction,
        timestamp,
        actor: input.actor,
      }),
      kind: "manual_decision",
      tenantId: input.tenantId,
      accountId: input.accountId,
      canonicalMessageId:
        input.canonicalMessageId,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      ...(input.internetMessageId
        ? {
            internetMessageId:
              input.internetMessageId,
          }
        : {}),
      actor: structuredClone(input.actor),
      timestamp,
      signals: input.reason
        ? [
            {
              code: "manual_reason",
              reason: sanitizeAuditText(
                input.reason,
                500,
              ),
            },
          ]
        : [],
      ...(input.matchedPolicyId
        ? {
            matchedRule: {
              policyId: input.matchedPolicyId,
            },
          }
        : {}),
      policyReasons: [],
      requestedAction: {
        type: input.requestedAction,
      },
      ...(input.executedAction
        ? {
            executedAction: {
              type: input.executedAction,
            },
          }
        : {}),
      outcome: input.outcome,
      ...(input.beforeState
        ? {
            beforeState: structuredClone(
              input.beforeState,
            ),
          }
        : {}),
      ...(input.afterState !== undefined
        ? {
            afterState:
              input.afterState === null
                ? null
                : structuredClone(
                    input.afterState,
                  ),
          }
        : {}),
      ...(input.afterStateStatus
        ? {
            afterStateStatus:
              input.afterStateStatus,
          }
        : {}),
      ...(input.metadata
        ? {
            metadata: structuredClone(
              input.metadata,
            ),
          }
        : {}),
    };

    await this.store.append(event);
    return event;
  }
}

export interface PolicyEvaluator {
  evaluate(input: PolicyEngineInput): PolicyDecision;
}

export class AuditedPolicyEvaluator {
  constructor(
    private readonly policy: PolicyEvaluator,
    private readonly audit: ExplainabilityAuditRecorder,
  ) {}

  async evaluate(
    input: PolicyEngineInput,
    options: PolicyDecisionAuditInput = {},
  ): Promise<PolicyDecision> {
    const decision = this.policy.evaluate(input);
    await this.audit.recordPolicyDecision(
      input,
      decision,
      options,
    );
    return decision;
  }
}
