import { randomUUID } from "node:crypto";
import type {
  CanonicalMessage,
  RetentionState,
} from "../domain/email-model.js";
import { buildRetentionActionPlan } from "./retention-plan.js";
import type {
  ProviderTrashSemantics,
  RetentionActionExecutor,
  RetentionAuditEvent,
  RetentionJob,
  RetentionJobStore,
  RetentionMessageRepository,
  RetentionPolicyRevalidator,
  RetentionRunResult,
  RetentionScheduleConfig,
} from "./retention-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function assertDays(value: number, field: string): void {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > 36500
  ) {
    throw new RangeError(
      field + " must be an integer between 0 and 36500",
    );
  }
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

function restoredOutsideRetentionFlow(
  message: CanonicalMessage,
  job: RetentionJob,
): boolean {
  if (job.nextAction === "trash") {
    return message.retention.stage === "active";
  }
  if (job.nextAction === "delete_permanent") {
    return (
      message.retention.stage === "active" ||
      message.retention.stage === "archived"
    );
  }
  return false;
}

export interface ScheduleRetentionInput {
  message: CanonicalMessage;
  policyId: string;
  config: RetentionScheduleConfig;
  trashSemantics: ProviderTrashSemantics;
}

export class RetentionScheduler {
  constructor(
    private readonly jobs: RetentionJobStore,
    private readonly messages: RetentionMessageRepository,
    private readonly revalidator: RetentionPolicyRevalidator,
    private readonly actions: RetentionActionExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async schedule(
    input: ScheduleRetentionInput,
  ): Promise<RetentionJob> {
    if (!input.policyId.trim()) {
      throw new TypeError("Retention policyId is required");
    }
    assertDays(
      input.config.archiveRetentionDays,
      "archiveRetentionDays",
    );
    assertDays(
      input.config.trashRetentionDays,
      "trashRetentionDays",
    );

    if (
      input.trashSemantics.provider !==
      input.message.provider.kind
    ) {
      throw new TypeError(
        "Trash semantics provider does not match message provider",
      );
    }

    if (input.message.retention.protected) {
      throw new TypeError(
        "Protected message cannot enter automatic retention cleanup",
      );
    }

    const existing = await this.jobs.findActiveByMessage(
      input.message.tenantId,
      input.message.accountId,
      input.message.provider.messageId,
    );
    if (existing) return existing;

    const now = this.now().toISOString();
    const job: RetentionJob = {
      id: randomUUID(),
      version: 1,
      tenantId: input.message.tenantId,
      accountId: input.message.accountId,
      canonicalMessageId: input.message.id,
      provider: input.message.provider.kind,
      providerMessageId: input.message.provider.messageId,
      policyId: input.policyId,
      status: "scheduled",
      nextAction: "archive",
      nextRunAt: now,
      config: { ...input.config },
      trashSemantics: { ...input.trashSemantics },
      createdAt: now,
      updatedAt: now,
    };
    await this.jobs.create(job);
    await this.audit(job, {
      event: "scheduled",
      action: "archive",
      retentionStage: input.message.retention.stage,
      timestamp: now,
    });
    return job;
  }

  async runDue(limit = 100): Promise<RetentionRunResult[]> {
    const now = this.now().toISOString();
    const due = await this.jobs.listDue(
      now,
      Math.max(1, Math.min(limit, 1000)),
    );
    const results: RetentionRunResult[] = [];
    for (const job of due) {
      results.push(await this.run(job.id));
    }
    return results;
  }

  async run(jobId: string): Promise<RetentionRunResult> {
    let job = await this.requireJob(jobId);

    if (job.status === "cancelled") {
      return { job, outcome: "cancelled" };
    }
    if (job.status === "completed") {
      return { job, outcome: "completed" };
    }
    if (job.status === "provider_managed") {
      return { job, outcome: "provider_managed" };
    }
    if (job.status === "blocked") {
      return { job, outcome: "blocked" };
    }
    if (job.status === "failed") {
      return { job, outcome: "failed" };
    }
    if (!job.nextAction || !job.nextRunAt) {
      throw new Error("Scheduled retention job lacks next action/time");
    }

    const now = this.now().toISOString();
    if (Date.parse(job.nextRunAt) > Date.parse(now)) {
      return { job, outcome: "not_due" };
    }

    const message = await this.messages.get(
      job.tenantId,
      job.accountId,
      job.providerMessageId,
    );
    if (!message) {
      job = await this.fail(
        job,
        "Canonical message is unavailable for retention execution",
      );
      return { job, outcome: "failed" };
    }

    if (restoredOutsideRetentionFlow(message, job)) {
      job = await this.cancelRestoredJob(
        job,
        message,
        "Message was restored before the next retention stage",
      );
      return { job, outcome: "cancelled" };
    }

    if (message.retention.protected) {
      job = await this.block(
        job,
        message,
        "Message became protected before retention execution",
      );
      return { job, outcome: "blocked" };
    }

    if (job.nextAction === "archive") {
      return this.executeArchive(job, message, now);
    }

    const policy = await this.revalidator.evaluate(
      message,
      job.nextAction,
      job,
    );
    if (!policy.allowed) {
      job = await this.block(
        job,
        message,
        policy.reason,
      );
      return { job, outcome: "blocked" };
    }

    if (
      policy.policyId &&
      policy.policyId !== job.policyId
    ) {
      job = await this.jobs.update(
        job.id,
        job.version,
        (current) => ({
          ...current,
          policyId: policy.policyId!,
          updatedAt: now,
        }),
      );
    }

    if (job.nextAction === "trash") {
      return this.executeTrash(
        job,
        message,
        now,
        policy.reason,
      );
    }

    return this.executePermanentDelete(
      job,
      message,
      now,
      policy.reason,
    );
  }

  async cancelOnRestore(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
    reason = "User restored message",
  ): Promise<RetentionJob | undefined> {
    const job = await this.jobs.findActiveByMessage(
      tenantId,
      accountId,
      providerMessageId,
    );
    if (!job) return undefined;

    const message = await this.messages.get(
      tenantId,
      accountId,
      providerMessageId,
    );
    if (!message) {
      throw new Error("Canonical message not found for restore");
    }

    const now = this.now().toISOString();
    const retention: RetentionState = {
      stage: "active",
      protected: message.retention.protected,
      protectionReasons: [
        ...message.retention.protectionReasons,
      ],
      ...(message.retention.policyId
        ? { policyId: message.retention.policyId }
        : {}),
      lastTransitionAt: now,
    };
    await this.messages.updateRetention(
      tenantId,
      accountId,
      providerMessageId,
      retention,
    );

    return this.cancelRestoredJob(job, {
      ...message,
      retention,
    }, reason);
  }

  private async executeArchive(
    job: RetentionJob,
    message: CanonicalMessage,
    now: string,
  ): Promise<RetentionRunResult> {
    await this.audit(job, {
      event: "action_planned",
      action: "archive",
      retentionStage: message.retention.stage,
      timestamp: now,
    });

    try {
      const plan = buildRetentionActionPlan(
        job,
        message,
        "Retention lifecycle archive stage",
      );
      await this.actions.execute(plan, {
        tenantId: job.tenantId,
        accountId: job.accountId,
        actorType: "system",
        actorId: "retention-scheduler",
      });
    } catch (error) {
      const failed = await this.fail(
        job,
        error instanceof Error ? error.message : "Archive stage failed",
      );
      return { job: failed, outcome: "failed" };
    }

    const retention: RetentionState = {
      ...message.retention,
      stage: "archived",
      policyId: job.policyId,
      archiveAt: now,
      lastTransitionAt: now,
    };
    await this.messages.updateRetention(
      job.tenantId,
      job.accountId,
      job.providerMessageId,
      retention,
    );

    job = await this.jobs.update(
      job.id,
      job.version,
      (current) => ({
        ...current,
        status: "scheduled",
        nextAction: "trash",
        nextRunAt: addDays(
          now,
          current.config.archiveRetentionDays,
        ),
        updatedAt: now,
      }),
    );
    await this.audit(job, {
      event: "action_succeeded",
      action: "archive",
      retentionStage: "archived",
      timestamp: now,
    });
    return { job, outcome: "archived" };
  }

  private async executeTrash(
    job: RetentionJob,
    message: CanonicalMessage,
    now: string,
    policyReason: string,
  ): Promise<RetentionRunResult> {
    await this.audit(job, {
      event: "action_planned",
      action: "trash",
      retentionStage: message.retention.stage,
      policyReason,
      timestamp: now,
    });

    try {
      const plan = buildRetentionActionPlan(
        job,
        message,
        policyReason,
      );
      await this.actions.execute(plan, {
        tenantId: job.tenantId,
        accountId: job.accountId,
        actorType: "system",
        actorId: "retention-scheduler",
      });
    } catch (error) {
      const failed = await this.fail(
        job,
        error instanceof Error ? error.message : "Trash stage failed",
      );
      return { job: failed, outcome: "failed" };
    }

    const retention: RetentionState = {
      ...message.retention,
      stage: "trashed",
      policyId: job.policyId,
      trashAt: now,
      lastTransitionAt: now,
    };
    await this.messages.updateRetention(
      job.tenantId,
      job.accountId,
      job.providerMessageId,
      retention,
    );
    await this.audit(job, {
      event: "action_succeeded",
      action: "trash",
      retentionStage: "trashed",
      policyReason,
      providerTrashBehavior: job.trashSemantics.behavior,
      timestamp: now,
    });

    if (!job.config.allowPermanentDelete) {
      const completed = await this.completeAfterTrash(
        job,
        now,
        false,
      );
      return { job: completed, outcome: "trashed" };
    }

    if (!job.trashSemantics.permanentDeleteSupported) {
      if (
        job.trashSemantics.behavior ===
        "provider_managed_expiry"
      ) {
        const managed = await this.jobs.update(
          job.id,
          job.version,
          (current) => {
            const {
              nextAction: _nextAction,
              nextRunAt: _nextRunAt,
              ...rest
            } = current;
            return {
              ...rest,
              status: "provider_managed",
              updatedAt: now,
            };
          },
        );
        await this.audit(managed, {
          event: "provider_managed",
          action: "delete_permanent",
          retentionStage: "trashed",
          providerTrashBehavior:
            managed.trashSemantics.behavior,
          timestamp: now,
        });
        return {
          job: managed,
          outcome: "provider_managed",
        };
      }

      const blocked = await this.block(
        job,
        { ...message, retention },
        "Permanent delete requested but provider has no explicit delete capability",
      );
      return { job: blocked, outcome: "blocked" };
    }

    job = await this.jobs.update(
      job.id,
      job.version,
      (current) => ({
        ...current,
        status: "scheduled",
        nextAction: "delete_permanent",
        nextRunAt: addDays(
          now,
          current.config.trashRetentionDays,
        ),
        updatedAt: now,
      }),
    );
    return { job, outcome: "trashed" };
  }

  private async executePermanentDelete(
    job: RetentionJob,
    message: CanonicalMessage,
    now: string,
    policyReason: string,
  ): Promise<RetentionRunResult> {
    if (!job.config.allowPermanentDelete) {
      const completed = await this.completeAfterTrash(
        job,
        now,
        false,
      );
      return { job: completed, outcome: "trashed" };
    }
    if (!job.trashSemantics.permanentDeleteSupported) {
      const blocked = await this.block(
        job,
        message,
        "Provider does not support explicit permanent delete",
      );
      return { job: blocked, outcome: "blocked" };
    }
    if (message.retention.stage !== "trashed") {
      const cancelled = await this.cancelRestoredJob(
        job,
        message,
        "Message is no longer in retention Trash",
      );
      return { job: cancelled, outcome: "cancelled" };
    }

    await this.audit(job, {
      event: "action_planned",
      action: "delete_permanent",
      retentionStage: "trashed",
      policyReason,
      timestamp: now,
    });

    try {
      const plan = buildRetentionActionPlan(
        job,
        message,
        policyReason,
      );
      await this.actions.execute(plan, {
        tenantId: job.tenantId,
        accountId: job.accountId,
        actorType: "system",
        actorId: "retention-scheduler",
      });
    } catch (error) {
      const failed = await this.fail(
        job,
        error instanceof Error
          ? error.message
          : "Permanent-delete stage failed",
      );
      return { job: failed, outcome: "failed" };
    }

    const retention: RetentionState = {
      ...message.retention,
      stage: "deleted",
      policyId: job.policyId,
      deleteAt: now,
      lastTransitionAt: now,
    };
    await this.messages.updateRetention(
      job.tenantId,
      job.accountId,
      job.providerMessageId,
      retention,
    );

    job = await this.jobs.update(
      job.id,
      job.version,
      (current) => {
        const {
          nextAction: _nextAction,
          nextRunAt: _nextRunAt,
          ...rest
        } = current;
        return {
          ...rest,
          status: "completed",
          completedAt: now,
          updatedAt: now,
        };
      },
    );
    await this.audit(job, {
      event: "action_succeeded",
      action: "delete_permanent",
      retentionStage: "deleted",
      policyReason,
      timestamp: now,
    });
    await this.audit(job, {
      event: "completed",
      retentionStage: "deleted",
      timestamp: now,
    });
    return { job, outcome: "deleted" };
  }

  private async completeAfterTrash(
    job: RetentionJob,
    now: string,
    providerManaged: boolean,
  ): Promise<RetentionJob> {
    const nextStatus = providerManaged
      ? "provider_managed"
      : "completed";
    const completed = await this.jobs.update(
      job.id,
      job.version,
      (current) => {
        const {
          nextAction: _nextAction,
          nextRunAt: _nextRunAt,
          ...rest
        } = current;
        return {
          ...rest,
          status: nextStatus,
          ...(providerManaged ? {} : { completedAt: now }),
          updatedAt: now,
        };
      },
    );
    await this.audit(completed, {
      event: providerManaged ? "provider_managed" : "completed",
      retentionStage: "trashed",
      providerTrashBehavior:
        completed.trashSemantics.behavior,
      timestamp: now,
    });
    return completed;
  }

  private async cancelRestoredJob(
    job: RetentionJob,
    message: CanonicalMessage,
    reason: string,
  ): Promise<RetentionJob> {
    const now = this.now().toISOString();
    const cancelled = await this.jobs.update(
      job.id,
      job.version,
      (current) => {
        const {
          nextAction: _nextAction,
          nextRunAt: _nextRunAt,
          ...rest
        } = current;
        return {
          ...rest,
          status: "cancelled",
          cancelledAt: now,
          blockedReason: reason,
          updatedAt: now,
        };
      },
    );
    await this.audit(cancelled, {
      event: "restore_cancelled",
      retentionStage: message.retention.stage,
      policyReason: reason,
      timestamp: now,
    });
    return cancelled;
  }

  private async block(
    job: RetentionJob,
    message: CanonicalMessage,
    reason: string,
  ): Promise<RetentionJob> {
    const now = this.now().toISOString();
    const blocked = await this.jobs.update(
      job.id,
      job.version,
      (current) => ({
        ...current,
        status: "blocked",
        blockedReason: reason,
        updatedAt: now,
      }),
    );
    await this.audit(blocked, {
      event: "policy_blocked",
      ...(blocked.nextAction
        ? { action: blocked.nextAction }
        : {}),
      retentionStage: message.retention.stage,
      policyReason: reason,
      timestamp: now,
    });
    return blocked;
  }

  private async fail(
    job: RetentionJob,
    error: string,
  ): Promise<RetentionJob> {
    const now = this.now().toISOString();
    const failed = await this.jobs.update(
      job.id,
      job.version,
      (current) => ({
        ...current,
        status: "failed",
        lastError: error.slice(0, 1000),
        updatedAt: now,
      }),
    );
    await this.audit(failed, {
      event: "failed",
      ...(failed.nextAction
        ? { action: failed.nextAction }
        : {}),
      policyReason: error.slice(0, 1000),
      timestamp: now,
    });
    return failed;
  }

  private async requireJob(jobId: string): Promise<RetentionJob> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error("Retention job not found");
    return job;
  }

  private async audit(
    job: RetentionJob,
    event: Omit<
      RetentionAuditEvent,
      "jobId" | "tenantId" | "accountId" | "providerMessageId"
    >,
  ): Promise<void> {
    await this.jobs.appendAudit({
      jobId: job.id,
      tenantId: job.tenantId,
      accountId: job.accountId,
      providerMessageId: job.providerMessageId,
      ...event,
    });
  }
}
