import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryPersonalLearningStore,
  InMemoryRetentionJobStore,
  InMemoryRetentionMessageRepository,
  PendingDeleteReviewService,
  PersonalLearningEngine,
  RetentionScheduler,
  buildPendingDeleteDashboardViewModel,
  snapshotMessage,
  type ActionExecutionResult,
  type CanonicalMessage,
  type MailboxActionPlan,
  type RetentionActionExecutor,
  type RetentionJob,
  type RetentionPolicyRevalidator,
} from "../src/index.js";

function message(
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  const base: CanonicalMessage = {
    schemaVersion: 1,
    id: "m1",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-1",
    provider: { kind: "imap", messageId: "provider-m1" },
    subject: "Sale reminder",
    body: { text: "Promotion", truncated: false },
    from: { name: "Shop", address: "Deals@Example.com" },
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
    receivedAt: "2026-10-05T08:30:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      importanceScore: 8,
      priority: "disposable",
      categories: ["promotion"],
      confidence: 0.96,
      reason: "Repeated promotional mail with no user interaction.",
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
      policyId: "policy-low-value",
    },
    providerMetadata: {},
    ingestedAt: "2026-10-05T08:31:00.000Z",
    updatedAt: "2026-10-05T08:31:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    provider: overrides.provider ?? base.provider,
    body: overrides.body ?? base.body,
    classification: overrides.classification ?? base.classification,
    retention: overrides.retention ?? base.retention,
    mailboxes: overrides.mailboxes ?? base.mailboxes,
  };
}

function retentionJob(
  overrides: Partial<RetentionJob> = {},
): RetentionJob {
  return {
    id: overrides.id ?? "job-1",
    version: 1,
    tenantId: overrides.tenantId ?? "tenant-1",
    accountId: overrides.accountId ?? "account-1",
    canonicalMessageId: "m1",
    provider: overrides.provider ?? "imap",
    providerMessageId: "provider-m1",
    policyId: "policy-low-value",
    status: overrides.status ?? "scheduled",
    nextAction: overrides.nextAction ?? "archive",
    nextRunAt:
      overrides.nextRunAt ?? "2026-10-10T12:00:00.000Z",
    config: {
      archiveRetentionDays: 5,
      trashRetentionDays: 10,
      allowPermanentDelete: true,
    },
    trashSemantics:
      overrides.trashSemantics ?? {
        provider: overrides.provider ?? "imap",
        behavior: "explicit_permanent_delete",
        permanentDeleteSupported: true,
        note: "test",
      },
    createdAt: "2026-10-06T12:00:00.000Z",
    updatedAt: "2026-10-06T12:00:00.000Z",
  };
}

class Executor implements RetentionActionExecutor {
  constructor(
    private readonly repo: InMemoryRetentionMessageRepository,
  ) {}
  async execute(plan: MailboxActionPlan): Promise<ActionExecutionResult> {
    const msg = await this.repo.get(
      plan.tenantId,
      plan.accountId,
      plan.providerMessageId,
    );
    if (!msg) throw new Error("missing message");
    return {
      status: "executed",
      idempotencyKey: plan.idempotencyKey,
      attempts: 1,
      beforeState: snapshotMessage(msg),
      afterState: null,
      afterStateStatus: "unavailable",
    };
  }
}

const policy: RetentionPolicyRevalidator = {
  async evaluate(_message, action, job) {
    return {
      allowed: true,
      reason: "allow " + action,
      policyId: job.policyId,
    };
  },
};

async function serviceFor(
  msg: CanonicalMessage,
  jobsToSeed: RetentionJob[],
) {
  const jobs = new InMemoryRetentionJobStore();
  const messages = new InMemoryRetentionMessageRepository();
  messages.seed(msg);
  for (const item of jobsToSeed) await jobs.create(item);
  const executor = new Executor(messages);
  const scheduler = new RetentionScheduler(
    jobs,
    messages,
    policy,
    executor,
    () => new Date("2026-10-06T12:00:00.000Z"),
  );
  const service = new PendingDeleteReviewService(
    jobs,
    messages,
    scheduler,
    executor,
    new PersonalLearningEngine(
      new InMemoryPersonalLearningStore(),
    ),
    () => new Date("2026-10-06T12:00:00.000Z"),
  );
  return { service, jobs, messages };
}

test("review queue projects all required message and schedule fields", async () => {
  const env = await serviceFor(message(), [retentionJob()]);
  const [item] = await env.service.list(
    "tenant-1",
    "account-1",
  );
  assert.ok(item);
  assert.equal(item.sender, "deals@example.com");
  assert.equal(item.senderName, "Shop");
  assert.equal(item.subject, "Sale reminder");
  assert.equal(item.importanceScore, 8);
  assert.equal(item.priority, "disposable");
  assert.deepEqual(item.categories, ["promotion"]);
  assert.equal(
    item.explanation,
    "Repeated promotional mail with no user interaction.",
  );
  assert.equal(item.matchedRule.id, "policy-low-value");
  assert.equal(
    item.scheduledTrashAt,
    "2026-10-15T12:00:00.000Z",
  );
  assert.equal(
    item.scheduledPermanentDeleteAt,
    "2026-10-25T12:00:00.000Z",
  );
});

test("provider-managed expiry is not mislabeled as InboxPilot permanent delete", async () => {
  const msg = message({
    provider: { kind: "gmail", messageId: "provider-m1" },
    retention: {
      stage: "trashed",
      protected: false,
      protectionReasons: [],
      policyId: "policy-low-value",
      trashAt: "2026-10-06T12:00:00.000Z",
    },
    mailboxes: [{ id: "TRASH", role: "trash" }],
  });
  const j = retentionJob({
    provider: "gmail",
    status: "provider_managed",
    trashSemantics: {
      provider: "gmail",
      behavior: "provider_managed_expiry",
      permanentDeleteSupported: false,
      providerAutoDeleteAfterDays: 30,
      note: "gmail",
    },
  });
  delete j.nextAction;
  delete j.nextRunAt;

  const env = await serviceFor(msg, [j]);
  const [item] = await env.service.list(
    "tenant-1",
    "account-1",
  );
  assert.ok(item);
  assert.equal(item.scheduledPermanentDeleteAt, undefined);
  assert.equal(
    item.providerManagedExpiryAt,
    "2026-11-05T12:00:00.000Z",
  );
  assert.equal(
    item.actions.find((action) => action.key === "delete_now")
      ?.enabled,
    false,
  );
});

test("inactive jobs and other accounts are excluded", async () => {
  const env = await serviceFor(message(), [
    retentionJob({ id: "active" }),
    retentionJob({ id: "cancelled", status: "cancelled" }),
    retentionJob({ id: "completed", status: "completed" }),
    retentionJob({
      id: "other",
      accountId: "account-2",
    }),
  ]);
  const items = await env.service.list(
    "tenant-1",
    "account-1",
  );
  assert.deepEqual(items.map((item) => item.jobId), ["active"]);
});

test("dashboard view model contains review data and all six controls", async () => {
  const env = await serviceFor(message(), [retentionJob()]);
  const view = buildPendingDeleteDashboardViewModel(
    await env.service.list("tenant-1", "account-1"),
  );
  assert.equal(view.title, "Pending Delete");
  assert.equal(view.count, 1);
  assert.equal(view.rows[0]?.sender, "Shop <deals@example.com>");
  assert.equal(view.rows[0]?.scoreLabel, "8 · disposable");
  assert.deepEqual(
    view.rows[0]?.actions.map((action) => action.key),
    [
      "keep",
      "restore_to_inbox",
      "never_delete_sender",
      "never_delete_domain",
      "change_rule",
      "delete_now",
    ],
  );
});
