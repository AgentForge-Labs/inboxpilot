import type {
  CanonicalMessage,
  RetentionState,
} from "../domain/email-model.js";
import type {
  RetentionAuditEvent,
  RetentionJob,
  RetentionJobStore,
  RetentionMessageRepository,
} from "./retention-types.js";

function messageKey(
  tenantId: string,
  accountId: string,
  providerMessageId: string,
): string {
  return [tenantId, accountId, providerMessageId].join("\u0000");
}

export class RetentionJobConflictError extends Error {
  readonly code = "RETENTION_JOB_CONFLICT";

  constructor() {
    super("Retention job changed concurrently");
    this.name = "RetentionJobConflictError";
  }
}

export class InMemoryRetentionJobStore
  implements RetentionJobStore
{
  readonly jobs = new Map<string, RetentionJob>();
  readonly audit: RetentionAuditEvent[] = [];

  async create(job: RetentionJob): Promise<void> {
    if (this.jobs.has(job.id)) {
      throw new Error("Retention job already exists");
    }
    this.jobs.set(job.id, structuredClone(job));
  }

  async get(jobId: string): Promise<RetentionJob | undefined> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  async findActiveByMessage(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
  ): Promise<RetentionJob | undefined> {
    for (const job of this.jobs.values()) {
      if (
        job.tenantId === tenantId &&
        job.accountId === accountId &&
        job.providerMessageId === providerMessageId &&
        !["cancelled", "completed", "failed"].includes(job.status)
      ) {
        return structuredClone(job);
      }
    }
    return undefined;
  }

  async listDue(now: string, limit: number): Promise<RetentionJob[]> {
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) {
      throw new TypeError("Retention due timestamp is invalid");
    }
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.status === "scheduled" &&
          job.nextRunAt !== undefined &&
          Date.parse(job.nextRunAt) <= nowMs,
      )
      .sort((a, b) =>
        (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""),
      )
      .slice(0, Math.max(0, limit))
      .map((job) => structuredClone(job));
  }

  async listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<RetentionJob[]> {
    return [...this.jobs.values()]
      .filter(
        (job) =>
          job.tenantId === tenantId &&
          job.accountId === accountId,
      )
      .map((job) => structuredClone(job))
      .sort((a, b) =>
        (a.nextRunAt ?? a.updatedAt).localeCompare(
          b.nextRunAt ?? b.updatedAt,
        ),
      );
  }

  async update(
    jobId: string,
    expectedVersion: number,
    mutate: (job: RetentionJob) => RetentionJob,
  ): Promise<RetentionJob> {
    const current = this.jobs.get(jobId);
    if (!current) throw new Error("Retention job not found");
    if (current.version !== expectedVersion) {
      throw new RetentionJobConflictError();
    }

    const next = mutate(structuredClone(current));
    if (next.id !== current.id) {
      throw new Error("Retention job id cannot change");
    }
    next.version = current.version + 1;
    this.jobs.set(jobId, structuredClone(next));
    return structuredClone(next);
  }

  async appendAudit(event: RetentionAuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }
}

export class InMemoryRetentionMessageRepository
  implements RetentionMessageRepository
{
  readonly messages = new Map<string, CanonicalMessage>();

  seed(message: CanonicalMessage): void {
    this.messages.set(
      messageKey(
        message.tenantId,
        message.accountId,
        message.provider.messageId,
      ),
      structuredClone(message),
    );
  }

  async get(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
  ): Promise<CanonicalMessage | undefined> {
    const message = this.messages.get(
      messageKey(tenantId, accountId, providerMessageId),
    );
    return message ? structuredClone(message) : undefined;
  }

  async updateRetention(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
    retention: RetentionState,
  ): Promise<void> {
    const key = messageKey(tenantId, accountId, providerMessageId);
    const current = this.messages.get(key);
    if (!current) throw new Error("Retention message not found");
    this.messages.set(key, {
      ...structuredClone(current),
      retention: structuredClone(retention),
      updatedAt: retention.lastTransitionAt ?? current.updatedAt,
    });
  }
}
