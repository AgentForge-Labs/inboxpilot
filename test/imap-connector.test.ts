import test from "node:test";
import assert from "node:assert/strict";
import type { ImapFlow } from "imapflow";
import {
  ImapAdapter,
  assertImapAuthPolicy,
  decodeImapCursor,
  decodeImapMessageRef,
  encodeImapCursor,
  encodeImapMessageRef,
  normalizeImapMessage,
  type ImapCredentialStore,
  type ImapSecretRecord,
  type ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

class MemoryCredentials implements ImapCredentialStore {
  deleted = false;
  constructor(public value: ImapSecretRecord | null) {}
  async get() { return this.value; }
  async delete() {
    this.value = null;
    this.deleted = true;
  }
}

const rawMail = Buffer.from(
  [
    "From: Sender <sender@example.test>",
    "To: User <user@example.test>",
    "Subject: Important status",
    "Message-ID: <msg-1@example.test>",
    "Date: Tue, 06 Oct 2026 07:00:00 +0000",
    "Authentication-Results: mx.example; spf=pass; dkim=pass; dmarc=pass",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello from IMAP.",
  ].join("\r\n"),
);

test("IMAP auth policy requires explicit opt-in for normal passwords", () => {
  assert.throws(
    () =>
      assertImapAuthPolicy(
        { username: "u", authMode: "password", secret: "secret-value" },
        { host: "mail.example.test", port: 993, tlsMode: "implicit" },
      ),
    /disabled/,
  );

  assert.doesNotThrow(() =>
    assertImapAuthPolicy(
      { username: "u", authMode: "app_password", secret: "secret-value" },
      { host: "mail.example.test", port: 993, tlsMode: "implicit" },
    ),
  );

  assert.doesNotThrow(() =>
    assertImapAuthPolicy(
      { username: "u", authMode: "oauth2", accessToken: "token-value" },
      { host: "mail.example.test", port: 993, tlsMode: "implicit" },
    ),
  );
});

test("IMAP message refs and cursors preserve UIDVALIDITY scope", () => {
  const encodedRef = encodeImapMessageRef({
    mailbox: "INBOX",
    uidValidity: "77",
    uid: 42,
  });
  assert.deepEqual(decodeImapMessageRef(encodedRef), {
    mailbox: "INBOX",
    uidValidity: "77",
    uid: 42,
  });

  const encodedCursor = encodeImapCursor({
    mailbox: "INBOX",
    uidValidity: "77",
    lastUid: 42,
  });
  assert.deepEqual(decodeImapCursor(encodedCursor), {
    mailbox: "INBOX",
    uidValidity: "77",
    lastUid: 42,
  });
});

test("IMAP RFC822 normalization creates canonical message and security signals", async () => {
  const message = await normalizeImapMessage({
    fetched: {
      seq: 1,
      uid: 10,
      source: rawMail,
      flags: new Set(["\\Flagged", "$Important"]),
      internalDate: new Date("2026-10-06T07:01:00Z"),
    },
    source: rawMail,
    mailbox: "INBOX",
    uidValidity: 77n,
    mailboxRole: "inbox",
    context,
  });

  assert.equal(message.provider.kind, "imap");
  assert.equal(message.subject, "Important status");
  assert.match(message.body.text ?? "", /Hello from IMAP/);
  assert.equal(message.flags.starred, true);
  assert.equal(message.flags.important, true);
  assert.equal(message.authentication.spf, "pass");
  assert.equal(message.mailboxes[0]?.role, "inbox");

  const ref = decodeImapMessageRef(message.provider.messageId);
  assert.equal(ref.uid, 10);
  assert.equal(ref.uidValidity, "77");
});

function fakeClient() {
  const actions: string[] = [];
  let fetchRange = "";
  const mailbox = {
    path: "INBOX",
    delimiter: "/",
    flags: new Set<string>(),
    uidValidity: 77n,
    uidNext: 3,
    exists: 2,
    readOnly: false,
  };

  const client = {
    async list() {
      return [
        {
          path: "INBOX",
          pathAsListed: "INBOX",
          name: "INBOX",
          delimiter: "/",
          parent: [],
          parentPath: "",
          flags: new Set<string>(),
          specialUse: "\\Inbox",
          listed: true,
          subscribed: true,
        },
        {
          path: "Archive",
          pathAsListed: "Archive",
          name: "Archive",
          delimiter: "/",
          parent: [],
          parentPath: "",
          flags: new Set<string>(),
          specialUse: "\\Archive",
          listed: true,
          subscribed: true,
        },
      ];
    },
    async mailboxOpen(path: string) {
      actions.push(`open:${path}`);
      return { ...mailbox, path };
    },
    async fetchAll(range: string) {
      fetchRange = range;
      return [
        {
          seq: 1,
          uid: 1,
          source: rawMail,
          flags: new Set<string>(["\\Seen"]),
          internalDate: new Date("2026-10-06T07:01:00Z"),
        },
        {
          seq: 2,
          uid: 2,
          source: rawMail,
          flags: new Set<string>(),
          internalDate: new Date("2026-10-06T07:02:00Z"),
        },
      ];
    },
    async fetchOne(uid: number) {
      return {
        seq: uid,
        uid,
        source: rawMail,
        flags: new Set<string>(),
        internalDate: new Date("2026-10-06T07:01:00Z"),
      };
    },
    async messageMove(uid: number, destination: string) {
      actions.push(`move:${uid}:${destination}`);
      return false;
    },
    async messageFlagsAdd(uid: number, flags: string[]) {
      actions.push(`add:${uid}:${flags.join(",")}`);
      return true;
    },
    async messageFlagsRemove(uid: number, flags: string[]) {
      actions.push(`remove:${uid}:${flags.join(",")}`);
      return true;
    },
    async idle() {
      actions.push("idle");
      return true;
    },
    async logout() {
      actions.push("logout");
    },
  };

  return {
    client: client as unknown as ImapFlow,
    actions,
    getFetchRange: () => fetchRange,
    mailbox,
  };
}

function makeAdapter(fake = fakeClient()) {
  const credentials = new MemoryCredentials({
    username: "user@example.test",
    authMode: "app_password",
    secret: "secret-value",
  });
  const adapter = new ImapAdapter(
    {
      host: "mail.example.test",
      port: 993,
      tlsMode: "implicit",
      inboxPath: "INBOX",
      archivePath: "Archive",
      trashPath: "Trash",
    },
    credentials,
    (async () => fake.client) as never,
  );
  return { adapter, credentials, fake };
}

test("IMAP adapter maps folders and incrementally syncs UIDs", async () => {
  const { adapter, fake } = makeAdapter();
  await adapter.connect(context);

  const folders = await adapter.listFolders();
  assert.equal(folders[0]?.role, "inbox");
  assert.equal(folders[1]?.role, "archive");

  const sync = await adapter.syncChanges({ limit: 10 });
  assert.equal(sync.messages.length, 2);
  assert.equal(fake.getFetchRange(), "1:*");
  assert.equal(sync.hasMore, false);

  const cursor = decodeImapCursor(sync.nextCursor);
  assert.equal(cursor?.uidValidity, "77");
  assert.equal(cursor?.lastUid, 2);
});

test("UIDVALIDITY change forces safe reconciliation from first UID", async () => {
  const { adapter, fake } = makeAdapter();
  await adapter.connect(context);

  await adapter.syncChanges({
    cursor: encodeImapCursor({
      mailbox: "INBOX",
      uidValidity: "66",
      lastUid: 100,
    }),
  });

  assert.equal(fake.getFetchRange(), "1:*");
});

test("IMAP actions use configured folders and flags", async () => {
  const { adapter, fake } = makeAdapter();
  await adapter.connect(context);
  const message = await adapter.getMessage(
    encodeImapMessageRef({ mailbox: "INBOX", uidValidity: "77", uid: 2 }),
  );

  await adapter.archive(message.provider.messageId);
  await adapter.trash(message.provider.messageId);
  await adapter.restore(message.provider.messageId);
  await adapter.markRead(message.provider.messageId, true);
  await adapter.star(message.provider.messageId, true);
  await adapter.markImportant(message.provider.messageId, true);
  assert.equal(await adapter.waitForIdleChange(), true);

  assert.ok(fake.actions.includes("move:2:Archive"));
  assert.ok(fake.actions.includes("move:2:Trash"));
  assert.ok(fake.actions.includes("move:2:INBOX"));
  assert.ok(fake.actions.includes("add:2:\\Seen"));
  assert.ok(fake.actions.includes("add:2:\\Flagged"));
  assert.ok(fake.actions.includes("add:2:$Important"));
  assert.ok(fake.actions.includes("idle"));
});

test("archive and trash capabilities are disabled without configured folders", () => {
  const fake = fakeClient();
  const adapter = new ImapAdapter(
    { host: "mail.example.test", port: 993, tlsMode: "implicit" },
    new MemoryCredentials({
      username: "user@example.test",
      authMode: "oauth2",
      accessToken: "token-value",
    }),
    (async () => fake.client) as never,
  );

  assert.equal(adapter.capabilities().archive, false);
  assert.equal(adapter.capabilities().trash, false);
});

test("disconnect can remove credential-store record explicitly", async () => {
  const { adapter, credentials, fake } = makeAdapter();
  await adapter.connect(context);
  await adapter.disconnect(true);

  assert.equal(credentials.deleted, true);
  assert.ok(fake.actions.includes("logout"));
  await assert.rejects(() => adapter.listFolders(), /not connected/);
});
