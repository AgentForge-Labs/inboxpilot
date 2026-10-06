import test from "node:test";
import assert from "node:assert/strict";
import {
  MicrosoftGraphAdapter,
  MicrosoftGraphApiClient,
  MicrosoftOAuthClient,
  normalizeGraphMessage,
} from "../src/index.js";

import type {
  MicrosoftCredentialStore,
  MicrosoftStoredCredentials,
  ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = { tenantId: "t1", accountId: "a1" };

class MemoryStore implements MicrosoftCredentialStore {
  value: MicrosoftStoredCredentials | null = null;
  async get() { return this.value; }
  async set(_c: ProviderConnectionContext, v: MicrosoftStoredCredentials) { this.value = v; }
  async delete() { this.value = null; }
}

function makeOauth(store: MemoryStore) {
  return new MicrosoftOAuthClient(
    { clientId: "id", clientSecret: "value", redirectUri: "https://example.test/callback" },
    store,
    async () => new Response("{}", { status: 500 }),
  );
}

function graphMessage(id = "m1") {
  return {
    id,
    conversationId: "c1",
    internetMessageId: `<${id}@example.test>`,
    subject: "Status",
    body: { contentType: "html", content: "<p>Hello</p>" },
    from: { emailAddress: { address: "sender@example.test" } },
    toRecipients: [{ emailAddress: { address: "user@example.test" } }],
    categories: ["Customer"],
    importance: "high",
    isRead: false,
    isDraft: false,
    flag: { flagStatus: "flagged" },
    receivedDateTime: "2026-10-06T07:00:00Z",
    parentFolderId: "inbox-id",
  };
}

test("normalizes Graph message flags and conversation", () => {
  const normalized = normalizeGraphMessage(graphMessage(), context);
  assert.equal(normalized.provider.threadId, "c1");
  assert.equal(normalized.body.html, "<p>Hello</p>");
  assert.equal(normalized.flags.important, true);
  assert.equal(normalized.flags.starred, true);
  assert.deepEqual(normalized.labels, ["Customer"]);
});

test("authorization URL requests offline and read/write mail access", () => {
  const url = new URL(makeOauth(new MemoryStore()).authorizationUrl("state"));
  const scope = url.searchParams.get("scope") ?? "";
  assert.match(scope, /offline_access/);
  assert.match(scope, /Mail\.ReadWrite/);
  assert.equal(url.searchParams.get("state"), "state");
});

test("Graph API retries throttling with Retry-After", async () => {
  const store = new MemoryStore();
  store.value = {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  };
  const auth = makeOauth(store);
  let calls = 0;
  const sleeps: number[] = [];
  const api = new MicrosoftGraphApiClient(
    auth,
    async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("busy", {
          status: 429,
          headers: { "retry-after": "2" },
        });
      }
      return new Response(JSON.stringify({ id: "me" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    { sleep: async (ms) => { sleeps.push(ms); } },
  );

  await api.request(context, "/me");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("delta sync normalizes live messages and tombstones", async () => {
  const store = new MemoryStore();
  store.value = {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  };
  const auth = makeOauth(store);
  const api = new MicrosoftGraphApiClient(auth, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/me")) {
      return new Response(JSON.stringify({ id: "me", mail: "u@example.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      value: [graphMessage("m1"), { id: "m2", "@removed": { reason: "deleted" } }],
      "@odata.deltaLink":
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=x",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const adapter = new MicrosoftGraphAdapter(api, auth);
  await adapter.connect(context);
  const result = await adapter.syncChanges({ limit: 20 });

  assert.equal(result.messages[0]?.provider.messageId, "m1");
  assert.deepEqual(result.deletedProviderMessageIds, ["m2"]);
  assert.ok(result.nextCursor);
  assert.equal(result.hasMore, false);
});

test("revoked consent clears stored credentials", async () => {
  const store = new MemoryStore();
  store.value = {
    accessToken: "expired",
    refreshToken: "refresh",
    expiresAt: Date.now() - 1,
  };
  const auth = new MicrosoftOAuthClient(
    { clientId: "id", clientSecret: "value", redirectUri: "https://example.test/callback" },
    store,
    async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  );

  await assert.rejects(() => auth.accessToken(context));
  assert.equal(store.value, null);
});

test("Graph actions and subscriptions use provider APIs", async () => {
  const store = new MemoryStore();
  store.value = {
    accessToken: "token",
    refreshToken: "refresh",
    expiresAt: Date.now() + 3600000,
  };
  const auth = makeOauth(store);
  const bodies: string[] = [];
  const api = new MicrosoftGraphApiClient(auth, async (input, init) => {
    const url = new URL(String(input));
    if (typeof init?.body === "string") bodies.push(init.body);

    if (url.pathname.endsWith("/me")) {
      return new Response(JSON.stringify({ id: "me", mail: "u@example.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname.endsWith("/subscriptions")) {
      return new Response(JSON.stringify({
        id: "sub-1",
        resource: "/me/messages",
        changeType: "created,updated,deleted",
        notificationUrl: "https://example.test/webhook",
        expirationDateTime: "2026-10-07T07:00:00Z",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(graphMessage()), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const adapter = new MicrosoftGraphAdapter(api, auth);
  await adapter.connect(context);
  await adapter.archive("m1");
  await adapter.trash("m1");
  await adapter.restore("m1");
  await adapter.markImportant("m1", true);
  await adapter.star("m1", true);
  await adapter.markRead("m1", true);
  const sub = await adapter.createSubscription(
    "https://example.test/webhook",
    "state",
    "2026-10-07T07:00:00Z",
  );

  assert.equal(sub.id, "sub-1");
  assert.ok(bodies.some((body) => body.includes('"destinationId":"archive"')));
  assert.ok(bodies.some((body) => body.includes('"destinationId":"deleteditems"')));
  assert.ok(bodies.some((body) => body.includes('"destinationId":"inbox"')));
  assert.ok(bodies.some((body) => body.includes('"importance":"high"')));
  assert.ok(bodies.some((body) => body.includes('"flagStatus":"flagged"')));
  assert.ok(bodies.some((body) => body.includes('"isRead":true')));
  assert.ok(bodies.some((body) => body.includes('"resource":"/me/messages"')));
});
