import test from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_SCHEMA_VERSION,
  HostedMcpToolRegistry,
  InMemoryHostedEmailReadDataSource,
  InMemoryMcpControlPlaneUsageStore,
  registerHostedEmailReadTools,
  type CanonicalMessage,
  type McpOAuthPrincipal,
} from "../src/index.js";

function message(
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  const base: CanonicalMessage = {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: "message-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-1",
    provider: {
      kind: "gmail",
      messageId: "gmail-message-1",
      threadId: "gmail-thread-1",
    },
    internetMessageId: "<message-1@example.com>",
    subject: "Quarterly planning",
    snippet: "Confidential roadmap preview",
    body: {
      text: "Secret launch phrase ALPHA-BIRD",
      html: "<p>Secret launch phrase ALPHA-BIRD</p>",
      truncated: false,
    },
    from: {
      address: "alice@example.com",
      name: "Alice",
    },
    to: [{ address: "me@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {
      "x-sensitive-header": ["private-value"],
    },
    labels: ["INBOX"],
    mailboxes: [
      {
        id: "inbox",
        role: "inbox",
        displayName: "Inbox",
      },
    ],
    flags: {
      read: false,
      starred: true,
      important: true,
      draft: false,
      answered: false,
      forwarded: false,
    },
    attachments: [
      {
        id: "attachment-1",
        filename: "plan.pdf",
        contentType: "application/pdf",
        sizeBytes: 2048,
        inline: false,
      },
    ],
    receivedAt: "2026-10-07T10:00:00.000Z",
    authentication: {
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
    },
    classification: {
      status: "classified",
      importanceScore: 91,
      priority: "critical",
      categories: ["work"],
      confidence: 0.98,
      actionRequired: true,
    },
    retention: {
      stage: "active",
      protected: true,
      protectionReasons: ["important"],
    },
    providerMetadata: {
      gmailInternalDate: "secret-provider-field",
    },
    ingestedAt: "2026-10-07T10:00:01.000Z",
    updatedAt: "2026-10-07T10:00:01.000Z",
  };
  return { ...base, ...overrides };
}

function principal(
  accountIds: string[] = ["account-1"],
): McpOAuthPrincipal {
  return {
    tenantId: "tenant-1",
    userId: "user-1",
    grantId: "grant-1",
    clientId: "chatgpt",
    accessTokenExpiresAt: "2026-10-07T12:00:00.000Z",
    scopes: ["mcp:tools", "mailbox:read"],
    accountIds,
  };
}

function setup() {
  const usage = new InMemoryMcpControlPlaneUsageStore();
  const registry = new HostedMcpToolRegistry(usage);
  const source = new InMemoryHostedEmailReadDataSource();

  source.seedAccount({
    tenantId: "tenant-1",
    userId: "user-1",
    accountId: "account-1",
    provider: "gmail",
    state: "healthy",
    displayName: "Work",
    emailAddress: "me@example.com",
    lastSyncAt: "2026-10-07T10:01:00.000Z",
  });
  source.seedAccount({
    tenantId: "tenant-1",
    userId: "user-1",
    accountId: "account-2",
    provider: "imap",
    state: "degraded",
    lastError: "temporary sync failure",
  });

  source.seedMessage(message());
  source.seedMessage(
    message({
      id: "message-2",
      provider: {
        kind: "gmail",
        messageId: "gmail-message-2",
        threadId: "gmail-thread-1",
      },
      subject: "Re: Quarterly planning",
      body: {
        text: "Follow-up content",
        truncated: false,
      },
      snippet: "Follow-up",
      receivedAt: "2026-10-07T11:00:00.000Z",
    }),
  );
  source.seedMessage(
    message({
      id: "message-account-2",
      accountId: "account-2",
      threadId: "thread-2",
      provider: {
        kind: "imap",
        messageId: "imap-message-1",
        threadId: "imap-thread-1",
      },
      subject: "Other mailbox",
    }),
  );

  registerHostedEmailReadTools(registry, source);
  return { usage, registry, source };
}

test("registers five normalized read-only mailbox tools", () => {
  const { registry } = setup();
  const tools = registry.list(principal());
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "email_account_list",
      "email_account_status",
      "email_read",
      "email_search",
      "email_thread_read",
    ],
  );
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }
});

test("email_account_list only exposes accounts authorized by the grant", async () => {
  const { registry } = setup();
  const result = (await registry.call(
    "email_account_list",
    {},
    principal(["account-1"]),
    "request-1",
  )) as { accounts: Array<Record<string, unknown>> };

  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0]?.accountId, "account-1");
  assert.equal(result.accounts[0]?.provider, "gmail");
  assert.equal(result.accounts[0]?.state, "healthy");
});

test("email_account_status normalizes provider health and rejects unauthorized accounts", async () => {
  const { registry } = setup();
  const status = (await registry.call(
    "email_account_status",
    { accountId: "account-1" },
    principal(),
    "request-2",
  )) as Record<string, unknown>;

  assert.equal(status.accountId, "account-1");
  assert.equal(status.provider, "gmail");
  assert.equal(status.state, "healthy");

  await assert.rejects(
    () =>
      registry.call(
        "email_account_status",
        { accountId: "account-2" },
        principal(["account-1"]),
        "request-3",
      ),
    /not authorized/,
  );
});

test("email_search finds canonical messages but withholds sensitive content by default", async () => {
  const { registry } = setup();
  const result = (await registry.call(
    "email_search",
    {
      accountId: "account-1",
      query: "ALPHA-BIRD",
    },
    principal(),
    "request-4",
  )) as {
    count: number;
    messages: Array<Record<string, unknown>>;
  };

  assert.equal(result.count, 1);
  const found = result.messages[0]!;
  assert.equal(found.id, "message-1");
  assert.equal(found.provider, "gmail");
  assert.equal(found.providerMessageId, "gmail-message-1");
  assert.equal("body" in found, false);
  assert.equal("snippet" in found, false);
  assert.equal("headers" in found, false);
  assert.equal("providerMetadata" in found, false);
});

test("email_search returns body and headers only after explicit includeContent opt-in", async () => {
  const { registry } = setup();
  const result = (await registry.call(
    "email_search",
    {
      accountId: "account-1",
      query: "planning",
      includeContent: true,
      limit: 1,
    },
    principal(),
    "request-5",
  )) as {
    count: number;
    messages: Array<Record<string, unknown>>;
  };

  assert.equal(result.count, 1);
  assert.deepEqual(result.messages[0]?.body, {
    text: "Follow-up content",
    truncated: false,
  });
  assert.equal(result.messages[0]?.snippet, "Follow-up");
  assert.ok(result.messages[0]?.headers);
  assert.equal(
    "providerMetadata" in result.messages[0]!,
    false,
  );
});

test("email_read accepts canonical/provider IDs and protects body by default", async () => {
  const { registry } = setup();
  const safe = (await registry.call(
    "email_read",
    {
      accountId: "account-1",
      messageId: "gmail-message-1",
    },
    principal(),
    "request-6",
  )) as { message: Record<string, unknown> };

  assert.equal(safe.message.id, "message-1");
  assert.equal("body" in safe.message, false);

  const full = (await registry.call(
    "email_read",
    {
      accountId: "account-1",
      messageId: "message-1",
      includeContent: true,
    },
    principal(),
    "request-7",
  )) as { message: Record<string, unknown> };

  assert.deepEqual(full.message.body, {
    text: "Secret launch phrase ALPHA-BIRD",
    html: "<p>Secret launch phrase ALPHA-BIRD</p>",
    truncated: false,
  });
});

test("email_thread_read accepts provider thread IDs and returns normalized chronological messages", async () => {
  const { registry } = setup();
  const result = (await registry.call(
    "email_thread_read",
    {
      accountId: "account-1",
      threadId: "gmail-thread-1",
    },
    principal(),
    "request-8",
  )) as {
    threadId: string;
    count: number;
    messages: Array<Record<string, unknown>>;
  };

  assert.equal(result.threadId, "thread-1");
  assert.equal(result.count, 2);
  assert.deepEqual(
    result.messages.map((entry) => entry.id),
    ["message-1", "message-2"],
  );
  assert.equal("body" in result.messages[0]!, false);
  assert.equal("providerMetadata" in result.messages[0]!, false);
});
