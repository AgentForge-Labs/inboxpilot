import test from "node:test";
import assert from "node:assert/strict";

import {
  Pop3Adapter,
  Pop3CapabilityError,
  ProviderCapabilityError,
  discoverCapabilities,
  discoverPop3Capabilities,
  type Pop3FetchedMessage,
  type Pop3MessageRef,
  type Pop3Transport,
  type ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

class StubPop3Transport implements Pop3Transport {
  connected = false;
  deleted: Pop3MessageRef[] = [];
  readonly refs: Pop3MessageRef[] = [
    { sequenceNumber: 1, uidl: "uidl-1", sizeBytes: 42 },
  ];

  async connect(): Promise<{ accountExternalId: string }> {
    this.connected = true;
    return { accountExternalId: "user@example.test" };
  }

  async list(): Promise<readonly Pop3MessageRef[]> {
    return this.refs;
  }

  async fetch(ref: Pop3MessageRef): Promise<Pop3FetchedMessage> {
    return {
      ref,
      raw: Buffer.from(
        "Subject: Test\r\nFrom: sender@example.test\r\n\r\nHello",
      ),
    };
  }

  async deleteOnServer(ref: Pop3MessageRef): Promise<void> {
    this.deleted.push(ref);
  }

  async close(): Promise<void> {
    this.connected = false;
  }
}

test("POP3 is discoverable as receive-only without pretending mailbox mutation support", async () => {
  const transport = new StubPop3Transport();
  const adapter = new Pop3Adapter(transport);

  assert.equal(adapter.kind, "pop3");

  const common = discoverCapabilities(adapter);
  assert.deepEqual(common.supported, []);
  for (const capability of [
    "listFolders",
    "listLabels",
    "getThread",
    "archive",
    "move",
    "trash",
    "restore",
    "deletePermanent",
  ]) {
    assert.ok(common.unsupported.includes(capability as never));
  }

  assert.deepEqual(discoverPop3Capabilities(adapter), {
    connect: true,
    list: true,
    fetch: true,
    deleteOnServer: false,
  });

  const connected = await adapter.connect(context);
  assert.equal(connected.provider, "pop3");
  assert.equal(connected.accountExternalId, "user@example.test");

  assert.deepEqual(await adapter.list(), transport.refs);
  const fetched = await adapter.fetch(transport.refs[0]!);
  assert.equal(fetched.ref.uidl, "uidl-1");
  assert.match(Buffer.from(fetched.raw).toString("utf8"), /Subject: Test/);

  await assert.rejects(
    () => adapter.archive("uidl-1"),
    (error: unknown) =>
      error instanceof ProviderCapabilityError &&
      error.provider === "pop3" &&
      error.capability === "archive",
  );

  await assert.rejects(
    () => adapter.deleteOnServer(transport.refs[0]!),
    (error: unknown) =>
      error instanceof Pop3CapabilityError &&
      error.code === "POP3_CAPABILITY_UNSUPPORTED" &&
      error.capability === "deleteOnServer",
  );
});

test("POP3 server deletion is a separate explicit opt-in capability", async () => {
  const transport = new StubPop3Transport();
  const adapter = new Pop3Adapter(transport, {
    allowServerDelete: true,
  });

  assert.equal(
    adapter.pop3Capabilities().deleteOnServer,
    true,
  );

  await adapter.connect(context);
  await adapter.deleteOnServer(transport.refs[0]!);
  assert.deepEqual(transport.deleted, [transport.refs[0]!]);

  await adapter.disconnect();
  assert.equal(transport.connected, false);
  await assert.rejects(() => adapter.list(), /not connected/i);
});
