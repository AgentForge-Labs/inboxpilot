import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_PLAN_VERSION,
  ActionAuditDashboardService,
  ExplainabilityAuditRecorder,
  InMemoryActionExecutionStore,
  InMemoryExplainabilityAuditStore,
  InMemoryShadowModeStore,
  MailboxPolicyEngine,
  ProviderSafeActionExecutor,
  ShadowModePolicyCoordinator,
  ShadowModeService,
  buildActionAuditDashboardView,
  createActionIdempotencyKey,
  parseClassifierResult,
  priorityForImportanceScore,
  sanitizeAuditText,
  unsupportedCapabilities,
  type CanonicalMessage,
  type MailboxActionPlan,
  type ProviderAdapter,
  type ProviderCapabilities,
} from "../src/index.js";

function message(): CanonicalMessage {
  return {
    schemaVersion: 1,
    id: "canonical-audit-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-1",
    provider: {
      kind: "gmail",
      messageId: "provider-audit-1",
      threadId: "provider-thread-1",
    },
    internetMessageId: "<audit@example.com>",
    subject: "Sensitive subject is not copied into audit",
    body: {
      text: "FULL BODY SECRET SHOULD NEVER APPEAR",
      html: "<p>FULL HTML SECRET</p>",
      truncated: false,
    },
    from: { address: "sender@example.com" },
    to: [{ address: "me@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {
      authorization: ["Bearer secret-header-value"],
    },
    labels: ["INBOX"],
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
    receivedAt: "2026-10-07T05:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["promotion"],
      importanceScore: 25,
      priority: "very_low",
      confidence: 0.94,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-07T05:00:00.000Z",
    updatedAt: "2026-10-07T05:01:00.000Z",
  };
}

function classification(reason = "Bulk mail with Bearer abcdefghijk secret=topsecret") {
  return parseClassifierResult({
    contractVersion: 1,
    importanceScore: 25,
    priority: priorityForImportanceScore(25),
    categories: ["promotion"],
    actionRequired: false,
    replyRequired: false,
    spamRisk: 2,
    phishingRisk: 1,
    confidence: 0.94,
    recommendedAction: "archive",
    retention: {
      disposition: "archive",
      protected: false,
      protectionReasons: [],
      archiveAfterDays: 0,
    },
    reason,
    modelVersion: "classifier-v7",
  });
}

const providerCapabilities = unsupportedCapabilities([
  "getMessage",
  "archive",
  "markRead",
]);

const policyInput = () => ({
  policyId: "policy-low-mail",
  message: message(),
  classification: classification(),
  providerCapabilities,
  planCapabilities: {
    automaticMarkImportant: true,
    automaticArchive: true,
    automaticTrash: false,
  },
});

test("policy audit contains classifier, signals, matched rule and requested action without body data", async () => {
  const store = new InMemoryExplainabilityAuditStore();
  const recorder = new ExplainabilityAuditRecorder(
    store,
    () => new Date("2026-10-07T05:10:00.000Z"),
  );
  const input = policyInput();
  const decision = new MailboxPolicyEngine().evaluate(input);

  const event = await recorder.recordPolicyDecision(
    input,
    decision,
    {
      signals: [
        {
          code: "mailing_list",
          weight: -18,
          reason: "List traffic api_key=abcdef123456",
        },
      ],
    },
  );

  assert.equal(event.kind, "policy_decision");
  assert.equal(event.classifier?.modelVersion, "classifier-v7");
  assert.equal(event.classifier?.importanceScore, 25);
  assert.deepEqual(event.classifier?.categories, ["promotion"]);
  assert.equal(event.classifier?.confidence, 0.94);
  assert.equal(event.matchedRule?.policyId, "policy-low-mail");
  assert.equal(event.requestedAction?.type, "archive");
  assert.ok(event.policyReasons.includes("archive_threshold"));
  assert.ok(
    event.signals.some(
      (signal) => signal.code === "mailing_list" && signal.weight === -18,
    ),
  );

  const serialized = JSON.stringify(
    (await store.listForAccount("tenant-1", "account-1"))[0],
  );
  assert.equal(serialized.includes("FULL BODY SECRET"), false);
  assert.equal(serialized.includes("FULL HTML SECRET"), false);
  assert.equal(serialized.includes("secret-header-value"), false);
  assert.equal(serialized.includes("topsecret"), false);
  assert.equal(serialized.includes("abcdef123456"), false);
  assert.match(event.classifier?.reason ?? "", /\[REDACTED\]/);
});

test("audit sanitizer redacts credential-like free text and rejects forbidden payload fields", async () => {
  const sanitized = sanitizeAuditText(
    "Authorization: Bearer abcdefghijklmnop",
  );
  assert.match(sanitized, /\[REDACTED\]/);
  assert.equal(sanitized.includes("abcdefghijklmnop"), false);

  const store = new InMemoryExplainabilityAuditStore();
  await assert.rejects(
    () =>
      store.append({
        version: 1,
        eventId: "bad",
        kind: "manual_decision",
        tenantId: "tenant-1",
        accountId: "account-1",
        canonicalMessageId: "m1",
        provider: "gmail",
        providerMessageId: "p1",
        actor: { type: "user" },
        timestamp: "2026-10-07T05:00:00.000Z",
        signals: [],
        policyReasons: [],
        outcome: "succeeded",
        metadata: {
          body: "must never persist",
        },
      } as never),
    /Forbidden sensitive audit field/,
  );
});

test("Shadow Mode records a planned archive as suppressed while preserving the original policy outcome", async () => {
  const auditStore = new InMemoryExplainabilityAuditStore();
  const recorder = new ExplainabilityAuditRecorder(
    auditStore,
    () => new Date("2026-10-07T05:15:00.000Z"),
  );
  const shadow = new ShadowModeService(
    new InMemoryShadowModeStore(),
    () => new Date("2026-10-07T05:15:00.000Z"),
  );
  const coordinator = new ShadowModePolicyCoordinator(
    new MailboxPolicyEngine(),
    shadow,
    () => new Date("2026-10-07T05:15:00.000Z"),
    recorder,
  );

  const evaluated = await coordinator.evaluate(policyInput());
  assert.equal(evaluated.decision.outcome, "planned");
  assert.equal(evaluated.suppressed, true);

  const [event] = await auditStore.listForMessage(
    "tenant-1",
    "account-1",
    "provider-audit-1",
  );
  assert.equal(event?.outcome, "suppressed");
  assert.equal(event?.policyOutcome, "planned");
  assert.equal(event?.requestedAction?.type, "archive");
});

class FakeAdapter implements ProviderAdapter {
  current = message();

  constructor(
    readonly kind: "gmail",
    private readonly caps: ProviderCapabilities,
  ) {}

  capabilities() { return this.caps; }
  async connect() { return { connected: true as const, provider: this.kind }; }
  async listFolders() { return []; }
  async listLabels() { return []; }
  async syncChanges() {
    return { messages: [], deletedProviderMessageIds: [], hasMore: false };
  }
  async getMessage() { return structuredClone(this.current); }
  async getThread(): Promise<never> { throw new Error("unused"); }
  async archive() { throw new Error("unused"); }
  async move() { throw new Error("unused"); }
  async trash() { throw new Error("unused"); }
  async restore() { throw new Error("unused"); }
  async deletePermanent() { throw new Error("unused"); }
  async addLabel() { throw new Error("unused"); }
  async removeLabel() { throw new Error("unused"); }
  async markImportant() { throw new Error("unused"); }
  async star() { throw new Error("unused"); }
  async markRead(_id: string, value = true) {
    this.current = {
      ...this.current,
      flags: { ...this.current.flags, read: value },
      updatedAt: "2026-10-07T05:20:00.000Z",
    };
  }
}

test("provider-safe action executor writes linked before/after explainability execution events", async () => {
  const auditStore = new InMemoryExplainabilityAuditStore();
  const recorder = new ExplainabilityAuditRecorder(auditStore);
  const adapter = new FakeAdapter(
    "gmail",
    unsupportedCapabilities(["getMessage", "markRead"]),
  );
  const executionStore = new InMemoryActionExecutionStore();
  const executor = new ProviderSafeActionExecutor(
    {
      async resolve() {
        return adapter;
      },
    },
    executionStore,
    {
      maxAttempts: 1,
      retryDelayMs: 0,
      auditRecorder: recorder,
    },
  );

  const partial = {
    schemaVersion: ACTION_PLAN_VERSION,
    planId: "plan-audit-read",
    source: "mcp_explicit" as const,
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail" as const,
    providerMessageId: "provider-audit-1",
    action: { type: "mark_read" as const, value: true },
  };
  const plan: MailboxActionPlan = {
    ...partial,
    idempotencyKey: createActionIdempotencyKey(partial),
  };

  await executor.execute(plan, {
    tenantId: "tenant-1",
    accountId: "account-1",
    actorType: "mcp",
    actorId: "chatgpt",
  });

  const [event] = await auditStore.listForPlan(
    "tenant-1",
    "account-1",
    "plan-audit-read",
  );
  assert.equal(event?.kind, "action_execution");
  assert.equal(event?.requestedAction?.type, "mark_read");
  assert.equal(event?.executedAction?.type, "mark_read");
  assert.equal(event?.actor.type, "mcp");
  assert.equal(event?.actor.id, "chatgpt");
  assert.equal(event?.beforeState?.flags.read, false);
  assert.equal(event?.afterState?.flags.read, true);
  assert.equal(event?.outcome, "succeeded");

  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("FULL BODY SECRET"), false);
  assert.equal(serialized.includes("authorization"), false);
});

test("manual decision audit captures actor, matched rule and safe state transition metadata", async () => {
  const store = new InMemoryExplainabilityAuditStore();
  const recorder = new ExplainabilityAuditRecorder(store);
  const msg = message();
  const before = {
    canonicalMessageId: msg.id,
    provider: msg.provider.kind,
    providerMessageId: msg.provider.messageId,
    tenantId: msg.tenantId,
    accountId: msg.accountId,
    updatedAt: msg.updatedAt,
    mailboxRoles: ["inbox" as const],
    mailboxIds: ["inbox"],
    labels: ["INBOX"],
    flags: { ...msg.flags },
    retention: { ...msg.retention, protectionReasons: [] },
  };

  await recorder.recordManualDecision({
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: msg.id,
    provider: "gmail",
    providerMessageId: msg.provider.messageId,
    actor: { type: "user", id: "user-1" },
    requestedAction: "keep",
    executedAction: "cancel_retention_schedule",
    outcome: "succeeded",
    matchedPolicyId: "policy-low-mail",
    reason: "User chose Keep",
    beforeState: before,
    afterState: before,
    metadata: {
      confirmationId: "confirm-1",
    },
  });

  const [event] = await store.listForMessage(
    "tenant-1",
    "account-1",
    "provider-audit-1",
  );
  assert.equal(event?.kind, "manual_decision");
  assert.equal(event?.actor.id, "user-1");
  assert.equal(event?.matchedRule?.policyId, "policy-low-mail");
  assert.equal(event?.requestedAction?.type, "keep");
  assert.equal(
    event?.executedAction?.type,
    "cancel_retention_schedule",
  );
});

test("audit dashboard exposes explainable timeline without raw content", async () => {
  const store = new InMemoryExplainabilityAuditStore();
  const recorder = new ExplainabilityAuditRecorder(store);
  const input = policyInput();
  const decision = new MailboxPolicyEngine().evaluate(input);
  await recorder.recordPolicyDecision(input, decision);

  const service = new ActionAuditDashboardService(store);
  const view = await service.explainMessage(
    "tenant-1",
    "account-1",
    "provider-audit-1",
  );
  assert.equal(view.title, "Action Audit");
  assert.equal(view.count, 1);
  assert.equal(view.rows[0]?.ruleLabel, "policy-low-mail");
  assert.equal(view.rows[0]?.requestedAction, "archive");
  assert.match(
    view.rows[0]?.classifierLabel ?? "",
    /25 · promotion · confidence 0.94/,
  );

  const direct = buildActionAuditDashboardView(
    await store.listForAccount("tenant-1", "account-1"),
  );
  assert.equal(direct.count, 1);
});
