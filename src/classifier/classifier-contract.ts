import type {
  ClassificationState,
  PriorityBand,
} from "../domain/email-model.js";
import {
  DEFAULT_IMPORTANCE_SETTINGS,
  priorityForScoreWithSettings,
  type ImportanceSettings,
} from "../settings/importance-settings.js";

export const CLASSIFIER_CONTRACT_VERSION = 1 as const;

export const CLASSIFIER_CATEGORIES = [
  "personal",
  "work",
  "customer",
  "finance",
  "invoice",
  "receipt",
  "security",
  "legal",
  "government",
  "appointment",
  "travel",
  "shopping",
  "delivery",
  "newsletter",
  "promotion",
  "social",
  "notification",
  "system",
  "spam",
  "phishing",
] as const;

export type ClassifierCategory =
  (typeof CLASSIFIER_CATEGORIES)[number];

export const RECOMMENDED_ACTIONS = [
  "keep_in_inbox",
  "mark_important",
  "archive",
  "trash",
  "needs_review",
] as const;

export type RecommendedAction =
  (typeof RECOMMENDED_ACTIONS)[number];

export const RETENTION_DISPOSITIONS = [
  "keep",
  "archive",
  "trash_later",
  "protect",
] as const;

export type RetentionDisposition =
  (typeof RETENTION_DISPOSITIONS)[number];

export interface ClassifierRetentionRecommendation {
  disposition: RetentionDisposition;
  protected: boolean;
  protectionReasons: string[];
  archiveAfterDays?: number;
  trashAfterDays?: number;
}

export interface CanonicalClassifierResult {
  contractVersion: typeof CLASSIFIER_CONTRACT_VERSION;
  importanceScore: number;
  priority: PriorityBand;
  categories: ClassifierCategory[];
  actionRequired: boolean;
  replyRequired: boolean;
  spamRisk: number;
  phishingRisk: number;
  confidence: number;
  recommendedAction: RecommendedAction;
  retention: ClassifierRetentionRecommendation;
  reason: string;
  modelVersion?: string;
}

const CATEGORY_SET = new Set<string>(CLASSIFIER_CATEGORIES);
const ACTION_SET = new Set<string>(RECOMMENDED_ACTIONS);
const RETENTION_SET = new Set<string>(RETENTION_DISPOSITIONS);

const TOP_LEVEL_FIELDS = new Set([
  "contractVersion",
  "importanceScore",
  "priority",
  "categories",
  "actionRequired",
  "replyRequired",
  "spamRisk",
  "phishingRisk",
  "confidence",
  "recommendedAction",
  "retention",
  "reason",
  "modelVersion",
]);

const RETENTION_FIELDS = new Set([
  "disposition",
  "protected",
  "protectionReasons",
  "archiveAfterDays",
  "trashAfterDays",
]);

const FORBIDDEN_EXECUTABLE_OUTPUT_FIELDS = new Set([
  "toolCall",
  "toolCalls",
  "tool_calls",
  "functionCall",
  "function_call",
  "arguments",
  "command",
  "commands",
  "shell",
  "script",
  "code",
  "url",
  "endpoint",
  "httpRequest",
  "request",
  "headers",
  "authorization",
  "recipients",
  "to",
  "cc",
  "bcc",
  "messageBody",
  "body",
  "__proto__",
  "prototype",
  "constructor",
]);

function assertNoExecutableOutputFields(
  value: unknown,
  path = "classifier result",
  depth = 0,
): void {
  if (depth > 10) {
    throw new TypeError(
      "classifier result exceeds maximum structured depth",
    );
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoExecutableOutputFields(
        entry,
        path + "[" + index + "]",
        depth + 1,
      ),
    );
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (FORBIDDEN_EXECUTABLE_OUTPUT_FIELDS.has(key)) {
      throw new TypeError(
        path +
          ' contains forbidden executable field "' +
          key +
          '"',
      );
    }
    assertNoExecutableOutputFields(
      entry,
      path + "." + key,
      depth + 1,
    );
  }
}

function assertObject(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertNoUnknownFields(
  value: Record<string, unknown>,
  allowed: Set<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${field} contains unknown field "${key}"`);
    }
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength = 2000,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new RangeError(`${field} is too long`);
  }
  return normalized;
}

function integerScore(
  value: unknown,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new RangeError(`${field} must be an integer between 0 and 100`);
  }
  return value;
}

function confidenceScore(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new RangeError("confidence must be between 0 and 1");
  }
  return value;
}

function booleanField(
  value: unknown,
  field: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be boolean`);
  }
  return value;
}

function optionalDays(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 36500
  ) {
    throw new RangeError(
      `${field} must be an integer between 0 and 36500`,
    );
  }
  return value;
}

export function priorityForImportanceScore(
  score: number,
  settings: ImportanceSettings = DEFAULT_IMPORTANCE_SETTINGS,
): PriorityBand {
  integerScore(score, "importanceScore");
  return priorityForScoreWithSettings(score, settings);
}

function parseCategories(value: unknown): ClassifierCategory[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("categories must contain at least one category");
  }
  if (value.length > CLASSIFIER_CATEGORIES.length) {
    throw new RangeError("categories contains too many values");
  }

  const result: ClassifierCategory[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !CATEGORY_SET.has(entry)) {
      throw new TypeError(`Unknown classifier category "${String(entry)}"`);
    }
    if (seen.has(entry)) {
      throw new TypeError(`Duplicate classifier category "${entry}"`);
    }
    seen.add(entry);
    result.push(entry as ClassifierCategory);
  }
  return result;
}

function parseRetention(
  value: unknown,
): ClassifierRetentionRecommendation {
  assertObject(value, "retention");
  assertNoUnknownFields(value, RETENTION_FIELDS, "retention");

  const disposition = requiredString(
    value.disposition,
    "retention.disposition",
    64,
  );
  if (!RETENTION_SET.has(disposition)) {
    throw new TypeError(
      `Unknown retention disposition "${disposition}"`,
    );
  }

  const protectedValue = booleanField(
    value.protected,
    "retention.protected",
  );

  if (!Array.isArray(value.protectionReasons)) {
    throw new TypeError(
      "retention.protectionReasons must be an array",
    );
  }
  const protectionReasons = value.protectionReasons.map(
    (reason, index) =>
      requiredString(
        reason,
        `retention.protectionReasons[${index}]`,
        200,
      ),
  );

  if (new Set(protectionReasons).size !== protectionReasons.length) {
    throw new TypeError(
      "retention.protectionReasons must not contain duplicates",
    );
  }

  const archiveAfterDays = optionalDays(
    value.archiveAfterDays,
    "retention.archiveAfterDays",
  );
  const trashAfterDays = optionalDays(
    value.trashAfterDays,
    "retention.trashAfterDays",
  );

  if (disposition === "protect" && !protectedValue) {
    throw new TypeError(
      'retention disposition "protect" requires protected=true',
    );
  }
  if (protectedValue && protectionReasons.length === 0) {
    throw new TypeError(
      "protected retention requires at least one protection reason",
    );
  }
  if (disposition === "trash_later" && trashAfterDays === undefined) {
    throw new TypeError(
      'retention disposition "trash_later" requires trashAfterDays',
    );
  }
  if (
    disposition !== "trash_later" &&
    trashAfterDays !== undefined
  ) {
    throw new TypeError(
      "trashAfterDays is only valid for trash_later disposition",
    );
  }
  if (
    disposition !== "archive" &&
    archiveAfterDays !== undefined
  ) {
    throw new TypeError(
      "archiveAfterDays is only valid for archive disposition",
    );
  }

  return {
    disposition: disposition as RetentionDisposition,
    protected: protectedValue,
    protectionReasons,
    ...(archiveAfterDays !== undefined ? { archiveAfterDays } : {}),
    ...(trashAfterDays !== undefined ? { trashAfterDays } : {}),
  };
}

export function parseClassifierResult(
  input: unknown,
): CanonicalClassifierResult {
  assertObject(input, "classifier result");
  assertNoExecutableOutputFields(input);
  assertNoUnknownFields(
    input,
    TOP_LEVEL_FIELDS,
    "classifier result",
  );

  if (input.contractVersion !== CLASSIFIER_CONTRACT_VERSION) {
    throw new TypeError(
      `Unsupported classifier contract version: ${String(
        input.contractVersion,
      )}`,
    );
  }

  const importanceScore = integerScore(
    input.importanceScore,
    "importanceScore",
  );
  const priority = requiredString(
    input.priority,
    "priority",
    32,
  ) as PriorityBand;
  const expectedPriority =
    priorityForImportanceScore(importanceScore);
  if (priority !== expectedPriority) {
    throw new TypeError(
      `priority "${priority}" does not match importanceScore ${importanceScore}; expected "${expectedPriority}"`,
    );
  }

  const recommendedAction = requiredString(
    input.recommendedAction,
    "recommendedAction",
    64,
  );
  if (!ACTION_SET.has(recommendedAction)) {
    throw new TypeError(
      `Unknown recommended action "${recommendedAction}"`,
    );
  }

  const modelVersion =
    input.modelVersion === undefined
      ? undefined
      : requiredString(input.modelVersion, "modelVersion", 200);

  return {
    contractVersion: CLASSIFIER_CONTRACT_VERSION,
    importanceScore,
    priority,
    categories: parseCategories(input.categories),
    actionRequired: booleanField(
      input.actionRequired,
      "actionRequired",
    ),
    replyRequired: booleanField(
      input.replyRequired,
      "replyRequired",
    ),
    spamRisk: integerScore(input.spamRisk, "spamRisk"),
    phishingRisk: integerScore(
      input.phishingRisk,
      "phishingRisk",
    ),
    confidence: confidenceScore(input.confidence),
    recommendedAction: recommendedAction as RecommendedAction,
    retention: parseRetention(input.retention),
    reason: requiredString(input.reason, "reason"),
    ...(modelVersion ? { modelVersion } : {}),
  };
}

export function classifierResultToClassificationState(
  result: CanonicalClassifierResult,
  classifiedAt = new Date().toISOString(),
): ClassificationState {
  if (Number.isNaN(Date.parse(classifiedAt))) {
    throw new TypeError(
      "classifiedAt must be an ISO-compatible timestamp",
    );
  }

  return {
    status: "classified",
    ...(result.modelVersion
      ? { modelVersion: result.modelVersion }
      : {}),
    importanceScore: result.importanceScore,
    priority: result.priority,
    categories: [...result.categories],
    confidence: result.confidence,
    actionRequired: result.actionRequired,
    replyRequired: result.replyRequired,
    riskScore: Math.max(result.spamRisk, result.phishingRisk),
    reason: result.reason,
    classifiedAt: new Date(classifiedAt).toISOString(),
  };
}
