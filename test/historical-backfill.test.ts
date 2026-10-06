import test from "node:test";
import assert from "node:assert/strict";
import {
  BackfillRateLimitError,
  HistoricalBackfillService,
  InMemoryBackfillJobStore,
  InMemoryBackfillMessageRepository,
  InMemoryBackfillUsageLedger,
  ProviderSyncBackfillSource,
  buildBackfillProgress,
  unsupportedCapabilities,
  type BackfillClassifier,
  type BackfillJob,
  type CanonicalMessage,
  type HistoricalBackfillPage,
  type HistoricalBackfillSource,
  type ProviderAdapter,
  type ProviderKind,
} from "../src/index.js";

function message(
  id: string,
  providerMessageId: string,
  receivedAt: string,
  provider: ProviderKind = "gmail",
): CanonicalMessage {
  return {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: `thread-${id}`,
    provider: {
      kind: provider,
      messageId: providerMessageId,
      threadId: `provider-thread-${id}`,
    },
    subject: `Subject ${id}`,
    body: { text: "body", truncated: false },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {},
    labels: [],
    mailboxes: [{ id: "inbox", role: "inbox" }],
    flags: {
      read: false,
      starred: false,
      important: false,
      draft: false,
      answered: false,
      forwarded: false,
    },
    attachments: [],
    receivedAt,
    authentication: {},
    classification: { status: "unclassified", categories: [] },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: receivedAt,
    updatedAt: receivedAt,
  };
}

class PageSource implements HistoricalBackfillSource {
  calls = 0;
  constructor(private readonly pages: HistoricalBackfillPage[]) {}

  async fetchPage(): Promise<HistoricalBackfillPage> {
    const page = this.pages[this.calls];
    this.calls += 1;
    if (!page) throw new Error("No backfill page configured");
    return structuredClone(page);
  }
}

class ThrottledSource implements HistoricalBackfillSource {
  calls = 0;

  async fetchPage(): Promise<HistoricalBackfillPage> {
    this.calls += 1;
    if (this.calls === 1) {
      throw new BackfillRateLimitError(60_000, "provider says slow down");
    }
    return {
      messages: [
        message("c1", "p1", "2026-10-05T12:00:00.000Z"),
      ],
      hasMore: false,
    };
  }
}

const classifier: BackfillClassifier = {
  async classify(_message, context) {
    return {
      status: "classified",
      categories: [context.reclassification ? "reclassified" : "historical"],
      importanceScore: 70,
      confidence: 0.95,
      classifiedAt: "2026-10-06T12:00:00.000Z",
    };
  },
};

function service(
  source: HistoricalBackfillSource,
  options?: {
    now?: () => Date;
    jobs?: InMemoryBackfillJobStore;
    messages?: InMemoryBackfillMessageRepository;
    usage?: InMemoryBackfillUsageLedger;
  },
) {
  const jobs = options?.jobs ?? new InMemoryBackfillJobStore();
  const messages =
    options?.messages ?? new InMemoryBackfillMessageRepository();
  const usage = options?.usage ?? new InMemoryBackfillUsageLedger();
  const instance = new HistoricalBackfillService(
    jobs,
    {
      async resolve() {
        return source;
      },
    },
    messages,
    classifier,
    usage,
    options?.now,
  );
  return { instance, jobs, messages, usage };
}

test("historical backfill yields after bounded pages and resumes from checkpoint", async () => {
  const source = new PageSource([
    {
      messages: [
        message("c1", "p1", "2026-10-05T10:00:00.000Z"),
      ],
      nextCursor: "page-2",
      hasMore: true,
      totalEstimate: 2,
    },
    {
      messages: [
        message("c2", "p2", "2026-10-04T10:00:00.000Z"),
      ],
      hasMore: false,
      totalEstimate: 2,
    },
  ]);
  const { instance, messages } = service(source);

  const job = await instance.createJob({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-06T12:00:00.000Z",
    pageSize: 1,
    maxPagesPerRun: 1,
    mode: "classify_only",
  });

  const first = await instance.run(job.id);
  assert.equal(first.status, "yielded");
  assert.equal(first.job.cursor, "page-2");
  assert.equal(first.job.messagesClassified, 1);
  assert.equal(first.job.uniqueUsageCharged, 1);

  const second = await instance.run(job.id);
  assert.equal(second.status, "completed");
  assert.equal(second.job.messagesClassified, 2);
  assert.equal(second.job.uniqueUsageCharged, 2);

  const stored = await messages.getByProviderMessageId({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    providerMessageId: "p2",
  });
  assert.equal(stored?.classification.status, "classified");
});

test("pause, resume and cancel are durable job controls", async () => {
  const source = new PageSource([
    { messages: [], hasMore: false },
  ]);
  const { instance } = service(source);

  const job = await instance.createJob({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    lookbackDays: 30,
    until: "2026-10-06T12:00:00.000Z",
  });

  const paused = await instance.pause(job.id);
  assert.equal(paused.status, "paused");
  const notRun = await instance.run(job.id);
  assert.equal(notRun.status, "paused");
  assert.equal(source.calls, 0);

  const resumed = await instance.resume(job.id);
  assert.equal(resumed.status, "queued");
  const completed = await instance.run(job.id);
  assert.equal(completed.status, "completed");
  assert.equal(source.calls, 1);

  const secondJob = await instance.createJob({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    lookbackDays: 7,
    until: "2026-10-06T12:00:00.000Z",
  });
  const cancelled = await instance.cancel(secondJob.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await instance.run(secondJob.id)).status, "cancelled");
});

test("provider throttling stores retry deadline and resumes without losing cursor", async () => {
  let nowMs = Date.parse("2026-10-06T12:00:00.000Z");
  const source = new ThrottledSource();
  const { instance } = service(source, {
    now: () => new Date(nowMs),
  });

  const job = await instance.createJob({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    lookbackDays: 30,
  });

  const first = await instance.run(job.id);
  assert.equal(first.status, "throttled");
  assert.equal(first.job.nextRunAt, "2026-10-06T12:01:00.000Z");
  assert.equal(source.calls, 1);

  const early = await instance.run(job.id);
  assert.equal(early.status, "throttled");
  assert.equal(source.calls, 1);

  nowMs += 60_001;
  const resumed = await instance.run(job.id);
  assert.equal(resumed.status, "completed");
  assert.equal(source.calls, 2);
  assert.equal(resumed.job.uniqueUsageCharged, 1);
});

test("retry and reclassification of same provider message never double-charge quota", async () => {
  const jobs = new InMemoryBackfillJobStore();
  const messages = new InMemoryBackfillMessageRepository();
  const usage = new InMemoryBackfillUsageLedger();

  const firstSource = new PageSource([
    {
      messages: [
        message("c1", "p1", "2026-10-05T10:00:00.000Z"),
      ],
      hasMore: false,
    },
  ]);
  const first = service(firstSource, { jobs, messages, usage }).instance;
  const job1 = await first.createJob({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    lookbackDays: 30,
    until: "2026-10-06T12:00:00.000Z",
  });
  const result1 = await first.run(job1.id);
  assert.equal(result1.job.uniqueUsageCharged, 1);

  const secondSource = new PageSource([
    {
      messages: [
        message("c1", "p1", "2026-10-05T10:00:00.000Z"),
      ],
      hasMore: false,
    },
  ]);
  const second = service(secondSource, { jobs, messages, usage }).instance;
  const job2 = await second.createJob({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    lookbackDays: 30,
    until: "2026-10-06T12:00:00.000Z",
  });
  const result2 = await second.run(job2.id);

  assert.equal(result2.job.uniqueUsageCharged, 0);
  assert.equal(result2.job.duplicateUsageSkipped, 1);
  const stored = await messages.getByProviderMessageId({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    providerMessageId: "p1",
  });
  assert.deepEqual(stored?.classification.categories, ["reclassified"]);
  assert.equal(usage.charged.size, 1);
});

test("messages outside configured historical window are not classified or charged", async () => {
  let classifications = 0;
  const jobs = new InMemoryBackfillJobStore();
  const messages = new InMemoryBackfillMessageRepository();
  const usage = new InMemoryBackfillUsageLedger();
  const instance = new HistoricalBackfillService(
    jobs,
    {
      async resolve() {
        return new PageSource([
          {
            messages: [
              message("old", "old-p", "2025-01-01T00:00:00.000Z"),
              message("new", "new-p", "2026-10-05T00:00:00.000Z"),
            ],
            hasMore: false,
          },
        ]);
      },
    },
    messages,
    {
      async classify(mail) {
        classifications += 1;
        return {
          status: "classified",
          categories: [mail.provider.messageId],
        };
      },
    },
    usage,
  );

  const job = await instance.createJob({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-06T12:00:00.000Z",
  });
  const result = await instance.run(job.id);

  assert.equal(result.job.messagesSeen, 1);
  assert.equal(classifications, 1);
  assert.equal(usage.charged.size, 1);
});

test("progress view exposes percentage and safe customer-facing counters", () => {
  const job: BackfillJob = {
    id: "job-1",
    version: 2,
    status: "running",
    config: {
      tenantId: "tenant-1",
      accountId: "account-1",
      provider: "gmail",
      mode: "classify_only",
      since: "2026-10-01T00:00:00.000Z",
      until: "2026-10-06T12:00:00.000Z",
      pageSize: 100,
      maxPagesPerRun: 10,
    },
    pagesProcessed: 2,
    messagesSeen: 25,
    messagesClassified: 25,
    uniqueUsageCharged: 20,
    duplicateUsageSkipped: 5,
    totalEstimate: 100,
    createdAt: "2026-10-06T12:00:00.000Z",
    updatedAt: "2026-10-06T12:01:00.000Z",
  };

  const progress = buildBackfillProgress(job);
  assert.equal(progress.percent, 25);
  assert.equal(progress.messagesClassified, 25);
  assert.equal(progress.uniqueUsageCharged, 20);
  assert.equal(progress.duplicateUsageSkipped, 5);
});

class FakeProviderAdapter implements ProviderAdapter {
  readonly kind = "gmail" as const;
  calls = 0;
  fail429 = false;

  capabilities() {
    return unsupportedCapabilities(["syncChanges"]);
  }
  async connect() {
    return { connected: true as const, provider: this.kind };
  }
  async listFolders() { return []; }
  async listLabels() { return []; }
  async syncChanges() {
    this.calls += 1;
    if (this.fail429) {
      throw { status: 429, retryAfterMs: 5_000 };
    }
    return {
      messages: [
        message("old", "old-p", "2025-01-01T00:00:00.000Z"),
        message("new", "new-p", "2026-10-05T00:00:00.000Z"),
      ],
      deletedProviderMessageIds: [],
      hasMore: false,
    };
  }
  async getMessage(): Promise<CanonicalMessage> { throw new Error("unused"); }
  async getThread(): Promise<never> { throw new Error("unused"); }
  async archive() {}
  async move() {}
  async trash() {}
  async restore() {}
  async deletePermanent() {}
  async addLabel() {}
  async removeLabel() {}
  async markImportant() {}
  async star() {}
  async markRead() {}
}

test("ProviderSyncBackfillSource filters historical window and maps exhausted 429", async () => {
  const adapter = new FakeProviderAdapter();
  const source = new ProviderSyncBackfillSource(adapter);
  const page = await source.fetchPage({
    limit: 100,
    since: "2026-10-01T00:00:00.000Z",
    until: "2026-10-06T12:00:00.000Z",
  });
  assert.deepEqual(
    page.messages.map((item) => item.provider.messageId),
    ["new-p"],
  );

  adapter.fail429 = true;
  await assert.rejects(
    () =>
      source.fetchPage({
        limit: 100,
        since: "2026-10-01T00:00:00.000Z",
        until: "2026-10-06T12:00:00.000Z",
      }),
    (error: unknown) =>
      error instanceof BackfillRateLimitError &&
      error.retryAfterMs === 5_000,
  );
});
