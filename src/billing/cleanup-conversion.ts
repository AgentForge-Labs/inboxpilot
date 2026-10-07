import type {
  CanonicalMessage,
} from "../domain/email-model.js";

export type CleanupOpportunityAction =
  | "archive"
  | "trash";

export interface CleanupOpportunity {
  tenantId: string;
  accountId: string;
  providerMessageId: string;
  canonicalMessageId: string;
  action: CleanupOpportunityAction;
  observedAt: string;
  monthStart: string;
}

export interface CleanupOpportunityStore {
  upsert(
    opportunity: CleanupOpportunity,
  ): Promise<boolean>;
  listMonth(
    tenantId: string,
    monthStart: string,
    accountId?: string,
  ): Promise<CleanupOpportunity[]>;
}

function required(
  value: string,
  field: string,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(field + " is required");
  }
  return normalized;
}

function iso(
  value: string | Date,
  field: string,
): string {
  const date =
    value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      field + " must be an ISO-compatible timestamp",
    );
  }
  return date.toISOString();
}

export function cleanupMonthStart(
  at: string | Date,
): string {
  const date = new Date(iso(at, "at"));
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      1,
    ),
  ).toISOString();
}

function key(
  opportunity: CleanupOpportunity,
): string {
  return [
    opportunity.tenantId,
    opportunity.accountId,
    opportunity.monthStart,
    opportunity.providerMessageId,
  ].join("\u0000");
}

export class InMemoryCleanupOpportunityStore
  implements CleanupOpportunityStore
{
  readonly opportunities =
    new Map<string, CleanupOpportunity>();

  async upsert(
    opportunity: CleanupOpportunity,
  ): Promise<boolean> {
    const normalized: CleanupOpportunity = {
      tenantId: required(
        opportunity.tenantId,
        "tenantId",
      ),
      accountId: required(
        opportunity.accountId,
        "accountId",
      ),
      providerMessageId: required(
        opportunity.providerMessageId,
        "providerMessageId",
      ),
      canonicalMessageId: required(
        opportunity.canonicalMessageId,
        "canonicalMessageId",
      ),
      action: opportunity.action,
      observedAt: iso(
        opportunity.observedAt,
        "observedAt",
      ),
      monthStart: cleanupMonthStart(
        opportunity.monthStart,
      ),
    };
    const entryKey = key(normalized);
    const existing =
      this.opportunities.get(entryKey);
    this.opportunities.set(
      entryKey,
      normalized,
    );
    return existing === undefined;
  }

  async listMonth(
    tenantIdInput: string,
    monthStartInput: string,
    accountIdInput?: string,
  ): Promise<CleanupOpportunity[]> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    const monthStart =
      cleanupMonthStart(monthStartInput);
    const accountId = accountIdInput
      ? required(accountIdInput, "accountId")
      : undefined;

    return [...this.opportunities.values()]
      .filter(
        (item) =>
          item.tenantId === tenantId &&
          item.monthStart === monthStart &&
          (accountId === undefined ||
            item.accountId === accountId),
      )
      .sort((a, b) =>
        a.observedAt.localeCompare(b.observedAt),
      )
      .map((item) =>
        structuredClone(item),
      );
  }
}

export interface CleanupConversionSummary {
  monthStart: string;
  total: number;
  wouldArchive: number;
  wouldDelete: number;
  message: string;
}

export class CleanupConversionService {
  constructor(
    private readonly store:
      CleanupOpportunityStore,
    private readonly now: () => Date =
      () => new Date(),
  ) {}

  async record(
    message: CanonicalMessage,
    action: CleanupOpportunityAction,
    observedAt:
      | string
      | Date = this.now(),
  ): Promise<boolean> {
    const timestamp = iso(
      observedAt,
      "observedAt",
    );
    return this.store.upsert({
      tenantId: message.tenantId,
      accountId: message.accountId,
      providerMessageId:
        message.provider.messageId,
      canonicalMessageId: message.id,
      action,
      observedAt: timestamp,
      monthStart:
        cleanupMonthStart(timestamp),
    });
  }

  async summary(
    tenantId: string,
    options: {
      accountId?: string;
      at?: string | Date;
    } = {},
  ): Promise<CleanupConversionSummary> {
    const at = iso(
      options.at ?? this.now(),
      "at",
    );
    const monthStart =
      cleanupMonthStart(at);
    const items =
      await this.store.listMonth(
        tenantId,
        monthStart,
        options.accountId,
      );
    const wouldArchive =
      items.filter(
        (item) =>
          item.action === "archive",
      ).length;
    const wouldDelete =
      items.filter(
        (item) => item.action === "trash",
      ).length;
    const total =
      wouldArchive + wouldDelete;

    return {
      monthStart,
      total,
      wouldArchive,
      wouldDelete,
      message:
        total === 1
          ? "1 email this month could have been automatically cleaned up."
          : total +
            " emails this month could have been automatically cleaned up.",
    };
  }
}

export interface CleanupConversionTracker {
  record(
    message: CanonicalMessage,
    action: CleanupOpportunityAction,
    observedAt?: string | Date,
  ): Promise<boolean>;
}
