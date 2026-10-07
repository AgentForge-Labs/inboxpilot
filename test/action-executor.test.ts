import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_PLAN_VERSION,
  ActionAuthorizationError,
  ActionIdempotencyConflictError,
  ActionPreconditionError,
  GmailApiError,
  InMemoryActionExecutionStore,
  InMemoryOperationalTelemetry,
  MicrosoftGraphApiError,
  ProviderSafeActionExecutor,
  createActionIdempotencyKey,
  unsupportedCapabilities,
  type CanonicalMessage,
  type MailboxActionPlan,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderKind,
} from "../src/index.js";

function message(
  provider: ProviderKind = "gmail",
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  const base: CanonicalMessage = {
    schemaVersion: 1,
    id: "canonical-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-1",
    provider: {
      kind: provider,
      messageId: "provider-message-1",
      threadId: "provider-thread-1",
    },
    subject: "Test",
    body: { text: "body", truncated: false },
    to: [],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {},
    labels: [],
    mailboxes: [
      {
        id: "inbox",
        role: "inbox",
      },
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
    receivedAt: "2026-10-06T10:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["normal"],
      importanceScore: 50,
      confidence: 0.9,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-06T10:00:00.000Z",
    updatedAt: "2026-10-06T10:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    provider: overrides.provider ?? base.provider,
    flags: overrides.flags ?? base.flags,
    retention: overrides.retention ?? base.retention,
    mailboxes: overrides.mailboxes ?? base.mailboxes,
  };
}

class FakeAdapter implements ProviderAdapter {
  readonly calls: string[] = [];
  current: CanonicalMessage;
  failNext: Error | undefined;

  constructor(
    readonly kind: ProviderKind,
    private readonly caps: ProviderCapabilities,
    initial?: CanonicalMessage,
  ) {
    this.current = initial ?? message(kind);
  }

  capabilities() { return this.caps; }
  async connect() { return { connected: true as const, provider: this.kind }; }
  async listFolders() { return []; }
  async listLabels() { return []; }
  async syncChanges() {
    return { messages: [], deletedProviderMessageIds: [], hasMore: false };
  }
  async getMessage() { return structuredClone(this.current); }
  async getThread(): Promise<never> { throw new Error("unused"); }

  private maybeFail(name: string) {
    this.calls.push(name);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      throw error;
    }
  }

  async archive() { this.maybeFail("archive"); }
  async move(_id: string, target: { folderId: string }) {
    this.maybeFail(`move:${target.folderId}`);
  }
  async trash() {
    this.maybeFail("trash");
    this.current = {
      ...this.current,
      mailboxes: [{ id: "trash", role: "trash" }],
      updatedAt: "2026-10-06T10:01:00.000Z",
    };
  }
  async restore() { this.maybeFail("restore"); }
  async deletePermanent() { this.maybeFail("deletePermanent"); }
  async addLabel(_id: string, label: string) { this.maybeFail(`addLabel:${label}`); }
  async removeLabel(_id: string, label: string) { this.maybeFail(`removeLabel:${label}`); }
  async markImportant(_id: string, value = true) {
    this.maybeFail(`markImportant:${value}`);
    this.current = {
      ...this.current,
      flags: { ...this.current.flags, important: value },
      updatedAt: "2026-10-06T10:01:00.000Z",
    };
  }
  async star(_id: string, value = true) {
    this.maybeFail(`star:${value}`);
    this.current = {
      ...this.current,
      flags: { ...this.current.flags, starred: value },
      updatedAt: "2026-10-06T10:01:00.000Z",
    };
  }
  async markRead(_id: string, value = true) {
    this.maybeFail(`markRead:${value}`);
    this.current = {
      ...this.current,
      flags: { ...this.current.flags, read: value },
      updatedAt: "2026-10-06T10:01:00.000Z",
    };
  }
}

function capabilities(...supported: Parameters<typeof unsupportedCapabilities>[0]) {
  return unsupportedCapabilities(supported);
}

function plan(
  action: MailboxActionPlan["action"],
  provider: ProviderKind = "gmail",
  planId = "plan-1",
): MailboxActionPlan {
  const partial = {
    schemaVersion: ACTION_PLAN_VERSION,
    planId,
    source: "policy_engine" as const,
    tenantId: "tenant-1",
    accountId: "account-1",
    provider,
    providerMessageId: "provider-message-1",
    action,
  };
  return {
    ...partial,
    idempotencyKey: createActionIdempotencyKey(partial),
  };
}

function executor(
  adapter: ProviderAdapter,
  store = new InMemoryActionExecutionStore(),
  maxAttempts = 2,
  telemetry?: InMemoryOperationalTelemetry,
) {
  let resolves = 0;
  const instance = new ProviderSafeActionExecutor(
    {
      async resolve() {
        resolves += 1;
        return adapter;
      },
    },
    store,
    {
      maxAttempts,
      retryDelayMs: 0,
      ...(telemetry
        ? { operationalTelemetry: telemetry }
        : {}),
      now: () =>
        new Date("2026-10-07T12:00:00.000Z"),
    },
  );
  return { instance, store, getResolves: () => resolves };
}

const executionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
  actorType: "worker" as const,
  actorId: "worker-1",
};

test("raw/untrusted model output cannot be executed as an action plan", async () => {
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "markRead"),
  );
  const { instance, getResolves } = executor(adapter);

  await assert.rejects(
    () =>
      instance.execute(
        {
          ...plan({ type: "mark_read", value: true }),
          source: "llm",
        },
        executionContext,
      ),
    /source is not trusted/,
  );
  assert.equal(getResolves(), 0);
  assert.equal(adapter.calls.length, 0);
});

test("tenant/account authorization is checked before provider resolution", async () => {
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "markRead"),
  );
  const { instance, getResolves } = executor(adapter);

  await assert.rejects(
    () =>
      instance.execute(plan({ type: "mark_read", value: true }), {
        ...executionContext,
        tenantId: "another-tenant",
      }),
    ActionAuthorizationError,
  );
  assert.equal(getResolves(), 0);
});

test("successful mutation persists before/after state and deduplicates replay", async () => {
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "markRead"),
  );
  const { instance, store } = executor(adapter);
  const actionPlan = plan({ type: "mark_read", value: true });

  const first = await instance.execute(actionPlan, executionContext);
  const second = await instance.execute(actionPlan, executionContext);

  assert.equal(first.status, "executed");
  assert.equal(first.beforeState.flags.read, false);
  assert.equal(first.afterState?.flags.read, true);
  assert.equal(first.afterStateStatus, "captured");
  assert.equal(second.status, "deduplicated");
  assert.deepEqual(adapter.calls, ["markRead:true"]);

  const record = store.records.get(actionPlan.idempotencyKey);
  assert.equal(record?.status, "succeeded");
  assert.equal(record?.beforeState.flags.read, false);
  assert.equal(record?.afterState?.flags.read, true);
  assert.deepEqual(
    store.audit.map((event) => event.outcome),
    ["succeeded", "deduplicated"],
  );
});

test("same idempotency key cannot be reused for a different action plan", async () => {
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "markRead", "star"),
  );
  const { instance } = executor(adapter);
  const original = plan({ type: "mark_read", value: true });

  await instance.execute(original, executionContext);

  const conflicting = {
    ...plan({ type: "star", value: true }, "gmail", "plan-2"),
    idempotencyKey: original.idempotencyKey,
  };

  await assert.rejects(
    () => instance.execute(conflicting, executionContext),
    ActionIdempotencyConflictError,
  );
  assert.deepEqual(adapter.calls, ["markRead:true"]);
});

test("trash requires destructive authorization and rejects protected messages", async () => {
  const protectedMessage = message("gmail", {
    retention: {
      stage: "active",
      protected: true,
      protectionReasons: ["banking"],
    },
  });
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "trash"),
    protectedMessage,
  );
  const { instance } = executor(adapter);

  await assert.rejects(
    () => instance.execute(plan({ type: "trash" }), executionContext),
    ActionAuthorizationError,
  );

  const authorized = {
    ...plan({ type: "trash" }),
    destructiveAuthorization: {
      policyId: "policy-1",
      reason: "retention policy",
    },
  };
  await assert.rejects(
    () => instance.execute(authorized, executionContext),
    ActionPreconditionError,
  );
  assert.equal(adapter.calls.length, 0);
});

test("explicit expected state precondition prevents stale-plan mutation", async () => {
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "star"),
  );
  const { instance } = executor(adapter);
  const actionPlan = {
    ...plan({ type: "star", value: true }),
    preconditions: {
      expectedUpdatedAt: "2026-10-06T09:00:00.000Z",
    },
  };

  await assert.rejects(
    () => instance.execute(actionPlan, executionContext),
    /changed after action plan/,
  );
  assert.equal(adapter.calls.length, 0);
});

test("retry-safe Gmail state mutation retries transient provider failure", async () => {
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "markRead"),
  );
  adapter.failNext = new GmailApiError(503, "POST", "/messages/x/modify", "busy");
  const { instance, store } = executor(adapter, undefined, 2);

  const result = await instance.execute(
    plan({ type: "mark_read", value: true }),
    executionContext,
  );

  assert.equal(result.attempts, 2);
  assert.deepEqual(adapter.calls, ["markRead:true", "markRead:true"]);
  assert.deepEqual(
    store.audit.map((event) => event.outcome),
    ["retrying", "succeeded"],
  );
});

test("Graph move is not retried after a transient error because provider identity may change", async () => {
  const adapter = new FakeAdapter(
    "microsoft_graph",
    capabilities("getMessage", "move"),
  );
  adapter.failNext = new MicrosoftGraphApiError(
    503,
    "POST",
    "https://graph.microsoft.com/v1.0/me/messages/x/move",
    "busy",
  );
  const { instance, store } = executor(adapter, undefined, 3);
  const actionPlan = plan(
    { type: "move", folderId: "graph:archive" },
    "microsoft_graph",
  );

  await assert.rejects(
    () => instance.execute(actionPlan, executionContext),
    MicrosoftGraphApiError,
  );
  assert.deepEqual(adapter.calls, ["move:graph:archive"]);
  assert.equal(store.records.get(actionPlan.idempotencyKey)?.status, "failed");
  assert.equal(
    store.records.get(actionPlan.idempotencyKey)?.failure?.category,
    "retryable",
  );
});

test("unsupported capability is rejected before mutation is persisted", async () => {
  const adapter = new FakeAdapter(
    "mbox",
    capabilities("getMessage"),
    message("mbox"),
  );
  const { instance, store } = executor(adapter);
  const actionPlan = plan({ type: "archive" }, "mbox");

  await assert.rejects(
    () => instance.execute(actionPlan, executionContext),
    ActionPreconditionError,
  );
  assert.equal(store.records.size, 0);
});

test("idempotent action records execution then deduplication without a second provider mutation", async () => {
  const adapter = new FakeAdapter(
    "gmail",
    capabilities("getMessage", "markRead"),
  );
  const telemetry = new InMemoryOperationalTelemetry();
  const { instance } = executor(
    adapter,
    new InMemoryActionExecutionStore(),
    2,
    telemetry,
  );
  const actionPlan = plan({
    type: "mark_read",
    value: true,
  });

  const first = await instance.execute(
    actionPlan,
    executionContext,
  );
  const second = await instance.execute(
    actionPlan,
    executionContext,
  );

  assert.equal(first.status, "executed");
  assert.equal(second.status, "deduplicated");
  assert.equal(
    adapter.calls.filter((call) =>
      call.startsWith("markRead:"),
    ).length,
    1,
  );

  const metrics = telemetry.list({
    metric: "action_result",
    tenantId: "tenant-1",
    accountId: "account-1",
  });
  assert.deepEqual(
    metrics.map((event) => event.status),
    ["succeeded", "deduplicated"],
  );
  assert.deepEqual(
    metrics.map((event) => event.source),
    ["policy_engine", "policy_engine"],
  );
  assert.equal(
    JSON.stringify(metrics).includes("provider-message-1"),
    false,
  );
});

