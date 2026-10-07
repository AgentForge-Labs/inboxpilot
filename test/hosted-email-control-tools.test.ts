import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPLAINABILITY_AUDIT_VERSION,
  HostedMcpToolRegistry,
  InMemoryDashboardRuleStore,
  InMemoryExplainabilityAuditStore,
  InMemoryMcpControlPlaneUsageStore,
  InMemoryShadowModeStore,
  RulesDashboardService,
  ShadowModeService,
  registerHostedEmailControlTools,
  type McpOAuthPrincipal,
} from "../src/index.js";

function principal(
  scopes = [
    "mcp:tools",
    "mailbox:read",
    "rules:write",
  ],
): McpOAuthPrincipal {
  return {
    grantId: "grant-1",
    clientId: "client-1",
    tenantId: "tenant-1",
    userId: "user-1",
    accountIds: ["account-1"],
    scopes,
    accessTokenExpiresAt:
      "2026-10-08T00:00:00.000Z",
  };
}

function setup() {
  const ruleStore = new InMemoryDashboardRuleStore();
  const rules = new RulesDashboardService(
    ruleStore,
    {
      async listForAccount() {
        return [];
      },
    },
    () => new Date("2026-10-07T12:00:00.000Z"),
  );
  const shadowStore = new InMemoryShadowModeStore();
  const automation = new ShadowModeService(
    shadowStore,
    () => new Date("2026-10-07T12:00:00.000Z"),
  );
  const activity =
    new InMemoryExplainabilityAuditStore();
  const usage =
    new InMemoryMcpControlPlaneUsageStore();
  const registry = new HostedMcpToolRegistry(
    usage,
    () => new Date("2026-10-07T12:00:00.000Z"),
  );

  registerHostedEmailControlTools(registry, {
    rules,
    automation,
    activity,
    usage,
  });

  return {
    registry,
    rules,
    automation,
    activity,
    usage,
  };
}

test("registers rule, automation, activity and usage MCP tools", () => {
  const env = setup();
  assert.deepEqual(
    env.registry
      .list(principal())
      .map((tool) => tool.name),
    [
      "email_activity",
      "email_automation_configure",
      "email_automation_status",
      "email_rule_create",
      "email_rule_delete",
      "email_rule_list",
      "email_rule_update",
      "email_usage",
    ],
  );
});

test("destructive rule creation is preview-only until explicitly confirmed", async () => {
  const env = setup();
  const args = {
    accountId: "account-1",
    name: "Delete low value later",
    condition: {
      kind: "score",
      operator: "lt",
      value: 10,
    },
    action: {
      kind: "delete_after_days",
      days: 30,
    },
  };

  const preview = (await env.registry.call(
    "email_rule_create",
    args,
    principal(),
    "preview-request",
  )) as {
    preview: {
      applied: boolean;
      requiresConfirmation: boolean;
    };
  };

  assert.equal(preview.preview.applied, false);
  assert.equal(
    preview.preview.requiresConfirmation,
    true,
  );
  assert.equal(
    (await env.rules.list(
      "tenant-1",
      "account-1",
    )).length,
    0,
  );

  const applied = (await env.registry.call(
    "email_rule_create",
    {
      ...args,
      confirmDestructive: true,
    },
    principal(),
    "apply-request",
  )) as {
    rule: { action: { kind: string } };
    preview: { applied: boolean };
  };

  assert.equal(
    applied.rule.action.kind,
    "delete_after_days",
  );
  assert.equal(applied.preview.applied, true);
  assert.equal(
    (await env.rules.list(
      "tenant-1",
      "account-1",
    )).length,
    1,
  );
});

test("rule list, update and delete use revision-safe dashboard service", async () => {
  const env = setup();
  const created = await env.rules.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Important boss",
    condition: {
      kind: "sender",
      address: "boss@example.com",
    },
    action: { kind: "always_important" },
  });

  const list = (await env.registry.call(
    "email_rule_list",
    { accountId: "account-1" },
    principal(),
    "list-request",
  )) as { count: number };
  assert.equal(list.count, 1);

  const updated = (await env.registry.call(
    "email_rule_update",
    {
      accountId: "account-1",
      ruleId: created.id,
      expectedRevision: 1,
      name: "VIP boss",
    },
    principal(),
    "update-request",
  )) as {
    rule: { name: string; revision: number };
  };
  assert.equal(updated.rule.name, "VIP boss");
  assert.equal(updated.rule.revision, 2);

  const deleted = (await env.registry.call(
    "email_rule_delete",
    {
      accountId: "account-1",
      ruleId: created.id,
      expectedRevision: 2,
    },
    principal(),
    "delete-request",
  )) as { deleted: boolean };
  assert.equal(deleted.deleted, true);
});

test("automation enabling returns a safe preview before activation", async () => {
  const env = setup();
  await env.automation.startAccount(
    "tenant-1",
    "account-1",
    "2026-09-29T12:00:00.000Z",
  );

  const status = (await env.registry.call(
    "email_automation_status",
    { accountId: "account-1" },
    principal(),
    "status-request",
  )) as {
    status: string;
    canEnableAutomation: boolean;
  };
  assert.equal(status.status, "review_ready");
  assert.equal(status.canEnableAutomation, true);

  const preview = (await env.registry.call(
    "email_automation_configure",
    {
      accountId: "account-1",
      action: "enable",
    },
    principal(),
    "automation-preview",
  )) as {
    preview: {
      applied: boolean;
      requiresConfirmation: boolean;
    };
  };
  assert.equal(preview.preview.applied, false);
  assert.equal(
    preview.preview.requiresConfirmation,
    true,
  );

  const applied = (await env.registry.call(
    "email_automation_configure",
    {
      accountId: "account-1",
      action: "enable",
      confirmDestructive: true,
    },
    principal(),
    "automation-enable",
  )) as {
    state: { status: string; enabledBy?: string };
    preview: { applied: boolean };
  };
  assert.equal(applied.state.status, "enabled");
  assert.equal(applied.state.enabledBy, "user-1");
  assert.equal(applied.preview.applied, true);
});

test("activity and usage return tenant/account scoped safe operational data", async () => {
  const env = setup();
  await env.activity.append({
    version: EXPLAINABILITY_AUDIT_VERSION,
    eventId: "event-1",
    kind: "manual_decision",
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "message-1",
    provider: "gmail",
    providerMessageId: "provider-1",
    actor: {
      type: "mcp",
      id: "user-1",
    },
    timestamp: "2026-10-07T11:00:00.000Z",
    signals: [],
    policyReasons: [],
    requestedAction: {
      type: "archive",
    },
    outcome: "succeeded",
  });
  await env.usage.append({
    tenantId: "tenant-1",
    userId: "user-1",
    grantId: "grant-1",
    requestId: "old-request",
    toolName: "email_rule_list",
    outcome: "succeeded",
    timestamp: "2026-10-07T11:00:00.000Z",
    accountId: "account-1",
    billable: false,
  });

  const activity = (await env.registry.call(
    "email_activity",
    {
      accountId: "account-1",
      limit: 10,
    },
    principal(),
    "activity-request",
  )) as {
    count: number;
    events: Array<Record<string, unknown>>;
  };
  assert.equal(activity.count, 1);
  assert.equal(
    activity.events[0]?.eventId,
    "event-1",
  );

  const usage = (await env.registry.call(
    "email_usage",
    { accountId: "account-1" },
    principal(),
    "usage-request",
  )) as {
    totalCalls: number;
    byTool: Record<string, number>;
    billableCalls: number;
  };
  assert.ok(usage.totalCalls >= 2);
  assert.equal(
    usage.byTool.email_rule_list,
    1,
  );
  assert.equal(usage.billableCalls, 0);
});

test("write controls remain hidden/denied without rules:write scope", async () => {
  const env = setup();
  const readOnly = principal([
    "mcp:tools",
    "mailbox:read",
  ]);

  assert.equal(
    env.registry
      .list(readOnly)
      .some(
        (tool) =>
          tool.name === "email_rule_create",
      ),
    false,
  );

  await assert.rejects(
    () =>
      env.registry.call(
        "email_rule_create",
        {
          accountId: "account-1",
          name: "x",
          condition: {
            kind: "sender",
            address: "x@example.com",
          },
          action: {
            kind: "always_important",
          },
        },
        readOnly,
        "denied-request",
      ),
    /required tool scope/,
  );
});
