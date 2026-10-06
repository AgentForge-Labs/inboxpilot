import type {
  CanonicalMessage,
  ProviderKind,
} from "../domain/email-model.js";
import type {
  BackfillJob,
  BackfillJobStore,
  BackfillMessageRepository,
  BackfillUsageLedger,
} from "./backfill-types.js";

export class BackfillJobConflictError extends Error {
  readonly code = "BACKFILL_JOB_CONFLICT";
  constructor() {
    super("Backfill job version changed concurrently");
    this.name = "BackfillJobConflictError";
  }
}

export class InMemoryBackfillJobStore implements BackfillJobStore {
  readonly jobs = new Map<string, BackfillJob>();

  async create(job: BackfillJob): Promise<void> {
    if (this.jobs.has(job.id)) {
      throw new Error("Backfill job already exists");
    }
    this.jobs.set(job.id, structuredClone(job));
  }

  async get(jobId: string): Promise<BackfillJob | undefined> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : undefined;
  }

  async update(
    jobId: string,
    expectedVersion: number,
    mutate: (job: BackfillJob) => BackfillJob,
  ): Promise<BackfillJob> {
    const current = this.jobs.get(jobId);
    if (!current) throw new Error("Backfill job not found");
    if (current.version !== expectedVersion) {
      throw new BackfillJobConflictError();
    }

    const next = mutate(structuredClone(current));
    if (next.id !== current.id) {
      throw new Error("Backfill job id cannot change");
    }
    next.version = current.version + 1;
    next.updatedAt = new Date().toISOString();
    this.jobs.set(jobId, structuredClone(next));
    return structuredClone(next);
  }
}

function providerKey(input: {
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  providerMessageId: string;
}): string {
  return [
    input.tenantId,
    input.accountId,
    input.provider,
    input.providerMessageId,
  ].join("\u0000");
}

export class InMemoryBackfillUsageLedger implements BackfillUsageLedger {
  readonly charged = new Set<string>();

  async chargeUnique(input: {
    tenantId: string;
    accountId: string;
    provider: ProviderKind;
    providerMessageId: string;
  }): Promise<boolean> {
    const key = providerKey(input);
    if (this.charged.has(key)) return false;
    this.charged.add(key);
    return true;
  }
}

export class InMemoryBackfillMessageRepository
  implements BackfillMessageRepository
{
  readonly messages = new Map<string, CanonicalMessage>();

  async getByProviderMessageId(input: {
    tenantId: string;
    accountId: string;
    provider: ProviderKind;
    providerMessageId: string;
  }): Promise<CanonicalMessage | undefined> {
    const message = this.messages.get(providerKey(input));
    return message ? structuredClone(message) : undefined;
  }

  async saveClassified(input: {
    job: BackfillJob;
    message: CanonicalMessage;
    classification: CanonicalMessage["classification"];
  }): Promise<"inserted" | "updated" | "classification_only"> {
    const key = providerKey({
      tenantId: input.job.config.tenantId,
      accountId: input.job.config.accountId,
      provider: input.job.config.provider,
      providerMessageId: input.message.provider.messageId,
    });
    const existing = this.messages.get(key);

    if (input.job.config.mode === "classify_only") {
      this.messages.set(
        key,
        existing
          ? {
              ...structuredClone(existing),
              classification: structuredClone(input.classification),
              updatedAt: input.message.updatedAt,
            }
          : {
              ...structuredClone(input.message),
              classification: structuredClone(input.classification),
            },
      );
      return "classification_only";
    }

    this.messages.set(key, {
      ...structuredClone(input.message),
      classification: structuredClone(input.classification),
      ...(existing
        ? {
            ingestedAt: existing.ingestedAt,
            retention: structuredClone(existing.retention),
          }
        : {}),
    });
    return existing ? "updated" : "inserted";
  }
}
