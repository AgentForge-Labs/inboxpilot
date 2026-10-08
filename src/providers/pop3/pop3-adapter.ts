import { BaseProviderAdapter } from "../base-provider-adapter.js";
import type {
  ProviderConnectResult,
  ProviderConnectionContext,
  SyncChangesRequest,
  SyncChangesResult,
} from "../provider-adapter.js";
import { normalizePop3Message } from "./pop3-normalizer.js";
import {
  InMemoryPop3SyncStateStore,
  Pop3IncrementalSync,
  type Pop3SyncItem,
  type Pop3SyncStateStore,
} from "./pop3-sync.js";
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

export interface Pop3AdapterRuntimeOptions
  extends Pop3AdapterOptions {
  syncStateStore?: Pop3SyncStateStore;
}

interface Pop3AdapterCursor {
  version: 1;
  acknowledge: Array<{
    identityKey: string;
    stableMessageId: string;
  }>;
}

function encodeCursor(
  items: readonly Pick<
    Pop3SyncItem,
    "identityKey" | "stableMessageId"
  >[],
): string {
  const cursor: Pop3AdapterCursor = {
    version: 1,
    acknowledge: items.map((item) => ({
      identityKey: item.identityKey,
      stableMessageId:
        item.stableMessageId,
    })),
  };
  return Buffer.from(
    JSON.stringify(cursor),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  value?: string,
): Pop3AdapterCursor | undefined {
  if (!value) return undefined;
  let parsed: Partial<Pop3AdapterCursor>;
  try {
    parsed = JSON.parse(
      Buffer.from(
        value,
        "base64url",
      ).toString("utf8"),
    ) as Partial<Pop3AdapterCursor>;
  } catch {
    throw new TypeError(
      "Invalid POP3 sync cursor",
    );
  }

  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.acknowledge) ||
    parsed.acknowledge.length > 500
  ) {
    throw new TypeError(
      "Invalid POP3 sync cursor",
    );
  }

  const acknowledge =
    parsed.acknowledge.map((item) => {
      if (
        !item ||
        typeof item.identityKey !==
          "string" ||
        !item.identityKey.trim() ||
        typeof item.stableMessageId !==
          "string" ||
        !item.stableMessageId.trim()
      ) {
        throw new TypeError(
          "Invalid POP3 sync cursor",
        );
      }
      return {
        identityKey:
          item.identityKey,
        stableMessageId:
          item.stableMessageId,
      };
    });

  return {
    version: 1,
    acknowledge,
  };
}

export class Pop3Adapter extends BaseProviderAdapter {
  private readonly pop3Caps: Pop3Capabilities;
  private readonly sync: Pop3IncrementalSync;
  private context:
    | ProviderConnectionContext
    | undefined;

  constructor(
    private readonly transport: Pop3Transport,
    options: Pop3AdapterRuntimeOptions = {},
  ) {
    super("pop3", ["syncChanges"]);
    this.pop3Caps = pop3Capabilities(
      Boolean(options.allowServerDelete),
    );
    this.sync = new Pop3IncrementalSync(
      transport,
      options.syncStateStore ??
        new InMemoryPop3SyncStateStore(),
    );
  }

  pop3Capabilities(): Pop3Capabilities {
    return this.pop3Caps;
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    const connected =
      await this.transport.connect(context);
    this.context = context;
    return {
      connected: true,
      provider: "pop3",
      ...(connected.accountExternalId
        ? {
            accountExternalId:
              connected.accountExternalId,
          }
        : {}),
    };
  }

  async list(): Promise<
    readonly Pop3MessageRef[]
  > {
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

  override async syncChanges(
    request: SyncChangesRequest = {},
  ): Promise<SyncChangesResult> {
    this.assertConnected();
    this.assertCapability("syncChanges");
    const context = this.requireContext();

    const previous =
      decodeCursor(request.cursor);
    if (previous) {
      await this.sync.acknowledgeAll(
        context,
        previous.acknowledge,
      );
    }

    const batch = await this.sync.poll(
      context,
      {
        ...(request.limit !== undefined
          ? { limit: request.limit }
          : {}),
      },
    );

    const messages = await Promise.all(
      batch.items.map((item) =>
        normalizePop3Message({
          item,
          context,
        }),
      ),
    );

    return {
      messages,
      deletedProviderMessageIds: [],
      nextCursor: encodeCursor(
        batch.items,
      ),
      hasMore: batch.hasMore,
    };
  }

  async deleteOnServer(
    ref: Pop3MessageRef,
  ): Promise<void> {
    this.assertConnected();
    this.assertPop3Capability(
      "deleteOnServer",
    );
    await this.transport.deleteOnServer(
      ref,
    );
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
    this.context = undefined;
    this.setDisconnected();
  }

  private requireContext(): ProviderConnectionContext {
    this.assertConnected();
    if (!this.context) {
      throw new Error(
        "POP3 connection context is unavailable",
      );
    }
    return this.context;
  }

  private assertPop3Capability(
    capability: keyof Pop3Capabilities,
  ): void {
    if (!this.pop3Caps[capability]) {
      throw new Pop3CapabilityError(
        capability,
      );
    }
  }
}

export function discoverPop3Capabilities(
  adapter: Pick<
    Pop3Adapter,
    "pop3Capabilities"
  >,
): Pop3Capabilities {
  return adapter.pop3Capabilities();
}
