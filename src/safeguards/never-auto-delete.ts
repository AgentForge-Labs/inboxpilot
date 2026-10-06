import type { CanonicalMessage } from "../domain/email-model.js";
import type {
  ClassifierCategory,
} from "../classifier/classifier-contract.js";
import type {
  DangerousSafeguardOverride,
  NeverAutoDeleteContext,
  NeverAutoDeleteEvaluation,
  NeverAutoDeleteReason,
} from "./safeguard-types.js";

export const DEFAULT_NEVER_AUTO_DELETE_CATEGORIES = Object.freeze([
  "finance",
  "government",
  "legal",
  "security",
  "invoice",
  "receipt",
  "appointment",
  "travel",
] as const satisfies readonly ClassifierCategory[]);

const TWO_FACTOR_RE =
  /\b(?:2fa|two[- ]factor|two[- ]step|verification\s+code|security\s+code|one[- ]time\s+(?:code|password)|otp|tan|bestätigungscode|bestaetigungscode)\b/i;

const PASSWORD_RESET_RE =
  /\b(?:password\s+reset|reset\s+(?:your\s+)?password|forgot\s+password|passwort\s+(?:zurücksetzen|zuruecksetzen|ändern|aendern)|kennwort\s+zurücksetzen|kennwort\s+zuruecksetzen)\b/i;

const BANKING_RE =
  /\b(?:bank(?:ing)?|bankkonto|kontoauszug|iban|sepa|wire\s+transfer|überweisung|ueberweisung|lastschrift|direct\s+debit|credit\s+card|debit\s+card|kreditkarte|transaction|transaktion)\b/i;

function normalize(value: string | undefined): string | undefined {
  const result = value?.trim().toLowerCase();
  return result || undefined;
}

function senderDomain(address: string | undefined): string | undefined {
  const normalized = normalize(address);
  if (!normalized) return undefined;
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at >= normalized.length - 1) return undefined;
  return normalized.slice(at + 1);
}

function messageText(message: CanonicalMessage): string {
  return [
    message.subject,
    message.snippet ?? "",
    message.body.text ?? "",
  ]
    .join("\n")
    .slice(0, 100_000);
}

function addReason(
  reasons: NeverAutoDeleteReason[],
  reason: NeverAutoDeleteReason,
): void {
  if (!reasons.some((item) => item.code === reason.code)) {
    reasons.push(reason);
  }
}

function activeOverrides(
  message: CanonicalMessage,
  overrides: readonly DangerousSafeguardOverride[],
): DangerousSafeguardOverride[] {
  return overrides.filter(
    (override) =>
      override.enabled &&
      override.tenantId === message.tenantId &&
      override.accountId === message.accountId,
  );
}

function overrideForReason(
  message: CanonicalMessage,
  reason: NeverAutoDeleteReason,
  overrides: readonly DangerousSafeguardOverride[],
): DangerousSafeguardOverride | undefined {
  if (!reason.bypassable) return undefined;

  const sender = normalize(message.from?.address);
  const domain = senderDomain(sender);
  const thread = message.threadId;

  return overrides.find((override) => {
    const key = normalize(override.key);
    if (override.scope === "sender") {
      return sender !== undefined && key === sender;
    }
    if (override.scope === "domain") {
      return domain !== undefined && key === domain;
    }
    if (override.scope === "thread") {
      return override.key.trim() === thread;
    }
    if (override.scope === "category") {
      return (
        reason.kind === "category" &&
        key === normalize(reason.key)
      );
    }
    return (
      override.scope === "signal" &&
      (reason.kind === "security_signal" ||
        reason.kind === "banking_signal") &&
      key === normalize(reason.key)
    );
  });
}

export function evaluateNeverAutoDelete(
  message: CanonicalMessage,
  context: NeverAutoDeleteContext = {},
): NeverAutoDeleteEvaluation {
  const reasons: NeverAutoDeleteReason[] = [];
  const categories = new Set<string>(
    context.categories ?? message.classification.categories,
  );

  if (message.retention.protected) {
    addReason(reasons, {
      code: "retention:protected",
      kind: "retention",
      key: "protected",
      description:
        "Message is already protected by retention state",
      bypassable: false,
    });
  }

  for (const category of DEFAULT_NEVER_AUTO_DELETE_CATEGORIES) {
    if (categories.has(category)) {
      addReason(reasons, {
        code: "category:" + category,
        kind: "category",
        key: category,
        description:
          "Default Never Auto Delete category: " + category,
        bypassable: true,
      });
    }
  }

  const trusted = new Set(
    (context.trustedContacts ?? [])
      .map((value) => normalize(value))
      .filter((value): value is string => Boolean(value)),
  );
  const sender = normalize(message.from?.address);
  if (sender && trusted.has(sender)) {
    addReason(reasons, {
      code: "contact:" + sender,
      kind: "trusted_contact",
      key: sender,
      description:
        "Sender is a trusted/known contact",
      bypassable: true,
    });
  }

  const repliedThreads = new Set(
    (context.repliedThreadIds ?? [])
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (repliedThreads.has(message.threadId)) {
    addReason(reasons, {
      code: "thread:replied:" + message.threadId,
      kind: "replied_thread",
      key: message.threadId,
      description:
        "User has previously replied in this thread",
      bypassable: true,
    });
  }

  const text = messageText(message);
  if (TWO_FACTOR_RE.test(text)) {
    addReason(reasons, {
      code: "signal:two_factor",
      kind: "security_signal",
      key: "two_factor",
      description:
        "Message appears to contain a two-factor or verification code",
      bypassable: true,
    });
  }
  if (PASSWORD_RESET_RE.test(text)) {
    addReason(reasons, {
      code: "signal:password_reset",
      kind: "security_signal",
      key: "password_reset",
      description:
        "Message appears to concern a password reset",
      bypassable: true,
    });
  }
  if (BANKING_RE.test(text)) {
    addReason(reasons, {
      code: "signal:banking",
      kind: "banking_signal",
      key: "banking",
      description:
        "Message contains banking or payment-account context",
      bypassable: true,
    });
  }

  const overrides = activeOverrides(
    message,
    context.overrides ?? [],
  );
  const remaining: NeverAutoDeleteReason[] = [];
  const suppressedReasons: NeverAutoDeleteEvaluation["suppressedReasons"] =
    [];
  const matchedOverrideIds = new Set<string>();

  for (const reason of reasons) {
    const override = overrideForReason(
      message,
      reason,
      overrides,
    );
    if (!override) {
      remaining.push(reason);
      continue;
    }
    matchedOverrideIds.add(override.id);
    suppressedReasons.push({
      reason,
      overrideId: override.id,
    });
  }

  return {
    protected: remaining.length > 0,
    reasons: remaining,
    suppressedReasons,
    matchedOverrideIds: [...matchedOverrideIds],
  };
}
