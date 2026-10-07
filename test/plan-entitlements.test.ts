import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryCustomerUsageStore,
  InMemoryMcpAccountLinkStore,
  InMemoryTenantPlanStore,
  PLAN_ENTITLEMENTS,
  PLAN_PRICE_TARGETS_EUR,
  PlanAccountLinkStore,
  PlanEntitlementService,
  PlanMailboxLimitError,
  PlanRevisionConflictError,
  type CanonicalMessage,
} from "../src/index.js";

function message(
  index: number,
): CanonicalMessage {
  const id = "plan-message-" + index;
  const now = "2026-10-07T12:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-" + id,
    provider: {
      kind: "gmail",
      messageId: "provider-" + index,
    },
    subject: "Plan test",
    body: {
      text: "private",
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

function service() {
  return new PlanEntitlementService(
    new InMemoryTenantPlanStore(),
    new InMemoryCustomerUsageStore(),
    () =>
      new Date("2026-10-07T12:00:00.000Z"),
  );
}

test("plan entitlements are immutable and contain no pricing fields", () => {
  assert.deepEqual(
    PLAN_ENTITLEMENTS.free.limits,
    {
      mailboxes: 1,
      emailsPerDay: 100,
      emailsPerMonth: 3000,
    },
  );
  assert.deepEqual(
    PLAN_ENTITLEMENTS.personal.limits,
    {
      mailboxes: 3,
      emailsPerDay: null,
      emailsPerMonth: 20_000,
    },
  );
  assert.deepEqual(
    PLAN_ENTITLEMENTS.pro.limits,
    {
      mailboxes: 10,
      emailsPerDay: null,
      emailsPerMonth: 100_000,
    },
  );
  assert.equal(
    PLAN_ENTITLEMENTS.personal.features.automaticArchive,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.personal.features.automaticDelete,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.pro.features.advancedAi,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.pro.features.advancedRules,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.business.features.teams,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.business.features.auditLog,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.business.features.privacyControls,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.business.features.selfHosted,
    true,
  );

  for (const value of Object.values(
    PLAN_ENTITLEMENTS,
  )) {
    assert.equal(
      "priceCents" in value,
      false,
    );
    assert.equal(
      "currency" in value,
      false,
    );
  }
});

test("price targets live separately from entitlement presets", () => {
  assert.deepEqual(
    PLAN_PRICE_TARGETS_EUR.personal,
    {
      currency: "EUR",
      minCents: 499,
      maxCents: 599,
      custom: false,
    },
  );
  assert.deepEqual(
    PLAN_PRICE_TARGETS_EUR.pro,
    {
      currency: "EUR",
      minCents: 999,
      maxCents: 1299,
      custom: false,
    },
  );
  assert.equal(
    PLAN_PRICE_TARGETS_EUR.business.custom,
    true,
  );
});

test("unassigned tenants fail safe to Free entitlements", async () => {
  const plans = service();
  const assignment =
    await plans.assignment("tenant-new");
  assert.equal(assignment.planId, "free");
  assert.equal(assignment.revision, 0);

  const entitlements =
    await plans.entitlements("tenant-new");
  assert.equal(
    entitlements.limits.mailboxes,
    1,
  );
  assert.equal(
    entitlements.features.automaticArchive,
    false,
  );

  const effective =
    await plans.resolvePlanCapabilities(
      "tenant-new",
      "account-1",
      {
        automaticMarkImportant: true,
        automaticArchive: true,
        automaticTrash: true,
      },
    );
  assert.deepEqual(effective, {
    automaticMarkImportant: true,
    automaticArchive: false,
    automaticTrash: false,
  });
});

test("Personal and Pro assignments enable their expected commercial capabilities", async () => {
  const store =
    new InMemoryTenantPlanStore();
  const plans = new PlanEntitlementService(
    store,
    new InMemoryCustomerUsageStore(),
  );

  const personal = await plans.assignPlan(
    "tenant-1",
    "personal",
  );
  assert.equal(personal.revision, 1);
  let entitlements =
    await plans.entitlements("tenant-1");
  assert.equal(
    entitlements.limits.emailsPerMonth,
    20_000,
  );
  assert.equal(
    entitlements.features.automaticArchive,
    true,
  );
  assert.equal(
    entitlements.features.advancedAi,
    false,
  );

  const pro = await plans.assignPlan(
    "tenant-1",
    "pro",
    {
      expectedRevision: 1,
    },
  );
  assert.equal(pro.revision, 2);
  entitlements =
    await plans.entitlements("tenant-1");
  assert.equal(
    entitlements.limits.mailboxes,
    10,
  );
  assert.equal(
    entitlements.limits.emailsPerMonth,
    100_000,
  );
  assert.equal(
    entitlements.features.advancedAi,
    true,
  );
  assert.equal(
    entitlements.features.advancedRules,
    true,
  );

  await assert.rejects(
    () =>
      plans.assignPlan(
        "tenant-1",
        "free",
        {
          expectedRevision: 1,
        },
      ),
    PlanRevisionConflictError,
  );
});

test("Business supports tenant-specific high/custom limits without changing the global preset", async () => {
  const plans = service();
  await plans.assignPlan(
    "tenant-1",
    "business",
    {
      businessLimits: {
        mailboxes: 50,
        emailsPerDay: 25_000,
        emailsPerMonth: 500_000,
      },
    },
  );
  const entitlements =
    await plans.entitlements("tenant-1");
  assert.deepEqual(
    entitlements.limits,
    {
      mailboxes: 50,
      emailsPerDay: 25_000,
      emailsPerMonth: 500_000,
    },
  );
  assert.equal(
    entitlements.features.teams,
    true,
  );
  assert.equal(
    PLAN_ENTITLEMENTS.business.limits.mailboxes,
    null,
  );

  await assert.rejects(
    () =>
      plans.assignPlan(
        "tenant-2",
        "pro",
        {
          businessLimits: {
            mailboxes: 20,
          },
        },
      ),
    /businessLimits can only be set/,
  );
});

test("plan mailbox decorator enforces current entitlement and upgrades immediately", async () => {
  const store =
    new InMemoryTenantPlanStore();
  const plans = new PlanEntitlementService(
    store,
    new InMemoryCustomerUsageStore(),
  );
  const links = new PlanAccountLinkStore(
    new InMemoryMcpAccountLinkStore(),
    plans,
  );

  await links.link(
    "tenant-1",
    "user-1",
    "account-1",
    "2026-10-07T12:00:00.000Z",
  );
  await assert.rejects(
    () =>
      links.link(
        "tenant-1",
        "user-1",
        "account-2",
        "2026-10-07T12:01:00.000Z",
      ),
    PlanMailboxLimitError,
  );

  await plans.assignPlan(
    "tenant-1",
    "personal",
  );
  await links.link(
    "tenant-1",
    "user-1",
    "account-2",
    "2026-10-07T12:02:00.000Z",
  );
  await links.link(
    "tenant-1",
    "user-1",
    "account-3",
    "2026-10-07T12:03:00.000Z",
  );
  await assert.rejects(
    () =>
      links.link(
        "tenant-1",
        "user-1",
        "account-4",
        "2026-10-07T12:04:00.000Z",
      ),
    PlanMailboxLimitError,
  );
});

test("plan usage reservation uses plan limits and deduplicates provider identities", async () => {
  const planStore =
    new InMemoryTenantPlanStore();
  const usage =
    new InMemoryCustomerUsageStore();
  const plans = new PlanEntitlementService(
    planStore,
    usage,
    () =>
      new Date("2026-10-07T12:00:00.000Z"),
  );

  const first =
    await plans.reserveEmailProcessing(
      message(1),
    );
  const duplicate =
    await plans.reserveEmailProcessing(
      message(1),
    );
  assert.equal(first.allowed, true);
  assert.equal(first.newlyCounted, true);
  assert.equal(first.planId, "free");
  assert.equal(
    duplicate.reason,
    "duplicate",
  );
  assert.equal(
    duplicate.newlyCounted,
    false,
  );

  await plans.assignPlan(
    "tenant-1",
    "business",
    {
      businessLimits: {
        emailsPerDay: 2,
        emailsPerMonth: 3,
      },
    },
  );
  const second =
    await plans.reserveEmailProcessing(
      message(2),
    );
  assert.equal(second.allowed, true);
  const blocked =
    await plans.reserveEmailProcessing(
      message(3),
    );
  assert.equal(blocked.allowed, false);
  assert.equal(
    blocked.reason,
    "daily_limit",
  );
});

test("paid plan automation resolver never grants more than the requested policy capabilities", async () => {
  const plans = service();
  await plans.assignPlan(
    "tenant-1",
    "pro",
  );

  const effective =
    await plans.resolvePlanCapabilities(
      "tenant-1",
      "account-1",
      {
        automaticMarkImportant: false,
        automaticArchive: true,
        automaticTrash: false,
      },
    );
  assert.deepEqual(effective, {
    automaticMarkImportant: false,
    automaticArchive: true,
    automaticTrash: false,
  });
});
