import test from "node:test";
import assert from "node:assert/strict";
import {
  CustomerUsageAccountingService,
  InMemoryCustomerUsageStore,
  InMemorySemanticQuotaLedger,
  formatMonthlyEmailUsage,
  type CanonicalMessage,
  type ProviderKind,
} from "../src/index.js";

function message(
  id: string,
  providerMessageId = id,
  accountId = "account-1",
  provider: ProviderKind = "gmail",
): CanonicalMessage {
  const now = "2026-10-07T12:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId,
    threadId: "thread-" + id,
    provider: {
      kind: provider,
      messageId: providerMessageId,
    },
    subject: "Usage accounting fixture",
    body: {
      text: "This body must never be copied into usage records.",
      truncated: false,
    },
    from: { address: "sender@example.test" },
    to: [{ address: "me@example.test" }],
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
    receivedAt: now,
    authentication: {},
    classification: {
      status: "unclassified",
      categories: [],
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: now,
    updatedAt: now,
  };
}

test("customer usage charges one provider email only once across retries and re-reads", async () => {
  const store = new InMemoryCustomerUsageStore();
  const usage = new CustomerUsageAccountingService(store);
  const original = message("canonical-1", "provider-1");
  const rereadWithDifferentCanonicalId = message(
    "canonical-reread",
    "provider-1",
  );

  const first = await usage.recordProcessed(
    [original],
    "2026-10-07T10:00:00.000Z",
  );
  const retry = await usage.recordProcessed(
    [original],
    "2026-10-07T10:01:00.000Z",
  );
  const reread = await usage.recordProcessed(
    [rereadWithDifferentCanonicalId],
    "2026-10-07T10:02:00.000Z",
  );

  assert.deepEqual(first, {
    attempted: 1,
    newlyProcessed: 1,
    duplicates: 0,
  });
  assert.equal(retry.newlyProcessed, 0);
  assert.equal(reread.newlyProcessed, 0);
  assert.equal(store.events.size, 1);

  const serialized = JSON.stringify([...store.events.values()]);
  assert.equal(serialized.includes("This body must never"), false);
});

test("usage summary is tenant-aware, account-filterable and resets by UTC period", async () => {
  const store = new InMemoryCustomerUsageStore();
  const usage = new CustomerUsageAccountingService(store);

  await usage.recordProcessed(
    [message("sep", "sep-1")],
    "2026-09-30T23:59:00.000Z",
  );
  await usage.recordProcessed(
    [
      message("oct-a", "oct-1", "account-1"),
      message("oct-b", "oct-2", "account-2"),
    ],
    "2026-10-07T08:00:00.000Z",
  );
  await usage.recordProcessed(
    [message("oct-c", "oct-3", "account-1")],
    "2026-10-06T08:00:00.000Z",
  );

  const tenant = await usage.summary("tenant-1", {
    at: "2026-10-07T12:00:00.000Z",
  });
  assert.equal(tenant.day.processed, 2);
  assert.equal(tenant.month.processed, 3);
  assert.equal(
    tenant.month.start,
    "2026-10-01T00:00:00.000Z",
  );
  assert.equal(
    tenant.month.endExclusive,
    "2026-11-01T00:00:00.000Z",
  );

  const account = await usage.summary("tenant-1", {
    accountId: "account-1",
    at: "2026-10-07T12:00:00.000Z",
  });
  assert.equal(account.day.processed, 1);
  assert.equal(account.month.processed, 2);
});

test("internal semantic quota is independent from customer-facing email usage", async () => {
  const store = new InMemoryCustomerUsageStore();
  const usage = new CustomerUsageAccountingService(store);
  const semanticQuota = new InMemorySemanticQuotaLedger();
  const email = message("canonical-1", "provider-1");

  assert.equal(
    await semanticQuota.chargeUnique(email),
    true,
  );
  assert.equal(
    await semanticQuota.chargeUnique(email),
    false,
  );

  let summary = await usage.summary("tenant-1", {
    at: "2026-10-07T12:00:00.000Z",
  });
  assert.equal(summary.month.processed, 0);

  await usage.recordProcessed(
    [email],
    "2026-10-07T12:00:00.000Z",
  );
  summary = await usage.summary("tenant-1", {
    at: "2026-10-07T12:00:00.000Z",
  });
  assert.equal(summary.month.processed, 1);
});

test("usage dashboard copy matches unique-email billing language", () => {
  assert.equal(
    formatMonthlyEmailUsage(2341, 3000),
    "2,341 / 3,000 emails processed this month",
  );
});

test("account deletion removes only that mailbox usage metadata", async () => {
  const store = new InMemoryCustomerUsageStore();
  const usage = new CustomerUsageAccountingService(store);

  await usage.recordProcessed(
    [
      message("a", "a", "account-1"),
      message("b", "b", "account-2"),
    ],
    "2026-10-07T12:00:00.000Z",
  );

  assert.equal(
    await store.deleteAccountData(
      "tenant-1",
      "account-1",
    ),
    1,
  );
  assert.equal(
    (
      await store.exportAccountData(
        "tenant-1",
        "account-1",
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await store.exportAccountData(
        "tenant-1",
        "account-2",
      )
    ).length,
    1,
  );
});
