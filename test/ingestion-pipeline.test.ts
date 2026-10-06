import test from "node:test";
import assert from "node:assert/strict";
import {
  ImapIdleWakeupSource,
  InMemoryIngestionLeaseManager,
  InMemoryIngestionRepository,
  InMemoryIngestionSignalStore,
  IncrementalIngestionPipeline,
  MaildirWakeupSource,
  ReconciliationPlanner,
  gmailPushSignal,
  jmapChangeSignal,
  microsoftGraphWebhookSignal,
  scheduledReconciliationSignal,
  unsupportedCapabilities,
  type CanonicalMessage,
  type IngestionAccount,
  type ProviderAdapter,
  type ProviderKind,
  type SyncChangesResult,
} from "../src/index.js";

const account: IngestionAccount = {
  context: { tenantId: "tenant-1", accountId: "account-1" },
  provider: "gmail",
};

function canonical(
  id: string,
  providerMessageId: string,
  provider: ProviderKind = "gmail",
  subject = "Subject",
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
    subject,
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
    receivedAt: "2026-10-06T11:00:00.000Z",
    authentication: {},
    classification: { status: "unclassified", categories: [] },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-06T11:00:00.000Z",
    updatedAt: "2026-10-06T11:00:00.000Z",
  };
}

class FakeAdapter implements ProviderAdapter {
  readonly kind: ProviderKind;
  readonly requests: Array<{ cursor?: string; limit?: number }> = [];
  private index = 0;

  constructor(
    kind: ProviderKind,
    private readonly pages: SyncChangesResult[],
  ) {
    this.kind = kind;
  }

  capabilities() {
    return unsupportedCapabilities(["syncChanges", "getMessage"]);
  }
  async connect() {
    return { connected: true as const, provider: this.kind };
  }
  async listFolders() { return []; }
  async listLabels() { return []; }
  async syncChanges(request: { cursor?: string; limit?: number } = {}) {
    this.requests.push(request);
    const result = this.pages[this.index];
    if (!result) throw new Error("No fake page configured");
    this.index += 1;
    return structuredClone(result);
  }
  async getMessage(): Promise<CanonicalMessage> {
    throw new Error("unused");
  }
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

function pipeline(adapter: ProviderAdapter) {
  const repository = new InMemoryIngestionRepository();
  const signals = new InMemoryIngestionSignalStore();
  const leases = new InMemoryIngestionLeaseManager();
  const ingestion = new IncrementalIngestionPipeline(
    {
      async resolve() {
        return adapter;
      },
    },
    repository,
    signals,
    leases,
    { pageSize: 50, maxPages: 10 },
  );
  return { ingestion, repository, signals, leases };
}

test("pipeline consumes multiple provider pages and checkpoints each cursor", async () => {
  const adapter = new FakeAdapter("gmail", [
    {
      messages: [canonical("c1", "p1")],
      deletedProviderMessageIds: [],
      nextCursor: "cursor-1",
      hasMore: true,
    },
    {
      messages: [canonical("c2", "p2")],
      deletedProviderMessageIds: ["old-provider-id"],
      nextCursor: "cursor-2",
      hasMore: false,
    },
  ]);
  const { ingestion, repository } = pipeline(adapter);

  const signal = gmailPushSignal(
    account.context,
    { emailAddress: "u@example.test", historyId: "55" },
    "2026-10-06T11:05:00Z",
  );
  const result = await ingestion.handle(signal);

  assert.equal(result.status, "processed");
  assert.equal(result.pages, 2);
  assert.equal(result.inserted, 2);
  assert.equal(result.deletedMarked, 1);
  assert.equal(result.finalCursor, "cursor-2");
  assert.deepEqual(adapter.requests, [
    { limit: 50 },
    { cursor: "cursor-1", limit: 50 },
  ]);
  assert.equal(
    await repository.isProviderDeleted(
      "tenant-1",
      "account-1",
      "gmail",
      "old-provider-id",
    ),
    true,
  );
});

test("duplicate webhook signal is deduplicated without calling provider twice", async () => {
  const adapter = new FakeAdapter("gmail", [
    {
      messages: [canonical("c1", "p1")],
      deletedProviderMessageIds: [],
      nextCursor: "cursor-1",
      hasMore: false,
    },
  ]);
  const { ingestion } = pipeline(adapter);
  const signal = gmailPushSignal(
    account.context,
    { emailAddress: "u@example.test", historyId: "55" },
    "2026-10-06T11:05:00Z",
  );

  const first = await ingestion.handle(signal);
  const second = await ingestion.handle(signal);

  assert.equal(first.status, "processed");
  assert.equal(second.status, "deduplicated");
  assert.equal(adapter.requests.length, 1);
});

test("provider update preserves classification and retention state", async () => {
  const repository = new InMemoryIngestionRepository();
  const original = canonical("c1", "p1");
  original.classification = {
    status: "classified",
    categories: ["government"],
    importanceScore: 95,
    confidence: 0.98,
  };
  original.retention = {
    stage: "active",
    protected: true,
    protectionReasons: ["government"],
  };

  await repository.commitBatch({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    nextCursor: "c1",
    messages: [original],
    deletedProviderMessageIds: [],
  });

  const updated = canonical("c1", "p1", "gmail", "Updated subject");
  await repository.commitBatch({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    expectedCursor: "c1",
    nextCursor: "c2",
    messages: [updated],
    deletedProviderMessageIds: [],
  });

  const stored = await repository.getMessage(
    "tenant-1",
    "account-1",
    "c1",
  );
  assert.equal(stored?.subject, "Updated subject");
  assert.equal(stored?.classification.importanceScore, 95);
  assert.equal(stored?.retention.protected, true);
});

test("live message wins over same-batch tombstone", async () => {
  const repository = new InMemoryIngestionRepository();
  await repository.commitBatch({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    nextCursor: "c1",
    messages: [canonical("c1", "p1")],
    deletedProviderMessageIds: ["p1"],
  });

  assert.equal(
    await repository.isProviderDeleted(
      "tenant-1",
      "account-1",
      "gmail",
      "p1",
    ),
    false,
  );
});

test("out-of-order JMAP wakeup hint never replaces authoritative stored cursor", async () => {
  const repository = new InMemoryIngestionRepository();
  await repository.commitBatch({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "jmap",
    nextCursor: "authoritative-state-10",
    messages: [],
    deletedProviderMessageIds: [],
  });

  const adapter = new FakeAdapter("jmap", [
    {
      messages: [],
      deletedProviderMessageIds: [],
      nextCursor: "authoritative-state-11",
      hasMore: false,
    },
  ]);
  const signals = new InMemoryIngestionSignalStore();
  const ingestion = new IncrementalIngestionPipeline(
    { async resolve() { return adapter; } },
    repository,
    signals,
    new InMemoryIngestionLeaseManager(),
  );

  await ingestion.handle(
    jmapChangeSignal(
      account.context,
      "older-provider-hint-3",
      "2026-10-06T11:10:00Z",
    ),
  );

  assert.equal(
    adapter.requests[0]?.cursor,
    "authoritative-state-10",
  );
});

test("pipeline refuses hasMore page that does not advance cursor", async () => {
  const adapter = new FakeAdapter("gmail", [
    {
      messages: [],
      deletedProviderMessageIds: [],
      hasMore: true,
    },
  ]);
  const { ingestion, signals } = pipeline(adapter);
  const signal = gmailPushSignal(
    account.context,
    { emailAddress: "u@example.test", historyId: "60" },
  );

  await assert.rejects(
    () => ingestion.handle(signal),
    /without advancing its sync cursor/,
  );
  assert.equal(await signals.isProcessed(signal.id), false);
});

test("busy account lease coalesces another wakeup", async () => {
  const adapter = new FakeAdapter("gmail", [
    {
      messages: [],
      deletedProviderMessageIds: [],
      nextCursor: "c1",
      hasMore: false,
    },
  ]);
  const repository = new InMemoryIngestionRepository();
  const signals = new InMemoryIngestionSignalStore();
  const leases = new InMemoryIngestionLeaseManager();
  const held = await leases.tryAcquire(account);
  assert.ok(held);

  const ingestion = new IncrementalIngestionPipeline(
    { async resolve() { return adapter; } },
    repository,
    signals,
    leases,
  );
  const signal = gmailPushSignal(
    account.context,
    { emailAddress: "u@example.test", historyId: "61" },
  );
  const result = await ingestion.handle(signal);

  assert.equal(result.status, "coalesced");
  assert.equal(adapter.requests.length, 0);
  await held?.release();
});

test("scheduled reconciliation planner creates bounded recurring fallback signals", () => {
  const planner = new ReconciliationPlanner([
    { provider: "gmail", intervalMs: 60_000 },
  ]);
  const now = new Date("2026-10-06T11:20:30Z");

  const first = planner.due([account], now);
  const immediate = planner.due(
    [account],
    new Date("2026-10-06T11:20:45Z"),
  );
  const later = planner.due(
    [account],
    new Date("2026-10-06T11:21:31Z"),
  );

  assert.equal(first.length, 1);
  assert.equal(first[0]?.source, "scheduled_reconciliation");
  assert.equal(immediate.length, 0);
  assert.equal(later.length, 1);

  const direct = scheduledReconciliationSignal(
    account.context,
    "gmail",
    "2026-10-06T11:22:00Z",
  );
  assert.equal(direct.provider, "gmail");
});

test("Microsoft Graph webhook signal is stable for duplicate notification identity", () => {
  const notification = {
    subscriptionId: "sub-1",
    changeType: "updated",
    resource: "me/messages/p1",
    resourceData: { id: "p1" },
  };
  const first = microsoftGraphWebhookSignal(
    account.context,
    notification,
    "delivery-123",
    "2026-10-06T11:30:00Z",
  );
  const duplicate = microsoftGraphWebhookSignal(
    account.context,
    notification,
    "delivery-123",
    "2026-10-06T11:30:10Z",
  );

  assert.equal(first.id, duplicate.id);
  assert.equal(first.provider, "microsoft_graph");
  assert.equal(first.providerHint, "p1");
});

test("IMAP IDLE and Maildir watcher sources emit reconcile-only wakeup signals", async () => {
  const imapSource = new ImapIdleWakeupSource(
    {
      async waitForIdleChange() {
        return true;
      },
    },
    account.context,
  );
  const imapSignal = await imapSource.wait();
  assert.equal(imapSignal?.source, "imap_idle");
  assert.equal(imapSignal?.provider, "imap");

  const maildirSource = new MaildirWakeupSource(
    {
      async waitForChange() {
        return true;
      },
    },
    account.context,
    1000,
  );
  const localSignal = await maildirSource.wait();
  assert.equal(localSignal?.source, "local_filesystem");
  assert.equal(localSignal?.provider, "maildir");
});
