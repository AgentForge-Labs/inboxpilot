import test from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_SCHEMA_VERSION,
  HostedMcpToolRegistry,
  InMemoryMcpControlPlaneUsageStore,
  registerHostedEmailAutomationTools,
  type ActionExecutionContext,
  type CanonicalMessage,
  type MailboxActionPlan,
  type McpOAuthPrincipal,
  type SemanticClassificationResult,
} from "../src/index.js";

function message(
  id: string,
  providerMessageId = id + "-provider",
): CanonicalMessage {
  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-1",
    provider: {
      kind: "gmail",
      messageId: providerMessageId,
      threadId: "provider-thread-1",
    },
    subject: "Test " + id,
    body: { text: "body", truncated: false },
    to: [],
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
    receivedAt: "2026-10-07T10:00:00.000Z",
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
    ingestedAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
  };
}

function classification(): SemanticClassificationResult {
  return {
    route: "deterministic",
    deterministic: {
      importanceScore: 88,
      priority: "important",
      confidence: 0.95,
      contributions: [],
      categoryHints: ["work"],
      actionRequiredHint: true,
      replyRequiredHint: false,
      needsLlm: false,
      llmDecisionReason: "high_confidence_important",
    },
    needsReview: false,
    quotaCharged: true,
    attempts: 0,
  };
}

function principal(
  scopes = ["mcp:tools", "mailbox:read", "mailbox:write"],
): McpOAuthPrincipal {
  return {
    grantId: "grant-1",
    clientId: "client-1",
    tenantId: "tenant-1",
    userId: "user-1",
    accountIds: ["account-1"],
    scopes,
    accessTokenExpiresAt: "2026-10-08T00:00:00.000Z",
  };
}

function setup() {
  const messages = [
    message("message-1", "provider-1"),
    message("message-2", "provider-2"),
  ];
  const plans: MailboxActionPlan[] = [];
  const contexts: ActionExecutionContext[] = [];
  let singleCalls = 0;
  let bulkCalls = 0;

  const registry = new HostedMcpToolRegistry(
    new InMemoryMcpControlPlaneUsageStore(),
  );
  registerHostedEmailAutomationTools(registry, {
    source: {
      async listMessages() {
        return messages.map((entry) =>
          structuredClone(entry),
        );
      },
    },
    classifier: {
      async classify() {
        singleCalls += 1;
        return classification();
      },
      async classifyMany(selected) {
        bulkCalls += 1;
        return {
          results: selected.map(() => classification()),
          semanticCandidates: 0,
          batchedRequests: 0,
        };
      },
    },
    executor: {
      async execute(plan, context) {
        plans.push(structuredClone(plan));
        contexts.push(structuredClone(context));
        return {
          status: "executed",
          idempotencyKey: plan.idempotencyKey,
          attempts: 1,
          beforeState: {
            canonicalMessageId: "message-1",
            provider: "gmail",
            providerMessageId: plan.providerMessageId,
            tenantId: plan.tenantId,
            accountId: plan.accountId,
            updatedAt: "2026-10-07T10:00:00.000Z",
            mailboxRoles: ["inbox"],
            mailboxIds: ["inbox"],
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
          afterStateStatus: "unavailable",
        };
      },
    },
  });

  return {
    registry,
    plans,
    contexts,
    getSingleCalls: () => singleCalls,
    getBulkCalls: () => bulkCalls,
  };
}

test("registers the seven MCP classification and mutation tools", () => {
  const { registry } = setup();
  assert.deepEqual(
    registry.list(principal()).map((tool) => tool.name),
    [
      "email_archive",
      "email_classify",
      "email_classify_bulk",
      "email_mark_important",
      "email_move",
      "email_restore",
      "email_trash",
    ],
  );
});

test("email_classify and bulk route through the canonical classifier service", async () => {
  const env = setup();
  const one = (await env.registry.call(
    "email_classify",
    {
      accountId: "account-1",
      messageId: "provider-1",
    },
    principal(),
    "request-classify",
  )) as Record<string, unknown>;
  assert.equal(one.messageId, "message-1");
  assert.equal(one.route, "deterministic");
  assert.equal(env.getSingleCalls(), 1);

  const bulk = (await env.registry.call(
    "email_classify_bulk",
    {
      accountId: "account-1",
      messageIds: ["message-1", "provider-2"],
    },
    principal(),
    "request-bulk",
  )) as {
    count: number;
    results: unknown[];
  };
  assert.equal(bulk.count, 2);
  assert.equal(bulk.results.length, 2);
  assert.equal(env.getBulkCalls(), 1);
});

test("archive uses mcp_explicit action plan and preserves request idempotency", async () => {
  const env = setup();
  const args = {
    accountId: "account-1",
    messageId: "message-1",
    idempotencyKey: "operation-123",
  };

  await env.registry.call(
    "email_archive",
    args,
    principal(),
    "request-a",
  );
  await env.registry.call(
    "email_archive",
    args,
    principal(),
    "request-b",
  );

  assert.equal(env.plans.length, 2);
  assert.equal(env.plans[0]?.source, "mcp_explicit");
  assert.equal(env.plans[0]?.action.type, "archive");
  assert.equal(
    env.plans[0]?.idempotencyKey,
    env.plans[1]?.idempotencyKey,
  );
  assert.equal(
    env.plans[0]?.preconditions?.expectedCanonicalMessageId,
    "message-1",
  );
  assert.equal(env.contexts[0]?.actorType, "mcp");
  assert.equal(env.contexts[0]?.actorId, "user-1");
});

test("trash carries explicit destructive authorization into the shared executor", async () => {
  const env = setup();
  await env.registry.call(
    "email_trash",
    {
      accountId: "account-1",
      messageId: "message-1",
      idempotencyKey: "trash-operation",
    },
    principal(),
    "request-trash",
  );

  const plan = env.plans[0]!;
  assert.equal(plan.action.type, "trash");
  assert.equal(
    plan.destructiveAuthorization?.userConfirmationId,
    "request-trash",
  );
  assert.equal(
    plan.preconditions?.requireUnprotected,
    true,
  );
});

test("mark important and move preserve canonical mutation arguments", async () => {
  const env = setup();
  await env.registry.call(
    "email_mark_important",
    {
      accountId: "account-1",
      messageId: "message-1",
      important: false,
    },
    principal(),
    "request-important",
  );
  await env.registry.call(
    "email_move",
    {
      accountId: "account-1",
      messageId: "message-1",
      folderId: "archive-2026",
    },
    principal(),
    "request-move",
  );

  assert.deepEqual(env.plans[0]?.action, {
    type: "mark_important",
    value: false,
  });
  assert.deepEqual(env.plans[1]?.action, {
    type: "move",
    folderId: "archive-2026",
  });
});

test("mutation tools require mailbox write scope while classifiers remain read-only", async () => {
  const env = setup();
  const readOnlyPrincipal = principal([
    "mcp:tools",
    "mailbox:read",
  ]);

  await env.registry.call(
    "email_classify",
    {
      accountId: "account-1",
      messageId: "message-1",
    },
    readOnlyPrincipal,
    "read-request",
  );

  await assert.rejects(
    () =>
      env.registry.call(
        "email_archive",
        {
          accountId: "account-1",
          messageId: "message-1",
        },
        readOnlyPrincipal,
        "write-request",
      ),
    /required tool scope/,
  );
});
