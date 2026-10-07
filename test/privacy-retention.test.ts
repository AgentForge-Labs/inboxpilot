import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRIVACY_RETENTION_POLICY,
  EXPLAINABILITY_AUDIT_VERSION,
  InMemoryExplainabilityAuditStore,
  InMemoryIngestionRepository,
  InMemoryMcpAccountLinkStore,
  InMemoryMcpControlPlaneUsageStore,
  InMemoryMcpOAuthStore,
  InMemoryPrivacyRetentionStore,
  InMemorySemanticCostTelemetry,
  InMemorySemanticQuotaLedger,
  PrivacyRetentionService,
  PrivacyRetentionSweep,
  type CanonicalMessage,
  type McpOAuthGrant,
  type McpOAuthTokenRecord,
  type PrivacyAccountDataTarget,
} from "../src/index.js";

function canonicalMessage(
  tenantId = "tenant-1",
  accountId = "account-1",
  id = "message-1",
): CanonicalMessage {
  const now = "2026-10-07T10:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    tenantId,
    accountId,
    threadId: "thread-" + id,
    provider: {
      kind: "gmail",
      messageId: "provider-" + id,
    },
    subject: "Private subject",
    body: {
      text: "Sensitive body",
      html: "<p>Sensitive body</p>",
      truncated: false,
    },
    from: { address: "sender@example.test" },
    to: [{ address: "me@example.test" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {
      authorization: ["secret-header"],
    },
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
    receivedAt: now,
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
    ingestedAt: now,
    updatedAt: now,
  };
}

test("default privacy disclosure covers every sensitive data class with explicit retention", () => {
  const store = new InMemoryPrivacyRetentionStore();
  const service = new PrivacyRetentionService(
    store,
    [],
    DEFAULT_PRIVACY_RETENTION_POLICY,
    () => new Date("2026-10-07T12:00:00.000Z"),
  );

  const disclosure = service.disclosure();
  assert.equal(disclosure.policyVersion, 1);
  assert.equal(disclosure.rules.length, 10);

  const prompt = disclosure.rules.find(
    (rule) => rule.dataClass === "classifier_prompt",
  );
  assert.equal(prompt?.persistence, "forbidden");
  assert.equal(prompt?.retentionDays, 0);

  const attachment = disclosure.rules.find(
    (rule) =>
      rule.dataClass === "attachment_extraction",
  );
  assert.equal(attachment?.retentionDays, 7);

  const audit = disclosure.rules.find(
    (rule) => rule.dataClass === "audit_metadata",
  );
  assert.equal(audit?.persistence, "metadata_only");
  assert.equal(audit?.retentionDays, 365);
});

test("privacy policy forbids persisted prompts and content inside metadata-only records", async () => {
  const store = new InMemoryPrivacyRetentionStore();
  const service = new PrivacyRetentionService(store);

  await assert.rejects(
    () =>
      service.retain({
        id: "prompt-1",
        tenantId: "tenant-1",
        accountId: "account-1",
        dataClass: "classifier_prompt",
        payload: {
          system: "secret",
          input: "raw email",
        },
      }),
    /persistence is forbidden/,
  );

  await assert.rejects(
    () =>
      service.retain({
        id: "tool-1",
        tenantId: "tenant-1",
        accountId: "account-1",
        dataClass: "tool_arguments",
        payload: {
          messageBody: "sensitive",
        },
      }),
    /metadata only/,
  );

  await assert.rejects(
    () =>
      service.retain({
        id: "audit-1",
        tenantId: "tenant-1",
        accountId: "account-1",
        dataClass: "audit_metadata",
        metadata: {
          bodyPreview: "do not keep this",
        },
      }),
    /may contain sensitive content/,
  );

  const result = await service.retain({
    id: "classifier-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    dataClass: "classifier_result",
    metadata: {
      modelVersion: "v1",
      confidence: 0.91,
    },
  });
  assert.ok(result);
  assert.equal("payload" in result, false);
});

test("automated sweep removes expired content while preserving unexpired and grant-lifecycle metadata", async () => {
  const store = new InMemoryPrivacyRetentionStore();
  const service = new PrivacyRetentionService(
    store,
    [],
    DEFAULT_PRIVACY_RETENTION_POLICY,
    () => new Date("2026-10-07T12:00:00.000Z"),
  );

  await service.retain({
    id: "attachment-old",
    tenantId: "tenant-1",
    accountId: "account-1",
    dataClass: "attachment_extraction",
    payload: "temporary extracted text",
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  await service.retain({
    id: "body-recent",
    tenantId: "tenant-1",
    accountId: "account-1",
    dataClass: "email_body_cache",
    payload: "recent body",
    createdAt: "2026-10-01T00:00:00.000Z",
  });
  await service.retain({
    id: "oauth-lifecycle",
    tenantId: "tenant-1",
    accountId: "account-1",
    dataClass: "oauth_token",
    metadata: {
      grantId: "grant-1",
      active: true,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const sweep = new PrivacyRetentionSweep(service);
  const result = await sweep.run(
    "2026-10-07T12:00:00.000Z",
  );
  assert.equal(result.deleted, 1);

  const remaining = await store.listAccount(
    "tenant-1",
    "account-1",
  );
  assert.deepEqual(
    remaining.map((record) => record.id).sort(),
    ["body-recent", "oauth-lifecycle"],
  );
});

test("account export returns only exportable retained data and configured target exports", async () => {
  const store = new InMemoryPrivacyRetentionStore();
  const target: PrivacyAccountDataTarget = {
    name: "mailbox-cache",
    async exportAccountData(tenantId, accountId) {
      return {
        tenantId,
        accountId,
        messages: 3,
      };
    },
    async deleteAccountData() {
      return 3;
    },
  };
  const service = new PrivacyRetentionService(store, [
    target,
  ]);

  await service.retain({
    id: "body-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    dataClass: "email_body_cache",
    payload: "user-owned content",
  });
  await service.retain({
    id: "oauth-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    dataClass: "oauth_token",
    metadata: {
      grantId: "grant-1",
    },
  });

  const exported = await service.exportAccount(
    "tenant-1",
    "account-1",
  );

  assert.deepEqual(
    exported.retainedRecords.map((record) => record.id),
    ["body-1"],
  );
  assert.deepEqual(exported.sources, [
    {
      name: "mailbox-cache",
      data: {
        tenantId: "tenant-1",
        accountId: "account-1",
        messages: 3,
      },
    },
  ]);
});

test("account deletion purges connected stores and leaves only a short-lived tombstone", async () => {
  const privacyStore =
    new InMemoryPrivacyRetentionStore();
  const ingestion = new InMemoryIngestionRepository();
  const audit = new InMemoryExplainabilityAuditStore();
  const telemetry = new InMemorySemanticCostTelemetry();
  const quota = new InMemorySemanticQuotaLedger();
  const oauth = new InMemoryMcpOAuthStore();
  const links = new InMemoryMcpAccountLinkStore();
  const usage =
    new InMemoryMcpControlPlaneUsageStore();

  const accountMessage = canonicalMessage();
  const otherMessage = canonicalMessage(
    "tenant-1",
    "account-2",
    "other",
  );

  await ingestion.commitBatch({
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    nextCursor: "cursor-1",
    messages: [accountMessage],
    deletedProviderMessageIds: [],
  });
  await ingestion.commitBatch({
    tenantId: "tenant-1",
    accountId: "account-2",
    provider: "gmail",
    nextCursor: "cursor-2",
    messages: [otherMessage],
    deletedProviderMessageIds: [],
  });

  await audit.append({
    version: EXPLAINABILITY_AUDIT_VERSION,
    eventId: "audit-1",
    kind: "manual_decision",
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "message-1",
    provider: "gmail",
    providerMessageId: "provider-message-1",
    actor: {
      type: "user",
      id: "user-1",
    },
    timestamp: "2026-10-07T10:00:00.000Z",
    signals: [],
    policyReasons: [],
    outcome: "succeeded",
  });

  await telemetry.append({
    tenantId: "tenant-1",
    accountId: "account-1",
    providerMessageId: "provider-message-1",
    model: "classifier-v1",
    attempt: 1,
    phase: "primary",
    inputTokens: 100,
    outputTokens: 20,
    estimatedCostMicros: 1,
    outcome: "success",
    timestamp: "2026-10-07T10:00:00.000Z",
  });
  assert.equal(await quota.chargeUnique(accountMessage), true);

  const grant: McpOAuthGrant = {
    grantId: "grant-1",
    clientId: "client-1",
    tenantId: "tenant-1",
    userId: "user-1",
    accountIds: ["account-1"],
    scopes: ["mcp:tools"],
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
  };
  const token: McpOAuthTokenRecord = {
    tokenHash: "hash-1",
    kind: "access",
    grantId: "grant-1",
    clientId: "client-1",
    issuedAt: "2026-10-07T10:00:00.000Z",
    expiresAt: "2026-10-08T10:00:00.000Z",
  };
  await oauth.putGrant(grant);
  await oauth.putToken(token);
  await links.link(
    "tenant-1",
    "user-1",
    "account-1",
    "2026-10-07T10:00:00.000Z",
  );
  await usage.append({
    tenantId: "tenant-1",
    userId: "user-1",
    grantId: "grant-1",
    requestId: "request-1",
    toolName: "email_read",
    outcome: "succeeded",
    timestamp: "2026-10-07T10:00:00.000Z",
    accountId: "account-1",
    billable: false,
  });

  const targets: PrivacyAccountDataTarget[] = [
    {
      name: "ingestion",
      exportAccountData: ingestion.exportAccountData.bind(
        ingestion,
      ),
      deleteAccountData:
        ingestion.deleteAccountData.bind(ingestion),
    },
    {
      name: "audit",
      exportAccountData: audit.exportAccountData.bind(audit),
      deleteAccountData:
        audit.deleteAccountData.bind(audit),
    },
    {
      name: "semantic-telemetry",
      exportAccountData:
        telemetry.exportAccountData.bind(telemetry),
      deleteAccountData:
        telemetry.deleteAccountData.bind(telemetry),
    },
    {
      name: "semantic-quota",
      deleteAccountData:
        quota.deleteAccountData.bind(quota),
    },
    {
      name: "mcp-oauth",
      exportAccountData: oauth.exportAccountData.bind(oauth),
      deleteAccountData:
        oauth.deleteAccountData.bind(oauth),
    },
    {
      name: "mcp-links",
      exportAccountData: links.exportAccountData.bind(links),
      deleteAccountData:
        links.deleteAccountData.bind(links),
    },
    {
      name: "mcp-usage",
      exportAccountData: usage.exportAccountData.bind(usage),
      deleteAccountData:
        usage.deleteAccountData.bind(usage),
    },
  ];

  const service = new PrivacyRetentionService(
    privacyStore,
    targets,
    DEFAULT_PRIVACY_RETENTION_POLICY,
    () => new Date("2026-10-07T12:00:00.000Z"),
  );

  await service.retain({
    id: "cached-body",
    tenantId: "tenant-1",
    accountId: "account-1",
    dataClass: "email_body_cache",
    payload: "temporary",
  });

  const before = await service.exportAccount(
    "tenant-1",
    "account-1",
  );
  assert.equal(before.sources.length, 6);

  const deleted = await service.deleteAccount(
    "tenant-1",
    "account-1",
  );
  assert.equal(deleted.targetResults.length, 7);

  assert.equal(
    await ingestion.getMessage(
      "tenant-1",
      "account-1",
      "message-1",
    ),
    undefined,
  );
  assert.ok(
    await ingestion.getMessage(
      "tenant-1",
      "account-2",
      "other",
    ),
  );
  assert.equal(
    (await audit.listForAccount(
      "tenant-1",
      "account-1",
    )).length,
    0,
  );
  assert.equal(
    (await telemetry.exportAccountData(
      "tenant-1",
      "account-1",
    )).length,
    0,
  );
  assert.equal(
    await quota.chargeUnique(accountMessage),
    true,
    "quota identity must be forgotten with the account",
  );
  assert.equal(
    (await oauth.exportAccountData(
      "tenant-1",
      "account-1",
    )).grants.length,
    0,
  );
  assert.equal(
    (await links.exportAccountData(
      "tenant-1",
      "account-1",
    )).length,
    0,
  );
  assert.equal(
    (await usage.exportAccountData(
      "tenant-1",
      "account-1",
    )).length,
    0,
  );

  const remaining = await privacyStore.listAccount(
    "tenant-1",
    "account-1",
  );
  assert.equal(remaining.length, 1);
  assert.equal(
    remaining[0]?.dataClass,
    "deleted_account_tombstone",
  );
  assert.equal(
    remaining[0]?.expiresAt,
    "2026-11-06T12:00:00.000Z",
  );
});
