import test from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_SCHEMA_VERSION,
  HostedMcpToolRegistry,
  InMemoryBackgroundAutomationQueue,
  InMemoryMcpControlPlaneUsageStore,
  InMemoryRetentionMessageRepository,
  assertEntityScope,
  assertServiceRoleCapability,
  assertTenantAccountAccess,
  serviceRoleAllows,
  tenantScopedKey,
  type BackgroundAutomationJob,
  type CanonicalMessage,
  type McpOAuthPrincipal,
} from "../src/index.js";

function message(
  tenantId: string,
  accountId: string,
  subject: string,
): CanonicalMessage {
  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: "same-message-id",
    tenantId,
    accountId,
    threadId: "thread-1",
    provider: {
      kind: "gmail",
      messageId: "same-provider-id",
    },
    subject,
    body: { text: subject, truncated: false },
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
    receivedAt: "2026-10-07T12:00:00.000Z",
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
    ingestedAt: "2026-10-07T12:00:00.000Z",
    updatedAt: "2026-10-07T12:00:00.000Z",
  };
}

test("tenant-scoped keys resist delimiter collision and separate tenant/account identities", () => {
  const one = tenantScopedKey(
    {
      tenantId: "tenant|a",
      accountId: "account:b",
    },
    "message",
    "x|y:z",
  );
  const two = tenantScopedKey(
    {
      tenantId: "tenant",
      accountId: "a|account:b",
    },
    "message",
    "x|y:z",
  );
  const three = tenantScopedKey(
    {
      tenantId: "tenant|a",
      accountId: "account:b",
    },
    "message",
    "x|y",
    "z",
  );

  assert.notEqual(one, two);
  assert.notEqual(one, three);
  assert.equal(
    one,
    tenantScopedKey(
      {
        tenantId: "tenant|a",
        accountId: "account:b",
      },
      "message",
      "x|y:z",
    ),
  );
});

test("authorization helper fails closed for cross-tenant and cross-account access", () => {
  const context = {
    tenantId: "tenant-1",
    accountIds: ["account-1", "account-2"],
  };

  assert.deepEqual(
    assertTenantAccountAccess(context, {
      tenantId: "tenant-1",
      accountId: "account-2",
    }),
    {
      tenantId: "tenant-1",
      accountId: "account-2",
    },
  );

  assert.throws(
    () =>
      assertTenantAccountAccess(context, {
        tenantId: "tenant-2",
        accountId: "account-1",
      }),
    /Tenant access denied/,
  );
  assert.throws(
    () =>
      assertTenantAccountAccess(context, {
        tenantId: "tenant-1",
        accountId: "account-3",
      }),
    /Mailbox account access denied/,
  );
  assert.throws(
    () =>
      assertEntityScope(
        {
          tenantId: "tenant-1",
          accountId: "account-1",
        },
        {
          tenantId: "tenant-1",
          accountId: "account-2",
        },
        "message",
      ),
    /outside the authorized tenant\/account scope/,
  );
});

test("least-privilege service roles deny unrelated capabilities", () => {
  assert.equal(
    serviceRoleAllows(
      "classification_worker",
      "classification:write",
    ),
    true,
  );
  assert.equal(
    serviceRoleAllows(
      "classification_worker",
      "mailbox:write",
    ),
    false,
  );
  assert.equal(
    serviceRoleAllows(
      "provider_maintenance_worker",
      "provider:maintain",
    ),
    true,
  );
  assert.equal(
    serviceRoleAllows(
      "provider_maintenance_worker",
      "retention:write",
    ),
    false,
  );

  assert.throws(
    () =>
      assertServiceRoleCapability(
        "classification_worker",
        "mailbox:write",
      ),
    /not allowed capability/,
  );
});

test("background queue allows identical job IDs across tenants but scoped mutations cannot cross boundaries", async () => {
  const queue = new InMemoryBackgroundAutomationQueue();
  const base = {
    id: "shared-job-id",
    kind: "classification" as const,
    accountId: "account-1",
    payload: { canonicalMessageId: "message-1" },
    createdAt: "2026-10-07T12:00:00.000Z",
    availableAt: "2026-10-07T12:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
  };
  const tenantOne: BackgroundAutomationJob = {
    ...base,
    tenantId: "tenant-1",
  };
  const tenantTwo: BackgroundAutomationJob = {
    ...base,
    tenantId: "tenant-2",
  };

  assert.equal(await queue.enqueue(tenantOne), true);
  assert.equal(await queue.enqueue(tenantTwo), true);

  const claimed = await queue.claimDue(
    "classification",
    "2026-10-07T12:00:00.000Z",
    10,
    "2026-10-07T11:55:00.000Z",
  );
  assert.equal(claimed.length, 2);

  await queue.complete(
    {
      tenantId: "tenant-1",
      accountId: "account-1",
    },
    "shared-job-id",
  );

  await queue.retry(
    {
      tenantId: "tenant-2",
      accountId: "account-1",
    },
    "shared-job-id",
    "2026-10-07T12:01:00.000Z",
    "retry tenant two only",
  );

  const stats = await queue.stats();
  assert.equal(stats.queued.classification, 1);
  assert.equal(stats.inFlight.classification, 0);

  await assert.rejects(
    () =>
      queue.retry(
        {
          tenantId: "tenant-1",
          accountId: "account-1",
        },
        "shared-job-id",
        "2026-10-07T12:02:00.000Z",
        "must not touch tenant two",
      ),
    /not found for retry/,
  );
});

test("retention message repository isolates identical provider IDs across tenants", async () => {
  const repository =
    new InMemoryRetentionMessageRepository();
  repository.seed(
    message("tenant-1", "account-1", "Tenant One"),
  );
  repository.seed(
    message("tenant-2", "account-1", "Tenant Two"),
  );

  const one = await repository.get(
    "tenant-1",
    "account-1",
    "same-provider-id",
  );
  const two = await repository.get(
    "tenant-2",
    "account-1",
    "same-provider-id",
  );
  const wrong = await repository.get(
    "tenant-1",
    "account-2",
    "same-provider-id",
  );

  assert.equal(one?.subject, "Tenant One");
  assert.equal(two?.subject, "Tenant Two");
  assert.equal(wrong, undefined);
});

test("MCP boundary derives tenant from OAuth and denies unauthorized accounts before tool execution", async () => {
  let executions = 0;
  const usage = new InMemoryMcpControlPlaneUsageStore();
  const registry = new HostedMcpToolRegistry(usage);
  registry.register({
    descriptor: {
      name: "tenant_boundary_probe",
      description: "Test tenant boundary",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "string" },
        },
        required: ["accountId"],
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    requiresAccount: true,
    requiredScopes: ["mailbox:read"],
    async execute(_args, context) {
      executions += 1;
      return {
        tenantId: context.tenantId,
        accountId: context.accountId,
      };
    },
  });

  const principal: McpOAuthPrincipal = {
    tenantId: "tenant-1",
    userId: "user-1",
    grantId: "grant-1",
    clientId: "client-1",
    accountIds: ["account-1"],
    scopes: ["mcp:tools", "mailbox:read"],
    accessTokenExpiresAt:
      "2026-10-08T00:00:00.000Z",
  };

  await assert.rejects(
    () =>
      registry.call(
        "tenant_boundary_probe",
        {
          accountId: "account-1",
          tenantId: "tenant-2",
        },
        principal,
        "request-tenant-injection",
      ),
    /tenantId is derived from OAuth/,
  );
  await assert.rejects(
    () =>
      registry.call(
        "tenant_boundary_probe",
        { accountId: "account-2" },
        principal,
        "request-cross-account",
      ),
    /not authorized/,
  );
  assert.equal(executions, 0);

  const ok = (await registry.call(
    "tenant_boundary_probe",
    { accountId: "account-1" },
    principal,
    "request-ok",
  )) as Record<string, unknown>;
  assert.equal(ok.tenantId, "tenant-1");
  assert.equal(ok.accountId, "account-1");
  assert.equal(executions, 1);
});
