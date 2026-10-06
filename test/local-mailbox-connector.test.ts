import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MaildirAdapter,
  MboxAdapter,
  splitMbox,
  validateLocalMailboxConfig,
  type ClassificationState,
  type ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

const rawMessage = [
  "From: Sender <sender@example.test>",
  "To: User <user@example.test>",
  "Subject: Local mailbox",
  "Message-ID: <local-1@example.test>",
  "Date: Tue, 06 Oct 2026 08:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello from local storage.",
  "",
].join("\r\n");

async function makeMaildir() {
  const root = await mkdtemp(join(tmpdir(), "inboxpilot-local-"));
  const inbox = join(root, "inbox");
  const archive = join(root, "archive");
  const trash = join(root, "trash");
  for (const path of [inbox, archive, trash]) {
    await mkdir(join(path, "cur"), { recursive: true });
    await mkdir(join(path, "new"), { recursive: true });
    await mkdir(join(path, "tmp"), { recursive: true });
  }
  await writeFile(join(inbox, "new", "msg-1"), rawMessage);
  return { root, inbox, archive, trash, state: join(root, "state.json") };
}

test("local path validation rejects source symlink escaping allowed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "inboxpilot-root-"));
  const outside = await mkdtemp(join(tmpdir(), "inboxpilot-outside-"));
  const link = join(root, "escape");
  await symlink(outside, link);

  await assert.rejects(
    () =>
      validateLocalMailboxConfig({
        sourcePath: link,
        allowedRoot: root,
        statePath: join(root, "state.json"),
      }),
    /escapes allowedRoot/,
  );

  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("Maildir adapter ingests once and restores classification from sidecar", async () => {
  const fixture = await makeMaildir();
  const adapter = new MaildirAdapter({
    sourcePath: fixture.inbox,
    allowedRoot: fixture.root,
    statePath: fixture.state,
  });

  await adapter.connect(context);
  const first = await adapter.syncChanges();
  assert.equal(first.messages.length, 1);
  assert.equal(first.messages[0]?.provider.kind, "maildir");
  assert.equal(first.messages[0]?.subject, "Local mailbox");

  const providerId = first.messages[0]!.provider.messageId;
  const classification: ClassificationState = {
    status: "classified",
    categories: ["personal"],
    importanceScore: 72,
    confidence: 0.9,
  };
  await adapter.setClassification(providerId, classification);

  const fetched = await adapter.getMessage(providerId);
  assert.deepEqual(fetched.classification, classification);

  const second = await adapter.syncChanges();
  assert.equal(second.messages.length, 0);

  const sidecar = JSON.parse(await readFile(fixture.state, "utf8")) as {
    version: number;
    classifications: Record<string, unknown>;
  };
  assert.equal(sidecar.version, 1);
  assert.ok(sidecar.classifications[providerId]);

  await rm(fixture.root, { recursive: true, force: true });
});

test("Maildir writable mode changes filename flags without changing provider identity", async () => {
  const fixture = await makeMaildir();
  const adapter = new MaildirAdapter({
    sourcePath: fixture.inbox,
    allowedRoot: fixture.root,
    statePath: fixture.state,
    writable: true,
  });
  await adapter.connect(context);
  const first = await adapter.syncChanges();
  const providerId = first.messages[0]!.provider.messageId;

  assert.equal(adapter.capabilities().markRead, true);
  assert.equal(adapter.capabilities().deletePermanent, false);

  await adapter.markRead(providerId, true);
  await adapter.star(providerId, true);

  const names = await readdir(join(fixture.inbox, "new"));
  assert.equal(names.length, 1);
  assert.match(names[0]!, /:2,FS$/);

  const fetched = await adapter.getMessage(providerId);
  assert.equal(fetched.provider.messageId, providerId);
  assert.equal(fetched.flags.read, true);
  assert.equal(fetched.flags.starred, true);

  await rm(fixture.root, { recursive: true, force: true });
});

test("Maildir destructive mode gates archive, trash, restore and permanent delete", async () => {
  const fixture = await makeMaildir();
  const adapter = new MaildirAdapter({
    sourcePath: fixture.inbox,
    allowedRoot: fixture.root,
    statePath: fixture.state,
    writable: true,
    allowDestructive: true,
    archivePath: fixture.archive,
    trashPath: fixture.trash,
  });
  await adapter.connect(context);
  const first = await adapter.syncChanges();
  const providerId = first.messages[0]!.provider.messageId;

  assert.equal(adapter.capabilities().archive, true);
  assert.equal(adapter.capabilities().trash, true);
  assert.equal(adapter.capabilities().deletePermanent, true);

  await adapter.archive(providerId);
  assert.equal((await readdir(join(fixture.archive, "cur"))).length, 1);
  await adapter.trash(providerId);
  assert.equal((await readdir(join(fixture.trash, "cur"))).length, 1);
  await adapter.restore(providerId);
  assert.equal((await readdir(join(fixture.inbox, "cur"))).length, 1);
  await adapter.deletePermanent(providerId);
  assert.equal((await readdir(join(fixture.inbox, "cur"))).length, 0);

  await rm(fixture.root, { recursive: true, force: true });
});

test("mbox splitter and adapter preserve duplicate messages as distinct provider entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "inboxpilot-mbox-"));
  const source = join(root, "mailbox.mbox");
  const envelope = "From sender@example.test Tue Oct  6 08:00:00 2026\n";
  await writeFile(
    source,
    envelope + rawMessage.replace(/\r\n/g, "\n") +
      envelope + rawMessage.replace(/\r\n/g, "\n"),
  );

  const blocks = splitMbox(await readFile(source));
  assert.equal(blocks.length, 2);

  const adapter = new MboxAdapter({
    sourcePath: source,
    allowedRoot: root,
    statePath: join(root, "state.json"),
  });
  await adapter.connect(context);
  const first = await adapter.syncChanges();

  assert.equal(first.messages.length, 2);
  assert.notEqual(
    first.messages[0]?.provider.messageId,
    first.messages[1]?.provider.messageId,
  );
  assert.equal(adapter.capabilities().move, false);
  assert.equal(adapter.capabilities().deletePermanent, false);

  const second = await adapter.syncChanges();
  assert.equal(second.messages.length, 0);

  await rm(root, { recursive: true, force: true });
});

test("mbox refuses writable or destructive configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "inboxpilot-mbox-ro-"));
  const source = join(root, "mailbox.mbox");
  await writeFile(source, rawMessage);

  const adapter = new MboxAdapter({
    sourcePath: source,
    allowedRoot: root,
    statePath: join(root, "state.json"),
    writable: true,
  });

  await assert.rejects(() => adapter.connect(context), /read-only/);
  await rm(root, { recursive: true, force: true });
});
