import test from "node:test";
import assert from "node:assert/strict";
import {
  JMAP_CORE_CAPABILITY,
  JMAP_MAIL_CAPABILITY,
  JmapAdapter,
  JmapClient,
  normalizeJmapEmail,
  type JmapCredentialStore,
  type JmapEmail,
  type JmapSession,
  type ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

class MemoryCredentials implements JmapCredentialStore {
  deleted = false;
  async get() {
    return { accessToken: "secret-token" };
  }
  async delete() {
    this.deleted = true;
  }
}

function session(readOnly = false): JmapSession {
  return {
    capabilities: {
      [JMAP_CORE_CAPABILITY]: {},
      [JMAP_MAIL_CAPABILITY]: {},
    },
    accounts: {
      acc: {
        name: "Mail",
        isPersonal: true,
        isReadOnly: readOnly,
        accountCapabilities: {
          [JMAP_MAIL_CAPABILITY]: {},
        },
      },
    },
    primaryAccounts: {
      [JMAP_MAIL_CAPABILITY]: "acc",
    },
    username: "user@example.test",
    apiUrl: "https://mail.example.test/jmap/api",
    state: "session-state",
  };
}

function email(id = "e1", threadId = "t1"): JmapEmail {
  return {
    id,
    blobId: `b-${id}`,
    threadId,
    mailboxIds: { inbox: true },
    keywords: {
      "$seen": true,
      "$flagged": true,
      "$important": true,
      Customer: true,
    },
    size: 100,
    receivedAt: "2026-10-06T07:00:00Z",
    sentAt: "2026-10-06T06:59:00Z",
    messageId: [`<${id}@example.test>`],
    from: [{ name: "Sender", email: "sender@example.test" }],
    to: [{ name: "User", email: "user@example.test" }],
    subject: "JMAP status",
    preview: "Preview",
    bodyValues: {
      text: { value: "Hello from JMAP." },
      html: { value: "<p>Hello from JMAP.</p>" },
    },
    textBody: [{ partId: "text", type: "text/plain" }],
    htmlBody: [{ partId: "html", type: "text/html" }],
    attachments: [
      {
        partId: "a1",
        blobId: "blob-a1",
        name: "invoice.pdf",
        type: "application/pdf",
        size: 123,
      },
    ],
    "header:Authentication-Results:asText":
      "mx.example; spf=pass; dkim=pass; dmarc=pass",
  };
}

test("JMAP session discovery uses bearer token and validates mail capability", async () => {
  const credentials = new MemoryCredentials();
  let authorization = "";
  const client = new JmapClient(
    { sessionUrl: "https://mail.example.test/.well-known/jmap" },
    credentials,
    async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify(session()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  const discovered = await client.discoverSession(context);
  assert.equal(authorization, "Bearer secret-token");
  assert.equal(
    discovered.primaryAccounts[JMAP_MAIL_CAPABILITY],
    "acc",
  );
});

test("JMAP normalizer maps bodies, mailbox, keywords and attachments", () => {
  const mailboxes = new Map([
    ["inbox", { name: "Inbox", role: "inbox" as const }],
  ]);
  const normalized = normalizeJmapEmail(email(), context, mailboxes);

  assert.equal(normalized.provider.kind, "jmap");
  assert.equal(normalized.provider.threadId, "t1");
  assert.equal(normalized.body.text, "Hello from JMAP.");
  assert.equal(normalized.body.html, "<p>Hello from JMAP.</p>");
  assert.equal(normalized.flags.read, true);
  assert.equal(normalized.flags.starred, true);
  assert.equal(normalized.flags.important, true);
  assert.deepEqual(normalized.labels, ["Customer"]);
  assert.equal(normalized.mailboxes[0]?.role, "inbox");
  assert.equal(normalized.attachments[0]?.filename, "invoice.pdf");
  assert.equal(normalized.authentication.dmarc, "pass");
});

class FakeJmapClient {
  readonly sets: Array<Record<string, unknown>> = [];
  readonly credentials = new MemoryCredentials();
  readonly readonlyAccount: boolean;
  changesCalls = 0;

  constructor(readonlyAccount = false) {
    this.readonlyAccount = readonlyAccount;
  }

  async discoverSession() {
    return session(this.readonlyAccount);
  }

  async removeCredentials() {
    await this.credentials.delete();
  }

  async invoke<T extends object>(
    _context: ProviderConnectionContext,
    _session: JmapSession,
    methodName: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    if (methodName === "Mailbox/get") {
      return {
        accountId: "acc",
        state: "mbox-state",
        list: [
          { id: "inbox", name: "Inbox", role: "inbox" },
          { id: "archive", name: "Archive", role: "archive" },
          { id: "trash", name: "Trash", role: "trash" },
          { id: "custom", name: "Projects", role: null },
        ],
      } as T;
    }

    if (methodName === "Email/query") {
      const position = Number(args.position ?? 0);
      return {
        accountId: "acc",
        queryState: "query-state",
        canCalculateChanges: true,
        position,
        ids: position === 0 ? ["e1"] : [],
        total: 1,
      } as T;
    }

    if (methodName === "Email/changes") {
      this.changesCalls += 1;
      return {
        accountId: "acc",
        oldState: args.sinceState,
        newState: "email-state-2",
        hasMoreChanges: false,
        created: ["e2"],
        updated: [],
        destroyed: ["e3"],
      } as T;
    }

    if (methodName === "Thread/get") {
      return {
        accountId: "acc",
        state: "thread-state",
        list: [{ id: "t1", emailIds: ["e1", "e2"] }],
      } as T;
    }

    if (methodName === "Email/get") {
      const ids = (args.ids ?? []) as string[];
      const properties = (args.properties ?? []) as string[];
      if (
        properties.length === 3 &&
        properties.includes("mailboxIds") &&
        properties.includes("keywords")
      ) {
        return {
          accountId: "acc",
          state: "email-state-1",
          list: ids.map((id) => ({
            id,
            threadId: "t1",
            mailboxIds: { inbox: true },
            keywords: { "$seen": true, existing: true },
            receivedAt: "2026-10-06T07:00:00Z",
          })),
        } as T;
      }

      return {
        accountId: "acc",
        state: "email-state-1",
        list: ids.map((id) =>
          id === "e2" ? email("e2", "t1") : email(id, "t1"),
        ),
      } as T;
    }

    if (methodName === "Email/set") {
      this.sets.push(args);
      return {
        accountId: "acc",
        oldState: "email-state-1",
        newState: "email-state-2",
        updated: { e1: null },
      } as T;
    }

    throw new Error(`Unexpected method ${methodName}`);
  }
}

test("JMAP adapter performs initial query then Email/changes incremental sync", async () => {
  const fake = new FakeJmapClient();
  const adapter = new JmapAdapter(fake as unknown as JmapClient);

  const connected = await adapter.connect(context);
  assert.equal(connected.accountExternalId, "acc");

  const initial = await adapter.syncChanges({ limit: 50 });
  assert.equal(initial.messages[0]?.provider.messageId, "e1");
  assert.equal(initial.hasMore, false);
  assert.ok(initial.nextCursor);

  const delta = await adapter.syncChanges({
    cursor: initial.nextCursor,
    limit: 50,
  });
  assert.equal(fake.changesCalls, 1);
  assert.equal(delta.messages[0]?.provider.messageId, "e2");
  assert.deepEqual(delta.deletedProviderMessageIds, ["e3"]);
  assert.equal(delta.hasMore, false);
});

test("JMAP adapter maps folders and retrieves canonical thread", async () => {
  const fake = new FakeJmapClient();
  const adapter = new JmapAdapter(fake as unknown as JmapClient);
  await adapter.connect(context);

  const folders = await adapter.listFolders();
  assert.equal(folders.find((folder) => folder.id === "jmap:inbox")?.role, "inbox");
  assert.equal(folders.find((folder) => folder.id === "jmap:trash")?.role, "trash");
  assert.equal(folders.find((folder) => folder.id === "jmap:custom")?.role, "custom");

  const thread = await adapter.getThread("t1");
  assert.equal(thread.messageIds.length, 2);
  assert.equal(thread.participantAddresses.includes("sender@example.test"), true);
});

test("JMAP actions use Email/set and preserve existing keywords", async () => {
  const fake = new FakeJmapClient();
  const adapter = new JmapAdapter(fake as unknown as JmapClient);
  await adapter.connect(context);

  await adapter.archive("e1");
  await adapter.trash("e1");
  await adapter.restore("e1");
  await adapter.move("e1", { folderId: "jmap:custom" });
  await adapter.markRead("e1", false);
  await adapter.star("e1", true);
  await adapter.markImportant("e1", true);

  const serialized = fake.sets.map((entry) => JSON.stringify(entry));
  assert.ok(serialized.some((body) => body.includes('"archive":true')));
  assert.ok(serialized.some((body) => body.includes('"trash":true')));
  assert.ok(serialized.some((body) => body.includes('"inbox":true')));
  assert.ok(serialized.some((body) => body.includes('"custom":true')));
  assert.ok(
    serialized.some(
      (body) =>
        body.includes('"existing":true') &&
        !body.includes('"$seen":true'),
    ),
  );
  assert.ok(serialized.some((body) => body.includes('"$flagged":true')));
  assert.ok(serialized.some((body) => body.includes('"$important":true')));
});

test("read-only JMAP account disables mutation capabilities", async () => {
  const fake = new FakeJmapClient(true);
  const adapter = new JmapAdapter(fake as unknown as JmapClient);
  await adapter.connect(context);

  assert.equal(adapter.capabilities().move, false);
  assert.equal(adapter.capabilities().archive, false);
  assert.equal(adapter.capabilities().trash, false);
  assert.equal(adapter.capabilities().markRead, false);
  await assert.rejects(
    () => adapter.archive("e1"),
    /does not support capability/,
  );
});

test("disconnect optionally removes JMAP credentials", async () => {
  const fake = new FakeJmapClient();
  const adapter = new JmapAdapter(fake as unknown as JmapClient);
  await adapter.connect(context);
  await adapter.disconnect(true);

  assert.equal(fake.credentials.deleted, true);
  await assert.rejects(() => adapter.listFolders(), /not connected/);
});
