import test from "node:test";
import assert from "node:assert/strict";

import {
  GMAIL_FULL_MAIL_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GmailAdapter,
  GmailApiClient,
  GmailOAuthClient,
  InMemoryOperationalTelemetry,
  ProviderRateLimitTracker,
  normalizeGmailMessage,
  providerRetryDelayMs,
  type GmailCredentialStore,
  type GmailStoredCredentials,
  type ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

class MemoryCredentialStore implements GmailCredentialStore {
  value: GmailStoredCredentials | null;

  constructor(value: GmailStoredCredentials | null = null) {
    this.value = value;
  }

  async get(): Promise<GmailStoredCredentials | null> {
    return this.value;
  }

  async set(
    _context: ProviderConnectionContext,
    credentials: GmailStoredCredentials,
  ): Promise<void> {
    this.value = credentials;
  }

  async delete(): Promise<void> {
    this.value = null;
  }
}

function oauthWithStore(
  store: MemoryCredentialStore,
  oauthFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ access_token: "unused" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
): GmailOAuthClient {
  return new GmailOAuthClient(
    {
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://app.example.test/oauth/google/callback",
    },
    store,
    oauthFetch,
  );
}

function activeStore(): MemoryCredentialStore {
  return new MemoryCredentialStore({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
  });
}

function gmailMessage(id = "m1", threadId = "t1") {
  return {
    id,
    threadId,
    labelIds: ["INBOX", "UNREAD", "IMPORTANT"],
    snippet: "Invoice needs review",
    historyId: "101",
    internalDate: "1791266400000",
    sizeEstimate: 1234,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Message-ID", value: `<${id}@example.test>` },
        { name: "Subject", value: "Invoice needs review" },
        { name: "From", value: "Billing <billing@example.test>" },
        { name: "To", value: "User <user@example.test>" },
        {
          name: "Authentication-Results",
          value: "mx.google.com; spf=pass; dkim=pass; dmarc=pass",
        },
      ],
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          body: {
            size: 12,
            data: Buffer.from("Please pay.").toString("base64url"),
          },
        },
        {
          mimeType: "text/html",
          body: {
            size: 19,
            data: Buffer.from("<p>Please pay.</p>").toString("base64url"),
          },
        },
      ],
    },
  };
}

test("OAuth authorization uses least-privilege Gmail scope by default", () => {
  const oauth = oauthWithStore(new MemoryCredentialStore());
  const url = new URL(oauth.authorizationUrl({ state: "state-123" }));

  assert.equal(url.searchParams.get("state"), "state-123");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("scope"), GMAIL_MODIFY_SCOPE);
  assert.ok(!url.searchParams.get("scope")?.includes(GMAIL_FULL_MAIL_SCOPE));
});

test("permanent-delete authorization explicitly requests full-mail scope", () => {
  const oauth = oauthWithStore(new MemoryCredentialStore());
  const url = new URL(
    oauth.authorizationUrl({
      state: "state-123",
      allowPermanentDelete: true,
    }),
  );

  assert.equal(url.searchParams.get("scope"), GMAIL_FULL_MAIL_SCOPE);
});

test("OAuth code exchange persists refresh credentials through credential store", async () => {
  const store = new MemoryCredentialStore();
  const oauth = oauthWithStore(
    store,
    async () =>
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: GMAIL_MODIFY_SCOPE,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
  );

  await oauth.exchangeCode(context, "authorization-code");

  assert.equal(store.value?.accessToken, "new-access");
  assert.equal(store.value?.refreshToken, "new-refresh");
  assert.ok((store.value?.expiresAt ?? 0) > Date.now());
});

test("Gmail message normalization creates canonical body, flags and auth signals", () => {
  const normalized = normalizeGmailMessage(gmailMessage(), context);

  assert.equal(normalized.provider.kind, "gmail");
  assert.equal(normalized.provider.messageId, "m1");
  assert.equal(normalized.subject, "Invoice needs review");
  assert.equal(normalized.body.text, "Please pay.");
  assert.equal(normalized.body.html, "<p>Please pay.</p>");
  assert.equal(normalized.flags.read, false);
  assert.equal(normalized.flags.important, true);
  assert.equal(normalized.mailboxes[0]?.role, "inbox");
  assert.equal(normalized.authentication.spf, "pass");
  assert.equal(normalized.authentication.dkim, "pass");
  assert.equal(normalized.authentication.dmarc, "pass");
  assert.equal(normalized.classification.status, "unclassified");
});

test("Gmail API retries 429 and succeeds without changing caller semantics", async () => {
  const store = activeStore();
  const oauth = oauthWithStore(store);
  const telemetry = new InMemoryOperationalTelemetry();
  const rateLimits = new ProviderRateLimitTracker();
  let calls = 0;
  const sleeps: number[] = [];

  const api = new GmailApiClient(
    oauth,
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        });
      }
      return new Response(JSON.stringify({ emailAddress: "user@example.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    {
      maxRetries: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      telemetry,
      rateLimits,
      now: () =>
        new Date("2026-10-07T12:00:00.000Z"),
    },
  );

  const result = await api.request<{ emailAddress: string }>(context, "/profile");
  assert.equal(result.emailAddress, "user@example.test");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);

  const events = telemetry.list({
    tenantId: "tenant-1",
    accountId: "account-1",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.metric, "provider_throttled");
  assert.equal(events[0]?.provider, "gmail");
  assert.equal(events[0]?.retryAfterMs, 1000);
  assert.equal(events[0]?.status, "throttled");
  assert.equal(rateLimits.snapshot().length, 0);
});

test("provider retry delay honors Retry-After dates and clamps excessive backoff", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  assert.equal(
    providerRetryDelayMs(
      0,
      "Wed, 07 Oct 2026 12:00:04 GMT",
      {
        baseDelayMs: 250,
        maxDelayMs: 10_000,
      },
      now,
    ),
    4000,
  );
  assert.equal(
    providerRetryDelayMs(
      10,
      "999999",
      {
        baseDelayMs: 250,
        maxDelayMs: 30_000,
      },
      now,
    ),
    30_000,
  );
});

test("Gmail adapter performs initial backfill and returns history cursor", async () => {
  const store = activeStore();
  const oauth = oauthWithStore(store);

  const api = new GmailApiClient(oauth, async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/profile")) {
      return new Response(
        JSON.stringify({
          emailAddress: "user@example.test",
          historyId: "500",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.endsWith("/messages")) {
      return new Response(
        JSON.stringify({ messages: [{ id: "m1", threadId: "t1" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.endsWith("/messages/m1")) {
      return new Response(JSON.stringify(gmailMessage()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  });

  const adapter = new GmailAdapter(api, oauth);
  const connected = await adapter.connect(context);
  const sync = await adapter.syncChanges({ limit: 25 });

  assert.equal(connected.accountExternalId, "user@example.test");
  assert.equal(sync.messages.length, 1);
  assert.equal(sync.messages[0]?.provider.messageId, "m1");
  assert.equal(sync.nextCursor, "500");
  assert.equal(sync.hasMore, false);
});

test("Gmail adapter reconciles history changes and deleted message ids", async () => {
  const store = activeStore();
  const oauth = oauthWithStore(store);

  const api = new GmailApiClient(oauth, async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/profile")) {
      return new Response(
        JSON.stringify({ emailAddress: "user@example.test", historyId: "500" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.endsWith("/history")) {
      assert.equal(url.searchParams.get("startHistoryId"), "500");
      return new Response(
        JSON.stringify({
          historyId: "505",
          history: [
            {
              id: "505",
              messagesAdded: [{ message: { id: "m2", threadId: "t2" } }],
              messagesDeleted: [{ message: { id: "m3", threadId: "t3" } }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.pathname.endsWith("/messages/m2")) {
      return new Response(JSON.stringify(gmailMessage("m2", "t2")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  });

  const adapter = new GmailAdapter(api, oauth);
  await adapter.connect(context);
  const sync = await adapter.syncChanges({ cursor: "500" });

  assert.equal(sync.messages[0]?.provider.messageId, "m2");
  assert.deepEqual(sync.deletedProviderMessageIds, ["m3"]);
  assert.equal(sync.nextCursor, "505");
});

test("Gmail actions map to Gmail API and permanent delete is disabled by default", async () => {
  const store = activeStore();
  const oauth = oauthWithStore(store);
  const requests: Array<{ path: string; method: string; body?: string }> = [];

  const api = new GmailApiClient(oauth, async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });

    if (url.pathname.endsWith("/profile")) {
      return new Response(JSON.stringify({ emailAddress: "user@example.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ id: "m1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const adapter = new GmailAdapter(api, oauth);
  await adapter.connect(context);

  assert.equal(adapter.capabilities().deletePermanent, false);
  assert.equal(adapter.capabilities().restore, true);

  await adapter.archive("m1");
  await adapter.trash("m1");
  await adapter.restore("m1");
  await adapter.markRead("m1", true);

  assert.ok(
    requests.some(
      (request) =>
        request.path.endsWith("/messages/m1/modify") &&
        request.body?.includes('"removeLabelIds":["INBOX"]'),
    ),
  );
  assert.ok(requests.some((request) => request.path.endsWith("/messages/m1/trash")));
  assert.ok(requests.some((request) => request.path.endsWith("/messages/m1/untrash")));
  await assert.rejects(() => adapter.deletePermanent("m1"), /does not support capability/);
});

test("Gmail watch registration and Pub/Sub notification parser are available", async () => {
  const store = activeStore();
  const oauth = oauthWithStore(store);
  let watchBody = "";

  const api = new GmailApiClient(oauth, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/profile")) {
      return new Response(JSON.stringify({ emailAddress: "user@example.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/watch")) {
      watchBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({ historyId: "600", expiration: "1791270000000" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const adapter = new GmailAdapter(api, oauth);
  await adapter.connect(context);
  const watch = await adapter.watchPush("projects/demo/topics/inboxpilot");

  assert.equal(watch.historyId, "600");
  assert.ok(watchBody.includes("projects/demo/topics/inboxpilot"));

  const encoded = Buffer.from(
    JSON.stringify({
      emailAddress: "user@example.test",
      historyId: "601",
    }),
    "utf8",
  ).toString("base64");

  assert.deepEqual(adapter.parsePushNotification(encoded), {
    emailAddress: "user@example.test",
    historyId: "601",
  });
});

test("disconnect revokes OAuth token and clears stored credentials", async () => {
  const store = activeStore();
  let revokeCalled = false;
  const oauth = oauthWithStore(store, async (input) => {
    if (String(input).includes("/revoke")) revokeCalled = true;
    return new Response("", { status: 200 });
  });

  const api = new GmailApiClient(oauth, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/profile")) {
      return new Response(JSON.stringify({ emailAddress: "user@example.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const adapter = new GmailAdapter(api, oauth);
  await adapter.connect(context);
  await adapter.disconnect();

  assert.equal(revokeCalled, true);
  assert.equal(store.value, null);
  await assert.rejects(() => adapter.listLabels(), /not connected/);
});
