import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

import type { ProviderConnectionContext } from "../provider-adapter.js";
import type {
  Pop3FetchedMessage,
  Pop3MessageRef,
  Pop3Transport,
} from "./pop3-types.js";

export type Pop3SyncIdentityMode = "uidl" | "content_fingerprint";

export interface Pop3SyncIdentity {
  mode: Pop3SyncIdentityMode;
  identityKey: string;
  stableMessageId: string;
}

export interface Pop3SyncItem extends Pop3SyncIdentity {
  fetched: Pop3FetchedMessage;
}

export interface Pop3SyncBatch {
  items: readonly Pop3SyncItem[];
  listed: number;
  alreadySeen: number;
  fallbackFetched: number;
  hasMore: boolean;
}

export interface Pop3SyncStateStore {
  hasSeen(
    context: ProviderConnectionContext,
    identityKey: string,
  ): Promise<boolean>;
  markSeen(
    context: ProviderConnectionContext,
    identityKey: string,
    stableMessageId: string,
  ): Promise<void>;
}

interface StoredPop3Identity {
  stableMessageId: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface Pop3StateDocument {
  version: 1;
  accounts: Record<
    string,
    {
      seen: Record<string, StoredPop3Identity>;
    }
  >;
}

function accountKey(
  context: ProviderConnectionContext,
): string {
  return Buffer.from(
    JSON.stringify([
      context.tenantId,
      context.accountId,
    ]),
    "utf8",
  ).toString("base64url");
}

function freshDocument(): Pop3StateDocument {
  return {
    version: 1,
    accounts: {},
  };
}

export class InMemoryPop3SyncStateStore
  implements Pop3SyncStateStore
{
  readonly seen = new Map<
    string,
    Map<string, StoredPop3Identity>
  >();

  async hasSeen(
    context: ProviderConnectionContext,
    identityKey: string,
  ): Promise<boolean> {
    return (
      this.seen
        .get(accountKey(context))
        ?.has(identityKey) ?? false
    );
  }

  async markSeen(
    context: ProviderConnectionContext,
    identityKey: string,
    stableMessageId: string,
  ): Promise<void> {
    const key = accountKey(context);
    let account = this.seen.get(key);
    if (!account) {
      account = new Map();
      this.seen.set(key, account);
    }
    const now = new Date().toISOString();
    const current = account.get(identityKey);
    account.set(identityKey, {
      stableMessageId,
      firstSeenAt:
        current?.firstSeenAt ?? now,
      lastSeenAt: now,
    });
  }
}

export class FilePop3SyncStateStore
  implements Pop3SyncStateStore
{
  private loaded = false;
  private document: Pop3StateDocument =
    freshDocument();
  private writeQueue: Promise<void> =
    Promise.resolve();

  constructor(
    private readonly path: string,
  ) {}

  async hasSeen(
    context: ProviderConnectionContext,
    identityKey: string,
  ): Promise<boolean> {
    await this.load();
    return Boolean(
      this.document.accounts[
        accountKey(context)
      ]?.seen[identityKey],
    );
  }

  async markSeen(
    context: ProviderConnectionContext,
    identityKey: string,
    stableMessageId: string,
  ): Promise<void> {
    await this.load();
    const key = accountKey(context);
    const account =
      this.document.accounts[key] ??
      { seen: {} };
    this.document.accounts[key] =
      account;

    const now = new Date().toISOString();
    const current =
      account.seen[identityKey];
    account.seen[identityKey] = {
      stableMessageId,
      firstSeenAt:
        current?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    await this.flush();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(
        this.path,
        "utf8",
      );
      const parsed = JSON.parse(
        raw,
      ) as Partial<Pop3StateDocument>;
      if (
        parsed.version !== 1 ||
        !parsed.accounts ||
        typeof parsed.accounts !==
          "object"
      ) {
        throw new Error(
          "Unsupported POP3 sync state format",
        );
      }
      this.document =
        parsed as Pop3StateDocument;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException)
          .code !== "ENOENT"
      ) {
        throw error;
      }
      await mkdir(dirname(this.path), {
        recursive: true,
      });
    }
    this.loaded = true;
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(
      this.document,
      null,
      2,
    );
    this.writeQueue =
      this.writeQueue.then(async () => {
        await mkdir(dirname(this.path), {
          recursive: true,
        });
        const temp =
          this.path +
          ".tmp-" +
          process.pid +
          "-" +
          Date.now();
        await writeFile(temp, snapshot, {
          mode: 0o600,
        });
        await rename(temp, this.path);
      });
    await this.writeQueue;
  }
}

function digest(
  parts: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

export function pop3UidlIdentity(
  context: ProviderConnectionContext,
  uidl: string,
): Pop3SyncIdentity {
  const normalized = uidl.trim();
  if (!normalized) {
    throw new TypeError(
      "POP3 UIDL must not be empty",
    );
  }
  const hash = digest([
    context.tenantId,
    context.accountId,
    "uidl",
    normalized,
  ]);
  return {
    mode: "uidl",
    identityKey:
      "uidl:" + normalized,
    stableMessageId:
      "pop3:" + hash,
  };
}

export function pop3ContentIdentity(
  context: ProviderConnectionContext,
  raw: Uint8Array,
): Pop3SyncIdentity {
  const contentHash = createHash("sha256")
    .update(raw)
    .digest("hex");
  const stableHash = digest([
    context.tenantId,
    context.accountId,
    "content",
    contentHash,
  ]);
  return {
    mode: "content_fingerprint",
    identityKey:
      "content:" + contentHash,
    stableMessageId:
      "pop3:" + stableHash,
  };
}

function positiveLimit(
  value: number | undefined,
): number {
  const resolved = value ?? 100;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1
  ) {
    throw new RangeError(
      "POP3 sync limit must be a positive safe integer",
    );
  }
  return Math.min(resolved, 500);
}

export class Pop3IncrementalSync {
  constructor(
    private readonly transport: Pick<
      Pop3Transport,
      "list" | "fetch"
    >,
    private readonly state:
      Pop3SyncStateStore,
  ) {}

  async poll(
    context: ProviderConnectionContext,
    options: { limit?: number } = {},
  ): Promise<Pop3SyncBatch> {
    const limit = positiveLimit(
      options.limit,
    );
    const refs = await this.transport.list();
    const items: Pop3SyncItem[] = [];
    let alreadySeen = 0;
    let fallbackFetched = 0;
    let remainingUnseen = false;

    for (const ref of refs) {
      if (ref.uidl?.trim()) {
        const identity = pop3UidlIdentity(
          context,
          ref.uidl,
        );
        if (
          await this.state.hasSeen(
            context,
            identity.identityKey,
          )
        ) {
          alreadySeen += 1;
          continue;
        }
        if (items.length >= limit) {
          remainingUnseen = true;
          continue;
        }
        items.push({
          ...identity,
          fetched:
            await this.transport.fetch(ref),
        });
        continue;
      }

      // A server without UIDL cannot tell us whether a sequence number is
      // stable across reconnects. The safe fallback re-fetches the candidate
      // and fingerprints the RFC822 bytes. We may spend bandwidth, but we
      // never treat an unstable sequence number as a durable identity.
      const fetched =
        await this.transport.fetch(ref);
      fallbackFetched += 1;
      const identity =
        pop3ContentIdentity(
          context,
          fetched.raw,
        );
      if (
        await this.state.hasSeen(
          context,
          identity.identityKey,
        )
      ) {
        alreadySeen += 1;
        continue;
      }
      if (items.length >= limit) {
        remainingUnseen = true;
        continue;
      }
      items.push({
        ...identity,
        fetched,
      });
    }

    return {
      items,
      listed: refs.length,
      alreadySeen,
      fallbackFetched,
      hasMore: remainingUnseen,
    };
  }

  async acknowledge(
    context: ProviderConnectionContext,
    item: Pick<
      Pop3SyncItem,
      "identityKey" | "stableMessageId"
    >,
  ): Promise<void> {
    await this.state.markSeen(
      context,
      item.identityKey,
      item.stableMessageId,
    );
  }

  async acknowledgeAll(
    context: ProviderConnectionContext,
    items: readonly Pick<
      Pop3SyncItem,
      "identityKey" | "stableMessageId"
    >[],
  ): Promise<void> {
    for (const item of items) {
      await this.acknowledge(
        context,
        item,
      );
    }
  }
}

export function pop3RefDebugIdentity(
  ref: Pop3MessageRef,
): string {
  return ref.uidl?.trim()
    ? "uidl:" + ref.uidl.trim()
    : "sequence:" +
        String(ref.sequenceNumber);
}
