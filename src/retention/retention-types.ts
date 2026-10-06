import type {
  CanonicalMessage,
  ProviderKind,
  RetentionState,
} from "../domain/email-model.js";
import type {
  ActionExecutionContext,
  MailboxActionPlan,
} from "../actions/action-types.js";
import type { ActionExecutionResult } from "../actions/action-executor.js";

export type RetentionJobStatus =
  | "scheduled"
  | "blocked"
  | "provider_managed"
  | "cancelled"
  | "completed"
  | "failed";

export type RetentionNextAction =
  | "archive"
  | "trash"
  | "delete_permanent";

export interface RetentionScheduleConfig {
  archiveRetentionDays: number;
  trashRetentionDays: number;
  allowPermanentDelete: boolean;
}

export type ProviderTrashBehavior =
  | "provider_managed_expiry"
  | "explicit_permanent_delete"
  | "unknown";

export interface ProviderTrashSemantics {
  provider: ProviderKind;
  behavior: ProviderTrashBehavior;
  permanentDeleteSupported: boolean;
  providerAutoDeleteAfterDays?: number;
  note: string;
}

export interface RetentionJob {
  id: string;
  version: number;
  tenantId: string;
  accountId: string;
  canonicalMessageId: string;
  provider: ProviderKind;
  providerMessageId: string;
  policyId: string;
  status: RetentionJobStatus;
  nextAction?: RetentionNextAction;
  nextRunAt?: string;
  config: RetentionScheduleConfig;
  trashSemantics: ProviderTrashSemantics;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  blockedReason?: string;
  lastError?: string;
}

export interface RetentionAuditEvent {
  jobId: string;
  tenantId: string;
  accountId: string;
  providerMessageId: string;
  event:
    | "scheduled"
    | "action_planned"
    | "action_succeeded"
    | "policy_blocked"
    | "provider_managed"
    | "restore_cancelled"
    | "failed"
    | "completed";
  action?: RetentionNextAction;
  retentionStage?: RetentionState["stage"];
  policyReason?: string;
  providerTrashBehavior?: ProviderTrashBehavior;
  timestamp: string;
}

export interface RetentionJobStore {
  create(job: RetentionJob): Promise<void>;
  get(jobId: string): Promise<RetentionJob | undefined>;
  findActiveByMessage(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
  ): Promise<RetentionJob | undefined>;
  listDue(now: string, limit: number): Promise<RetentionJob[]>;
  update(
    jobId: string,
    expectedVersion: number,
    mutate: (job: RetentionJob) => RetentionJob,
  ): Promise<RetentionJob>;
  appendAudit(event: RetentionAuditEvent): Promise<void>;
}

export interface RetentionMessageRepository {
  get(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
  ): Promise<CanonicalMessage | undefined>;
  updateRetention(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
    retention: RetentionState,
  ): Promise<void>;
}

export interface RetentionPolicyDecision {
  allowed: boolean;
  reason: string;
  policyId?: string;
}

export interface RetentionPolicyRevalidator {
  evaluate(
    message: CanonicalMessage,
    action: "trash" | "delete_permanent",
    job: RetentionJob,
  ): Promise<RetentionPolicyDecision>;
}

export interface RetentionActionExecutor {
  execute(
    plan: MailboxActionPlan,
    context: ActionExecutionContext,
  ): Promise<ActionExecutionResult>;
}

export interface RetentionRunResult {
  job: RetentionJob;
  outcome:
    | "not_due"
    | "archived"
    | "trashed"
    | "deleted"
    | "blocked"
    | "provider_managed"
    | "cancelled"
    | "completed"
    | "failed";
}
