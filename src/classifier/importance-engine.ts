import type {
  CanonicalMessage,
  PriorityBand,
} from "../domain/email-model.js";
import {
  priorityForImportanceScore,
  type ClassifierCategory,
} from "./classifier-contract.js";

export type ImportanceSignalCode =
  | "trusted_contact"
  | "allowlisted_sender"
  | "allowlisted_domain"
  | "prior_user_replies"
  | "sender_interaction_history"
  | "domain_interaction_history"
  | "direct_recipient"
  | "mailing_list"
  | "list_unsubscribe"
  | "bulk_precedence"
  | "thread_participation"
  | "deadline_language"
  | "monetary_amount"
  | "action_language"
  | "invoice_indicator"
  | "receipt_indicator"
  | "security_context"
  | "suspicious_authentication"
  | "reply_pattern"
  | "new_conversation";

export interface ImportanceContribution {
  code: ImportanceSignalCode;
  weight: number;
  reason: string;
}

export interface InteractionStats {
  receivedCount?: number;
  repliedByUserCount?: number;
  sentByUserCount?: number;
  lastInteractionAt?: string;
}

export interface ImportanceHistoryContext {
  userAddresses: readonly string[];
  trustedContacts?: readonly string[];
  allowlistedSenders?: readonly string[];
  allowlistedDomains?: readonly string[];
  sender?: InteractionStats;
  domain?: InteractionStats;
  thread?: {
    userParticipated: boolean;
    userSentCount?: number;
    messageCount?: number;
  };
}

export type LlmDecisionReason =
  | "high_confidence_important"
  | "high_confidence_bulk"
  | "semantic_ambiguity"
  | "conflicting_signals"
  | "insufficient_signals";

export interface DeterministicImportanceResult {
  importanceScore: number;
  priority: PriorityBand;
  confidence: number;
  contributions: ImportanceContribution[];
  categoryHints: ClassifierCategory[];
  actionRequiredHint: boolean;
  replyRequiredHint: boolean;
  needsLlm: boolean;
  llmDecisionReason: LlmDecisionReason;
}

const BASE_SCORE = 45;

const DEADLINE_RE =
  /\b(?:deadline|due(?:\s+date)?|respond\s+by|reply\s+by|complete\s+by|expires?|expiration|frist|fällig|faellig|bis\s+(?:zum|spätestens|spaetestens))\b/i;

const MONEY_RE =
  /(?:[$€£¥]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:eur|usd|gbp|chf|cad|aud|jpy)\b)/i;

const ACTION_RE =
  /\b(?:please\s+(?:reply|respond|confirm|approve|review|sign|complete|submit|pay)|action\s+required|response\s+required|confirm(?:ation)?\s+required|approve|review\s+and|sign\s+and|bitte\s+(?:antworten|bestätigen|bestaetigen|prüfen|pruefen|freigeben|bezahlen)|handlungsbedarf)\b/i;

const INVOICE_RE =
  /\b(?:invoice|rechnung|payment\s+due|amount\s+due|zahlungsziel|zahlbar|faktura)\b/i;

const RECEIPT_RE =
  /\b(?:receipt|quittung|payment\s+(?:received|confirmed|confirmation)|order\s+confirmation|bestellbestätigung|bestellbestaetigung|zahlungsbestätigung|zahlungsbestaetigung)\b/i;

const SECURITY_RE =
  /\b(?:security\s+alert|password\s+reset|reset\s+your\s+password|verification\s+code|two[- ]factor|2fa|one[- ]time\s+(?:code|password)|otp|new\s+(?:login|sign[- ]in)|suspicious\s+activity|unusual\s+activity|konto(?:sicherheits|zugriffs)|passwort\s+zurücksetzen|passwort\s+zuruecksetzen|bestätigungscode|bestaetigungscode)\b/i;

function normalizedSet(values: readonly string[] = []): Set<string> {
  return new Set(
    values
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function senderAddress(message: CanonicalMessage): string | undefined {
  return message.from?.address.trim().toLowerCase();
}

function domainOf(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return undefined;
  return address.slice(at + 1).toLowerCase();
}

function headerValues(
  message: CanonicalMessage,
  name: string,
): string[] {
  return message.headers[name.toLowerCase()] ?? [];
}

function hasHeader(message: CanonicalMessage, name: string): boolean {
  return headerValues(message, name).length > 0;
}

function combinedText(message: CanonicalMessage): string {
  return [
    message.subject,
    message.snippet ?? "",
    message.body.text ?? "",
  ]
    .join("\n")
    .slice(0, 100_000);
}

function isReply(message: CanonicalMessage): boolean {
  return (
    /^(?:re|aw|sv):/i.test(message.subject.trim()) ||
    hasHeader(message, "in-reply-to") ||
    hasHeader(message, "references")
  );
}

function isBulkMessage(message: CanonicalMessage): boolean {
  return headerValues(message, "precedence").some((value) =>
    /\b(?:bulk|list|junk)\b/i.test(value),
  );
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function addContribution(
  contributions: ImportanceContribution[],
  code: ImportanceSignalCode,
  weight: number,
  reason: string,
): void {
  contributions.push({ code, weight, reason });
}

function interactionWeight(
  stats: InteractionStats | undefined,
  kind: "sender" | "domain",
): { weight: number; reason: string } | undefined {
  if (!stats) return undefined;
  const received = Math.max(0, stats.receivedCount ?? 0);
  const replies = Math.max(0, stats.repliedByUserCount ?? 0);
  const sent = Math.max(0, stats.sentByUserCount ?? 0);

  if (replies >= 5 || sent >= 5) {
    return {
      weight: kind === "sender" ? 14 : 8,
      reason: `Strong prior ${kind} interaction history`,
    };
  }
  if (replies >= 2 || sent >= 2) {
    return {
      weight: kind === "sender" ? 9 : 5,
      reason: `Repeated prior ${kind} interaction history`,
    };
  }
  if (received >= 10 && replies === 0 && sent === 0) {
    return {
      weight: kind === "sender" ? -5 : -3,
      reason: `Frequent ${kind} messages without user replies`,
    };
  }
  return undefined;
}

function hasConflictingSignals(
  contributions: readonly ImportanceContribution[],
): boolean {
  const positive = contributions
    .filter((item) => item.weight >= 10)
    .reduce((sum, item) => sum + item.weight, 0);
  const negative = contributions
    .filter((item) => item.weight <= -10)
    .reduce((sum, item) => sum + Math.abs(item.weight), 0);
  return positive >= 15 && negative >= 15;
}

function inferCategoryHints(
  text: string,
  message: CanonicalMessage,
): ClassifierCategory[] {
  const hints = new Set<ClassifierCategory>();

  if (INVOICE_RE.test(text)) {
    hints.add("finance");
    hints.add("invoice");
  }
  if (RECEIPT_RE.test(text)) {
    hints.add("receipt");
  }
  if (SECURITY_RE.test(text)) {
    hints.add("security");
  }
  if (
    hasHeader(message, "list-unsubscribe") ||
    hasHeader(message, "list-id")
  ) {
    hints.add("newsletter");
  }
  if (message.authentication.suspicious) {
    hints.add("security");
    hints.add("phishing");
  }

  return [...hints];
}

export function scoreDeterministicImportance(
  message: CanonicalMessage,
  context: ImportanceHistoryContext,
): DeterministicImportanceResult {
  const contributions: ImportanceContribution[] = [];
  const text = combinedText(message);
  const sender = senderAddress(message);
  const senderDomain = domainOf(sender);
  const trustedContacts = normalizedSet(context.trustedContacts);
  const allowlistedSenders = normalizedSet(context.allowlistedSenders);
  const allowlistedDomains = normalizedSet(context.allowlistedDomains);
  const userAddresses = normalizedSet(context.userAddresses);

  if (sender && trustedContacts.has(sender)) {
    addContribution(
      contributions,
      "trusted_contact",
      24,
      "Sender is in trusted contacts",
    );
  }
  if (sender && allowlistedSenders.has(sender)) {
    addContribution(
      contributions,
      "allowlisted_sender",
      22,
      "Sender is explicitly allowlisted",
    );
  }
  if (senderDomain && allowlistedDomains.has(senderDomain)) {
    addContribution(
      contributions,
      "allowlisted_domain",
      15,
      "Sender domain is explicitly allowlisted",
    );
  }

  const senderInteraction = interactionWeight(context.sender, "sender");
  if (senderInteraction) {
    addContribution(
      contributions,
      context.sender && (context.sender.repliedByUserCount ?? 0) > 0
        ? "prior_user_replies"
        : "sender_interaction_history",
      senderInteraction.weight,
      senderInteraction.reason,
    );
  }

  const domainInteraction = interactionWeight(context.domain, "domain");
  if (domainInteraction) {
    addContribution(
      contributions,
      "domain_interaction_history",
      domainInteraction.weight,
      domainInteraction.reason,
    );
  }

  const directRecipient = [...message.to, ...message.cc].some((address) =>
    userAddresses.has(address.address.trim().toLowerCase()),
  );
  if (directRecipient) {
    addContribution(
      contributions,
      "direct_recipient",
      7,
      "Message directly addresses the connected user",
    );
  }

  if (hasHeader(message, "list-id")) {
    addContribution(
      contributions,
      "mailing_list",
      -12,
      "List-Id indicates mailing-list delivery",
    );
  }
  if (hasHeader(message, "list-unsubscribe")) {
    addContribution(
      contributions,
      "list_unsubscribe",
      -14,
      "List-Unsubscribe indicates subscription/bulk mail",
    );
  }
  if (isBulkMessage(message)) {
    addContribution(
      contributions,
      "bulk_precedence",
      -16,
      "Precedence header marks message as bulk/list traffic",
    );
  }

  if (context.thread?.userParticipated) {
    addContribution(
      contributions,
      "thread_participation",
      13,
      "User previously participated in this thread",
    );
  }

  if (DEADLINE_RE.test(text)) {
    addContribution(
      contributions,
      "deadline_language",
      10,
      "Message contains deadline or due-date language",
    );
  }
  if (MONEY_RE.test(text)) {
    addContribution(
      contributions,
      "monetary_amount",
      7,
      "Message contains a monetary amount",
    );
  }
  if (ACTION_RE.test(text)) {
    addContribution(
      contributions,
      "action_language",
      10,
      "Message contains explicit action-request language",
    );
  }
  if (INVOICE_RE.test(text)) {
    addContribution(
      contributions,
      "invoice_indicator",
      12,
      "Message contains invoice/payment-due indicators",
    );
  }
  if (RECEIPT_RE.test(text)) {
    addContribution(
      contributions,
      "receipt_indicator",
      4,
      "Message contains receipt/payment-confirmation indicators",
    );
  }
  if (SECURITY_RE.test(text)) {
    addContribution(
      contributions,
      "security_context",
      18,
      "Message contains account-security or verification context",
    );
  }
  if (
    message.authentication.suspicious ||
    message.authentication.dmarc === "fail" ||
    message.authentication.dkim === "fail"
  ) {
    addContribution(
      contributions,
      "suspicious_authentication",
      8,
      "Authentication signals require elevated attention",
    );
  }

  const reply = isReply(message);
  if (reply) {
    addContribution(
      contributions,
      "reply_pattern",
      context.thread?.userParticipated ? 8 : 3,
      context.thread?.userParticipated
        ? "Reply continues a thread the user participated in"
        : "Message appears to be a reply",
    );
  } else {
    addContribution(
      contributions,
      "new_conversation",
      -2,
      "Message starts a new conversation",
    );
  }

  const score = clampScore(
    BASE_SCORE +
      contributions.reduce((sum, item) => sum + item.weight, 0),
  );

  const strongPositive = contributions.filter(
    (item) => item.weight >= 10,
  ).length;
  const strongNegative = contributions.filter(
    (item) => item.weight <= -10,
  ).length;
  const evidenceStrength = Math.min(
    0.36,
    contributions.reduce(
      (sum, item) => sum + Math.min(Math.abs(item.weight), 15) / 100,
      0,
    ),
  );
  const confidence = clampConfidence(
    0.52 +
      evidenceStrength +
      (strongPositive + strongNegative >= 2 ? 0.06 : 0),
  );

  const conflicting = hasConflictingSignals(contributions);
  const highImportance =
    score >= 85 &&
    confidence >= 0.82 &&
    strongPositive >= 2 &&
    !conflicting;
  const clearBulk =
    score <= 28 &&
    confidence >= 0.82 &&
    strongNegative >= 2 &&
    strongPositive === 0;

  let needsLlm = true;
  let llmDecisionReason: LlmDecisionReason = "semantic_ambiguity";

  if (highImportance) {
    needsLlm = false;
    llmDecisionReason = "high_confidence_important";
  } else if (clearBulk) {
    needsLlm = false;
    llmDecisionReason = "high_confidence_bulk";
  } else if (conflicting) {
    llmDecisionReason = "conflicting_signals";
  } else if (contributions.length <= 2) {
    llmDecisionReason = "insufficient_signals";
  }

  const actionRequiredHint =
    ACTION_RE.test(text) ||
    DEADLINE_RE.test(text) ||
    INVOICE_RE.test(text);
  const replyRequiredHint =
    ACTION_RE.test(text) &&
    /\b(?:reply|respond|antworten|response)\b/i.test(text);

  return {
    importanceScore: score,
    priority: priorityForImportanceScore(score),
    confidence,
    contributions,
    categoryHints: inferCategoryHints(text, message),
    actionRequiredHint,
    replyRequiredHint,
    needsLlm,
    llmDecisionReason,
  };
}
