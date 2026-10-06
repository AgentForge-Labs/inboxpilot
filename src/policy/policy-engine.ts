import { createHash } from "node:crypto";
import {
  ACTION_PLAN_VERSION,
  createActionIdempotencyKey,
  type CanonicalMutation,
  type MailboxActionPlan,
} from "../actions/action-types.js";
import type { ProviderCapabilityName } from "../providers/provider-adapter.js";
import {
  DEFAULT_IMPORTANCE_SETTINGS,
  policyThresholdsFromImportanceSettings,
} from "../settings/importance-settings.js";
import {
  DEFAULT_NEVER_AUTO_DELETE_CATEGORIES,
} from "../safeguards/never-auto-delete.js";
import type {
  PolicyDecision,
  PolicyDecisionReason,
  PolicyEngineInput,
  PolicyOverride,
  PolicyThresholds,
} from "./policy-types.js";

export const DEFAULT_POLICY_THRESHOLDS: Readonly<PolicyThresholds> =
  Object.freeze(
    policyThresholdsFromImportanceSettings(
      DEFAULT_IMPORTANCE_SETTINGS,
    ),
  );

export const DEFAULT_PROTECTED_CATEGORIES =
  DEFAULT_NEVER_AUTO_DELETE_CATEGORIES;

function normalizeAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function senderDomain(address: string | undefined): string | undefined {
  const normalized = normalizeAddress(address);
  if (!normalized) return undefined;
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at >= normalized.length - 1) return undefined;
  return normalized.slice(at + 1);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function resolveThresholds(
  input: PolicyEngineInput,
): PolicyThresholds {
  const base = input.importanceSettings
    ? policyThresholdsFromImportanceSettings(
        input.importanceSettings,
      )
    : DEFAULT_POLICY_THRESHOLDS;
  const value = {
    ...base,
    ...input.thresholds,
  };

  for (const [field, threshold] of [
    ["importantAtOrAbove", value.importantAtOrAbove],
    ["archiveBelow", value.archiveBelow],
    ["trashBelow", value.trashBelow],
  ] as const) {
    if (
      !Number.isInteger(threshold) ||
      threshold < 0 ||
      threshold > 100
    ) {
      throw new RangeError(
        field + " must be an integer between 0 and 100",
      );
    }
  }

  if (
    !Number.isFinite(value.minClassifierConfidence) ||
    value.minClassifierConfidence < 0 ||
    value.minClassifierConfidence > 1
  ) {
    throw new RangeError(
      "minClassifierConfidence must be between 0 and 1",
    );
  }
  if (value.trashBelow > value.archiveBelow) {
    throw new RangeError("trashBelow must be <= archiveBelow");
  }
  if (value.archiveBelow >= value.importantAtOrAbove) {
    throw new RangeError(
      "archiveBelow must be lower than importantAtOrAbove",
    );
  }

  return value;
}

function findOverride(
  input: PolicyEngineInput,
): PolicyOverride | undefined {
  const sender = normalizeAddress(input.message.from?.address);
  const domain = senderDomain(sender);
  const enabled = (input.overrides ?? []).filter(
    (override) => override.enabled,
  );

  if (sender) {
    const senderMatch = enabled.find(
      (override) =>
        override.scope === "sender" &&
        normalizeAddress(override.key) === sender,
    );
    if (senderMatch) return senderMatch;
  }

  if (domain) {
    return enabled.find(
      (override) =>
        override.scope === "domain" &&
        override.key.trim().toLowerCase() === domain,
    );
  }

  return undefined;
}

function capabilityForAction(
  action: CanonicalMutation["type"],
): ProviderCapabilityName {
  switch (action) {
    case "archive":
      return "archive";
    case "trash":
      return "trash";
    case "mark_important":
      return "markImportant";
    case "move":
      return "move";
    case "restore":
      return "restore";
    case "delete_permanent":
      return "deletePermanent";
    case "add_label":
      return "addLabel";
    case "remove_label":
      return "removeLabel";
    case "star":
      return "star";
    case "mark_read":
      return "markRead";
  }
}

function planCapabilityAllows(
  input: PolicyEngineInput,
  action: CanonicalMutation["type"],
): boolean {
  if (action === "mark_important") {
    return input.planCapabilities.automaticMarkImportant;
  }
  if (action === "archive") {
    return input.planCapabilities.automaticArchive;
  }
  if (action === "trash") {
    return input.planCapabilities.automaticTrash;
  }
  return false;
}

function alreadyInTargetState(
  input: PolicyEngineInput,
  action: CanonicalMutation,
): boolean {
  const message = input.message;
  if (action.type === "mark_important") {
    return message.flags.important === action.value;
  }
  if (action.type === "archive") {
    return (
      message.retention.stage === "archived" ||
      message.mailboxes.some((mailbox) => mailbox.role === "archive")
    );
  }
  if (action.type === "trash") {
    return (
      message.retention.stage === "pending_trash" ||
      message.retention.stage === "trashed" ||
      message.retention.stage === "pending_delete" ||
      message.retention.stage === "deleted" ||
      message.mailboxes.some((mailbox) => mailbox.role === "trash")
    );
  }
  return false;
}

function planIdFor(
  input: PolicyEngineInput,
  action: CanonicalMutation,
  effectiveScore: number,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        policyId: input.policyId,
        messageId: input.message.id,
        providerMessageId: input.message.provider.messageId,
        updatedAt: input.message.updatedAt,
        action,
        effectiveScore,
        classificationConfidence: input.classification.confidence,
      }),
    )
    .digest("hex")
    .slice(0, 32);

  return "policy_" + digest;
}

function buildPlan(
  input: PolicyEngineInput,
  action: CanonicalMutation,
  effectiveScore: number,
  reason: string,
): MailboxActionPlan {
  const planId = planIdFor(input, action, effectiveScore);
  const partial = {
    schemaVersion: ACTION_PLAN_VERSION,
    planId,
    source: "policy_engine" as const,
    tenantId: input.message.tenantId,
    accountId: input.message.accountId,
    provider: input.message.provider.kind,
    providerMessageId: input.message.provider.messageId,
    action,
  };

  return {
    ...partial,
    idempotencyKey: createActionIdempotencyKey(partial),
    preconditions: {
      expectedCanonicalMessageId: input.message.id,
      expectedUpdatedAt: input.message.updatedAt,
      ...(action.type === "archive" || action.type === "trash"
        ? { requireUnprotected: true }
        : {}),
    },
    ...(action.type === "trash"
      ? {
          destructiveAuthorization: {
            policyId: input.policyId,
            reason,
          },
        }
      : {}),
  };
}

function noPlan(
  outcome: PolicyDecision["outcome"],
  effectiveImportanceScore: number,
  protectedValue: boolean,
  reasons: PolicyDecisionReason[],
  matchedOverride?: PolicyOverride,
): PolicyDecision {
  return {
    outcome,
    effectiveImportanceScore,
    protected: protectedValue,
    reasons,
    ...(matchedOverride ? { matchedOverride } : {}),
  };
}

function actionDecision(
  input: PolicyEngineInput,
  action: Extract<
    CanonicalMutation,
    { type: "archive" | "trash" | "mark_important" }
  >,
  effectiveScore: number,
  protectedValue: boolean,
  reasons: PolicyDecisionReason[],
  matchedOverride?: PolicyOverride,
): PolicyDecision {
  if (!planCapabilityAllows(input, action.type)) {
    return noPlan(
      "blocked",
      effectiveScore,
      protectedValue,
      [...reasons, "plan_capability_missing"],
      matchedOverride,
    );
  }

  const providerCapability = capabilityForAction(action.type);
  if (!input.providerCapabilities[providerCapability]) {
    return noPlan(
      "blocked",
      effectiveScore,
      protectedValue,
      [...reasons, "provider_capability_missing"],
      matchedOverride,
    );
  }

  if (alreadyInTargetState(input, action)) {
    return noPlan(
      "no_action",
      effectiveScore,
      protectedValue,
      [...reasons, "already_in_target_state"],
      matchedOverride,
    );
  }

  return {
    outcome: "planned",
    effectiveImportanceScore: effectiveScore,
    protected: protectedValue,
    reasons,
    ...(matchedOverride ? { matchedOverride } : {}),
    plan: buildPlan(
      input,
      action,
      effectiveScore,
      reasons.join(", "),
    ),
  };
}

export class MailboxPolicyEngine {
  evaluate(input: PolicyEngineInput): PolicyDecision {
    if (!input.policyId.trim()) {
      throw new TypeError("policyId is required");
    }

    const thresholds = resolveThresholds(input);
    const effectiveScore = clampScore(
      input.classification.importanceScore +
        (input.personal?.importanceDelta ?? 0),
    );

    if (
      input.message.retention.stage === "deleted" ||
      input.message.retention.stage === "pending_delete"
    ) {
      return noPlan(
        "blocked",
        effectiveScore,
        true,
        ["message_already_terminal"],
      );
    }

    const protectedCategories = new Set<string>(
      input.protectedCategories ?? DEFAULT_PROTECTED_CATEGORIES,
    );
    const categoryProtected =
      (input.protectedCategories !== undefined ||
        input.neverAutoDelete === undefined) &&
      input.classification.categories.some((category) =>
        protectedCategories.has(category),
      );
    const safeguardProtected =
      input.neverAutoDelete?.protected ?? false;
    const retentionProtected =
      input.message.retention.protected ||
      input.classification.retention.protected;
    const hardProtected =
      retentionProtected ||
      safeguardProtected ||
      categoryProtected;
    const matchedOverride = findOverride(input);

    if (hardProtected) {
      const safetyReason: PolicyDecisionReason =
        retentionProtected
          ? "retention_protected"
          : safeguardProtected
            ? "never_auto_delete_safeguard"
            : "protected_category";

      if (
        effectiveScore >= thresholds.importantAtOrAbove &&
        !input.message.flags.important
      ) {
        return actionDecision(
          input,
          { type: "mark_important", value: true },
          effectiveScore,
          true,
          [safetyReason, "important_threshold"],
          matchedOverride,
        );
      }

      return noPlan(
        "blocked",
        effectiveScore,
        true,
        [safetyReason],
        matchedOverride,
      );
    }

    if (matchedOverride?.action === "protect") {
      return noPlan(
        "blocked",
        effectiveScore,
        true,
        ["override_protect"],
        matchedOverride,
      );
    }

    if (matchedOverride?.action === "keep") {
      return noPlan(
        "no_action",
        effectiveScore,
        false,
        ["override_keep"],
        matchedOverride,
      );
    }

    if (matchedOverride?.action === "mark_important") {
      return actionDecision(
        input,
        { type: "mark_important", value: true },
        effectiveScore,
        false,
        ["override_mark_important"],
        matchedOverride,
      );
    }

    if (matchedOverride?.action === "archive") {
      return actionDecision(
        input,
        { type: "archive" },
        effectiveScore,
        false,
        ["override_archive"],
        matchedOverride,
      );
    }

    if (matchedOverride?.action === "trash") {
      return actionDecision(
        input,
        { type: "trash" },
        effectiveScore,
        false,
        ["override_trash"],
        matchedOverride,
      );
    }

    if (input.personal?.neverDelete) {
      if (
        input.personal.alwaysArchive &&
        !input.personal.avoidArchive
      ) {
        return actionDecision(
          input,
          { type: "archive" },
          effectiveScore,
          true,
          ["personal_never_delete", "personal_always_archive"],
        );
      }
      return noPlan(
        "no_action",
        effectiveScore,
        true,
        ["personal_never_delete"],
      );
    }

    if (
      input.personal?.alwaysArchive &&
      !input.personal.avoidArchive
    ) {
      return actionDecision(
        input,
        { type: "archive" },
        effectiveScore,
        false,
        ["personal_always_archive"],
      );
    }

    if (
      input.classification.recommendedAction === "needs_review"
    ) {
      return noPlan(
        "needs_review",
        effectiveScore,
        false,
        ["classifier_requests_review"],
      );
    }

    if (
      input.classification.confidence <
      thresholds.minClassifierConfidence
    ) {
      return noPlan(
        "needs_review",
        effectiveScore,
        false,
        ["low_classifier_confidence"],
      );
    }

    if (
      effectiveScore >= thresholds.importantAtOrAbove ||
      input.classification.recommendedAction === "mark_important"
    ) {
      return actionDecision(
        input,
        { type: "mark_important", value: true },
        effectiveScore,
        false,
        [
          effectiveScore >= thresholds.importantAtOrAbove
            ? "important_threshold"
            : "classifier_recommendation",
        ],
      );
    }

    const trashRecommended =
      input.classification.recommendedAction === "trash" ||
      input.classification.retention.disposition === "trash_later";

    if (
      effectiveScore <= thresholds.trashBelow &&
      trashRecommended &&
      !input.personal?.avoidTrash
    ) {
      if (
        input.planCapabilities.automaticTrash &&
        input.providerCapabilities.trash
      ) {
        return actionDecision(
          input,
          { type: "trash" },
          effectiveScore,
          false,
          ["trash_threshold", "classifier_recommendation"],
        );
      }

      if (
        input.planCapabilities.automaticArchive &&
        input.providerCapabilities.archive &&
        !input.personal?.avoidArchive
      ) {
        return actionDecision(
          input,
          { type: "archive" },
          effectiveScore,
          false,
          [
            "trash_threshold",
            "classifier_recommendation",
            "safe_archive_fallback",
          ],
        );
      }
    }

    const archiveRecommended =
      input.classification.recommendedAction === "archive" ||
      input.classification.recommendedAction === "trash" ||
      input.classification.retention.disposition === "archive" ||
      input.classification.retention.disposition === "trash_later";

    if (
      effectiveScore <= thresholds.archiveBelow &&
      archiveRecommended
    ) {
      if (input.personal?.avoidArchive) {
        return noPlan(
          "no_action",
          effectiveScore,
          false,
          ["personal_avoid_archive"],
        );
      }

      return actionDecision(
        input,
        { type: "archive" },
        effectiveScore,
        false,
        ["archive_threshold", "classifier_recommendation"],
      );
    }

    if (
      effectiveScore <= thresholds.trashBelow &&
      input.personal?.avoidTrash
    ) {
      return noPlan(
        "no_action",
        effectiveScore,
        false,
        ["personal_avoid_trash"],
      );
    }

    return noPlan(
      "no_action",
      effectiveScore,
      false,
      ["no_policy_action"],
    );
  }
}
