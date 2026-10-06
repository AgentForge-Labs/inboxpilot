import type { MailboxActionPlan } from "../actions/action-types.js";
import type { PriorityBand } from "../domain/email-model.js";
import type { PolicyDecision } from "../policy/policy-types.js";

export const SHADOW_MODE_VERSION = 1 as const;
export const SHADOW_MODE_DAYS = 7 as const;

export type ShadowModeStatus =
  | "shadow"
  | "review_ready"
  | "enabled";

export interface ShadowModeAccountState {
  version: typeof SHADOW_MODE_VERSION;
  tenantId: string;
  accountId: string;
  revision: number;
  status: ShadowModeStatus;
  startedAt: string;
  shadowEndsAt: string;
  enabledAt?: string;
  enabledBy?: string;
  reviewConfirmedAt?: string;
}

export type ShadowIntendedAction =
  | "none"
  | "mark_important"
  | "archive"
  | "trash";

export interface ShadowModeObservation {
  tenantId: string;
  accountId: string;
  canonicalMessageId: string;
  providerMessageId: string;
  priority: PriorityBand;
  policyOutcome: PolicyDecision["outcome"];
  intendedAction: ShadowIntendedAction;
  observedAt: string;
}

export interface ShadowModeCounts {
  critical: number;
  important: number;
  normal: number;
  low: number;
  wouldArchive: number;
  wouldDelete: number;
  total: number;
}

export interface ShadowModeDashboardView {
  status: ShadowModeStatus;
  startedAt: string;
  shadowEndsAt: string;
  daysRemaining: number;
  canEnableAutomation: boolean;
  automationEnabled: boolean;
  counts: ShadowModeCounts;
}

export interface EnableAutomationRequest {
  tenantId: string;
  accountId: string;
  actorId: string;
  reviewed: true;
}

export interface ShadowModeAuditEvent {
  tenantId: string;
  accountId: string;
  event:
    | "shadow_started"
    | "review_ready"
    | "automation_enabled";
  actorId?: string;
  timestamp: string;
}

export interface ShadowModeStore {
  get(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeAccountState | undefined>;
  create(state: ShadowModeAccountState): Promise<void>;
  update(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    mutate: (
      state: ShadowModeAccountState,
    ) => ShadowModeAccountState,
  ): Promise<ShadowModeAccountState>;
  upsertObservation(
    observation: ShadowModeObservation,
  ): Promise<void>;
  listObservations(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeObservation[]>;
  appendAudit(event: ShadowModeAuditEvent): Promise<void>;
  listAudit(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeAuditEvent[]>;
}

export interface ShadowPolicyEvaluation {
  shadow: ShadowModeAccountState;
  decision: PolicyDecision;
  intendedPlan?: MailboxActionPlan;
  executablePlan?: MailboxActionPlan;
  suppressed: boolean;
}
