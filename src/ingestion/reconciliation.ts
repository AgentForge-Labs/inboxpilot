import type { ProviderKind } from "../domain/email-model.js";
import type { ProviderConnectionContext } from "../providers/provider-adapter.js";
import { scheduledReconciliationSignal } from "./signals.js";
import type {
  IngestionAccount,
  IngestionSignal,
  ReconciliationSchedule,
} from "./ingestion-types.js";

export const DEFAULT_RECONCILIATION_SCHEDULES: readonly ReconciliationSchedule[] =
  Object.freeze([
    { provider: "gmail", intervalMs: 15 * 60_000 },
    { provider: "microsoft_graph", intervalMs: 15 * 60_000 },
    { provider: "imap", intervalMs: 10 * 60_000 },
    { provider: "jmap", intervalMs: 10 * 60_000 },
    { provider: "maildir", intervalMs: 5 * 60_000 },
    { provider: "mbox", intervalMs: 15 * 60_000 },
    { provider: "other", intervalMs: 15 * 60_000 },
  ]);

function accountKey(account: IngestionAccount): string {
  return [
    account.context.tenantId,
    account.context.accountId,
    account.provider,
  ].join("\u0000");
}

export class ReconciliationPlanner {
  private readonly lastScheduled = new Map<string, number>();
  private readonly intervals = new Map<ProviderKind, number>();

  constructor(
    schedules: readonly ReconciliationSchedule[] =
      DEFAULT_RECONCILIATION_SCHEDULES,
  ) {
    for (const schedule of schedules) {
      if (schedule.intervalMs < 60_000) {
        throw new RangeError(
          "Reconciliation interval must be at least one minute",
        );
      }
      this.intervals.set(schedule.provider, schedule.intervalMs);
    }
  }

  due(
    accounts: readonly IngestionAccount[],
    now = new Date(),
  ): IngestionSignal[] {
    const nowMs = now.getTime();
    if (Number.isNaN(nowMs)) throw new TypeError("Invalid scheduler time");
    const signals: IngestionSignal[] = [];

    for (const account of accounts) {
      const interval =
        this.intervals.get(account.provider) ?? 15 * 60_000;
      const key = accountKey(account);
      const previous = this.lastScheduled.get(key);
      if (previous !== undefined && nowMs - previous < interval) continue;

      const bucketMs = Math.floor(nowMs / interval) * interval;
      const scheduledFor = new Date(bucketMs).toISOString();
      signals.push(
        scheduledReconciliationSignal(
          account.context,
          account.provider,
          scheduledFor,
        ),
      );
      this.lastScheduled.set(key, nowMs);
    }

    return signals;
  }

  markScheduled(
    context: ProviderConnectionContext,
    provider: ProviderKind,
    at = new Date(),
  ): void {
    this.lastScheduled.set(
      accountKey({ context, provider }),
      at.getTime(),
    );
  }
}
