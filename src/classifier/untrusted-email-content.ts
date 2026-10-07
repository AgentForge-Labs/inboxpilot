import type {
  CanonicalMessage,
} from "../domain/email-model.js";

export const UNTRUSTED_EMAIL_BOUNDARY_VERSION = 1 as const;

export const PROMPT_INJECTION_SIGNAL_CODES = [
  "instruction_override",
  "role_spoofing",
  "tool_or_function_request",
  "secret_exfiltration_request",
  "quoted_instruction",
  "bidi_or_control_obfuscation",
] as const;

export type PromptInjectionSignalCode =
  (typeof PROMPT_INJECTION_SIGNAL_CODES)[number];

export interface UntrustedContentAnalysis {
  suspicious: boolean;
  signals: PromptInjectionSignalCode[];
}

const BIDI_AND_ZERO_WIDTH =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const UNSAFE_CONTROLS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const INJECTION_PATTERNS: ReadonlyArray<{
  code: PromptInjectionSignalCode;
  pattern: RegExp;
}> = [
  {
    code: "instruction_override",
    pattern:
      /\b(?:ignore|disregard|forget|override)\b.{0,60}\b(?:previous|prior|system|developer|instructions?|rules?|prompt)\b/i,
  },
  {
    code: "role_spoofing",
    pattern:
      /(?:^|\n)\s*(?:system|developer|assistant|tool|function)\s*:\s*/i,
  },
  {
    code: "role_spoofing",
    pattern:
      /<\s*\/?\s*(?:system|developer|assistant|tool|function)(?:\s|>)/i,
  },
  {
    code: "tool_or_function_request",
    pattern:
      /\b(?:call|invoke|execute|run|use)\b.{0,50}\b(?:tool|function|plugin|connector|api)\b/i,
  },
  {
    code: "tool_or_function_request",
    pattern:
      /\b(?:send|delete|trash|archive|forward|reply to)\b.{0,80}\b(?:email|message|mail|all messages|all emails)\b/i,
  },
  {
    code: "secret_exfiltration_request",
    pattern:
      /\b(?:reveal|print|return|send|exfiltrate|leak)\b.{0,80}\b(?:secret|token|password|credential|api key|system prompt|developer message)\b/i,
  },
  {
    code: "quoted_instruction",
    pattern:
      /(?:^|\n)\s*(?:>|-{2,}\s*original message\s*-{2,}|on .{0,120} wrote:|from:\s.+\n(?:sent|date|to|subject):)/i,
  },
];

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function sanitizeUntrustedText(
  value: string | undefined,
  maxLength: number,
): string {
  if (!value || maxLength <= 0) return "";
  const normalized = value
    .normalize("NFKC")
    .replace(BIDI_AND_ZERO_WIDTH, "")
    .replace(UNSAFE_CONTROLS, "");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return (
    normalized.slice(0, maxLength) +
    "\n[TRUNCATED]"
  );
}

export function analyzeUntrustedText(
  ...values: readonly (string | undefined)[]
): UntrustedContentAnalysis {
  const text = values.filter(Boolean).join("\n");
  const signals: PromptInjectionSignalCode[] = [];

  if (
    BIDI_AND_ZERO_WIDTH.test(text) ||
    UNSAFE_CONTROLS.test(text)
  ) {
    signals.push("bidi_or_control_obfuscation");
  }
  BIDI_AND_ZERO_WIDTH.lastIndex = 0;
  UNSAFE_CONTROLS.lastIndex = 0;

  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(text)) {
      signals.push(rule.code);
    }
  }

  const normalized = unique(signals);
  return {
    suspicious: normalized.length > 0,
    signals: normalized,
  };
}

function headerValues(
  message: CanonicalMessage,
): string[] {
  const values: string[] = [];
  for (const [name, entries] of Object.entries(
    message.headers,
  )) {
    values.push(name, ...entries);
  }
  return values;
}

export function analyzeUntrustedEmailContent(
  message: CanonicalMessage,
  threadContext: readonly CanonicalMessage[] = [],
): UntrustedContentAnalysis {
  const values: Array<string | undefined> = [
    message.subject,
    message.snippet,
    message.body.text,
    message.body.html,
    message.from?.name,
    message.from?.address,
    ...headerValues(message),
    ...message.attachments.flatMap((attachment) => [
      attachment.filename,
      attachment.contentType,
      attachment.contentId,
    ]),
  ];

  for (const item of threadContext.slice(-8)) {
    values.push(
      item.subject,
      item.snippet,
      item.body.text,
      item.body.html,
      item.from?.name,
      item.from?.address,
      ...headerValues(item),
      ...item.attachments.flatMap((attachment) => [
        attachment.filename,
        attachment.contentType,
        attachment.contentId,
      ]),
    );
  }

  return analyzeUntrustedText(...values);
}

export function looksLikeQuotedOrInjectedToolCommand(
  command: string,
): UntrustedContentAnalysis {
  const analysis = analyzeUntrustedText(command);
  const hardSignals = analysis.signals.filter(
    (signal) => signal !== "tool_or_function_request",
  );
  return {
    suspicious: hardSignals.length > 0,
    signals: analysis.signals,
  };
}
