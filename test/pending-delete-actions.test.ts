import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryPersonalLearningStore,
  InMemoryRetentionJobStore,
  InMemoryRetentionMessageRepository,
  PendingDeleteReviewService,
  PersonalLearningEngine,
  RetentionScheduler,
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
    subject: "Low value mail",
    body: { text: "Promotion", truncated: false },
    from: { address: "Deals@Example.com" },
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
    receivedAt: "2026-10-05T08:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      importanceScore: 8,
      priority: "disposable",
      categories: ["promotion"],
      confidence: 0.95,
      reason: "Low-value promotion",
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
      policyId: "policy-low",
    },
    providerMetadata: {},
    ingestedAt: "2026-10-05T08:00:00.000Z",
    updatedAt: "2026-10-05T08:00:00.000Z",
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
    version: overrides.version ?? 1,
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "m1",
    provider: overrides.provider ?? "imap",
    providerMessageId: "provider-m1",
    policyId: "policy-low",
    status: overrides.status ?? "scheduled",
    nextAction: overrides.nextAction ?? "archive",
    nextRunAt:
      overrides.nextRunAt ?? "2026-11-01T12:00:00.000Z",
    config:
      overrides.config ?? {
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

class RecordingExecutor implements RetentionActionExecutor {
  readonly plans: MailboxActionPlan[] = [];

  constructor(
    private readonly repo: InMemoryRetentionMessageRepository,
  ) {}

  async execute(
    plan: MailboxActionPlan,
  ): Promise<ActionExecutionResult> {
    this.plans.push(structuredClone(plan));
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
      afterStateStatus:
        plan.action.type === "delete_permanent"
          ? "deleted"
          : "unavailable",
    };
  }
}

class AllowPolicy implements RetentionPolicyRevalidator {
  readonly calls: string[] = [];

  async evaluate(
    _message: CanonicalMessage,
    action: "trash" | "delete_permanent",
    currentJob: RetentionJob,
  ) {
    this.calls.push(action);
    return {
      allowed: true,
      reason: "allow " + action,
      policyId: currentJob.policyId,
    };
  }
}

async function setup(
  msg = message(),
  currentJob = retentionJob(),
) {
  const jobs = new InMemoryRetentionJobStore();
  const messages = new InMemoryRetentionMessageRepository();
  messages.seed(msg);
  await jobs.create(currentJob);

  const policy = new AllowPolicy();
  const executor = new RecordingExecutor(messages);
  const now = () => new Date("2026-10-06T12:00:00.000Z");
  const scheduler = new RetentionScheduler(
    jobs,
    messages,
    policy,
    executor,
    now,
  );
  const learning = new PersonalLearningEngine(
    new InMemoryPersonalLearningStore(),
  );
  const service = new PendingDeleteReviewService(
    jobs,
    messages,
    scheduler,
    executor,
    learning,
    now,
  );
  return {
    jobs,
    messages,
    policy,
    executor,
    scheduler,
    learning,
    service,
  };
}

test("Keep cancels the current schedule without moving an active inbox message", async () => {
  const env = await setup();
  const result = await env.service.keep("job-1", "user-1");

  assert.equal(result.outcome, "kept");
  assert.equal(env.executor.plans.length, 0);
  assert.equal((await env.jobs.get("job-1"))?.status, "cancelled");
  assert.equal(
    env.jobs.audit.find(
      (event) => event.event === "review_cancelled",
    )?.actorId,
    "user-1",
  );
});

test("Keep restores provider-managed Trash before cancelling expiry", async () => {
  const msg = message({
    provider: { kind: "gmail", messageId: "provider-m1" },
    retention: {
      stage: "trashed",
      protected: false,
      protectionReasons: [],
      policyId: "policy-low",
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

  const env = await setup(msg, j);
  await env.service.keep("job-1", "user-1");

  assert.deepEqual(
    env.executor.plans.map((plan) => plan.action.type),
    ["restore"],
  );
  assert.equal(
    (
      await env.messages.get(
        "tenant-1",
        "account-1",
        "provider-m1",
      )
    )?.retention.stage,
    "active",
  );
  assert.equal((await env.jobs.get("job-1"))?.status, "cancelled");
});

test("Restore to Inbox uses user-confirmed provider action and cancels retention", async () => {
  const msg = message({
    retention: {
      stage: "archived",
      protected: false,
      protectionReasons: [],
      policyId: "policy-low",
      archiveAt: "2026-10-06T10:00:00.000Z",
    },
    mailboxes: [{ id: "archive", role: "archive" }],
  });
  const env = await setup(
    msg,
    retentionJob({
      nextAction: "trash",
      nextRunAt: "2026-10-20T12:00:00.000Z",
    }),
  );

  await env.service.restoreToInbox("job-1", "user-1");

  assert.equal(env.executor.plans[0]?.source, "user_confirmed");
  assert.equal(env.executor.plans[0]?.action.type, "restore");
  assert.equal((await env.jobs.get("job-1"))?.status, "cancelled");
  assert.equal(
    (
      await env.messages.get(
        "tenant-1",
        "account-1",
        "provider-m1",
      )
    )?.retention.stage,
    "active",
  );
});

test("Never delete sender creates explicit sender protection and cancels job", async () => {
  const env = await setup();

  await env.service.neverDeleteSender("job-1", "user-1");

  const profile = await env.learning.profile(
    "tenant-1",
    "account-1",
  );
  assert.ok(
    profile.features.some(
      (feature) =>
        feature.kind === "never_delete" &&
        feature.scope === "sender" &&
        feature.key === "deals@example.com" &&
        feature.explicit,
    ),
  );
  assert.equal((await env.jobs.get("job-1"))?.status, "cancelled");
});

test("Never delete domain creates explicit domain protection", async () => {
  const env = await setup();

  await env.service.neverDeleteDomain("job-1", "user-1");

  const profile = await env.learning.profile(
    "tenant-1",
    "account-1",
  );
  assert.ok(
    profile.features.some(
      (feature) =>
        feature.kind === "never_delete" &&
        feature.scope === "domain" &&
        feature.key === "example.com" &&
        feature.explicit,
    ),
  );
});

test("Change rule returns the matched policy edit intent", async () => {
  const env = await setup();

  assert.deepEqual(await env.service.changeRule("job-1"), {
    kind: "edit_rule",
    tenantId: "tenant-1",
    accountId: "account-1",
    jobId: "job-1",
    policyId: "policy-low",
  });
});

test("Delete now cannot skip an Archive stage", async () => {
  const env = await setup();

  const [item] = await env.service.list(
    "tenant-1",
    "account-1",
  );
  assert.equal(
    item?.actions.find((action) => action.key === "delete_now")
      ?.enabled,
    false,
  );

  await assert.rejects(
    () =>
      env.service.deleteNow({
        jobId: "job-1",
        actorId: "user-1",
        userConfirmationId: "confirm-1",
      }),
    /scheduled destructive retention stage/,
  );
});

test("Delete now expedites only the current Trash stage and audits explicit confirmation", async () => {
  const msg = message({
    retention: {
      stage: "archived",
      protected: false,
      protectionReasons: [],
      policyId: "policy-low",
      archiveAt: "2026-10-05T12:00:00.000Z",
    },
    mailboxes: [{ id: "archive", role: "archive" }],
  });
  const env = await setup(
    msg,
    retentionJob({
      nextAction: "trash",
      nextRunAt: "2026-11-01T12:00:00.000Z",
      config: {
        archiveRetentionDays: 5,
        trashRetentionDays: 10,
        allowPermanentDelete: true,
      },
    }),
  );

  const result = await env.service.deleteNow({
    jobId: "job-1",
    actorId: "user-1",
    userConfirmationId: "confirm-now",
  });

  assert.equal(result.retentionResult?.outcome, "trashed");
  assert.deepEqual(env.policy.calls, ["trash"]);
  assert.deepEqual(
    env.executor.plans.map((plan) => plan.action.type),
    ["trash"],
  );

  const current = await env.jobs.get("job-1");
  assert.equal(current?.nextAction, "delete_permanent");
  assert.equal(
    current?.nextRunAt,
    "2026-10-16T12:00:00.000Z",
  );

  const audit = env.jobs.audit.find(
    (event) => event.event === "expedited_by_user",
  );
  assert.equal(audit?.actorId, "user-1");
  assert.equal(audit?.userConfirmationId, "confirm-now");
});

test("Delete now requires explicit actor and confirmation IDs", async () => {
  const env = await setup(
    message({
      retention: {
        stage: "archived",
        protected: false,
        protectionReasons: [],
        policyId: "policy-low",
      },
    }),
    retentionJob({
      nextAction: "trash",
      nextRunAt: "2026-11-01T12:00:00.000Z",
    }),
  );

  await assert.rejects(
    () =>
      env.service.deleteNow({
        jobId: "job-1",
        actorId: "",
        userConfirmationId: "",
      }),
    /requires actorId and userConfirmationId/,
  );
});
