import type {
  CanonicalMessage,
} from "../domain/email-model.js";
import type {
  ClassifierCategory,
} from "../classifier/classifier-contract.js";

export const SAFEGUARD_OVERRIDE_VERSION = 1 as const;

export type NeverAutoDeleteReasonKind =
  | "retention"
  | "category"
  | "trusted_contact"
  | "replied_thread"
  | "security_signal"
  | "banking_signal";

export interface NeverAutoDeleteReason {
  code: string;
  kind: NeverAutoDeleteReasonKind;
  key: string;
  description: string;
  bypassable: boolean;
}

export type DangerousOverrideScope =
  | "category"
  | "sender"
  | "domain"
  | "thread"
  | "signal";

export interface DangerousOverrideConfirmation {
  confirmationId: string;
  actorId: string;
  confirmedAt: string;
  statement: string;
}

export interface DangerousSafeguardOverride {
  version: typeof SAFEGUARD_OVERRIDE_VERSION;
  id: string;
  tenantId: string;
  accountId: string;
  scope: DangerousOverrideScope;
  key: string;
  enabled: boolean;
  confirmation: DangerousOverrideConfirmation;
  createdAt: string;
  updatedAt: string;
}

export interface NeverAutoDeleteEvaluation {
  protected: boolean;
  reasons: NeverAutoDeleteReason[];
  suppressedReasons: Array<{
    reason: NeverAutoDeleteReason;
    overrideId: string;
  }>;
  matchedOverrideIds: string[];
}

export interface NeverAutoDeleteContext {
  trustedContacts?: readonly string[];
  repliedThreadIds?: readonly string[];
  overrides?: readonly DangerousSafeguardOverride[];
  categories?: readonly ClassifierCategory[];
}

export interface DangerousOverrideCreateInput {
  id: string;
  tenantId: string;
  accountId: string;
  scope: DangerousOverrideScope;
  key: string;
  confirmation?: DangerousOverrideConfirmation;
}

export interface SafeguardOverrideAuditEvent {
  overrideId: string;
  tenantId: string;
  accountId: string;
  action: "created" | "enabled" | "disabled";
  scope: DangerousOverrideScope;
  key: string;
  actorId: string;
  confirmationId: string;
  timestamp: string;
}

export interface SafeguardOverrideStore {
  create(override: DangerousSafeguardOverride): Promise<void>;
  get(
    tenantId: string,
    accountId: string,
    overrideId: string,
  ): Promise<DangerousSafeguardOverride | undefined>;
  list(
    tenantId: string,
    accountId: string,
  ): Promise<DangerousSafeguardOverride[]>;
  setEnabled(
    tenantId: string,
    accountId: string,
    overrideId: string,
    enabled: boolean,
    updatedAt: string,
  ): Promise<DangerousSafeguardOverride>;
  appendAudit(event: SafeguardOverrideAuditEvent): Promise<void>;
  listAudit(
    tenantId: string,
    accountId: string,
  ): Promise<SafeguardOverrideAuditEvent[]>;
}

export interface NeverAutoDeleteContextResolver {
  resolve(
    message: CanonicalMessage,
  ): Promise<{
    trustedContacts?: readonly string[];
    repliedThreadIds?: readonly string[];
  }>;
}
