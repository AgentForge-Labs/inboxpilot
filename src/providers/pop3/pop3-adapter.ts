import { BaseProviderAdapter } from "../base-provider-adapter.js";
import type {
  ProviderConnectResult,
  ProviderConnectionContext,
} from "../provider-adapter.js";
import type {
  Pop3AdapterOptions,
  Pop3Capabilities,
  Pop3FetchedMessage,
  Pop3MessageRef,
  Pop3Transport,
} from "./pop3-types.js";
import {
  Pop3CapabilityError,
  pop3Capabilities,
} from "./pop3-types.js";

export class Pop3Adapter extends BaseProviderAdapter {
  private readonly pop3Caps: Pop3Capabilities;

  constructor(
    private readonly transport: Pop3Transport,
    options: Pop3AdapterOptions = {},
  ) {
    super("pop3", []);
    this.pop3Caps = pop3Capabilities(
      Boolean(options.allowServerDelete),
    );
  }

  pop3Capabilities(): Pop3Capabilities {
    return this.pop3Caps;
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    const connected = await this.transport.connect(context);
    return {
      connected: true,
      provider: "pop3",
      ...(connected.accountExternalId
        ? { accountExternalId: connected.accountExternalId }
        : {}),
    };
  }

  async list(): Promise<readonly Pop3MessageRef[]> {
    this.assertConnected();
    this.assertPop3Capability("list");
    return this.transport.list();
  }

  async fetch(
    ref: Pop3MessageRef,
  ): Promise<Pop3FetchedMessage> {
    this.assertConnected();
    this.assertPop3Capability("fetch");
    return this.transport.fetch(ref);
  }

  async deleteOnServer(
    ref: Pop3MessageRef,
  ): Promise<void> {
    this.assertConnected();
    this.assertPop3Capability("deleteOnServer");
    await this.transport.deleteOnServer(ref);
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.setDisconnected();
  }

  private assertPop3Capability(
    capability: keyof Pop3Capabilities,
  ): void {
    if (!this.pop3Caps[capability]) {
      throw new Pop3CapabilityError(capability);
    }
  }
}

export function discoverPop3Capabilities(
  adapter: Pick<Pop3Adapter, "pop3Capabilities">,
): Pop3Capabilities {
  return adapter.pop3Capabilities();
}
