import { createHash } from "node:crypto";
import {
  ACTION_PLAN_VERSION,
  createActionIdempotencyKey,
  type MailboxActionPlan,
} from "../actions/action-types.js";
import type { CanonicalMessage } from "../domain/email-model.js";
import {
  PersonalLearningEngine,
} from "../learning/personal-learning-engine.js";
import {
  RetentionScheduler,
} from "../retention/retention-scheduler.js";
import type {
  RetentionActionExecutor,
  RetentionJob,
  RetentionJobStore,
  RetentionMessageRepository,
} from "../retention/retention-types.js";
import type {
  PendingDeleteActionResult,
  PendingDeleteDeleteNowInput,
  PendingDeleteQueueItem,
  PendingDeleteRuleEditIntent,
} from "./pending-delete-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

function normalizeAddress(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function domainFromAddress(value: string | undefined): string | undefined {
  const address = normalizeAddress(value);
  if (!address) return undefined;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at >= address.length - 1) return undefined;
  return address.slice(at + 1);
}

function scheduledDates(
  job: RetentionJob,
  message: CanonicalMessage,
): Pick<
  PendingDeleteQueueItem,
  | "scheduledTrashAt"
  | "scheduledPermanentDeleteAt"
  | "providerManagedExpiryAt"
> {
  let scheduledTrashAt: string | undefined;
  let scheduledPermanentDeleteAt: string | undefined;
  let providerManagedExpiryAt: string | undefined;

  if (job.nextAction === "archive" && job.nextRunAt) {
    scheduledTrashAt = addDays(
      job.nextRunAt,
      job.config.archiveRetentionDays,
    );
  } else if (job.nextAction === "trash" && job.nextRunAt) {
    scheduledTrashAt = job.nextRunAt;
  } else {
    scheduledTrashAt = message.retention.trashAt;
  }

  if (
    job.config.allowPermanentDelete &&
    job.trashSemantics.permanentDeleteSupported
  ) {
    if (job.nextAction === "delete_permanent" && job.nextRunAt) {
      scheduledPermanentDeleteAt = job.nextRunAt;
    } else if (scheduledTrashAt) {
      scheduledPermanentDeleteAt = addDays(
        scheduledTrashAt,
        job.config.trashRetentionDays,
      );
    }
  } else if (
    job.trashSemantics.behavior === "provider_managed_expiry" &&
    job.trashSemantics.providerAutoDeleteAfterDays !== undefined &&
    scheduledTrashAt
  ) {
    providerManagedExpiryAt = addDays(
      scheduledTrashAt,
      job.trashSemantics.providerAutoDeleteAfterDays,
    );
  }

  return {
    ...(scheduledTrashAt ? { scheduledTrashAt } : {}),
    ...(scheduledPermanentDeleteAt
      ? { scheduledPermanentDeleteAt }
      : {}),
    ...(providerManagedExpiryAt
      ? { providerManagedExpiryAt }
      : {}),
  };
}

function activeForReview(job: RetentionJob): boolean {
  return (
    job.status === "scheduled" ||
    job.status === "provider_managed"
  );
}

function restorePlan(
  job: RetentionJob,
  message: CanonicalMessage,
  actorId: string,
): MailboxActionPlan {
  const planId =
    "pending_restore_" +
    createHash("sha256")
      .update(
        JSON.stringify({
          jobId: job.id,
          messageId: message.id,
          updatedAt: message.updatedAt,
          actorId,
        }),
      )
      .digest("hex")
      .slice(0, 32);
  const partial = {
    schemaVersion: ACTION_PLAN_VERSION,
    planId,
    source: "user_confirmed" as const,
    tenantId: job.tenantId,
    accountId: job.accountId,
    provider: job.provider,
    providerMessageId: job.providerMessageId,
    action: { type: "restore" as const },
  };
  return {
    ...partial,
    idempotencyKey: createActionIdempotencyKey(partial),
    preconditions: {
      expectedCanonicalMessageId: message.id,
    },
  };
}

export class PendingDeleteReviewService {
  constructor(
    private readonly jobs: RetentionJobStore,
    private readonly messages: RetentionMessageRepository,
    private readonly scheduler: RetentionScheduler,
    private readonly actions: RetentionActionExecutor,
    private readonly learning: PersonalLearningEngine,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(
    tenantId: string,
    accountId: string,
  ): Promise<PendingDeleteQueueItem[]> {
    const jobs = (await this.jobs.listForAccount(
      tenantId,
      accountId,
    )).filter(activeForReview);

    const items: PendingDeleteQueueItem[] = [];
    for (const job of jobs) {
      const message = await this.messages.get(
        tenantId,
        accountId,
        job.providerMessageId,
      );
      if (!message) continue;
      items.push(this.project(job, message));
    }

    return items.sort((a, b) => {
      const aDate =
        a.scheduledTrashAt ??
        a.scheduledPermanentDeleteAt ??
        a.providerManagedExpiryAt ??
        "9999-12-31T23:59:59.999Z";
      const bDate =
        b.scheduledTrashAt ??
        b.scheduledPermanentDeleteAt ??
        b.providerManagedExpiryAt ??
        "9999-12-31T23:59:59.999Z";
      return aDate.localeCompare(bDate);
    });
  }

  async keep(
    jobId: string,
    actorId: string,
  ): Promise<PendingDeleteActionResult> {
    const { job, message } = await this.require(jobId);

    if (
      message.retention.stage === "trashed" ||
      job.status === "provider_managed"
    ) {
      await this.restoreToInbox(jobId, actorId);
    } else {
      await this.scheduler.cancelPendingDeletion(
        jobId,
        actorId,
        "User selected Keep in Pending Delete review",
      );
    }
    return { jobId, outcome: "kept" };
  }

  async restoreToInbox(
    jobId: string,
    actorId: string,
  ): Promise<PendingDeleteActionResult> {
    const actor = actorId.trim();
    if (!actor) throw new TypeError("actorId is required");
    const { job, message } = await this.require(jobId);

    if (message.retention.stage !== "active") {
      await this.actions.execute(
        restorePlan(job, message, actor),
        {
          tenantId: job.tenantId,
          accountId: job.accountId,
          actorType: "user",
          actorId: actor,
        },
      );
    }

    await this.scheduler.cancelOnRestore(
      job.tenantId,
      job.accountId,
      job.providerMessageId,
      "User restored message from Pending Delete review",
    );

    return { jobId, outcome: "restored" };
  }

  async neverDeleteSender(
    jobId: string,
    actorId: string,
  ): Promise<PendingDeleteActionResult> {
    return this.neverDelete(jobId, actorId, "sender");
  }

  async neverDeleteDomain(
    jobId: string,
    actorId: string,
  ): Promise<PendingDeleteActionResult> {
    return this.neverDelete(jobId, actorId, "domain");
  }

  async changeRule(
    jobId: string,
  ): Promise<PendingDeleteRuleEditIntent> {
    const { job } = await this.require(jobId);
    return {
      kind: "edit_rule",
      tenantId: job.tenantId,
      accountId: job.accountId,
      jobId: job.id,
      policyId: job.policyId,
    };
  }

  async deleteNow(
    input: PendingDeleteDeleteNowInput,
  ): Promise<PendingDeleteActionResult> {
    const result = await this.scheduler.runNow(
      input.jobId,
      input.actorId,
      input.userConfirmationId,
    );
    return {
      jobId: input.jobId,
      outcome: "delete_now",
      retentionResult: result,
    };
  }

  private async neverDelete(
    jobId: string,
    actorId: string,
    scope: "sender" | "domain",
  ): Promise<PendingDeleteActionResult> {
    const actor = actorId.trim();
    if (!actor) throw new TypeError("actorId is required");
    const { job, message } = await this.require(jobId);
    const sender = normalizeAddress(message.from?.address);
    const domain = domainFromAddress(sender);
    const key = scope === "sender" ? sender : domain;
    if (!key) {
      throw new Error(
        "Message does not have a sender value for this protection rule",
      );
    }

    await this.learning.record({
      id:
        "pending-delete:" +
        job.id +
        ":never-delete:" +
        scope +
        ":" +
        key,
      type:
        scope === "sender"
          ? "never_delete_sender"
          : "never_delete_domain",
      source: "explicit_correction",
      occurredAt: this.now().toISOString(),
      message,
    });

    if (
      message.retention.stage === "trashed" ||
      job.status === "provider_managed"
    ) {
      await this.restoreToInbox(jobId, actor);
    } else {
      await this.scheduler.cancelPendingDeletion(
        jobId,
        actor,
        "User created Never Delete " + scope + " rule",
      );
    }

    return {
      jobId,
      outcome:
        scope === "sender"
          ? "never_delete_sender"
          : "never_delete_domain",
    };
  }

  private project(
    job: RetentionJob,
    message: CanonicalMessage,
  ): PendingDeleteQueueItem {
    const sender = normalizeAddress(message.from?.address);
    const domain = domainFromAddress(sender);
    const deleteNowEnabled =
      job.status === "scheduled" &&
      (job.nextAction === "trash" ||
        (job.nextAction === "delete_permanent" &&
          job.config.allowPermanentDelete &&
          job.trashSemantics.permanentDeleteSupported));

    return {
      jobId: job.id,
      tenantId: job.tenantId,
      accountId: job.accountId,
      canonicalMessageId: message.id,
      providerMessageId: job.providerMessageId,
      ...(sender ? { sender } : {}),
      ...(message.from?.name
        ? { senderName: message.from.name }
        : {}),
      subject: message.subject,
      receivedAt: message.receivedAt,
      ...(message.classification.importanceScore !== undefined
        ? {
            importanceScore:
              message.classification.importanceScore,
          }
        : {}),
      ...(message.classification.priority
        ? { priority: message.classification.priority }
        : {}),
      categories: [...message.classification.categories],
      explanation:
        message.classification.reason ??
        "Retention policy scheduled this message for deletion review.",
      retentionStage: message.retention.stage,
      matchedRule: {
        id: job.policyId,
        label: job.policyId,
      },
      ...scheduledDates(job, message),
      actions: [
        { key: "keep", enabled: true },
        {
          key: "restore_to_inbox",
          enabled: message.retention.stage !== "active",
          ...(message.retention.stage === "active"
            ? { reason: "Message is already active/in inbox state" }
            : {}),
        },
        {
          key: "never_delete_sender",
          enabled: Boolean(sender),
          ...(!sender ? { reason: "Sender address unavailable" } : {}),
        },
        {
          key: "never_delete_domain",
          enabled: Boolean(domain),
          ...(!domain ? { reason: "Sender domain unavailable" } : {}),
        },
        { key: "change_rule", enabled: true },
        {
          key: "delete_now",
          enabled: deleteNowEnabled,
          ...(!deleteNowEnabled
            ? {
                reason:
                  job.status === "provider_managed"
                    ? "Provider manages the remaining Trash expiry"
                    : "Next retention stage is not an allowed destructive action",
              }
            : {}),
        },
      ],
    };
  }

  private async require(
    jobId: string,
  ): Promise<{ job: RetentionJob; message: CanonicalMessage }> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error("Pending Delete job not found");
    const message = await this.messages.get(
      job.tenantId,
      job.accountId,
      job.providerMessageId,
    );
    if (!message) {
      throw new Error("Pending Delete message not found");
    }
    return { job, message };
  }
}
