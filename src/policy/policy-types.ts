import type { MailboxActionPlan } from "../actions/action-types.js";
import type { CanonicalMessage } from "../domain/email-model.js";
import type { ProviderCapabilities } from "../providers/provider-adapter.js";
import type {
  CanonicalClassifierResult,
  ClassifierCategory,
} from "../classifier/classifier-contract.js";
import type { PersonalLearningEvaluation } from "../learning/learning-types.js";
import type { ImportanceSettings } from "../settings/importance-settings.js";
import type { NeverAutoDeleteEvaluation } from "../safeguards/safeguard-types.js";

export interface PolicyThresholds {
  importantAtOrAbove: number;
  archiveBelow: number;
  trashBelow: number;
  minClassifierConfidence: number;
}

export interface PolicyPlanCapabilities {
  automaticMarkImportant: boolean;
  automaticArchive: boolean;
  automaticTrash: boolean;
}

export type PolicyOverrideAction =
  | "keep"
  | "mark_important"
  | "archive"
  | "trash"
  | "protect";

export interface PolicyOverride {
  id: string;
  scope: "sender" | "domain";
  key: string;
  action: PolicyOverrideAction;
  enabled: boolean;
}

export interface PolicyEngineInput {
  policyId: string;
  message: CanonicalMessage;
  classification: CanonicalClassifierResult;
  providerCapabilities: ProviderCapabilities;
  planCapabilities: PolicyPlanCapabilities;
  importanceSettings?: ImportanceSettings;
  thresholds?: Partial<PolicyThresholds>;
  overrides?: readonly PolicyOverride[];
  protectedCategories?: readonly ClassifierCategory[];
  neverAutoDelete?: NeverAutoDeleteEvaluation;
  personal?: PersonalLearningEvaluation;
}

export type PolicyDecisionOutcome =
  | "planned"
  | "no_action"
  | "needs_review"
  | "blocked";

export type PolicyDecisionReason =
  | "message_already_terminal"
  | "retention_protected"
  | "protected_category"
  | "never_auto_delete_safeguard"
  | "classifier_requests_review"
  | "low_classifier_confidence"
  | "override_keep"
  | "override_protect"
  | "override_mark_important"
  | "override_archive"
  | "override_trash"
  | "personal_never_delete"
  | "personal_avoid_archive"
  | "personal_avoid_trash"
  | "personal_always_archive"
  | "important_threshold"
  | "archive_threshold"
  | "trash_threshold"
  | "classifier_recommendation"
  | "plan_capability_missing"
  | "provider_capability_missing"
  | "already_in_target_state"
  | "safe_archive_fallback"
  | "no_policy_action";

export interface PolicyDecision {
  outcome: PolicyDecisionOutcome;
  effectiveImportanceScore: number;
  protected: boolean;
  matchedOverride?: PolicyOverride;
  reasons: PolicyDecisionReason[];
  plan?: MailboxActionPlan;
}
