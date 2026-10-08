import { createHash } from "node:crypto";
import type {
  CanonicalFlags,
  CanonicalMessage,
  MailboxRole,
  ProviderKind,
  RetentionState,
} from "../domain/email-model.js";

export const ACTION_PLAN_VERSION = 1 as const;

export type ActionPlanSource =
  | "policy_engine"
  | "user_confirmed"
  | "system_retention"
  | "mcp_explicit";

export type CanonicalMutation =
  | { type: "archive" }
  | { type: "move"; folderId: string }
  | { type: "trash" }
  | { type: "restore" }
  | { type: "delete_permanent" }
  | { type: "add_label"; labelId: string }
  | { type: "remove_label"; labelId: string }
  | { type: "mark_important"; value: boolean }
  | { type: "star"; value: boolean }
  | { type: "mark_read"; value: boolean };

export interface ActionPreconditions {
  expectedCanonicalMessageId?: string;
  expectedUpdatedAt?: string;
  requiredMailboxRole?: MailboxRole;
  expectedRead?: boolean;
  expectedStarred?: boolean;
  expectedImportant?: boolean;
  requireUnprotected?: boolean;
}

export interface DestructiveAuthorization {
  policyId?: string;
  userConfirmationId?: string;
  reason: string;
}

export interface MailboxActionPlan {
  schemaVersion: typeof ACTION_PLAN_VERSION;
  planId: string;
  idempotencyKey: string;
  source: ActionPlanSource;
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  providerMessageId: string;
  action: CanonicalMutation;
  preconditions?: ActionPreconditions;
  destructiveAuthorization?: DestructiveAuthorization;
}

export interface MessageStateSnapshot {
  canonicalMessageId: string;
  provider: ProviderKind;
  providerMessageId: string;
  tenantId: string;
  accountId: string;
  updatedAt: string;
  mailboxRoles: MailboxRole[];
  mailboxIds: string[];
  labels: string[];
  flags: CanonicalFlags;
  retention: RetentionState;
}

export interface ActionExecutionContext {
  tenantId: string;
  accountId: string;
  actorType: "user" | "mcp" | "worker" | "system";
  actorId?: string;
}

const ALLOWED_SOURCES = new Set<ActionPlanSource>([
  "policy_engine",
  "user_confirmed",
  "system_retention",
  "mcp_explicit",
]);

const ACTIONS = new Set<CanonicalMutation["type"]>([
  "archive",
  "move",
  "trash",
  "restore",
  "delete_permanent",
  "add_label",
  "remove_label",
  "mark_important",
  "star",
  "mark_read",
]);

function requiredString(
  value: unknown,
  field: string,
  max = 512,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} is required`);
  }
  if (value.length > max) throw new RangeError(`${field} is too long`);
  return value;
}

export function assertExplicitActionPlan(input: unknown): MailboxActionPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Action plan must be an object");
  }
  const value = input as Record<string, unknown>;

  if (value.schemaVersion !== ACTION_PLAN_VERSION) {
    throw new TypeError("Unsupported action plan schema version");
  }

  const source = value.source;
  if (typeof source !== "string" || !ALLOWED_SOURCES.has(source as ActionPlanSource)) {
    throw new TypeError("Action plan source is not trusted");
  }

  const actionInput = value.action;
  if (!actionInput || typeof actionInput !== "object" || Array.isArray(actionInput)) {
    throw new TypeError("Action plan action must be an object");
  }
  const actionValue = actionInput as Record<string, unknown>;
  if (
    typeof actionValue.type !== "string" ||
    !ACTIONS.has(actionValue.type as CanonicalMutation["type"])
  ) {
    throw new TypeError("Unsupported canonical mailbox action");
  }

  let action: CanonicalMutation;
  switch (actionValue.type) {
    case "move":
      action = {
        type: "move",
        folderId: requiredString(actionValue.folderId, "action.folderId"),
      };
      break;
    case "add_label":
    case "remove_label":
      action = {
        type: actionValue.type,
        labelId: requiredString(actionValue.labelId, "action.labelId"),
      };
      break;
    case "mark_important":
    case "star":
    case "mark_read":
      if (typeof actionValue.value !== "boolean") {
        throw new TypeError(`action.value must be boolean for ${actionValue.type}`);
      }
      action = { type: actionValue.type, value: actionValue.value };
      break;
    default:
      action = { type: actionValue.type as "archive" | "trash" | "restore" | "delete_permanent" };
  }

  const provider = requiredString(value.provider, "provider") as ProviderKind;
  const validProviders = new Set<ProviderKind>([
    "gmail",
    "microsoft_graph",
    "imap",
    "jmap",
    "pop3",
    "maildir",
    "mbox",
    "other",
  ]);
  if (!validProviders.has(provider)) {
    throw new TypeError("Unsupported provider kind");
  }

  const plan: MailboxActionPlan = {
    schemaVersion: ACTION_PLAN_VERSION,
    planId: requiredString(value.planId, "planId"),
    idempotencyKey: requiredString(value.idempotencyKey, "idempotencyKey", 256),
    source: source as ActionPlanSource,
    tenantId: requiredString(value.tenantId, "tenantId"),
    accountId: requiredString(value.accountId, "accountId"),
    provider,
    providerMessageId: requiredString(value.providerMessageId, "providerMessageId", 4096),
    action,
  };

  if (value.preconditions !== undefined) {
    if (!value.preconditions || typeof value.preconditions !== "object") {
      throw new TypeError("preconditions must be an object");
    }
    plan.preconditions = value.preconditions as ActionPreconditions;
  }

  if (value.destructiveAuthorization !== undefined) {
    if (
      !value.destructiveAuthorization ||
      typeof value.destructiveAuthorization !== "object"
    ) {
      throw new TypeError("destructiveAuthorization must be an object");
    }
    const auth = value.destructiveAuthorization as Record<string, unknown>;
    plan.destructiveAuthorization = {
      reason: requiredString(auth.reason, "destructiveAuthorization.reason", 1000),
      ...(typeof auth.policyId === "string" && auth.policyId.trim()
        ? { policyId: auth.policyId }
        : {}),
      ...(typeof auth.userConfirmationId === "string" &&
      auth.userConfirmationId.trim()
        ? { userConfirmationId: auth.userConfirmationId }
        : {}),
    };
  }

  return plan;
}

export function createActionIdempotencyKey(
  input: Pick<
    MailboxActionPlan,
    "planId" | "tenantId" | "accountId" | "provider" | "providerMessageId" | "action"
  >,
): string {
  const material = JSON.stringify({
    planId: input.planId,
    tenantId: input.tenantId,
    accountId: input.accountId,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    action: input.action,
  });
  return `act_${createHash("sha256").update(material).digest("hex").slice(0, 40)}`;
}

export function actionPlanHash(plan: MailboxActionPlan): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: plan.schemaVersion,
        planId: plan.planId,
        source: plan.source,
        tenantId: plan.tenantId,
        accountId: plan.accountId,
        provider: plan.provider,
        providerMessageId: plan.providerMessageId,
        action: plan.action,
        preconditions: plan.preconditions ?? null,
        destructiveAuthorization: plan.destructiveAuthorization ?? null,
      }),
    )
    .digest("hex");
}

export function snapshotMessage(message: CanonicalMessage): MessageStateSnapshot {
  return {
    canonicalMessageId: message.id,
    provider: message.provider.kind,
    providerMessageId: message.provider.messageId,
    tenantId: message.tenantId,
    accountId: message.accountId,
    updatedAt: message.updatedAt,
    mailboxRoles: [...new Set(message.mailboxes.map((mailbox) => mailbox.role))],
    mailboxIds: message.mailboxes.map((mailbox) => mailbox.id),
    labels: [...message.labels],
    flags: { ...message.flags },
    retention: {
      ...message.retention,
      protectionReasons: [...message.retention.protectionReasons],
    },
  };
}
