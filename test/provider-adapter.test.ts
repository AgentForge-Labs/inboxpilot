import test from "node:test";
import assert from "node:assert/strict";

import {
  BaseProviderAdapter,
  ProviderCapabilityError,
  ProviderNotConnectedError,
  discoverCapabilities,
  requireCapability,
  unsupportedCapabilities,
  type ProviderConnectResult,
  type ProviderConnectionContext,
} from "../src/index.js";

class MinimalAdapter extends BaseProviderAdapter {
  constructor() {
    super("imap", ["syncChanges", "getMessage", "markRead"]);
  }

  protected async onConnect(
    _context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    return { connected: true, provider: "imap" };
  }

  override async markRead(_providerMessageId: string, _read = true): Promise<void> {
    this.assertConnected();
    this.assertCapability("markRead");
  }
}

test("capability map always advertises supported and unsupported features", () => {
  const caps = unsupportedCapabilities(["getMessage", "markRead"]);

  assert.equal(caps.getMessage, true);
  assert.equal(caps.markRead, true);
  assert.equal(caps.archive, false);
  assert.equal(caps.deletePermanent, false);
  assert.equal(Object.keys(caps).length, 15);
});

test("capability discovery returns explicit supported and unsupported groups", () => {
  const adapter = new MinimalAdapter();
  const summary = discoverCapabilities(adapter);

  assert.deepEqual(summary.supported.sort(), ["getMessage", "markRead", "syncChanges"]);
  assert.ok(summary.unsupported.includes("archive"));
  assert.ok(summary.unsupported.includes("listLabels"));
});

test("requireCapability fails before unsupported provider operation is invoked", () => {
  const adapter = new MinimalAdapter();

  assert.throws(
    () => requireCapability(adapter, "archive"),
    (error: unknown) =>
      error instanceof ProviderCapabilityError &&
      error.code === "PROVIDER_CAPABILITY_UNSUPPORTED",
  );
});

test("adapter rejects operations before connect", async () => {
  const adapter = new MinimalAdapter();

  await assert.rejects(
    () => adapter.markRead("message-1"),
    ProviderNotConnectedError,
  );
});

test("supported adapter operation works after connect", async () => {
  const adapter = new MinimalAdapter();

  await adapter.connect({ tenantId: "tenant-1", accountId: "account-1" });
  await assert.doesNotReject(() => adapter.markRead("message-1"));
});

test("base implementation returns typed capability error if supported method is not overridden", async () => {
  class IncompleteAdapter extends BaseProviderAdapter {
    constructor() {
      super("jmap", ["archive"]);
    }

    protected async onConnect(): Promise<ProviderConnectResult> {
      return { connected: true, provider: "jmap" };
    }
  }

  const adapter = new IncompleteAdapter();
  await adapter.connect({ tenantId: "tenant-1", accountId: "account-1" });

  await assert.rejects(
    () => adapter.archive("message-1"),
    ProviderCapabilityError,
  );
});
