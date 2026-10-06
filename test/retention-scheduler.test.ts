import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryRetentionJobStore,
  InMemoryRetentionMessageRepository,
  RetentionScheduler,
  resolveProviderTrashSemantics,
  unsupportedCapabilities,
  type ActionExecutionResult,
  type CanonicalMessage,
  type MailboxActionPlan,
  type RetentionActionExecutor,
  type RetentionJob,
  type RetentionPolicyRevalidator,
} from "../src/index.js";

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
    subject: "Low priority message",
    body: { text: "content", truncated: false },
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
    receivedAt: "2026-10-01T10:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["promotion"],
      importanceScore: 8,
      confidence: 0.95,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
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

class RecordingExecutor implements RetentionActionExecutor {
  readonly plans: MailboxActionPlan[] = [];

  async execute(
    plan: MailboxActionPlan,
  ): Promise<ActionExecutionResult> {
    this.plans.push(structuredClone(plan));
    return {
      status: "executed",
      idempotencyKey: plan.idempotencyKey,
      attempts: 1,
      beforeState: {
        canonicalMessageId: plan.providerMessageId.replace(
          "provider-",
          "",
        ),
        provider: plan.provider,
        providerMessageId: plan.providerMessageId,
        tenantId: plan.tenantId,
        accountId: plan.accountId,
        updatedAt: "2026-10-01T10:00:00.000Z",
        mailboxRoles: [],
        mailboxIds: [],
        labels: [],
        flags: {
          read: false,
          starred: false,
          important: false,
          draft: false,
          answered: false,
          forwarded: false,
        },
        retention: {
          stage: "active",
          protected: false,
          protectionReasons: [],
        },
      },
      afterState: null,
      afterStateStatus:
        plan.action.type === "delete_permanent"
          ? "deleted"
          : "unavailable",
    };
  }
}

class RecordingPolicy implements RetentionPolicyRevalidator {
  readonly calls: Array<{
    action: "trash" | "delete_permanent";
    stage: CanonicalMessage["retention"]["stage"];
  }> = [];
  allowTrash = true;
  allowDelete = true;

  async evaluate(
    current: CanonicalMessage,
    action: "trash" | "delete_permanent",
  ) {
    this.calls.push({
      action,
      stage: current.retention.stage,
    });
    const allowed =
      action === "trash" ? this.allowTrash : this.allowDelete;
    return {
      allowed,
      reason: allowed
        ? "current policy still allows " + action
        : "current policy blocks " + action,
      policyId: "policy-1",
    };
  }
}

function setup(options?: {
  provider?: CanonicalMessage["provider"]["kind"];
  deletePermanent?: boolean;
  now?: string;
}) {
  let nowMs = Date.parse(
    options?.now ?? "2026-10-06T10:00:00.000Z",
  );
  const msg = message("m1", {
    provider: {
      kind: options?.provider ?? "gmail",
      messageId: "provider-m1",
      threadId: "provider-thread-m1",
    },
  });
  const messages = new InMemoryRetentionMessageRepository();
  messages.seed(msg);
  const jobs = new InMemoryRetentionJobStore();
  const policy = new RecordingPolicy();
  const actions = new RecordingExecutor();
  const capabilities = unsupportedCapabilities([
    "getMessage",
    "archive",
    "trash",
    ...(options?.deletePermanent === false
      ? []
      : ["deletePermanent" as const]),
  ]);
  const semantics = resolveProviderTrashSemantics(
    msg.provider.kind,
    capabilities,
  );
  const scheduler = new RetentionScheduler(
    jobs,
    messages,
    policy,
    actions,
    () => new Date(nowMs),
  );
  return {
    scheduler,
    jobs,
    messages,
    policy,
    actions,
    semantics,
    msg,
    advanceDays(days: number) {
      nowMs += days * 24 * 60 * 60 * 1000;
    },
    now() {
      return new Date(nowMs).toISOString();
    },
  };
}

async function scheduled(
  env: ReturnType<typeof setup>,
  options?: {
    archiveRetentionDays?: number;
    trashRetentionDays?: number;
    allowPermanentDelete?: boolean;
  },
) {
  return env.scheduler.schedule({
    message: env.msg,
    policyId: "policy-1",
    config: {
      archiveRetentionDays:
        options?.archiveRetentionDays ?? 10,
      trashRetentionDays:
        options?.trashRetentionDays ?? 20,
      allowPermanentDelete:
        options?.allowPermanentDelete ?? true,
    },
    trashSemantics: env.semantics,
  });
}

test("retention lifecycle archives, waits, trashes, waits, then permanently deletes", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 10,
    trashRetentionDays: 20,
  });

  assert.equal(job.nextAction, "archive");
  assert.equal(job.nextRunAt, env.now());

  let result = await env.scheduler.run(job.id);
  assert.equal(result.outcome, "archived");
  job = result.job;
  assert.equal(job.nextAction, "trash");
  assert.equal(
    job.nextRunAt,
    "2026-10-16T10:00:00.000Z",
  );
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive"],
  );
  assert.equal(env.policy.calls.length, 0);

  const archived = await env.messages.get(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.equal(archived?.retention.stage, "archived");
  assert.equal(
    archived?.retention.archiveAt,
    "2026-10-06T10:00:00.000Z",
  );

  result = await env.scheduler.run(job.id);
  assert.equal(result.outcome, "not_due");

  env.advanceDays(10);
  result = await env.scheduler.run(job.id);
  assert.equal(result.outcome, "trashed");
  job = result.job;
  assert.equal(job.nextAction, "delete_permanent");
  assert.equal(
    job.nextRunAt,
    "2026-11-05T10:00:00.000Z",
  );
  assert.deepEqual(
    env.policy.calls.map((call) => call.action),
    ["trash"],
  );

  const trashed = await env.messages.get(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.equal(trashed?.retention.stage, "trashed");
  assert.equal(
    trashed?.retention.trashAt,
    "2026-10-16T10:00:00.000Z",
  );

  env.advanceDays(20);
  result = await env.scheduler.run(job.id);
  assert.equal(result.outcome, "deleted");
  assert.equal(result.job.status, "completed");
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive", "trash", "delete_permanent"],
  );
  assert.deepEqual(
    env.policy.calls.map((call) => call.action),
    ["trash", "delete_permanent"],
  );

  const deleted = await env.messages.get(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.equal(deleted?.retention.stage, "deleted");
  assert.equal(
    deleted?.retention.deleteAt,
    "2026-11-05T10:00:00.000Z",
  );
});

test("trash and permanent delete plans carry policy authorization and system-retention source", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 0,
    trashRetentionDays: 0,
  });

  job = (await env.scheduler.run(job.id)).job;
  job = (await env.scheduler.run(job.id)).job;
  await env.scheduler.run(job.id);

  const [, trash, permanentDelete] = env.actions.plans;
  assert.equal(trash?.source, "system_retention");
  assert.equal(
    trash?.destructiveAuthorization?.policyId,
    "policy-1",
  );
  assert.equal(
    trash?.preconditions?.requireUnprotected,
    true,
  );
  assert.equal(permanentDelete?.source, "system_retention");
  assert.equal(
    permanentDelete?.destructiveAuthorization?.policyId,
    "policy-1",
  );
  assert.equal(
    permanentDelete?.preconditions?.requiredMailboxRole,
    "trash",
  );
});

test("policy is re-evaluated before trash and can block without provider mutation", async () => {
  const env = setup();
  env.policy.allowTrash = false;
  let job = await scheduled(env, {
    archiveRetentionDays: 0,
  });

  job = (await env.scheduler.run(job.id)).job;
  const result = await env.scheduler.run(job.id);

  assert.equal(result.outcome, "blocked");
  assert.equal(result.job.status, "blocked");
  assert.match(
    result.job.blockedReason ?? "",
    /blocks trash/,
  );
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive"],
  );
  assert.deepEqual(
    env.policy.calls.map((call) => call.action),
    ["trash"],
  );
});

test("policy is re-evaluated again before permanent delete", async () => {
  const env = setup();
  env.policy.allowDelete = false;
  let job = await scheduled(env, {
    archiveRetentionDays: 0,
    trashRetentionDays: 0,
  });

  job = (await env.scheduler.run(job.id)).job;
  job = (await env.scheduler.run(job.id)).job;
  const result = await env.scheduler.run(job.id);

  assert.equal(result.outcome, "blocked");
  assert.equal(result.job.status, "blocked");
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive", "trash"],
  );
  assert.deepEqual(
    env.policy.calls.map((call) => call.action),
    ["trash", "delete_permanent"],
  );
  const current = await env.messages.get(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.equal(current?.retention.stage, "trashed");
});

test("restore cancels pending deletion and returns retention state to active", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 0,
    trashRetentionDays: 30,
  });

  job = (await env.scheduler.run(job.id)).job;
  job = (await env.scheduler.run(job.id)).job;
  assert.equal(job.nextAction, "delete_permanent");

  const cancelled = await env.scheduler.cancelOnRestore(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.equal(cancelled?.status, "cancelled");

  const current = await env.messages.get(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.equal(current?.retention.stage, "active");

  env.advanceDays(30);
  const result = await env.scheduler.run(job.id);
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive", "trash"],
  );
});

test("external restore is detected before next destructive stage", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 1,
  });
  job = (await env.scheduler.run(job.id)).job;

  const current = await env.messages.get(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.ok(current);
  await env.messages.updateRetention(
    "tenant-1",
    "account-1",
    "provider-m1",
    {
      stage: "active",
      protected: false,
      protectionReasons: [],
      lastTransitionAt: "2026-10-06T12:00:00.000Z",
    },
  );

  env.advanceDays(1);
  const result = await env.scheduler.run(job.id);
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive"],
  );
});

test("message becoming protected blocks the next retention mutation", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 1,
  });
  job = (await env.scheduler.run(job.id)).job;

  const current = await env.messages.get(
    "tenant-1",
    "account-1",
    "provider-m1",
  );
  assert.ok(current);
  await env.messages.updateRetention(
    "tenant-1",
    "account-1",
    "provider-m1",
    {
      ...current.retention,
      protected: true,
      protectionReasons: ["new legal hold"],
      lastTransitionAt: "2026-10-06T13:00:00.000Z",
    },
  );

  env.advanceDays(1);
  const result = await env.scheduler.run(job.id);
  assert.equal(result.outcome, "blocked");
  assert.equal(result.job.status, "blocked");
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive"],
  );
});

test("Gmail provider-managed Trash is explicit when permanent delete capability is unavailable", async () => {
  const env = setup({
    provider: "gmail",
    deletePermanent: false,
  });
  assert.equal(
    env.semantics.behavior,
    "provider_managed_expiry",
  );
  assert.equal(env.semantics.providerAutoDeleteAfterDays, 30);
  assert.equal(env.semantics.permanentDeleteSupported, false);

  let job = await scheduled(env, {
    archiveRetentionDays: 0,
    allowPermanentDelete: true,
  });
  job = (await env.scheduler.run(job.id)).job;
  const result = await env.scheduler.run(job.id);

  assert.equal(result.outcome, "provider_managed");
  assert.equal(result.job.status, "provider_managed");
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive", "trash"],
  );
});

test("without permanent-delete opt-in lifecycle completes after Trash", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 0,
    allowPermanentDelete: false,
  });
  job = (await env.scheduler.run(job.id)).job;
  const result = await env.scheduler.run(job.id);

  assert.equal(result.outcome, "trashed");
  assert.equal(result.job.status, "completed");
  assert.equal(result.job.nextAction, undefined);
  assert.deepEqual(
    env.actions.plans.map((plan) => plan.action.type),
    ["archive", "trash"],
  );
});

test("unknown provider semantics never pretend permanent deletion succeeded", async () => {
  const env = setup({
    provider: "imap",
    deletePermanent: false,
  });
  assert.equal(env.semantics.behavior, "unknown");

  let job = await scheduled(env, {
    archiveRetentionDays: 0,
    allowPermanentDelete: true,
  });
  job = (await env.scheduler.run(job.id)).job;
  const result = await env.scheduler.run(job.id);

  assert.equal(result.outcome, "blocked");
  assert.match(
    result.job.blockedReason ?? "",
    /no explicit delete capability/,
  );
});

test("schedule is idempotent while an active job exists", async () => {
  const env = setup();
  const first = await scheduled(env);
  const second = await scheduled(env);

  assert.equal(second.id, first.id);
  assert.equal(env.jobs.jobs.size, 1);
});

test("runDue only processes jobs whose nextRunAt has arrived", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 2,
  });

  let due = await env.scheduler.runDue();
  assert.equal(due.length, 1);
  job = due[0]!.job;
  assert.equal(due[0]!.outcome, "archived");

  due = await env.scheduler.runDue();
  assert.equal(due.length, 0);

  env.advanceDays(2);
  due = await env.scheduler.runDue();
  assert.equal(due.length, 1);
  assert.equal(due[0]!.outcome, "trashed");
});

test("retention audit records successful transitions and policy decisions with timestamps", async () => {
  const env = setup();
  let job = await scheduled(env, {
    archiveRetentionDays: 0,
    trashRetentionDays: 0,
  });
  job = (await env.scheduler.run(job.id)).job;
  job = (await env.scheduler.run(job.id)).job;
  await env.scheduler.run(job.id);

  const eventNames = env.jobs.audit.map((event) => event.event);
  assert.deepEqual(eventNames, [
    "scheduled",
    "action_planned",
    "action_succeeded",
    "action_planned",
    "action_succeeded",
    "action_planned",
    "action_succeeded",
    "completed",
  ]);
  assert.ok(
    env.jobs.audit.every(
      (event) => !Number.isNaN(Date.parse(event.timestamp)),
    ),
  );
  assert.equal(
    env.jobs.audit.find(
      (event) =>
        event.event === "action_succeeded" &&
        event.action === "trash",
    )?.providerTrashBehavior,
    "provider_managed_expiry",
  );
});

test("protected messages cannot enter automatic retention cleanup", async () => {
  const env = setup();
  env.msg.retention = {
    stage: "active",
    protected: true,
    protectionReasons: ["security"],
  };

  await assert.rejects(
    () => scheduled(env),
    /Protected message cannot enter/,
  );
});
