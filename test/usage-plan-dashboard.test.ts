import test from "node:test";
import assert from "node:assert/strict";
import {
  CleanupConversionService,
  InMemoryCleanupOpportunityStore,
  InMemoryCustomerUsageStore,
  InMemoryMcpAccountLinkStore,
  InMemoryOperationalTelemetry,
  InMemoryProTrialStore,
  InMemoryTenantPlanStore,
  PlanEntitlementService,
  ProTrialService,
  UsagePlanDashboardService,
  type CanonicalMessage,
} from "../src/index.js";

function message(
  id: string,
): CanonicalMessage {
  const now =
    "2026-10-07T12:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-" + id,
    provider: {
      kind: "gmail",
      messageId: "provider-" + id,
    },
    subject: "Dashboard fixture",
    body: {
      text: "private",
      truncated: false,
    },
    from: {
      address: "sender@example.test",
    },
    to: [{ address: "me@example.test" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {},
    labels: [],
    mailboxes: [
      { id: "inbox", role: "inbox" },
    ],
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

async function seedUsage(
  store: InMemoryCustomerUsageStore,
  count: number,
  processedAt: string,
  offset = 0,
) {
  for (
    let index = 0;
    index < count;
    index += 1
  ) {
    const id = offset + index;
    await store.recordUnique({
      tenantId: "tenant-1",
      accountId: "account-1",
      provider: "gmail",
      providerMessageId:
        "usage-provider-" + id,
      canonicalMessageId:
        "usage-message-" + id,
      processedAt,
    });
  }
}

async function baseDependencies(
  now = "2026-10-07T12:00:00.000Z",
) {
  const usage =
    new InMemoryCustomerUsageStore();
  const planStore =
    new InMemoryTenantPlanStore();
  const plans =
    new PlanEntitlementService(
      planStore,
      usage,
      () => new Date(now),
    );
  const accounts =
    new InMemoryMcpAccountLinkStore();
  const cleanup =
    new CleanupConversionService(
      new InMemoryCleanupOpportunityStore(),
      () => new Date(now),
    );
  const activity =
    new InMemoryOperationalTelemetry();
  return {
    usage,
    planStore,
    plans,
    accounts,
    cleanup,
    activity,
  };
}

test("Free dashboard shows email usage, active Pro trial, mailbox cap, cleanup value and customer activity without MCP quota", async () => {
  const now =
    "2026-10-07T12:00:00.000Z";
  const env =
    await baseDependencies(now);

  await seedUsage(
    env.usage,
    540,
    "2026-10-06T10:00:00.000Z",
  );
  await seedUsage(
    env.usage,
    60,
    "2026-10-07T10:00:00.000Z",
    540,
  );
  await env.accounts.link(
    "tenant-1",
    "user-1",
    "account-1",
    "2026-10-01T10:00:00.000Z",
  );

  for (let index = 0; index < 42; index += 1) {
    await env.cleanup.record(
      message("cleanup-" + index),
      index % 2 === 0
        ? "archive"
        : "trash",
      now,
    );
  }

  await env.activity.record({
    metric: "classifier_version",
    tenantId: "tenant-1",
    accountId: "account-1",
    classifierVersion: "v1",
    status: "succeeded",
    value: 5,
    timestamp: now,
  });
  await env.activity.record({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    action: "archive",
    source: "policy_engine",
    status: "succeeded",
    value: 2,
    timestamp: now,
  });
  await env.activity.record({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    action: "trash",
    source: "system_retention",
    status: "succeeded",
    value: 1,
    timestamp: now,
  });
  await env.activity.record({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    action: "archive",
    source: "mcp_explicit",
    status: "succeeded",
    value: 1,
    timestamp: now,
  });
  await env.activity.record({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    action: "trash",
    source: "user_confirmed",
    status: "succeeded",
    value: 1,
    timestamp: now,
  });

  const trials = new ProTrialService(
    new InMemoryProTrialStore(),
    () => new Date(now),
  );
  await trials.ensureStarted(
    "tenant-1",
    "account-1",
    "2026-10-01T10:00:00.000Z",
  );

  const dashboard =
    new UsagePlanDashboardService({
      usage: env.usage,
      plans: env.plans,
      accounts: env.accounts,
      cleanup: env.cleanup,
      activity: env.activity,
      trials,
      now: () => new Date(now),
    });

  const view = await dashboard.view({
    tenantId: "tenant-1",
    userId: "user-1",
    accountId: "account-1",
  });

  assert.deepEqual(view.usage.today, {
    processed: 60,
    limit: 100,
    remaining: 40,
    percentUsed: 60,
    resetAt:
      "2026-10-08T00:00:00.000Z",
    unlimited: false,
  });
  assert.equal(
    view.usage.month.processed,
    600,
  );
  assert.equal(
    view.usage.month.limit,
    3000,
  );
  assert.deepEqual(view.mailboxes, {
    connected: 1,
    limit: 1,
    remaining: 0,
    unlimited: false,
  });
  assert.equal(
    view.billingPlan.id,
    "free",
  );
  assert.equal(
    view.trial?.status,
    "active",
  );
  assert.equal(
    view.trial?.capabilities,
    "pro",
  );
  assert.equal(
    view.cleanupOpportunity.total,
    42,
  );
  assert.deepEqual(view.activity, {
    classifications: 5,
    automatedActions: 3,
    automatedArchive: 2,
    automatedTrash: 1,
    automatedMarkImportant: 0,
    otherAutomatedActions: 0,
    manualActions: 2,
  });
  assert.equal(
    view.upgrade?.targetPlan,
    "pro",
  );
  assert.equal(
    view.projection.status,
    "on_track",
  );

  const serialized =
    JSON.stringify(view);
  assert.equal(
    /mcpUsage|toolCalls|controlPlane|tool-call/i.test(
      serialized,
    ),
    false,
  );
});

test("expired trial is shown separately from the underlying Free plan and offers automation restoration", async () => {
  const now =
    "2026-10-07T12:00:00.000Z";
  const env =
    await baseDependencies(now);
  const trials = new ProTrialService(
    new InMemoryProTrialStore(),
    () => new Date(now),
  );
  await trials.ensureStarted(
    "tenant-1",
    "account-1",
    "2026-09-20T12:00:00.000Z",
  );

  const view =
    await new UsagePlanDashboardService({
      usage: env.usage,
      plans: env.plans,
      accounts: env.accounts,
      cleanup: env.cleanup,
      activity: env.activity,
      trials,
      now: () => new Date(now),
    }).view({
      tenantId: "tenant-1",
      userId: "user-1",
    });

  assert.equal(
    view.billingPlan.id,
    "free",
  );
  assert.equal(
    view.trial?.status,
    "expired",
  );
  assert.equal(
    view.trial?.automationPaused,
    true,
  );
  assert.equal(
    view.upgrade?.targetPlan,
    "personal",
  );
  assert.equal(
    view.upgrade?.title,
    "Restore automatic cleanup",
  );
});

test("Personal dashboard projects monthly exhaustion from current unique-email run rate", async () => {
  const now =
    "2026-10-07T12:00:00.000Z";
  const env =
    await baseDependencies(now);
  await env.plans.assignPlan(
    "tenant-1",
    "personal",
  );
  await seedUsage(
    env.usage,
    5000,
    "2026-10-07T10:00:00.000Z",
  );
  await env.accounts.link(
    "tenant-1",
    "user-1",
    "account-1",
    now,
  );
  await env.accounts.link(
    "tenant-1",
    "user-1",
    "account-2",
    now,
  );

  const view =
    await new UsagePlanDashboardService({
      usage: env.usage,
      plans: env.plans,
      accounts: env.accounts,
      cleanup: env.cleanup,
      activity: env.activity,
      now: () => new Date(now),
    }).view({
      tenantId: "tenant-1",
      userId: "user-1",
    });

  assert.equal(
    view.billingPlan.id,
    "personal",
  );
  assert.equal(
    view.usage.today.limit,
    null,
  );
  assert.equal(
    view.usage.month.limit,
    20_000,
  );
  assert.equal(
    view.mailboxes.connected,
    2,
  );
  assert.equal(
    view.mailboxes.limit,
    3,
  );
  assert.equal(
    view.projection.status,
    "projected_exhaustion",
  );
  assert.ok(
    view.projection
      .projectedExhaustionAt,
  );
  assert.ok(
    (view.projection
      .projectedMonthlyTotal ?? 0) >
      20_000,
  );
  assert.equal(
    view.upgrade?.targetPlan,
    "pro",
  );
});

test("Business default unlimited limits render as unlimited and omit an upgrade CTA", async () => {
  const now =
    "2026-10-07T12:00:00.000Z";
  const env =
    await baseDependencies(now);
  await env.plans.assignPlan(
    "tenant-1",
    "business",
  );
  await env.accounts.link(
    "tenant-1",
    "user-1",
    "account-1",
    now,
  );
  await env.accounts.link(
    "tenant-1",
    "user-1",
    "account-2",
    now,
  );

  const view =
    await new UsagePlanDashboardService({
      usage: env.usage,
      plans: env.plans,
      accounts: env.accounts,
      cleanup: env.cleanup,
      activity: env.activity,
      now: () => new Date(now),
    }).view({
      tenantId: "tenant-1",
      userId: "user-1",
    });

  assert.equal(
    view.billingPlan.id,
    "business",
  );
  assert.equal(
    view.usage.today.unlimited,
    true,
  );
  assert.equal(
    view.usage.month.unlimited,
    true,
  );
  assert.equal(
    view.mailboxes.unlimited,
    true,
  );
  assert.equal(
    view.projection.status,
    "unlimited",
  );
  assert.equal(
    view.upgrade,
    undefined,
  );
});

test("activity dashboard ignores failed/deduplicated action attempts and events outside the current month", async () => {
  const now =
    "2026-10-07T12:00:00.000Z";
  const env =
    await baseDependencies(now);

  await env.activity.record({
    metric: "classifier_version",
    tenantId: "tenant-1",
    accountId: "account-1",
    classifierVersion: "v1",
    status: "succeeded",
    value: 3,
    timestamp:
      "2026-10-07T10:00:00.000Z",
  });
  await env.activity.record({
    metric: "classifier_version",
    tenantId: "tenant-1",
    accountId: "account-1",
    classifierVersion: "v1",
    status: "succeeded",
    value: 99,
    timestamp:
      "2026-09-30T23:59:00.000Z",
  });
  await env.activity.record({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    action: "archive",
    source: "policy_engine",
    status: "failed",
    value: 5,
    timestamp:
      "2026-10-07T10:00:00.000Z",
  });
  await env.activity.record({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    action: "mark_important",
    source: "policy_engine",
    status: "succeeded",
    value: 2,
    timestamp:
      "2026-10-07T10:00:00.000Z",
  });
  await env.activity.record({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    action: "archive",
    source: "mcp_explicit",
    status: "deduplicated",
    value: 4,
    timestamp:
      "2026-10-07T10:00:00.000Z",
  });

  const view =
    await new UsagePlanDashboardService({
      usage: env.usage,
      plans: env.plans,
      accounts: env.accounts,
      cleanup: env.cleanup,
      activity: env.activity,
      now: () => new Date(now),
    }).view({
      tenantId: "tenant-1",
      userId: "user-1",
      accountId: "account-1",
    });

  assert.deepEqual(view.activity, {
    classifications: 3,
    automatedActions: 2,
    automatedArchive: 0,
    automatedTrash: 0,
    automatedMarkImportant: 2,
    otherAutomatedActions: 0,
    manualActions: 0,
  });
});
