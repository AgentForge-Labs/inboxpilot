export const EMAIL_SCHEMA_VERSION = 1 as const;

export type ProviderKind =
  | "gmail"
  | "microsoft_graph"
  | "imap"
  | "jmap"
  | "pop3"
  | "maildir"
  | "mbox"
  | "other";

export type PriorityBand =
  | "critical"
  | "important"
  | "normal"
  | "low"
  | "very_low"
  | "disposable";

export type MailboxRole =
  | "inbox"
  | "archive"
  | "sent"
  | "drafts"
  | "trash"
  | "spam"
  | "custom";

export interface CanonicalAddress {
  address: string;
  name?: string;
}

export interface CanonicalBody {
  text?: string;
  html?: string;
  truncated: boolean;
}

export interface CanonicalMailboxRef {
  id: string;
  role: MailboxRole;
  displayName?: string;
  providerMailboxId?: string;
}

export interface CanonicalFlags {
  read: boolean;
  starred: boolean;
  important: boolean;
  draft: boolean;
  answered: boolean;
  forwarded: boolean;
}

export interface CanonicalAttachment {
  id: string;
  providerAttachmentId?: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  inline: boolean;
  contentId?: string;
}

export interface AuthenticationSignals {
  spf?: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror";
  dkim?: "pass" | "fail" | "neutral" | "none" | "temperror" | "permerror";
  dmarc?: "pass" | "fail" | "none" | "temperror" | "permerror";
  transportEncrypted?: boolean;
  suspicious?: boolean;
}

export interface ClassificationState {
  status: "unclassified" | "classified" | "needs_review" | "failed";
  modelVersion?: string;
  importanceScore?: number;
  priority?: PriorityBand;
  categories: string[];
  confidence?: number;
  actionRequired?: boolean;
  replyRequired?: boolean;
  riskScore?: number;
  reason?: string;
  classifiedAt?: string;
}

export type RetentionStage =
  | "active"
  | "archived"
  | "pending_trash"
  | "trashed"
  | "pending_delete"
  | "deleted";

export interface RetentionState {
  stage: RetentionStage;
  policyId?: string;
  protected: boolean;
  protectionReasons: string[];
  archiveAt?: string;
  trashAt?: string;
  deleteAt?: string;
  lastTransitionAt?: string;
}

export interface ProviderIdentity {
  kind: ProviderKind;
  messageId: string;
  threadId?: string;
  accountExternalId?: string;
}

export type ProviderMetadata = Readonly<Record<string, unknown>>;

export interface CanonicalMessage {
  schemaVersion: typeof EMAIL_SCHEMA_VERSION;
  id: string;
  tenantId: string;
  accountId: string;
  threadId: string;
  provider: ProviderIdentity;
  internetMessageId?: string;
  subject: string;
  snippet?: string;
  body: CanonicalBody;
  from?: CanonicalAddress;
  to: CanonicalAddress[];
  cc: CanonicalAddress[];
  bcc: CanonicalAddress[];
  replyTo: CanonicalAddress[];
  headers: Record<string, string[]>;
  labels: string[];
  mailboxes: CanonicalMailboxRef[];
  flags: CanonicalFlags;
  attachments: CanonicalAttachment[];
  sentAt?: string;
  receivedAt: string;
  authentication: AuthenticationSignals;
  classification: ClassificationState;
  retention: RetentionState;
  providerMetadata: ProviderMetadata;
  ingestedAt: string;
  updatedAt: string;
}

export interface CanonicalThread {
  schemaVersion: typeof EMAIL_SCHEMA_VERSION;
  id: string;
  tenantId: string;
  accountId: string;
  subject: string;
  messageIds: string[];
  participantAddresses: string[];
  latestMessageAt: string;
  importanceScore?: number;
  priority?: PriorityBand;
  categories: string[];
  actionRequired: boolean;
  updatedAt: string;
}

export function createUnclassifiedState(): ClassificationState {
  return { status: "unclassified", categories: [] };
}

export function createDefaultRetentionState(): RetentionState {
  return { stage: "active", protected: false, protectionReasons: [] };
}

function assertIsoDate(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO-compatible timestamp`);
  }
}

function assertScore(value: number | undefined, field: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 100)) {
    throw new RangeError(`${field} must be between 0 and 100`);
  }
}

export function assertCanonicalMessage(message: CanonicalMessage): void {
  if (message.schemaVersion !== EMAIL_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported email schema version: ${message.schemaVersion}`);
  }

  for (const [field, value] of [
    ["id", message.id],
    ["tenantId", message.tenantId],
    ["accountId", message.accountId],
    ["threadId", message.threadId],
    ["provider.messageId", message.provider.messageId],
  ] as const) {
    if (!value.trim()) throw new TypeError(`${field} is required`);
  }

  assertIsoDate(message.receivedAt, "receivedAt");
  assertIsoDate(message.ingestedAt, "ingestedAt");
  assertIsoDate(message.updatedAt, "updatedAt");
  if (message.sentAt) assertIsoDate(message.sentAt, "sentAt");
  assertScore(message.classification.importanceScore, "classification.importanceScore");
  assertScore(message.classification.riskScore, "classification.riskScore");

  const confidence = message.classification.confidence;
  if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
    throw new RangeError("classification.confidence must be between 0 and 1");
  }

  for (const name of Object.keys(message.headers)) {
    if (name !== name.toLowerCase()) {
      throw new TypeError(`Header key must be lower-case: ${name}`);
    }
  }

  const attachmentIds = new Set<string>();
  for (const attachment of message.attachments) {
    if (!attachment.id.trim()) {
      throw new TypeError("attachment.id is required");
    }
    if (attachmentIds.has(attachment.id)) {
      throw new TypeError(
        `Duplicate attachment id: ${attachment.id}`,
      );
    }
    attachmentIds.add(attachment.id);

    if (
      attachment.sizeBytes !== undefined &&
      (!Number.isSafeInteger(attachment.sizeBytes) ||
        attachment.sizeBytes < 0)
    ) {
      throw new RangeError(
        "attachment.sizeBytes must be a non-negative safe integer",
      );
    }
  }
}
