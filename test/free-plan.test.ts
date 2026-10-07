import test from "node:test";
import assert from "node:assert/strict";
import {
  FREE_PLAN,
  FREE_PLAN_FEATURES,
  FREE_PLAN_LIMITS,
  FreePlanAccountLinkStore,
  FreePlanEntitlementService,
  FreePlanMailboxLimitError,
  FreePlanQuotaExceededError,
  InMemoryCustomerUsageStore,
  InMemoryMcpAccountLinkStore,
  type CanonicalMessage,
} from "../src/index.js";

function message(
  index: number,
  accountId = "account-1",
): CanonicalMessage {
  const id = "message-" + index;
  const now = "2026-10-07T12:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId,
    threadId: "thread-" + id,
    provider: {
      kind: "gmail",
      messageId: "provider-" + index,
    },
    subject: "Free plan fixture",
    body: {
      text: "private body",
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

test("permanent Free plan exposes the exact mailbox, daily, monthly and feature entitlements", () => {
  assert.equal(FREE_PLAN.id, "free");
  assert.equal(FREE_PLAN.permanent, true);
  assert.equal(FREE_PLAN.priceCents, 0);
  assert.deepEqual(FREE_PLAN_LIMITS, {
    mailboxes: 1,
    emailsPerDay: 100,
    emailsPerMonth: 3000,
  });

  assert.equal(
    FREE_PLAN_FEATURES.classification,
    true,
  );
  assert.equal(
    FREE_PLAN_FEATURES.importanceBuckets,
    true,
  );
  assert.equal(
    FREE_PLAN_FEATURES.basicRules,
    true,
  );
  assert.equal(
    FREE_PLAN_FEATURES.manualArchiveRecommendations,
    true,
  );
  assert.equal(
    FREE_PLAN_FEATURES.manualDeleteRecommendations,
    true,
  );
  assert.equal(
    FREE_PLAN_FEATURES.automaticArchive,
    false,
  );
  assert.equal(
    FREE_PLAN_FEATURES.automaticDelete,
    false,
  );
});

test("Free plan accepts 100 unique emails per UTC day and blocks the 101st", async () => {
  const store = new InMemoryCustomerUsageStore();
  const free = new FreePlanEntitlementService(store);
  const at = "2026-10-07T12:00:00.000Z";

  for (let index = 0; index < 100; index += 1) {
    const decision =
      await free.reserveEmailProcessing(
        message(index),
        at,
      );
    assert.equal(decision.allowed, true);
    assert.equal(decision.newlyCounted, true);
  }

  const blocked =
    await free.reserveEmailProcessing(
      message(100),
      at,
    );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "daily_limit");
  assert.equal(blocked.day.processed, 100);
  assert.equal(blocked.day.remaining, 0);

  const duplicate =
    await free.reserveEmailProcessing(
      message(0),
      at,
    );
  assert.equal(duplicate.allowed, true);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(duplicate.newlyCounted, false);
  assert.equal(duplicate.day.processed, 100);

  await assert.rejects(
    () =>
      free.assertCanProcessEmail(
        message(101),
        at,
      ),
    (error: unknown) =>
      error instanceof FreePlanQuotaExceededError &&
      error.reason === "daily_limit",
  );
});

test("Free plan enforces 3,000 monthly emails and automatically resets in the next UTC month", async () => {
  const store = new InMemoryCustomerUsageStore();
  const free = new FreePlanEntitlementService(store);

  for (let index = 0; index < 3000; index += 1) {
    const day =
      1 + Math.floor(index / 100);
    await store.recordUnique({
      tenantId: "tenant-1",
      accountId: "account-1",
      provider: "gmail",
      providerMessageId:
        "oct-provider-" + index,
      canonicalMessageId:
        "oct-message-" + index,
      processedAt:
        "2026-10-" +
        String(day).padStart(2, "0") +
        "T12:00:00.000Z",
    });
  }

  const octoberState = await free.usageState(
    "tenant-1",
    "2026-10-31T12:00:00.000Z",
  );
  assert.equal(
    octoberState.month.processed,
    3000,
  );
  assert.equal(
    octoberState.month.exhausted,
    true,
  );
  assert.equal(
    octoberState.blockingReason,
    "monthly_limit",
  );
  assert.equal(
    octoberState.month.copy,
    "3,000 / 3,000 emails processed this month",
  );

  const blocked =
    await free.reserveEmailProcessing(
      message(4000),
      "2026-10-31T12:00:00.000Z",
    );
  assert.equal(blocked.allowed, false);
  assert.equal(
    blocked.reason,
    "monthly_limit",
  );

  const november =
    await free.reserveEmailProcessing(
      message(4001),
      "2026-11-01T00:00:01.000Z",
    );
  assert.equal(november.allowed, true);
  assert.equal(november.newlyCounted, true);
  assert.equal(november.month.processed, 1);

  const novemberState = await free.usageState(
    "tenant-1",
    "2026-11-01T00:00:02.000Z",
  );
  assert.equal(
    novemberState.month.processed,
    1,
  );
  assert.equal(
    novemberState.month.remaining,
    2999,
  );
  assert.equal(
    novemberState.month.resetAt,
    "2026-12-01T00:00:00.000Z",
  );
});

test("daily and monthly limits apply across all mailboxes in the same tenant", async () => {
  const store = new InMemoryCustomerUsageStore();
  const free = new FreePlanEntitlementService(store);
  const at = "2026-10-07T12:00:00.000Z";

  for (let index = 0; index < 99; index += 1) {
    await free.reserveEmailProcessing(
      message(index, "account-1"),
      at,
    );
  }
  const hundredth =
    await free.reserveEmailProcessing(
      message(200, "account-2"),
      at,
    );
  assert.equal(hundredth.allowed, true);
  assert.equal(hundredth.day.processed, 100);

  const blocked =
    await free.reserveEmailProcessing(
      message(201, "account-2"),
      at,
    );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "daily_limit");
});

test("Free plan mailbox decorator permits one mailbox, is idempotent, and permits replacement after disconnect", async () => {
  const inner = new InMemoryMcpAccountLinkStore();
  const links = new FreePlanAccountLinkStore(inner);

  const first = await links.link(
    "tenant-1",
    "user-1",
    "account-1",
    "2026-10-07T10:00:00.000Z",
  );
  assert.equal(first.accountId, "account-1");

  const repeated = await links.link(
    "tenant-1",
    "user-1",
    "account-1",
    "2026-10-07T11:00:00.000Z",
  );
  assert.equal(
    repeated.linkedAt,
    "2026-10-07T10:00:00.000Z",
  );

  await assert.rejects(
    () =>
      links.link(
        "tenant-1",
        "user-1",
        "account-2",
        "2026-10-07T11:00:00.000Z",
      ),
    FreePlanMailboxLimitError,
  );

  assert.equal(
    await links.disconnect(
      "tenant-1",
      "user-1",
      "account-1",
      "2026-10-07T12:00:00.000Z",
    ),
    true,
  );

  const replacement = await links.link(
    "tenant-1",
    "user-1",
    "account-2",
    "2026-10-07T12:01:00.000Z",
  );
  assert.equal(
    replacement.accountId,
    "account-2",
  );
});

test("recordProcessed reserves only allowed unique emails and reports blocked overage", async () => {
  const store = new InMemoryCustomerUsageStore();
  const free = new FreePlanEntitlementService(store);
  const batch = Array.from(
    { length: 103 },
    (_, index) => message(index),
  );

  const result = await free.recordProcessed(
    batch,
    "2026-10-07T12:00:00.000Z",
  );
  assert.deepEqual(result, {
    attempted: 103,
    newlyProcessed: 100,
    duplicates: 0,
    blocked: 3,
    blockedDaily: 3,
    blockedMonthly: 0,
  });

  const state = await free.usageState(
    "tenant-1",
    "2026-10-07T12:00:01.000Z",
  );
  assert.equal(state.day.processed, 100);
  assert.equal(state.canProcessNewEmail, false);
  assert.equal(
    state.blockingReason,
    "daily_limit",
  );
});
