import type {
  ExplainabilityAuditEvent,
} from "./audit-types.js";

const FORBIDDEN_KEYS =
  /^(?:body|html|raw|headers?|attachments?|token|secret|password|authorization|cookie|credential|api[_-]?key|private[_-]?key)$/i;

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_RE =
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const SECRET_ASSIGNMENT_RE =
  /\b(token|secret|password|authorization|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi;

export function sanitizeAuditText(
  value: string,
  maxLength = 1000,
): string {
  return value
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(JWT_RE, "[REDACTED_JWT]")
    .replace(
      SECRET_ASSIGNMENT_RE,
      (_match, key: string) => key + "=[REDACTED]",
    )
    .slice(0, maxLength);
}

export function assertBodyFreeAuditEvent(
  event: ExplainabilityAuditEvent,
): void {
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, path + "[" + index + "]"),
      );
      return;
    }
    if (!value || typeof value !== "object") return;

    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_KEYS.test(key)) {
        throw new TypeError(
          "Forbidden sensitive audit field at " + path + "." + key,
        );
      }
      visit(child, path + "." + key);
    }
  };

  visit(event, "audit");
}

export function sanitizeAuditEvent(
  event: ExplainabilityAuditEvent,
): ExplainabilityAuditEvent {
  const sanitized = structuredClone(event);

  if (sanitized.classifier) {
    sanitized.classifier.reason = sanitizeAuditText(
      sanitized.classifier.reason,
    );
  }
  sanitized.signals = sanitized.signals.map((signal) => ({
    ...signal,
    ...(signal.reason
      ? { reason: sanitizeAuditText(signal.reason, 500) }
      : {}),
  }));
  if (sanitized.error) {
    sanitized.error.message = sanitizeAuditText(
      sanitized.error.message,
      500,
    );
  }

  assertBodyFreeAuditEvent(sanitized);
  return sanitized;
}
