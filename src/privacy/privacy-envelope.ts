import { createHash } from "node:crypto";
import {
  CLASSIFIER_CATEGORIES,
} from "../classifier/classifier-contract.js";
import type {
  SemanticClassificationResult,
} from "../classifier/semantic-types.js";
import type {
  CanonicalMessage,
  ClassificationState,
  PriorityBand,
} from "../domain/email-model.js";
import {
  PRIVACY_MODE_ENVELOPE_VERSION,
  type PrivacyCloudClassification,
  type PrivacyCloudClassificationEnvelope,
  type PrivacyClassificationStatus,
} from "./privacy-mode-types.js";

const TOP_LEVEL_FIELDS = new Set([
  "envelopeVersion",
  "mode",
  "tenantId",
  "accountId",
  "cloudMessageId",
  "receivedAt",
  "classification",
]);

const CLASSIFICATION_FIELDS = new Set([
  "status",
  "importanceScore",
  "priority",
  "categories",
  "confidence",
  "actionRequired",
  "replyRequired",
  "riskScore",
  "classifiedAt",
]);

const PRIORITIES = new Set<PriorityBand>([
  "critical",
  "important",
  "normal",
  "low",
  "very_low",
  "disposable",
]);

const STATUSES = new Set<PrivacyClassificationStatus>([
  "classified",
  "needs_review",
  "failed",
]);

const CATEGORIES = new Set<string>(
  CLASSIFIER_CATEGORIES,
);

export class PrivacyBoundaryViolationError extends Error {
  readonly code = "PRIVACY_BOUNDARY_VIOLATION";

  constructor(message: string) {
    super(message);
    this.name = "PrivacyBoundaryViolationError";
  }
}

function objectValue(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new PrivacyBoundaryViolationError(
      field + " must be an object",
    );
  }
  return value as Record<string, unknown>;
}

function noUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PrivacyBoundaryViolationError(
        field + ' contains forbidden or unknown field "' + key + '"',
      );
    }
  }
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PrivacyBoundaryViolationError(
      field + " must be a non-empty string",
    );
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new PrivacyBoundaryViolationError(
      field + " exceeds maximum length",
    );
  }
  return normalized;
}

function isoTimestamp(
  value: unknown,
  field: string,
): string {
  const normalized = requiredString(value, field, 64);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new PrivacyBoundaryViolationError(
      field + " must be an ISO-compatible timestamp",
    );
  }
  return normalized;
}

function score(
  value: unknown,
  field: string,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new PrivacyBoundaryViolationError(
      field + " must be between 0 and 100",
    );
  }
  return value;
}

function confidence(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new PrivacyBoundaryViolationError(
      "classification.confidence must be between 0 and 1",
    );
  }
  return value;
}

function booleanValue(
  value: unknown,
  field: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new PrivacyBoundaryViolationError(
      field + " must be boolean",
    );
  }
  return value;
}

function classificationStateForPrivacy(
  result: SemanticClassificationResult,
  now: string,
): ClassificationState {
  if (result.classification) {
    return result.classification;
  }

  return {
    status: result.needsReview
      ? "needs_review"
      : "classified",
    importanceScore:
      result.deterministic.importanceScore,
    priority: result.deterministic.priority,
    categories: [
      ...result.deterministic.categoryHints,
    ],
    confidence: result.deterministic.confidence,
    actionRequired:
      result.deterministic.actionRequiredHint,
    replyRequired:
      result.deterministic.replyRequiredHint,
    classifiedAt: now,
  };
}

export function privacyCloudMessageId(
  message: Pick<
    CanonicalMessage,
    "tenantId" | "accountId" | "id"
  >,
): string {
  return (
    "priv_" +
    createHash("sha256")
      .update(
        [
          "inboxpilot-privacy-v1",
          message.tenantId,
          message.accountId,
          message.id,
        ].join("\u0000"),
      )
      .digest("hex")
  );
}

export function projectPrivacyCloudEnvelope(
  message: CanonicalMessage,
  result: SemanticClassificationResult,
  now: () => Date = () => new Date(),
): PrivacyCloudClassificationEnvelope {
  const classifiedAt = now().toISOString();
  const source = classificationStateForPrivacy(
    result,
    classifiedAt,
  );

  const status: PrivacyClassificationStatus =
    source.status === "failed"
      ? "failed"
      : source.status === "needs_review"
        ? "needs_review"
        : "classified";

  const candidate: PrivacyCloudClassificationEnvelope = {
    envelopeVersion:
      PRIVACY_MODE_ENVELOPE_VERSION,
    mode: "local_self_hosted",
    tenantId: message.tenantId,
    accountId: message.accountId,
    cloudMessageId: privacyCloudMessageId(message),
    receivedAt: message.receivedAt,
    classification: {
      status,
      importanceScore:
        source.importanceScore ??
        result.deterministic.importanceScore,
      priority:
        source.priority ??
        result.deterministic.priority,
      categories: [...source.categories],
      confidence:
        source.confidence ??
        result.deterministic.confidence,
      actionRequired:
        source.actionRequired === true,
      replyRequired:
        source.replyRequired === true,
      ...(source.riskScore !== undefined
        ? { riskScore: source.riskScore }
        : {}),
      classifiedAt:
        source.classifiedAt ?? classifiedAt,
    },
  };

  return parsePrivacyCloudEnvelope(candidate);
}

export function parsePrivacyCloudEnvelope(
  value: unknown,
): PrivacyCloudClassificationEnvelope {
  const root = objectValue(
    value,
    "privacy envelope",
  );
  noUnknownFields(
    root,
    TOP_LEVEL_FIELDS,
    "privacy envelope",
  );

  if (
    root.envelopeVersion !==
    PRIVACY_MODE_ENVELOPE_VERSION
  ) {
    throw new PrivacyBoundaryViolationError(
      "Unsupported privacy envelope version",
    );
  }
  if (root.mode !== "local_self_hosted") {
    throw new PrivacyBoundaryViolationError(
      "privacy envelope mode must be local_self_hosted",
    );
  }

  const tenantId = requiredString(
    root.tenantId,
    "tenantId",
    160,
  );
  const accountId = requiredString(
    root.accountId,
    "accountId",
    160,
  );
  const cloudMessageId = requiredString(
    root.cloudMessageId,
    "cloudMessageId",
    80,
  );
  if (!/^priv_[0-9a-f]{64}$/.test(cloudMessageId)) {
    throw new PrivacyBoundaryViolationError(
      "cloudMessageId must be an opaque privacy identifier",
    );
  }

  const rawClassification = objectValue(
    root.classification,
    "classification",
  );
  noUnknownFields(
    rawClassification,
    CLASSIFICATION_FIELDS,
    "classification",
  );

  const rawStatus = requiredString(
    rawClassification.status,
    "classification.status",
    32,
  );
  if (!STATUSES.has(rawStatus as PrivacyClassificationStatus)) {
    throw new PrivacyBoundaryViolationError(
      "classification.status is invalid",
    );
  }

  const rawPriority = requiredString(
    rawClassification.priority,
    "classification.priority",
    32,
  );
  if (!PRIORITIES.has(rawPriority as PriorityBand)) {
    throw new PrivacyBoundaryViolationError(
      "classification.priority is invalid",
    );
  }

  if (!Array.isArray(rawClassification.categories)) {
    throw new PrivacyBoundaryViolationError(
      "classification.categories must be an array",
    );
  }
  if (rawClassification.categories.length > 20) {
    throw new PrivacyBoundaryViolationError(
      "classification.categories contains too many values",
    );
  }
  const categories: string[] = [];
  for (const entry of rawClassification.categories) {
    if (
      typeof entry !== "string" ||
      !CATEGORIES.has(entry)
    ) {
      throw new PrivacyBoundaryViolationError(
        "classification.categories contains an unknown category",
      );
    }
    if (categories.includes(entry)) {
      throw new PrivacyBoundaryViolationError(
        "classification.categories contains duplicates",
      );
    }
    categories.push(entry);
  }

  const parsedClassification: PrivacyCloudClassification = {
    status: rawStatus as PrivacyClassificationStatus,
    importanceScore: score(
      rawClassification.importanceScore,
      "classification.importanceScore",
    ),
    priority: rawPriority as PriorityBand,
    categories,
    confidence: confidence(
      rawClassification.confidence,
    ),
    actionRequired: booleanValue(
      rawClassification.actionRequired,
      "classification.actionRequired",
    ),
    replyRequired: booleanValue(
      rawClassification.replyRequired,
      "classification.replyRequired",
    ),
    ...(rawClassification.riskScore !== undefined
      ? {
          riskScore: score(
            rawClassification.riskScore,
            "classification.riskScore",
          ),
        }
      : {}),
    classifiedAt: isoTimestamp(
      rawClassification.classifiedAt,
      "classification.classifiedAt",
    ),
  };

  return {
    envelopeVersion:
      PRIVACY_MODE_ENVELOPE_VERSION,
    mode: "local_self_hosted",
    tenantId,
    accountId,
    cloudMessageId,
    receivedAt: isoTimestamp(
      root.receivedAt,
      "receivedAt",
    ),
    classification: parsedClassification,
  };
}
