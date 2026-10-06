import type {
  PriorityBand,
  RetentionStage,
} from "../domain/email-model.js";
import type { RetentionRunResult } from "../retention/retention-types.js";

export type PendingDeleteActionKey =
  | "keep"
  | "restore_to_inbox"
  | "never_delete_sender"
  | "never_delete_domain"
  | "change_rule"
  | "delete_now";

export interface PendingDeleteActionAvailability {
  key: PendingDeleteActionKey;
  enabled: boolean;
  reason?: string;
}

export interface PendingDeleteQueueItem {
  jobId: string;
  tenantId: string;
  accountId: string;
  canonicalMessageId: string;
  providerMessageId: string;
  sender?: string;
  senderName?: string;
  subject: string;
  receivedAt: string;
  importanceScore?: number;
  priority?: PriorityBand;
  categories: string[];
  explanation: string;
  retentionStage: RetentionStage;
  matchedRule: {
    id: string;
    label: string;
  };
  scheduledTrashAt?: string;
  scheduledPermanentDeleteAt?: string;
  providerManagedExpiryAt?: string;
  actions: PendingDeleteActionAvailability[];
}

export interface PendingDeleteRuleEditIntent {
  kind: "edit_rule";
  tenantId: string;
  accountId: string;
  jobId: string;
  policyId: string;
}

export interface PendingDeleteDeleteNowInput {
  jobId: string;
  actorId: string;
  userConfirmationId: string;
}

export interface PendingDeleteActionResult {
  jobId: string;
  outcome:
    | "kept"
    | "restored"
    | "never_delete_sender"
    | "never_delete_domain"
    | "delete_now";
  retentionResult?: RetentionRunResult;
}
