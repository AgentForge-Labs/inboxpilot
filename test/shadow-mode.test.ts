import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryShadowModeStore,
  MailboxPolicyEngine,
  ShadowModePolicyCoordinator,
  ShadowModeRetentionPolicyRevalidator,
  ShadowModeService,
  buildShadowModeDashboardViewModel,
  parseClassifierResult,
  priorityForImportanceScore,
  unsupportedCapabilities,
  type CanonicalMessage,
  type CanonicalClassifierResult,
  type RetentionJob,
  type RetentionPolicyRevalidator,
  type ShadowModeObservation,
} from "../src/index.js";

function clock(initial = "2026-10-01T10:00:00.000Z") {
  let now = Date.parse(initial);
  return {
    now: () => new Date(now),
    advanceDays(days: number) {
      now += days * 24 * 60 * 60 * 1000;
    },
    iso() {
      return new Date(now).toISOString();
    },
  };
}

function message(
  id = "m1",
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  const base: CanonicalMessage = {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-" + id,
    provider: {
      kind: "gmail",
      messageId: "provider-" + id,
      threadId: "provider-thread-" + id,
    },
    subject: "Message",
    body: { text: "Hello", truncated: false },
    from: { address: "sender@example.com" },
    to: [{ address: "me@example.com" }],
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
    receivedAt: "2026-10-01T09:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["promotion"],
      importanceScore: 30,
      priority: "low",
      confidence: 0.95,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    provider: overrides.provider ?? base.provider,
    body: overrides.body ?? base.body,
    headers: overrides.headers ?? base.headers,
    authentication:
      overrides.authentication ?? base.authentication,
    classification:
      overrides.classification ?? base.classification,
    retention: overrides.retention ?? base.retention,
    flags: overrides.flags ?? base.flags,
    mailboxes: overrides.mailboxes ?? base.mailboxes,
  };
}

function classification(
  score: number,
  recommendedAction:
    | "keep_in_inbox"
    | "mark_important"
    | "archive"
    | "trash" = "keep_in_inbox",
): CanonicalClassifierResult {
  const disposition =
    recommendedAction === "archive"
      ? "archive"
      : recommendedAction === "trash"
        ? "trash_later"
        : "keep";
  return parseClassifierResult({
    contractVersion: 1,
    importanceScore: score,
    priority: priorityForImportanceScore(score),
    categories: ["promotion"],
    actionRequired: false,
    replyRequired: false,
    spamRisk: 1,
    phishingRisk: 1,
    confidence: 0.95,
    recommendedAction,
    retention: {
      disposition,
      protected: false,
      protectionReasons: [],
      ...(disposition === "archive"
        ? { archiveAfterDays: 0 }
        : {}),
      ...(disposition === "trash_later"
        ? { trashAfterDays: 30 }
        : {}),
    },
    reason: "Shadow Mode test classification",
  });
}

const providerCapabilities = unsupportedCapabilities([
  "getMessage",
  "markImportant",
  "archive",
  "trash",
]);

const planCapabilities = {
  automaticMarkImportant: true,
  automaticArchive: true,
  automaticTrash: true,
};

function policyInput(
  msg: CanonicalMessage,
  result: CanonicalClassifierResult,
) {
  return {
    policyId: "policy-1",
    message: msg,
    classification: result,
    providerCapabilities,
    planCapabilities,
  };
}

test("new account starts in seven-day Shadow Mode", async () => {
  const time = clock();
  const store = new InMemoryShadowModeStore();
  const service = new ShadowModeService(store, time.now);

  const state = await service.startAccount(
    "tenant-1",
    "account-1",
  );

  assert.equal(state.status, "shadow");
  assert.equal(state.startedAt, "2026-10-01T10:00:00.000Z");
  assert.equal(
    state.shadowEndsAt,
    "2026-10-08T10:00:00.000Z",
  );

  const view = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  assert.equal(view.daysRemaining, 7);
  assert.equal(view.canEnableAutomation, false);
  assert.equal(view.automationEnabled, false);
});

test("unknown account fails closed by lazily entering Shadow Mode", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );

  const state = await service.getState(
    "tenant-x",
    "account-x",
  );

  assert.equal(state.status, "shadow");
  assert.equal(
    state.shadowEndsAt,
    "2026-10-08T10:00:00.000Z",
  );
});

test("seven days ending only makes account review_ready; explicit review is required to enable", async () => {
  const time = clock();
  const store = new InMemoryShadowModeStore();
  const service = new ShadowModeService(store, time.now);
  await service.startAccount("tenant-1", "account-1");

  await assert.rejects(
    () =>
      service.enableAutomation({
        tenantId: "tenant-1",
        accountId: "account-1",
        actorId: "user-1",
        reviewed: true,
      }),
    /cannot be enabled before the seven-day/,
  );

  time.advanceDays(7);
  const ready = await service.getState(
    "tenant-1",
    "account-1",
  );
  assert.equal(ready.status, "review_ready");

  const reviewView = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  assert.equal(reviewView.canEnableAutomation, true);
  assert.equal(reviewView.automationEnabled, false);

  const enabled = await service.enableAutomation({
    tenantId: "tenant-1",
    accountId: "account-1",
    actorId: "user-1",
    reviewed: true,
  });
  assert.equal(enabled.status, "enabled");
  assert.equal(enabled.enabledBy, "user-1");
  assert.equal(
    enabled.reviewConfirmedAt,
    "2026-10-08T10:00:00.000Z",
  );

  const audit = await store.listAudit(
    "tenant-1",
    "account-1",
  );
  assert.deepEqual(
    audit.map((event) => event.event),
    ["shadow_started", "review_ready", "automation_enabled"],
  );
});

test("Enable Automation rejects missing explicit review acknowledgement", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  await service.startAccount("tenant-1", "account-1");
  time.advanceDays(7);

  await assert.rejects(
    () =>
      service.enableAutomation({
        tenantId: "tenant-1",
        accountId: "account-1",
        actorId: "user-1",
        reviewed: false,
      } as never),
    /explicit review confirmation/,
  );
});

test("shadow policy coordinator preserves intended archive plan but suppresses execution", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  const coordinator = new ShadowModePolicyCoordinator(
    new MailboxPolicyEngine(),
    service,
    time.now,
  );
  const msg = message("archive");
  const result = classification(30, "archive");

  const evaluated = await coordinator.evaluate(
    policyInput(msg, result),
  );

  assert.equal(evaluated.decision.outcome, "planned");
  assert.equal(evaluated.intendedPlan?.action.type, "archive");
  assert.equal(evaluated.executablePlan, undefined);
  assert.equal(evaluated.suppressed, true);

  const dashboard = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  assert.equal(dashboard.counts.wouldArchive, 1);
  assert.equal(dashboard.counts.wouldDelete, 0);
});

test("shadow policy coordinator suppresses trash while still recording Would Delete", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  const coordinator = new ShadowModePolicyCoordinator(
    new MailboxPolicyEngine(),
    service,
    time.now,
  );
  const msg = message("trash");

  const evaluated = await coordinator.evaluate(
    policyInput(msg, classification(5, "trash")),
  );

  assert.equal(evaluated.intendedPlan?.action.type, "trash");
  assert.equal(evaluated.executablePlan, undefined);
  assert.equal(evaluated.suppressed, true);

  const dashboard = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  assert.equal(dashboard.counts.wouldDelete, 1);
});

test("non-destructive mark-important plan remains executable in Shadow Mode", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  const coordinator = new ShadowModePolicyCoordinator(
    new MailboxPolicyEngine(),
    service,
    time.now,
  );

  const evaluated = await coordinator.evaluate(
    policyInput(
      message("important"),
      classification(85, "mark_important"),
    ),
  );

  assert.equal(
    evaluated.executablePlan?.action.type,
    "mark_important",
  );
  assert.equal(evaluated.suppressed, false);
});

test("same provider message is upserted so retries do not inflate preview counts", async () => {
  const time = clock();
  const store = new InMemoryShadowModeStore();
  const service = new ShadowModeService(store, time.now);
  const coordinator = new ShadowModePolicyCoordinator(
    new MailboxPolicyEngine(),
    service,
    time.now,
  );
  const msg = message("same");

  await coordinator.evaluate(
    policyInput(msg, classification(30, "archive")),
  );
  await coordinator.evaluate(
    policyInput(msg, classification(5, "trash")),
  );

  const dashboard = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  assert.equal(dashboard.counts.total, 1);
  assert.equal(dashboard.counts.wouldArchive, 0);
  assert.equal(dashboard.counts.wouldDelete, 1);
  assert.equal(dashboard.counts.low, 1);
});

test("dashboard groups low, very-low and disposable priorities into Low", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  await service.startAccount("tenant-1", "account-1");

  const observations: ShadowModeObservation[] = [
    ["critical", "none"],
    ["important", "none"],
    ["normal", "none"],
    ["low", "archive"],
    ["very_low", "archive"],
    ["disposable", "trash"],
  ].map(([priority, intendedAction], index) => ({
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "m-" + index,
    providerMessageId: "p-" + index,
    priority: priority as ShadowModeObservation["priority"],
    policyOutcome: "planned",
    intendedAction:
      intendedAction as ShadowModeObservation["intendedAction"],
    observedAt: time.iso(),
  }));

  for (const observation of observations) {
    await service.recordObservation(observation);
  }

  const view = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  assert.deepEqual(view.counts, {
    critical: 1,
    important: 1,
    normal: 1,
    low: 3,
    wouldArchive: 2,
    wouldDelete: 1,
    total: 6,
  });
});

test("dashboard view model exposes exact review metrics and Enable Automation action only when ready", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  await service.startAccount("tenant-1", "account-1");

  let model = buildShadowModeDashboardViewModel(
    await service.dashboard("tenant-1", "account-1"),
  );
  assert.equal(model.statusLabel, "Shadow Mode");
  assert.equal(model.primaryAction, undefined);
  assert.deepEqual(
    model.metrics.map((metric) => metric.label),
    [
      "Critical",
      "Important",
      "Normal",
      "Low",
      "Would Archive",
      "Would Delete",
    ],
  );

  time.advanceDays(7);
  model = buildShadowModeDashboardViewModel(
    await service.dashboard("tenant-1", "account-1"),
  );
  assert.deepEqual(model.primaryAction, {
    kind: "enable_automation",
    label: "Enable Automation",
    enabled: true,
  });
});

test("review_ready still suppresses archive until explicit Enable Automation; enabled state exposes plan", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  const coordinator = new ShadowModePolicyCoordinator(
    new MailboxPolicyEngine(),
    service,
    time.now,
  );
  const msg = message("review");

  await service.startAccount("tenant-1", "account-1");
  time.advanceDays(7);

  let evaluated = await coordinator.evaluate(
    policyInput(msg, classification(30, "archive")),
  );
  assert.equal(evaluated.shadow.status, "review_ready");
  assert.equal(evaluated.suppressed, true);
  assert.equal(evaluated.executablePlan, undefined);

  await service.enableAutomation({
    tenantId: "tenant-1",
    accountId: "account-1",
    actorId: "user-1",
    reviewed: true,
  });

  evaluated = await coordinator.evaluate(
    policyInput(msg, classification(30, "archive")),
  );
  assert.equal(evaluated.shadow.status, "enabled");
  assert.equal(evaluated.suppressed, false);
  assert.equal(evaluated.executablePlan?.action.type, "archive");
});

test("observations freeze after automation is enabled", async () => {
  const time = clock();
  const store = new InMemoryShadowModeStore();
  const service = new ShadowModeService(store, time.now);
  await service.startAccount("tenant-1", "account-1");
  await service.recordObservation({
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "before",
    providerMessageId: "provider-before",
    priority: "normal",
    policyOutcome: "no_action",
    intendedAction: "none",
    observedAt: time.iso(),
  });

  time.advanceDays(7);
  await service.enableAutomation({
    tenantId: "tenant-1",
    accountId: "account-1",
    actorId: "user-1",
    reviewed: true,
  });

  await service.recordObservation({
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "after",
    providerMessageId: "provider-after",
    priority: "critical",
    policyOutcome: "planned",
    intendedAction: "archive",
    observedAt: time.iso(),
  });

  const view = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  assert.equal(view.counts.total, 1);
  assert.equal(view.counts.normal, 1);
  assert.equal(view.counts.critical, 0);
});

test("retention destructive stages are blocked until automation is explicitly enabled", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );
  await service.startAccount("tenant-1", "account-1");

  let delegateCalls = 0;
  const delegate: RetentionPolicyRevalidator = {
    async evaluate() {
      delegateCalls += 1;
      return {
        allowed: true,
        reason: "base policy allows",
        policyId: "policy-1",
      };
    },
  };
  const guarded = new ShadowModeRetentionPolicyRevalidator(
    service,
    delegate,
  );
  const job: RetentionJob = {
    id: "job-1",
    version: 1,
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "m1",
    provider: "gmail",
    providerMessageId: "provider-m1",
    policyId: "policy-1",
    status: "scheduled",
    nextAction: "trash",
    nextRunAt: time.iso(),
    config: {
      archiveRetentionDays: 30,
      trashRetentionDays: 30,
      allowPermanentDelete: false,
    },
    trashSemantics: {
      provider: "gmail",
      behavior: "provider_managed_expiry",
      permanentDeleteSupported: false,
      providerAutoDeleteAfterDays: 30,
      note: "test",
    },
    createdAt: time.iso(),
    updatedAt: time.iso(),
  };

  let result = await guarded.evaluate(
    message(),
    "trash",
    job,
  );
  assert.equal(result.allowed, false);
  assert.equal(delegateCalls, 0);

  time.advanceDays(7);
  result = await guarded.evaluate(
    message(),
    "trash",
    job,
  );
  assert.equal(result.allowed, false);
  assert.match(result.reason, /Enable Automation/);
  assert.equal(delegateCalls, 0);

  await service.enableAutomation({
    tenantId: "tenant-1",
    accountId: "account-1",
    actorId: "user-1",
    reviewed: true,
  });
  result = await guarded.evaluate(
    message(),
    "trash",
    job,
  );
  assert.equal(result.allowed, true);
  assert.equal(delegateCalls, 1);
});

test("Shadow Mode state and counts are account isolated", async () => {
  const time = clock();
  const service = new ShadowModeService(
    new InMemoryShadowModeStore(),
    time.now,
  );

  await service.startAccount("tenant-1", "account-1");
  await service.startAccount("tenant-1", "account-2");
  await service.recordObservation({
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "m1",
    providerMessageId: "p1",
    priority: "critical",
    policyOutcome: "planned",
    intendedAction: "archive",
    observedAt: time.iso(),
  });

  const first = await service.dashboard(
    "tenant-1",
    "account-1",
  );
  const second = await service.dashboard(
    "tenant-1",
    "account-2",
  );

  assert.equal(first.counts.total, 1);
  assert.equal(second.counts.total, 0);
});
