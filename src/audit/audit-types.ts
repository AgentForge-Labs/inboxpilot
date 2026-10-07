import type {
  ActionExecutionContext,
  MailboxActionPlan,
  MessageStateSnapshot,
} from "../actions/action-types.js";
import type {
  CanonicalClassifierResult,
  RecommendedAction,
} from "../classifier/classifier-contract.js";
import type {
  ImportanceContribution,
} from "../classifier/importance-engine.js";
import type {
  ProviderKind,
} from "../domain/email-model.js";
import type {
  PolicyDecisionOutcome,
  PolicyDecisionReason,
} from "../policy/policy-types.js";

export const EXPLAINABILITY_AUDIT_VERSION = 1 as const;

export type ExplainabilityAuditKind =
  | "policy_decision"
  | "action_execution"
  | "manual_decision";

export type ExplainabilityAuditOutcome =
  | PolicyDecisionOutcome
  | "succeeded"
  | "failed"
  | "deduplicated"
  | "cancelled"
  | "suppressed";

export interface ExplainabilityActor {
  type: ActionExecutionContext["actorType"];
  id?: string;
}

export interface ExplainabilityClassifierSnapshot {
  modelVersion?: string;
  importanceScore: number;
  priority: CanonicalClassifierResult["priority"];
  categories: CanonicalClassifierResult["categories"];
  confidence: number;
  reason: string;
  recommendedAction: RecommendedAction;
  actionRequired: boolean;
  replyRequired: boolean;
  spamRisk: number;
  phishingRisk: number;
}

export interface ExplainabilitySignal {
  code: string;
  weight?: number;
  reason?: string;
}

export interface ExplainabilityRuleMatch {
  policyId: string;
  overrideId?: string;
  overrideScope?: "sender" | "domain";
  overrideAction?: string;
}

export interface ExplainabilityActionRef {
  type: MailboxActionPlan["action"]["type"] | RecommendedAction | string;
  planId?: string;
  idempotencyKey?: string;
  source?: MailboxActionPlan["source"];
}

export interface ExplainabilityAuditEvent {
  version: typeof EXPLAINABILITY_AUDIT_VERSION;
  eventId: string;
  kind: ExplainabilityAuditKind;
  tenantId: string;
  accountId: string;
  canonicalMessageId: string;
  provider: ProviderKind;
  providerMessageId: string;
  internetMessageId?: string;
  actor: ExplainabilityActor;
  timestamp: string;
  classifier?: ExplainabilityClassifierSnapshot;
  signals: ExplainabilitySignal[];
  matchedRule?: ExplainabilityRuleMatch;
  policyOutcome?: PolicyDecisionOutcome;
  policyReasons: PolicyDecisionReason[];
  requestedAction?: ExplainabilityActionRef;
  executedAction?: ExplainabilityActionRef;
  outcome: ExplainabilityAuditOutcome;
  beforeState?: MessageStateSnapshot;
  afterState?: MessageStateSnapshot | null;
  afterStateStatus?: "captured" | "unavailable" | "deleted";
  error?: {
    code: string;
    category?: string;
    message: string;
  };
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PolicyDecisionAuditInput {
  actor?: ExplainabilityActor;
  signals?: readonly ImportanceContribution[];
  outcomeOverride?: ExplainabilityAuditOutcome;
  timestamp?: string;
}

export interface ManualDecisionAuditInput {
  tenantId: string;
  accountId: string;
  canonicalMessageId: string;
  provider: ProviderKind;
  providerMessageId: string;
  internetMessageId?: string;
  actor: ExplainabilityActor;
  timestamp?: string;
  requestedAction: string;
  executedAction?: string;
  outcome: ExplainabilityAuditOutcome;
  matchedPolicyId?: string;
  reason?: string;
  beforeState?: MessageStateSnapshot;
  afterState?: MessageStateSnapshot | null;
  afterStateStatus?: "captured" | "unavailable" | "deleted";
  metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ExplainabilityAuditStore {
  append(event: ExplainabilityAuditEvent): Promise<void>;
  listForAccount(
    tenantId: string,
    accountId: string,
    limit?: number,
  ): Promise<ExplainabilityAuditEvent[]>;
  listForMessage(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
  ): Promise<ExplainabilityAuditEvent[]>;
  listForPlan(
    tenantId: string,
    accountId: string,
    planId: string,
  ): Promise<ExplainabilityAuditEvent[]>;
}
