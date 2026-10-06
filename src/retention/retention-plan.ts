import { createHash } from "node:crypto";
import {
  ACTION_PLAN_VERSION,
  createActionIdempotencyKey,
  type CanonicalMutation,
  type MailboxActionPlan,
} from "../actions/action-types.js";
import type { CanonicalMessage } from "../domain/email-model.js";
import type {
  RetentionJob,
  RetentionNextAction,
} from "./retention-types.js";

function actionFor(
  nextAction: RetentionNextAction,
): CanonicalMutation {
  if (nextAction === "archive") return { type: "archive" };
  if (nextAction === "trash") return { type: "trash" };
  return { type: "delete_permanent" };
}

export function buildRetentionActionPlan(
  job: RetentionJob,
  message: CanonicalMessage,
  reason: string,
): MailboxActionPlan {
  if (!job.nextAction) {
    throw new TypeError("Retention job has no next action");
  }

  const action = actionFor(job.nextAction);
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        jobId: job.id,
        version: job.version,
        action,
        providerMessageId: job.providerMessageId,
        retentionStage: message.retention.stage,
        lastTransitionAt: message.retention.lastTransitionAt ?? null,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  const planId = "retention_" + digest;
  const partial = {
    schemaVersion: ACTION_PLAN_VERSION,
    planId,
    source: "system_retention" as const,
    tenantId: job.tenantId,
    accountId: job.accountId,
    provider: job.provider,
    providerMessageId: job.providerMessageId,
    action,
  };

  return {
    ...partial,
    idempotencyKey: createActionIdempotencyKey(partial),
    preconditions: {
      expectedCanonicalMessageId: job.canonicalMessageId,
      ...(action.type === "trash" ||
      action.type === "delete_permanent"
        ? { requireUnprotected: true }
        : {}),
      ...(action.type === "delete_permanent"
        ? { requiredMailboxRole: "trash" as const }
        : {}),
    },
    ...(action.type === "trash" ||
    action.type === "delete_permanent"
      ? {
          destructiveAuthorization: {
            policyId: job.policyId,
            reason,
          },
        }
      : {}),
  };
}
