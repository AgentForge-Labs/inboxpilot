import { createHash } from "node:crypto";
import type { CanonicalMessage, ProviderKind } from "../domain/email-model.js";
import { assertCanonicalMessage } from "../domain/email-model.js";
import type {
  IngestionAccount,
  IngestionBatch,
  IngestionCommitResult,
  IngestionLease,
  IngestionLeaseManager,
  IngestionRepository,
  IngestionSignal,
  IngestionSignalStore,
} from "./ingestion-types.js";

function accountKey(account: {
  context: { tenantId: string; accountId: string };
  provider: ProviderKind;
}): string {
  return [
    account.context.tenantId,
    account.context.accountId,
    account.provider,
  ].join("\u0000");
}

function messageKey(message: CanonicalMessage): string {
  return [
    message.tenantId,
    message.accountId,
    message.id,
  ].join("\u0000");
}

function providerKey(
  tenantId: string,
  accountId: string,
  provider: ProviderKind,
  providerMessageId: string,
): string {
  return [tenantId, accountId, provider, providerMessageId].join("\u0000");
}

function comparableProviderState(message: CanonicalMessage): string {
  return JSON.stringify({
    threadId: message.threadId,
    provider: message.provider,
    internetMessageId: message.internetMessageId ?? null,
    subject: message.subject,
    snippet: message.snippet ?? null,
    body: message.body,
    from: message.from ?? null,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    headers: message.headers,
    labels: message.labels,
    mailboxes: message.mailboxes,
    flags: message.flags,
    attachments: message.attachments,
    sentAt: message.sentAt ?? null,
    receivedAt: message.receivedAt,
    authentication: message.authentication,
    providerMetadata: message.providerMetadata,
  });
}

function providerFingerprint(message: CanonicalMessage): string {
  return createHash("sha256")
    .update(comparableProviderState(message))
    .digest("hex");
}

export class CursorConflictError extends Error {
  readonly code = "INGESTION_CURSOR_CONFLICT";
  constructor() {
    super("Ingestion cursor changed before batch commit");
    this.name = "CursorConflictError";
  }
}

export class InMemoryIngestionRepository implements IngestionRepository {
  readonly messages = new Map<string, CanonicalMessage>();
  readonly providerIndex = new Map<string, string>();
  readonly fingerprints = new Map<string, string>();
  readonly cursors = new Map<string, string>();
  readonly deletedProviderIds = new Set<string>();

  async getCursor(account: IngestionAccount): Promise<string | undefined> {
    return this.cursors.get(accountKey(account));
  }

  async commitBatch(batch: IngestionBatch): Promise<IngestionCommitResult> {
    const account: IngestionAccount = {
      context: {
        tenantId: batch.tenantId,
        accountId: batch.accountId,
      },
      provider: batch.provider,
    };
    const key = accountKey(account);
    const currentCursor = this.cursors.get(key);

    if (currentCursor !== batch.expectedCursor) {
      throw new CursorConflictError();
    }

    let inserted = 0;
    const insertedCanonicalMessageIds: string[] = [];
    let updated = 0;
    let unchanged = 0;
    let deletedMarked = 0;

    const pendingMessages = new Map(this.messages);
    const pendingProviderIndex = new Map(this.providerIndex);
    const pendingFingerprints = new Map(this.fingerprints);
    const pendingDeleted = new Set(this.deletedProviderIds);

    for (const providerMessageId of batch.deletedProviderMessageIds) {
      const pKey = providerKey(
        batch.tenantId,
        batch.accountId,
        batch.provider,
        providerMessageId,
      );
      if (!pendingDeleted.has(pKey)) {
        pendingDeleted.add(pKey);
        deletedMarked += 1;
      }
    }

    for (const incoming of batch.messages) {
      assertCanonicalMessage(incoming);
      if (
        incoming.tenantId !== batch.tenantId ||
        incoming.accountId !== batch.accountId ||
        incoming.provider.kind !== batch.provider
      ) {
        throw new TypeError("Canonical message does not match ingestion account");
      }

      const pKey = providerKey(
        batch.tenantId,
        batch.accountId,
        batch.provider,
        incoming.provider.messageId,
      );
      const indexedCanonicalId = pendingProviderIndex.get(pKey);
      if (indexedCanonicalId && indexedCanonicalId !== incoming.id) {
        throw new Error(
          "Provider message identity is already bound to another canonical message",
        );
      }

      const keyForMessage = messageKey(incoming);
      const existing = pendingMessages.get(keyForMessage);
      const fingerprint = providerFingerprint(incoming);

      if (!existing) {
        pendingMessages.set(keyForMessage, structuredClone(incoming));
        pendingProviderIndex.set(pKey, incoming.id);
        pendingFingerprints.set(keyForMessage, fingerprint);
        inserted += 1;
        insertedCanonicalMessageIds.push(incoming.id);
      } else if (pendingFingerprints.get(keyForMessage) === fingerprint) {
        unchanged += 1;
      } else {
        pendingMessages.set(keyForMessage, {
          ...structuredClone(incoming),
          ingestedAt: existing.ingestedAt,
          classification: structuredClone(existing.classification),
          retention: structuredClone(existing.retention),
        });
        pendingProviderIndex.set(pKey, incoming.id);
        pendingFingerprints.set(keyForMessage, fingerprint);
        updated += 1;
      }

      pendingDeleted.delete(pKey);
    }

    this.messages.clear();
    for (const [messageId, message] of pendingMessages) {
      this.messages.set(messageId, message);
    }
    this.providerIndex.clear();
    for (const [providerId, canonicalId] of pendingProviderIndex) {
      this.providerIndex.set(providerId, canonicalId);
    }
    this.fingerprints.clear();
    for (const [messageId, fingerprint] of pendingFingerprints) {
      this.fingerprints.set(messageId, fingerprint);
    }
    this.deletedProviderIds.clear();
    for (const providerId of pendingDeleted) {
      this.deletedProviderIds.add(providerId);
    }

    if (batch.nextCursor !== undefined) {
      this.cursors.set(key, batch.nextCursor);
    }

    return {
      inserted,
      insertedCanonicalMessageIds,
      updated,
      unchanged,
      deletedMarked,
      cursor: batch.nextCursor ?? currentCursor,
    };
  }

  async getMessage(
    tenantId: string,
    accountId: string,
    canonicalMessageId: string,
  ): Promise<CanonicalMessage | undefined> {
    const value = this.messages.get(
      [tenantId, accountId, canonicalMessageId].join("\u0000"),
    );
    return value ? structuredClone(value) : undefined;
  }

  async isProviderDeleted(
    tenantId: string,
    accountId: string,
    provider: ProviderKind,
    providerMessageId: string,
  ): Promise<boolean> {
    return this.deletedProviderIds.has(
      providerKey(tenantId, accountId, provider, providerMessageId),
    );
  }

  async exportAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<CanonicalMessage[]> {
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.tenantId === tenantId &&
          message.accountId === accountId,
      )
      .map((message) => structuredClone(message));
  }

  async deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    const prefix = tenantId + "\u0000" + accountId + "\u0000";
    let deleted = 0;

    for (const [key, message] of this.messages) {
      if (
        message.tenantId !== tenantId ||
        message.accountId !== accountId
      ) {
        continue;
      }
      this.messages.delete(key);
      this.fingerprints.delete(key);
      this.providerIndex.delete(
        providerKey(
          tenantId,
          accountId,
          message.provider.kind,
          message.provider.messageId,
        ),
      );
      deleted += 1;
    }

    for (const key of [...this.providerIndex.keys()]) {
      if (key.startsWith(prefix)) {
        this.providerIndex.delete(key);
      }
    }
    for (const key of [...this.fingerprints.keys()]) {
      if (key.startsWith(prefix)) {
        this.fingerprints.delete(key);
      }
    }
    for (const key of [...this.cursors.keys()]) {
      if (key.startsWith(prefix)) {
        this.cursors.delete(key);
      }
    }
    for (const key of [...this.deletedProviderIds]) {
      if (key.startsWith(prefix)) {
        this.deletedProviderIds.delete(key);
      }
    }

    return deleted;
  }
}

export class InMemoryIngestionSignalStore implements IngestionSignalStore {
  readonly processed = new Map<string, IngestionSignal>();

  async isProcessed(signalId: string): Promise<boolean> {
    return this.processed.has(signalId);
  }

  async markProcessed(signal: IngestionSignal): Promise<void> {
    this.processed.set(signal.id, structuredClone(signal));
  }
}

export class InMemoryIngestionLeaseManager implements IngestionLeaseManager {
  private readonly active = new Set<string>();

  async tryAcquire(account: IngestionAccount): Promise<IngestionLease | null> {
    const key = accountKey(account);
    if (this.active.has(key)) return null;
    this.active.add(key);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.active.delete(key);
      },
    };
  }
}
