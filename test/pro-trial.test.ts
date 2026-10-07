import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryMcpAccountLinkStore,
  InMemoryProTrialStore,
  InMemoryShadowModeStore,
  MailboxPolicyEngine,
  ProTrialAccountLinkStore,
  ProTrialService,
  ShadowModePolicyCoordinator,
  ShadowModeService,
  parseClassifierResult,
  priorityForImportanceScore,
  unsupportedCapabilities,
  type CanonicalMessage,
} from "../src/index.js";

function clock(
  initial = "2026-10-01T10:00:00.000Z",
) {
  let now = Date.parse(initial);
  return {
    now: () => new Date(now),
    advanceDays(days: number) {
      now += days * 24 * 60 * 60 * 1000;
    },
    set(value: string) {
      now = Date.parse(value);
    },
    iso() {
      return new Date(now).toISOString();
    },
  };
}

function message(
  id = "trial-message",
): CanonicalMessage {
  const now = "2026-10-01T09:00:00.000Z";
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
    subject: "Trial test",
    body: {
      text: "content",
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
      status: "classified",
      categories: ["promotion"],
      importanceScore: 20,
      priority: "low",
      confidence: 0.95,
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

function classification(
  recommendedAction:
    | "archive"
    | "trash"
    | "mark_important",
) {
  const score =
    recommendedAction === "mark_important"
      ? 90
      : recommendedAction === "trash"
        ? 5
        : 20;
  return parseClassifierResult({
    contractVersion: 1,
    importanceScore: score,
    priority:
      priorityForImportanceScore(score),
    categories: ["promotion"],
    actionRequired: false,
    replyRequired: false,
    spamRisk: 1,
    phishingRisk: 1,
    confidence: 0.95,
    recommendedAction,
    retention: {
      disposition:
        recommendedAction === "archive"
          ? "archive"
          : recommendedAction === "trash"
            ? "trash_later"
            : "keep",
      protected: false,
      protectionReasons: [],
      ...(recommendedAction === "archive"
        ? { archiveAfterDays: 0 }
        : {}),
      ...(recommendedAction === "trash"
        ? { trashAfterDays: 30 }
        : {}),
    },
    reason: "Pro trial policy test",
  });
}

const providerCapabilities =
  unsupportedCapabilities([
    "getMessage",
    "markImportant",
    "archive",
    "trash",
  ]);

const proPlanCapabilities = {
  automaticMarkImportant: true,
  automaticArchive: true,
  automaticTrash: true,
};

test("new tenant gets one immutable 14-day Pro trial", async () => {
  const time = clock();
  const store = new InMemoryProTrialStore();
  const trials = new ProTrialService(
    store,
    time.now,
  );

  const first = await trials.ensureStarted(
    "tenant-1",
    "account-1",
  );
  assert.equal(
    first.startedAt,
    "2026-10-01T10:00:00.000Z",
  );
  assert.equal(
    first.endsAt,
    "2026-10-15T10:00:00.000Z",
  );

  time.advanceDays(10);
  const reconnect = await trials.ensureStarted(
    "tenant-1",
    "account-2",
  );
  assert.deepEqual(reconnect, first);
  assert.equal(store.records.size, 1);
});

test("disconnect and reconnect cannot restart or extend the tenant trial", async () => {
  const time = clock();
  const trials = new ProTrialService(
    new InMemoryProTrialStore(),
    time.now,
  );
  const links = new ProTrialAccountLinkStore(
    new InMemoryMcpAccountLinkStore(),
    trials,
  );

  await links.link(
    "tenant-1",
    "user-1",
    "account-1",
    time.iso(),
  );
  const original =
    await trials.getState("tenant-1");
  assert.ok(original);

  time.advanceDays(10);
  await links.disconnect(
    "tenant-1",
    "user-1",
    "account-1",
    time.iso(),
  );
  await links.link(
    "tenant-1",
    "user-1",
    "account-2",
    time.iso(),
  );

  const afterReconnect =
    await trials.getState("tenant-1");
  assert.equal(
    afterReconnect?.startedAt,
    original.startedAt,
  );
  assert.equal(
    afterReconnect?.endsAt,
    original.endsAt,
  );
  assert.equal(
    afterReconnect?.daysRemaining,
    4,
  );
});

test("dashboard exposes deterministic countdown and safe downgrade copy", async () => {
  const time = clock();
  const trials = new ProTrialService(
    new InMemoryProTrialStore(),
    time.now,
  );
  await trials.ensureStarted(
    "tenant-1",
    "account-1",
  );

  let dashboard =
    await trials.dashboard("tenant-1");
  assert.equal(
    dashboard?.status,
    "active",
  );
  assert.equal(
    dashboard?.daysRemaining,
    14,
  );
  assert.equal(
    dashboard?.countdown,
    "14 days left",
  );
  assert.equal(
    dashboard?.automationPaused,
    false,
  );

  time.advanceDays(13);
  dashboard =
    await trials.dashboard("tenant-1");
  assert.equal(
    dashboard?.daysRemaining,
    1,
  );
  assert.equal(
    dashboard?.countdown,
    "1 day left",
  );

  time.advanceDays(1);
  dashboard =
    await trials.dashboard("tenant-1");
  assert.equal(
    dashboard?.status,
    "expired",
  );
  assert.equal(
    dashboard?.countdown,
    "Trial ended",
  );
  assert.equal(
    dashboard?.capabilities,
    "free",
  );
  assert.equal(
    dashboard?.automationPaused,
    true,
  );
  assert.match(
    dashboard?.safeDowngradeCopy ?? "",
    /Automatic archive\/delete is paused/,
  );
});

test("exact trial expiry removes destructive plan capabilities but keeps non-destructive mark-important", async () => {
  const time = clock();
  const trials = new ProTrialService(
    new InMemoryProTrialStore(),
    time.now,
  );
  await trials.ensureStarted(
    "tenant-1",
    "account-1",
  );

  const before =
    await trials.resolvePlanCapabilities(
      "tenant-1",
      "account-1",
      proPlanCapabilities,
    );
  assert.deepEqual(
    before,
    proPlanCapabilities,
  );

  time.set("2026-10-15T10:00:00.000Z");
  const after =
    await trials.resolvePlanCapabilities(
      "tenant-1",
      "account-1",
      proPlanCapabilities,
    );
  assert.deepEqual(after, {
    automaticMarkImportant: true,
    automaticArchive: false,
    automaticTrash: false,
  });
});

test("policy coordinator pauses Pro-only archive/trash at expiry instead of becoming more destructive", async () => {
  const time = clock();
  const trials = new ProTrialService(
    new InMemoryProTrialStore(),
    time.now,
  );
  await trials.ensureStarted(
    "tenant-1",
    "account-1",
  );

  const shadow = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  await shadow.startAccount(
    "tenant-1",
    "account-1",
  );

  time.advanceDays(7);
  await shadow.getState(
    "tenant-1",
    "account-1",
  );
  await shadow.enableAutomation({
    tenantId: "tenant-1",
    accountId: "account-1",
    actorId: "user-1",
    reviewed: true,
  });

  const coordinator =
    new ShadowModePolicyCoordinator(
      new MailboxPolicyEngine(),
      shadow,
      time.now,
      undefined,
      trials,
    );

  const input = {
    policyId: "policy-1",
    message: message(),
    classification:
      classification("archive"),
    providerCapabilities,
    planCapabilities:
      proPlanCapabilities,
  };

  const active =
    await coordinator.evaluate(input);
  assert.equal(
    active.executablePlan?.action.type,
    "archive",
  );
  assert.equal(active.suppressed, false);

  time.advanceDays(7);
  const expired =
    await coordinator.evaluate({
      ...input,
      message: message("after-expiry"),
    });
  assert.equal(
    expired.executablePlan,
    undefined,
  );
  assert.equal(
    expired.decision.plan,
    undefined,
  );
  assert.ok(
    expired.decision.reasons.includes(
      "plan_capability_missing",
    ),
  );

  const important =
    await coordinator.evaluate({
      ...input,
      message: message(
        "mark-important-after-expiry",
      ),
      classification:
        classification("mark_important"),
    });
  assert.equal(
    important.executablePlan?.action.type,
    "mark_important",
  );
});

test("missing trial state fails safe for destructive automation", async () => {
  const trials = new ProTrialService(
    new InMemoryProTrialStore(),
    () =>
      new Date(
        "2026-10-07T12:00:00.000Z",
      ),
  );
  const capabilities =
    await trials.resolvePlanCapabilities(
      "tenant-without-trial",
      "account-1",
      proPlanCapabilities,
    );
  assert.deepEqual(capabilities, {
    automaticMarkImportant: true,
    automaticArchive: false,
    automaticTrash: false,
  });
});
