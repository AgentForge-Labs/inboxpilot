import type {
  CanonicalMessage,
  ProviderKind,
} from "../domain/email-model.js";

export interface CustomerUsageEvent {
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  providerMessageId: string;
  canonicalMessageId: string;
  processedAt: string;
}

export interface CustomerUsagePeriod {
  start: string;
  endExclusive: string;
  processed: number;
}

export interface CustomerUsageSummary {
  tenantId: string;
  accountId?: string;
  asOf: string;
  day: CustomerUsagePeriod;
  month: CustomerUsagePeriod;
}

export interface CustomerUsageQuery {
  tenantId: string;
  accountId?: string;
  start: string;
  endExclusive: string;
}

export interface CustomerUsageStore {
  recordUnique(event: CustomerUsageEvent): Promise<boolean>;
  count(query: CustomerUsageQuery): Promise<number>;
  list(query: CustomerUsageQuery): Promise<CustomerUsageEvent[]>;
  deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number>;
}

export interface CustomerUsageAccounting {
  recordProcessed(
    messages: readonly CanonicalMessage[],
    processedAt?: string,
  ): Promise<{
    attempted: number;
    newlyProcessed: number;
    duplicates: number;
  }>;
}

function requireId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(field + " is required");
  }
  return normalized;
}

function iso(value: string | Date, field: string): string {
  const date =
    value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(
      field + " must be an ISO-compatible timestamp",
    );
  }
  return date.toISOString();
}

function eventKey(event: CustomerUsageEvent): string {
  return [
    event.tenantId,
    event.accountId,
    event.provider,
    event.providerMessageId,
  ].join("\u0000");
}

function inRange(
  value: string,
  start: string,
  endExclusive: string,
): boolean {
  return value >= start && value < endExclusive;
}

function cloneEvent(
  event: CustomerUsageEvent,
): CustomerUsageEvent {
  return structuredClone(event);
}

export function utcDayPeriod(
  at: string | Date,
): { start: string; endExclusive: string } {
  const date = new Date(iso(at, "at"));
  const start = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    ),
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    start: start.toISOString(),
    endExclusive: end.toISOString(),
  };
}

export function utcMonthPeriod(
  at: string | Date,
): { start: string; endExclusive: string } {
  const date = new Date(iso(at, "at"));
  const start = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      1,
    ),
  );
  const end = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      1,
    ),
  );
  return {
    start: start.toISOString(),
    endExclusive: end.toISOString(),
  };
}

export class InMemoryCustomerUsageStore
  implements CustomerUsageStore
{
  readonly events = new Map<string, CustomerUsageEvent>();

  async recordUnique(
    event: CustomerUsageEvent,
  ): Promise<boolean> {
    const normalized: CustomerUsageEvent = {
      tenantId: requireId(event.tenantId, "tenantId"),
      accountId: requireId(event.accountId, "accountId"),
      provider: event.provider,
      providerMessageId: requireId(
        event.providerMessageId,
        "providerMessageId",
      ),
      canonicalMessageId: requireId(
        event.canonicalMessageId,
        "canonicalMessageId",
      ),
      processedAt: iso(
        event.processedAt,
        "processedAt",
      ),
    };
    const key = eventKey(normalized);
    if (this.events.has(key)) return false;
    this.events.set(key, normalized);
    return true;
  }

  async count(
    query: CustomerUsageQuery,
  ): Promise<number> {
    return (
      await this.list(query)
    ).length;
  }

  async list(
    query: CustomerUsageQuery,
  ): Promise<CustomerUsageEvent[]> {
    const tenantId = requireId(
      query.tenantId,
      "tenantId",
    );
    const accountId = query.accountId
      ? requireId(query.accountId, "accountId")
      : undefined;
    const start = iso(query.start, "start");
    const endExclusive = iso(
      query.endExclusive,
      "endExclusive",
    );
    if (start >= endExclusive) {
      throw new RangeError(
        "start must be before endExclusive",
      );
    }

    return [...this.events.values()]
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          (accountId === undefined ||
            event.accountId === accountId) &&
          inRange(
            event.processedAt,
            start,
            endExclusive,
          ),
      )
      .sort((a, b) =>
        a.processedAt.localeCompare(b.processedAt),
      )
      .map(cloneEvent);
  }

  async exportAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<CustomerUsageEvent[]> {
    const normalizedTenant = requireId(
      tenantId,
      "tenantId",
    );
    const normalizedAccount = requireId(
      accountId,
      "accountId",
    );
    return [...this.events.values()]
      .filter(
        (event) =>
          event.tenantId === normalizedTenant &&
          event.accountId === normalizedAccount,
      )
      .sort((a, b) =>
        a.processedAt.localeCompare(b.processedAt),
      )
      .map(cloneEvent);
  }

  async deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    const normalizedTenant = requireId(
      tenantId,
      "tenantId",
    );
    const normalizedAccount = requireId(
      accountId,
      "accountId",
    );
    let deleted = 0;
    for (const [key, event] of this.events) {
      if (
        event.tenantId === normalizedTenant &&
        event.accountId === normalizedAccount
      ) {
        this.events.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class CustomerUsageAccountingService
  implements CustomerUsageAccounting
{
  constructor(
    private readonly store: CustomerUsageStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordProcessed(
    messages: readonly CanonicalMessage[],
    processedAt = this.now().toISOString(),
  ): Promise<{
    attempted: number;
    newlyProcessed: number;
    duplicates: number;
  }> {
    const timestamp = iso(
      processedAt,
      "processedAt",
    );
    let newlyProcessed = 0;

    for (const message of messages) {
      const recorded =
        await this.store.recordUnique({
          tenantId: message.tenantId,
          accountId: message.accountId,
          provider: message.provider.kind,
          providerMessageId:
            message.provider.messageId,
          canonicalMessageId: message.id,
          processedAt: timestamp,
        });
      if (recorded) newlyProcessed += 1;
    }

    return {
      attempted: messages.length,
      newlyProcessed,
      duplicates:
        messages.length - newlyProcessed,
    };
  }

  async summary(
    tenantIdInput: string,
    options: {
      accountId?: string;
      at?: string | Date;
    } = {},
  ): Promise<CustomerUsageSummary> {
    const tenantId = requireId(
      tenantIdInput,
      "tenantId",
    );
    const accountId = options.accountId
      ? requireId(options.accountId, "accountId")
      : undefined;
    const asOf = iso(
      options.at ?? this.now(),
      "at",
    );
    const day = utcDayPeriod(asOf);
    const month = utcMonthPeriod(asOf);
    const base = {
      tenantId,
      ...(accountId ? { accountId } : {}),
    };

    const [dayProcessed, monthProcessed] =
      await Promise.all([
        this.store.count({
          ...base,
          ...day,
        }),
        this.store.count({
          ...base,
          ...month,
        }),
      ]);

    return {
      tenantId,
      ...(accountId ? { accountId } : {}),
      asOf,
      day: {
        ...day,
        processed: dayProcessed,
      },
      month: {
        ...month,
        processed: monthProcessed,
      },
    };
  }
}

export function formatMonthlyEmailUsage(
  processed: number,
  limit: number,
): string {
  if (
    !Number.isSafeInteger(processed) ||
    processed < 0
  ) {
    throw new RangeError(
      "processed must be a non-negative safe integer",
    );
  }
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0
  ) {
    throw new RangeError(
      "limit must be a positive safe integer",
    );
  }
  const format = new Intl.NumberFormat("en-US");
  return (
    format.format(processed) +
    " / " +
    format.format(limit) +
    " emails processed this month"
  );
}
