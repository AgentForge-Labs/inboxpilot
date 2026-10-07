import { assertCanonicalMessage } from "../domain/email-model.js";
import type { CustomerUsageAccounting } from "../billing/usage-accounting.js";
import {
  isWebhookLikeSource,
  type OperationalTelemetry,
} from "../observability/operational-telemetry.js";
import type {
  IngestionAccount,
  IngestionLeaseManager,
  IngestionRepository,
  IngestionRunResult,
  IngestionSignal,
  IngestionSignalStore,
  IngestionProviderAdapterResolver,
} from "./ingestion-types.js";

export interface IncrementalIngestionPipelineOptions {
  pageSize?: number;
  maxPages?: number;
  telemetry?: OperationalTelemetry;
  customerUsage?: CustomerUsageAccounting;
  now?: () => Date;
}

function assertSignal(signal: IngestionSignal): void {
  if (
    !signal.id.trim() ||
    !signal.tenantId.trim() ||
    !signal.accountId.trim()
  ) {
    throw new TypeError("Ingestion signal identity is incomplete");
  }
  if (Number.isNaN(Date.parse(signal.receivedAt))) {
    throw new TypeError("Ingestion signal timestamp is invalid");
  }
}

export class IncrementalIngestionPipeline {
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly telemetry: OperationalTelemetry | undefined;
  private readonly customerUsage: CustomerUsageAccounting | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly resolver: IngestionProviderAdapterResolver,
    private readonly repository: IngestionRepository,
    private readonly signalStore: IngestionSignalStore,
    private readonly leases: IngestionLeaseManager,
    options: IncrementalIngestionPipelineOptions = {},
  ) {
    this.pageSize = Math.max(1, Math.min(options.pageSize ?? 100, 500));
    this.maxPages = Math.max(1, options.maxPages ?? 100);
    this.telemetry = options.telemetry;
    this.customerUsage = options.customerUsage;
    this.now = options.now ?? (() => new Date());
  }

  async handle(signal: IngestionSignal): Promise<IngestionRunResult> {
    assertSignal(signal);
    const observedAt = this.now();
    const lagMs = Math.max(
      0,
      observedAt.getTime() - Date.parse(signal.receivedAt),
    );
    await this.telemetry?.record({
      metric: "ingestion_lag_ms",
      tenantId: signal.tenantId,
      accountId: signal.accountId,
      provider: signal.provider,
      source: signal.source,
      status: "received",
      value: lagMs,
      timestamp: observedAt.toISOString(),
    });
    if (isWebhookLikeSource(signal.source)) {
      await this.telemetry?.record({
        metric: "webhook_health",
        tenantId: signal.tenantId,
        accountId: signal.accountId,
        provider: signal.provider,
        source: signal.source,
        status: "received",
        value: 1,
        timestamp: observedAt.toISOString(),
      });
    }

    if (await this.signalStore.isProcessed(signal.id)) {
      return {
        status: "deduplicated",
        signalId: signal.id,
        pages: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deletedMarked: 0,
      };
    }

    const account: IngestionAccount = {
      context: {
        tenantId: signal.tenantId,
        accountId: signal.accountId,
      },
      provider: signal.provider,
    };
    const lease = await this.leases.tryAcquire(account);
    if (!lease) {
      return {
        status: "coalesced",
        signalId: signal.id,
        pages: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deletedMarked: 0,
      };
    }

    try {
      if (await this.signalStore.isProcessed(signal.id)) {
        return {
          status: "deduplicated",
          signalId: signal.id,
          pages: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
          deletedMarked: 0,
        };
      }

      const adapter = await this.resolver.resolve(account);
      if (adapter.kind !== signal.provider) {
        throw new TypeError(
          "Resolved provider adapter does not match ingestion signal",
        );
      }
      if (!adapter.capabilities().syncChanges) {
        throw new Error(
          `Provider "${adapter.kind}" does not support incremental sync`,
        );
      }

      let cursor = await this.repository.getCursor(account);
      let pages = 0;
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let deletedMarked = 0;

      while (true) {
        if (pages >= this.maxPages) {
          throw new Error(
            `Ingestion exceeded maxPages=${this.maxPages}; cursor was not advanced beyond bounded run`,
          );
        }

        const result = await adapter.syncChanges({
          ...(cursor ? { cursor } : {}),
          limit: this.pageSize,
        });

        for (const message of result.messages) {
          assertCanonicalMessage(message);
          if (
            message.tenantId !== signal.tenantId ||
            message.accountId !== signal.accountId ||
            message.provider.kind !== signal.provider
          ) {
            throw new TypeError(
              "Provider returned message outside ingestion account scope",
            );
          }
        }

        if (
          result.hasMore &&
          (!result.nextCursor || result.nextCursor === cursor)
        ) {
          throw new Error(
            "Provider reported more changes without advancing its sync cursor",
          );
        }

        const committed = await this.repository.commitBatch({
          tenantId: signal.tenantId,
          accountId: signal.accountId,
          provider: signal.provider,
          ...(cursor ? { expectedCursor: cursor } : {}),
          ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
          messages: result.messages,
          deletedProviderMessageIds: result.deletedProviderMessageIds,
        });

        if (
          this.customerUsage &&
          committed.insertedCanonicalMessageIds.length > 0
        ) {
          const insertedIds = new Set(
            committed.insertedCanonicalMessageIds,
          );
          await this.customerUsage.recordProcessed(
            result.messages.filter((message) =>
              insertedIds.has(message.id),
            ),
            this.now().toISOString(),
          );
        }

        inserted += committed.inserted;
        updated += committed.updated;
        unchanged += committed.unchanged;
        deletedMarked += committed.deletedMarked;
        cursor = committed.cursor;
        pages += 1;

        if (!result.hasMore) break;
      }

      await this.signalStore.markProcessed(signal);
      return {
        status: "processed",
        signalId: signal.id,
        pages,
        inserted,
        updated,
        unchanged,
        deletedMarked,
        ...(cursor ? { finalCursor: cursor } : {}),
      };
    } finally {
      await lease.release();
    }
  }
}
