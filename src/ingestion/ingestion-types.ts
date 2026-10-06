import type { CanonicalMessage, ProviderKind } from "../domain/email-model.js";
import type { ProviderAdapter, ProviderConnectionContext } from "../providers/provider-adapter.js";

export type IngestionSignalSource =
  | "initial_sync"
  | "gmail_push"
  | "microsoft_graph_webhook"
  | "imap_idle"
  | "jmap_change"
  | "local_filesystem"
  | "scheduled_reconciliation";

export interface IngestionSignal {
  id: string;
  source: IngestionSignalSource;
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  receivedAt: string;
  providerHint?: string;
}

export interface IngestionAccount {
  context: ProviderConnectionContext;
  provider: ProviderKind;
}

export interface IngestionBatch {
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  expectedCursor?: string;
  nextCursor?: string;
  messages: CanonicalMessage[];
  deletedProviderMessageIds: string[];
}

export interface IngestionCommitResult {
  inserted: number;
  updated: number;
  deletedMarked: number;
  unchanged: number;
  cursor: string | undefined;
}

export interface IngestionRepository {
  getCursor(account: IngestionAccount): Promise<string | undefined>;
  commitBatch(batch: IngestionBatch): Promise<IngestionCommitResult>;
  getMessage(
    tenantId: string,
    accountId: string,
    canonicalMessageId: string,
  ): Promise<CanonicalMessage | undefined>;
  isProviderDeleted(
    tenantId: string,
    accountId: string,
    provider: ProviderKind,
    providerMessageId: string,
  ): Promise<boolean>;
}

export interface IngestionSignalStore {
  isProcessed(signalId: string): Promise<boolean>;
  markProcessed(signal: IngestionSignal): Promise<void>;
}

export interface IngestionLease {
  release(): Promise<void>;
}

export interface IngestionLeaseManager {
  tryAcquire(account: IngestionAccount): Promise<IngestionLease | null>;
}

export interface IngestionProviderAdapterResolver {
  resolve(account: IngestionAccount): Promise<ProviderAdapter>;
}

export interface IngestionRunResult {
  status: "processed" | "deduplicated" | "coalesced";
  signalId: string;
  pages: number;
  inserted: number;
  updated: number;
  unchanged: number;
  deletedMarked: number;
  finalCursor?: string;
}

export interface ReconciliationSchedule {
  provider: ProviderKind;
  intervalMs: number;
}
