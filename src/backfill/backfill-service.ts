import { randomUUID } from "node:crypto";
import { assertCanonicalMessage } from "../domain/email-model.js";
import { BackfillRateLimitError } from "./provider-backfill-source.js";
import { buildBackfillProgress } from "./backfill-progress.js";
import type {
  BackfillClassifier,
  BackfillJob,
  BackfillJobStore,
  BackfillMessageRepository,
  BackfillMode,
  BackfillProgressView,
  BackfillRunResult,
  BackfillSourceResolver,
  BackfillUsageLedger,
} from "./backfill-types.js";
import type { ProviderKind } from "../domain/email-model.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateBackfillJobInput {
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  mode?: BackfillMode;
  lookbackDays?: number;
  since?: string;
  until?: string;
  pageSize?: number;
  maxPagesPerRun?: number;
}

export class HistoricalBackfillService {
  constructor(
    private readonly jobs: BackfillJobStore,
    private readonly sources: BackfillSourceResolver,
    private readonly messages: BackfillMessageRepository,
    private readonly classifier: BackfillClassifier,
    private readonly usage: BackfillUsageLedger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createJob(input: CreateBackfillJobInput): Promise<BackfillJob> {
    if (!input.tenantId.trim() || !input.accountId.trim()) {
      throw new TypeError("Backfill tenantId and accountId are required");
    }

    const untilMs = input.until
      ? Date.parse(input.until)
      : this.now().getTime();
    if (Number.isNaN(untilMs)) {
      throw new TypeError("Backfill until must be a valid timestamp");
    }

    const lookbackDays = input.lookbackDays ?? 30;
    if (
      !Number.isInteger(lookbackDays) ||
      lookbackDays < 1 ||
      lookbackDays > 3650
    ) {
      throw new RangeError("Backfill lookbackDays must be between 1 and 3650");
    }

    const sinceMs = input.since
      ? Date.parse(input.since)
      : untilMs - lookbackDays * DAY_MS;
    if (Number.isNaN(sinceMs) || sinceMs > untilMs) {
      throw new TypeError("Backfill since must be before until");
    }

    const pageSize = input.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
      throw new RangeError("Backfill pageSize must be between 1 and 500");
    }

    const maxPagesPerRun = input.maxPagesPerRun ?? 10;
    if (
      !Number.isInteger(maxPagesPerRun) ||
      maxPagesPerRun < 1 ||
      maxPagesPerRun > 100
    ) {
      throw new RangeError(
        "Backfill maxPagesPerRun must be between 1 and 100",
      );
    }

    const now = this.now().toISOString();
    const job: BackfillJob = {
      id: randomUUID(),
      version: 1,
      status: "queued",
      config: {
        tenantId: input.tenantId,
        accountId: input.accountId,
        provider: input.provider,
        mode: input.mode ?? "classify_only",
        since: new Date(sinceMs).toISOString(),
        until: new Date(untilMs).toISOString(),
        pageSize,
        maxPagesPerRun,
      },
      pagesProcessed: 0,
      messagesSeen: 0,
      messagesClassified: 0,
      uniqueUsageCharged: 0,
      duplicateUsageSkipped: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.jobs.create(job);
    return job;
  }

  async pause(jobId: string): Promise<BackfillJob> {
    const job = await this.requireJob(jobId);
    if (job.status === "completed" || job.status === "cancelled") {
      return job;
    }
    return this.jobs.update(jobId, job.version, (current) => {
      const { nextRunAt: _nextRunAt, ...rest } = current;
      return { ...rest, status: "paused" };
    });
  }

  async resume(jobId: string): Promise<BackfillJob> {
    const job = await this.requireJob(jobId);
    if (job.status === "completed" || job.status === "cancelled") {
      return job;
    }
    return this.jobs.update(jobId, job.version, (current) => {
      const {
        nextRunAt: _nextRunAt,
        lastError: _lastError,
        ...rest
      } = current;
      return { ...rest, status: "queued" };
    });
  }

  async cancel(jobId: string): Promise<BackfillJob> {
    const job = await this.requireJob(jobId);
    if (job.status === "completed" || job.status === "cancelled") {
      return job;
    }
    return this.jobs.update(jobId, job.version, (current) => {
      const { nextRunAt: _nextRunAt, ...rest } = current;
      return { ...rest, status: "cancelled" };
    });
  }

  async progress(jobId: string): Promise<BackfillProgressView> {
    return buildBackfillProgress(await this.requireJob(jobId));
  }

  async run(jobId: string): Promise<BackfillRunResult> {
    let job = await this.requireJob(jobId);
    if (job.status === "completed") {
      return { job, pagesThisRun: 0, status: "completed" };
    }
    if (job.status === "cancelled") {
      return { job, pagesThisRun: 0, status: "cancelled" };
    }
    if (job.status === "paused") {
      return { job, pagesThisRun: 0, status: "paused" };
    }
    if (
      job.status === "throttled" &&
      job.nextRunAt &&
      Date.parse(job.nextRunAt) > this.now().getTime()
    ) {
      return { job, pagesThisRun: 0, status: "throttled" };
    }

    job = await this.jobs.update(job.id, job.version, (current) => {
      const {
        nextRunAt: _nextRunAt,
        lastError: _lastError,
        ...rest
      } = current;
      return { ...rest, status: "running" };
    });
    const source = await this.sources.resolve(job);
    let pagesThisRun = 0;

    while (pagesThisRun < job.config.maxPagesPerRun) {
      const latest = await this.requireJob(job.id);
      if (latest.status === "paused") {
        return { job: latest, pagesThisRun, status: "paused" };
      }
      if (latest.status === "cancelled") {
        return { job: latest, pagesThisRun, status: "cancelled" };
      }
      job = latest;

      let page;
      try {
        page = await source.fetchPage({
          ...(job.cursor ? { cursor: job.cursor } : {}),
          limit: job.config.pageSize,
          since: job.config.since,
          until: job.config.until,
        });
      } catch (error) {
        if (error instanceof BackfillRateLimitError) {
          const retryAt = new Date(
            this.now().getTime() + Math.max(1_000, error.retryAfterMs),
          ).toISOString();
          job = await this.jobs.update(
            job.id,
            job.version,
            (current) => ({
              ...current,
              status: "throttled",
              nextRunAt: retryAt,
              lastError: error.message,
            }),
          );
          return { job, pagesThisRun, status: "throttled" };
        }

        job = await this.jobs.update(job.id, job.version, (current) => ({
          ...current,
          status: "failed",
          lastError:
            error instanceof Error ? error.message : "Unknown backfill error",
        }));
        return { job, pagesThisRun, status: "failed" };
      }

      if (
        page.hasMore &&
        (!page.nextCursor || page.nextCursor === job.cursor)
      ) {
        job = await this.jobs.update(job.id, job.version, (current) => ({
          ...current,
          status: "failed",
          lastError:
            "Historical source reported more pages without advancing cursor",
        }));
        return { job, pagesThisRun, status: "failed" };
      }

      let seen = 0;
      let classified = 0;
      let charged = 0;
      let duplicateCharge = 0;
      const sinceMs = Date.parse(job.config.since);
      const untilMs = Date.parse(job.config.until);

      for (const message of page.messages) {
        assertCanonicalMessage(message);
        if (
          message.tenantId !== job.config.tenantId ||
          message.accountId !== job.config.accountId ||
          message.provider.kind !== job.config.provider
        ) {
          throw new TypeError(
            "Backfill source returned message outside job account scope",
          );
        }

        const receivedMs = Date.parse(message.receivedAt);
        if (receivedMs < sinceMs || receivedMs > untilMs) continue;
        seen += 1;

        const existing = await this.messages.getByProviderMessageId({
          tenantId: job.config.tenantId,
          accountId: job.config.accountId,
          provider: job.config.provider,
          providerMessageId: message.provider.messageId,
        });
        const classification = await this.classifier.classify(message, {
          jobId: job.id,
          mode: job.config.mode,
          reclassification:
            existing?.classification.status === "classified" ||
            existing?.classification.status === "needs_review",
        });
        await this.messages.saveClassified({
          job,
          message,
          classification,
        });
        classified += 1;

        const firstCharge = await this.usage.chargeUnique({
          tenantId: job.config.tenantId,
          accountId: job.config.accountId,
          provider: job.config.provider,
          providerMessageId: message.provider.messageId,
        });
        if (firstCharge) charged += 1;
        else duplicateCharge += 1;
      }

      const current = await this.requireJob(job.id);
      job = await this.jobs.update(job.id, current.version, (value) => {
        const done = !page.hasMore;
        return {
          ...value,
          status: done ? "completed" : "running",
          ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
          pagesProcessed: value.pagesProcessed + 1,
          messagesSeen: value.messagesSeen + seen,
          messagesClassified: value.messagesClassified + classified,
          uniqueUsageCharged: value.uniqueUsageCharged + charged,
          duplicateUsageSkipped:
            value.duplicateUsageSkipped + duplicateCharge,
          ...(page.totalEstimate !== undefined
            ? { totalEstimate: page.totalEstimate }
            : {}),
          ...(done ? { completedAt: this.now().toISOString() } : {}),
        };
      });
      pagesThisRun += 1;

      if (job.status === "completed") {
        return { job, pagesThisRun, status: "completed" };
      }
    }

    job = await this.jobs.update(job.id, job.version, (current) => ({
      ...current,
      status: "queued",
    }));
    return { job, pagesThisRun, status: "yielded" };
  }

  private async requireJob(jobId: string): Promise<BackfillJob> {
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error("Backfill job not found");
    return job;
  }
}
