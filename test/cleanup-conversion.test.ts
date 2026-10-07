import test from "node:test";
import assert from "node:assert/strict";
import {
  CleanupConversionService,
  HostedMcpToolRegistry,
  InMemoryCleanupOpportunityStore,
  InMemoryCustomerUsageStore,
  InMemoryMcpControlPlaneUsageStore,
  InMemoryShadowModeStore,
  InMemoryTenantPlanStore,
  MailboxPolicyEngine,
  PlanEntitlementService,
  ShadowModePolicyCoordinator,
  ShadowModeService,
  parseClassifierResult,
  priorityForImportanceScore,
  registerHostedEmailAutomationTools,
  unsupportedCapabilities,
  type ActionExecutionContext,
  type CanonicalMessage,
  type MailboxActionPlan,
  type McpOAuthPrincipal,
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
  };
}

function message(
  id: string,
  providerMessageId = "provider-" + id,
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
      messageId: providerMessageId,
    },
    subject: "Cleanup conversion fixture",
    body: {
      text: "private body",
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
      confidence: 0.98,
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
  action: "archive" | "trash",
) {
  const score = action === "trash" ? 5 : 20;
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
    confidence: 0.98,
    recommendedAction: action,
    retention: {
      disposition:
        action === "trash"
          ? "trash_later"
          : "archive",
      protected: false,
      protectionReasons: [],
      ...(action === "trash"
        ? { trashAfterDays: 30 }
        : { archiveAfterDays: 0 }),
    },
    reason: "Cleanup conversion test",
  });
}

const providerCapabilities =
  unsupportedCapabilities([
    "getMessage",
    "markImportant",
    "archive",
    "trash",
  ]);

const requestedAutomation = {
  automaticMarkImportant: true,
  automaticArchive: true,
  automaticTrash: true,
};

async function enabledShadow(
  time: ReturnType<typeof clock>,
) {
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
  return shadow;
}

test("Free blocks unattended archive/trash and records a unique conversion opportunity", async () => {
  const time = clock();
  const shadow = await enabledShadow(time);
  const plans = new PlanEntitlementService(
    new InMemoryTenantPlanStore(),
    new InMemoryCustomerUsageStore(),
    time.now,
  );
  const cleanup =
    new CleanupConversionService(
      new InMemoryCleanupOpportunityStore(),
      time.now,
    );
  const coordinator =
    new ShadowModePolicyCoordinator(
      new MailboxPolicyEngine(),
      shadow,
      time.now,
      undefined,
      plans,
      cleanup,
    );

  const input = {
    policyId: "cleanup-policy",
    message: message("free-archive"),
    classification:
      classification("archive"),
    providerCapabilities,
    planCapabilities:
      requestedAutomation,
  };

  const first =
    await coordinator.evaluate(input);
  assert.equal(first.decision.plan, undefined);
  assert.equal(
    first.executablePlan,
    undefined,
  );
  assert.ok(
    first.decision.reasons.includes(
      "plan_capability_missing",
    ),
  );

  await coordinator.evaluate(input);
  const summary = await cleanup.summary(
    "tenant-1",
    {
      at: time.now(),
    },
  );
  assert.equal(summary.total, 1);
  assert.equal(summary.wouldArchive, 1);
  assert.equal(summary.wouldDelete, 0);
  assert.equal(
    summary.message,
    "1 email this month could have been automatically cleaned up.",
  );
});

test("cleanup conversion counter deduplicates provider messages and supports the 427-email dashboard message", async () => {
  const store =
    new InMemoryCleanupOpportunityStore();
  const cleanup =
    new CleanupConversionService(
      store,
      () =>
        new Date(
          "2026-10-07T12:00:00.000Z",
        ),
    );

  for (let index = 0; index < 427; index += 1) {
    await cleanup.record(
      message(
        "canonical-" + index,
        "provider-" + index,
      ),
      index % 2 === 0
        ? "archive"
        : "trash",
    );
  }
  await cleanup.record(
    message(
      "canonical-retry",
      "provider-0",
    ),
    "trash",
  );

  const summary = await cleanup.summary(
    "tenant-1",
    {
      at:
        "2026-10-07T12:00:00.000Z",
    },
  );
  assert.equal(summary.total, 427);
  assert.equal(
    summary.message,
    "427 emails this month could have been automatically cleaned up.",
  );
  assert.equal(
    summary.wouldArchive +
      summary.wouldDelete,
    427,
  );
});

test("Personal paid entitlement restores unattended cleanup without recording conversion pressure", async () => {
  const time = clock();
  const shadow = await enabledShadow(time);
  const planStore =
    new InMemoryTenantPlanStore();
  const plans = new PlanEntitlementService(
    planStore,
    new InMemoryCustomerUsageStore(),
    time.now,
  );
  await plans.assignPlan(
    "tenant-1",
    "personal",
  );
  const cleanup =
    new CleanupConversionService(
      new InMemoryCleanupOpportunityStore(),
      time.now,
    );
  const coordinator =
    new ShadowModePolicyCoordinator(
      new MailboxPolicyEngine(),
      shadow,
      time.now,
      undefined,
      plans,
      cleanup,
    );

  const result =
    await coordinator.evaluate({
      policyId: "paid-cleanup",
      message: message("paid-archive"),
      classification:
        classification("archive"),
      providerCapabilities,
      planCapabilities:
        requestedAutomation,
    });

  assert.equal(
    result.executablePlan?.action.type,
    "archive",
  );
  assert.equal(
    (
      await cleanup.summary(
        "tenant-1",
        { at: time.now() },
      )
    ).total,
    0,
  );
});

function principal(): McpOAuthPrincipal {
  return {
    grantId: "grant-1",
    clientId: "client-1",
    tenantId: "tenant-1",
    userId: "user-1",
    accountIds: ["account-1"],
    scopes: [
      "mcp:tools",
      "mailbox:read",
      "mailbox:write",
    ],
    accessTokenExpiresAt:
      "2026-10-08T00:00:00.000Z",
  };
}

test("Free keeps explicit manual MCP archive and trash actions available", async () => {
  const plans: MailboxActionPlan[] = [];
  const contexts:
    ActionExecutionContext[] = [];
  const registry =
    new HostedMcpToolRegistry(
      new InMemoryMcpControlPlaneUsageStore(),
    );

  registerHostedEmailAutomationTools(
    registry,
    {
      source: {
        async listMessages() {
          return [message("manual")];
        },
      },
      classifier: {
        async classify() {
          throw new Error(
            "not used in manual action test",
          );
        },
        async classifyMany() {
          throw new Error(
            "not used in manual action test",
          );
        },
      },
      executor: {
        async execute(plan, context) {
          plans.push(
            structuredClone(plan),
          );
          contexts.push(
            structuredClone(context),
          );
          return {
            status: "executed",
            idempotencyKey:
              plan.idempotencyKey,
            attempts: 1,
            beforeState: {
              canonicalMessageId:
                "manual",
              provider: "gmail",
              providerMessageId:
                "provider-manual",
              tenantId: "tenant-1",
              accountId: "account-1",
              updatedAt:
                "2026-10-01T09:00:00.000Z",
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
            afterStateStatus:
              "unavailable",
          };
        },
      },
    },
  );

  await registry.call(
    "email_archive",
    {
      accountId: "account-1",
      messageId: "manual",
    },
    principal(),
    "manual-archive",
  );
  await registry.call(
    "email_trash",
    {
      accountId: "account-1",
      messageId: "manual",
    },
    principal(),
    "manual-trash",
  );

  assert.deepEqual(
    plans.map((plan) => ({
      source: plan.source,
      action: plan.action.type,
    })),
    [
      {
        source: "mcp_explicit",
        action: "archive",
      },
      {
        source: "mcp_explicit",
        action: "trash",
      },
    ],
  );
  assert.equal(
    plans[1]?.destructiveAuthorization
      ?.userConfirmationId,
    "manual-trash",
  );
  assert.deepEqual(
    contexts.map(
      (context) => context.actorType,
    ),
    ["mcp", "mcp"],
  );
});
