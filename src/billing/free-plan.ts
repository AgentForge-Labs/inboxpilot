import type {
  CanonicalMessage,
} from "../domain/email-model.js";
import type {
  McpLinkedAccount,
} from "../mcp/hosted/hosted-mcp-types.js";
import type {
  McpAccountLinkStore,
} from "../mcp/hosted/hosted-mcp-store.js";
import {
  formatMonthlyEmailUsage,
  utcDayPeriod,
  utcMonthPeriod,
  type CustomerUsageAccounting,
  type CustomerUsageStore,
} from "./usage-accounting.js";

export const FREE_PLAN_LIMITS = Object.freeze({
  mailboxes: 1,
  emailsPerDay: 100,
  emailsPerMonth: 3000,
});

export const FREE_PLAN_FEATURES = Object.freeze({
  classification: true,
  importanceBuckets: true,
  basicRules: true,
  manualArchiveRecommendations: true,
  manualDeleteRecommendations: true,
  automaticArchive: false,
  automaticDelete: false,
});

export type FreePlanFeature =
  keyof typeof FREE_PLAN_FEATURES;

export interface FreePlanDefinition {
  id: "free";
  permanent: true;
  priceCents: 0;
  limits: typeof FREE_PLAN_LIMITS;
  features: typeof FREE_PLAN_FEATURES;
}

export const FREE_PLAN: FreePlanDefinition =
  Object.freeze({
    id: "free",
    permanent: true,
    priceCents: 0,
    limits: FREE_PLAN_LIMITS,
    features: FREE_PLAN_FEATURES,
  });

export type FreePlanQuotaReason =
  | "allowed"
  | "duplicate"
  | "daily_limit"
  | "monthly_limit";

export interface FreePlanQuotaDecision {
  allowed: boolean;
  reason: FreePlanQuotaReason;
  newlyCounted: boolean;
  day: {
    processed: number;
    limit: number;
    remaining: number;
    resetAt: string;
  };
  month: {
    processed: number;
    limit: number;
    remaining: number;
    resetAt: string;
  };
}

export interface FreePlanUsageState {
  planId: "free";
  permanent: true;
  mailboxes: {
    limit: number;
  };
  day: {
    processed: number;
    limit: number;
    remaining: number;
    resetAt: string;
    exhausted: boolean;
  };
  month: {
    processed: number;
    limit: number;
    remaining: number;
    resetAt: string;
    exhausted: boolean;
    copy: string;
  };
  canProcessNewEmail: boolean;
  blockingReason?: "daily_limit" | "monthly_limit";
  features: typeof FREE_PLAN_FEATURES;
}

export class FreePlanQuotaExceededError extends Error {
  readonly code = "FREE_PLAN_EMAIL_QUOTA_EXCEEDED";

  constructor(
    readonly reason: "daily_limit" | "monthly_limit",
    readonly decision: FreePlanQuotaDecision,
  ) {
    super(
      reason === "daily_limit"
        ? "Free plan daily email limit reached"
        : "Free plan monthly email limit reached",
    );
    this.name = "FreePlanQuotaExceededError";
  }
}

export class FreePlanMailboxLimitError extends Error {
  readonly code = "FREE_PLAN_MAILBOX_LIMIT_REACHED";

  constructor(readonly limit = FREE_PLAN_LIMITS.mailboxes) {
    super(
      "Free plan supports at most " +
        limit +
        " connected mailbox",
    );
    this.name = "FreePlanMailboxLimitError";
  }
}

function clampRemaining(
  limit: number,
  processed: number,
): number {
  return Math.max(0, limit - processed);
}

function eventFor(
  message: CanonicalMessage,
  processedAt: string,
) {
  return {
    tenantId: message.tenantId,
    accountId: message.accountId,
    provider: message.provider.kind,
    providerMessageId:
      message.provider.messageId,
    canonicalMessageId: message.id,
    processedAt,
  };
}

export class FreePlanEntitlementService
  implements CustomerUsageAccounting
{
  constructor(
    private readonly usage: CustomerUsageStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  featureEnabled(feature: FreePlanFeature): boolean {
    return FREE_PLAN_FEATURES[feature];
  }

  async reserveEmailProcessing(
    message: CanonicalMessage,
    processedAt = this.now().toISOString(),
  ): Promise<FreePlanQuotaDecision> {
    const day = utcDayPeriod(processedAt);
    const month = utcMonthPeriod(processedAt);
    const reserved =
      await this.usage.reserveUniqueWithinLimits(
        eventFor(message, processedAt),
        {
          day: {
            ...day,
            limit: FREE_PLAN_LIMITS.emailsPerDay,
          },
          month: {
            ...month,
            limit:
              FREE_PLAN_LIMITS.emailsPerMonth,
          },
        },
      );

    const dayProcessed = reserved.dayProcessed;
    const monthProcessed =
      reserved.monthProcessed;
    const reason: FreePlanQuotaReason =
      reserved.status === "reserved"
        ? "allowed"
        : reserved.status;
    return {
      allowed:
        reserved.status === "reserved" ||
        reserved.status === "duplicate",
      reason,
      newlyCounted:
        reserved.status === "reserved",
      day: {
        processed: dayProcessed,
        limit: FREE_PLAN_LIMITS.emailsPerDay,
        remaining: clampRemaining(
          FREE_PLAN_LIMITS.emailsPerDay,
          dayProcessed,
        ),
        resetAt: day.endExclusive,
      },
      month: {
        processed: monthProcessed,
        limit:
          FREE_PLAN_LIMITS.emailsPerMonth,
        remaining: clampRemaining(
          FREE_PLAN_LIMITS.emailsPerMonth,
          monthProcessed,
        ),
        resetAt: month.endExclusive,
      },
    };
  }

  async assertCanProcessEmail(
    message: CanonicalMessage,
    processedAt = this.now().toISOString(),
  ): Promise<FreePlanQuotaDecision> {
    const decision =
      await this.reserveEmailProcessing(
        message,
        processedAt,
      );
    if (
      decision.reason === "daily_limit" ||
      decision.reason === "monthly_limit"
    ) {
      throw new FreePlanQuotaExceededError(
        decision.reason,
        decision,
      );
    }
    return decision;
  }

  async recordProcessed(
    messages: readonly CanonicalMessage[],
    processedAt = this.now().toISOString(),
  ): Promise<{
    attempted: number;
    newlyProcessed: number;
    duplicates: number;
    blocked: number;
    blockedDaily: number;
    blockedMonthly: number;
  }> {
    let newlyProcessed = 0;
    let duplicates = 0;
    let blockedDaily = 0;
    let blockedMonthly = 0;

    for (const message of messages) {
      const decision =
        await this.reserveEmailProcessing(
          message,
          processedAt,
        );
      switch (decision.reason) {
        case "allowed":
          newlyProcessed += 1;
          break;
        case "duplicate":
          duplicates += 1;
          break;
        case "daily_limit":
          blockedDaily += 1;
          break;
        case "monthly_limit":
          blockedMonthly += 1;
          break;
      }
    }

    return {
      attempted: messages.length,
      newlyProcessed,
      duplicates,
      blocked:
        blockedDaily + blockedMonthly,
      blockedDaily,
      blockedMonthly,
    };
  }

  async usageState(
    tenantId: string,
    at: string | Date = this.now(),
  ): Promise<FreePlanUsageState> {
    const day = utcDayPeriod(at);
    const month = utcMonthPeriod(at);
    const [dayProcessed, monthProcessed] =
      await Promise.all([
        this.usage.count({
          tenantId,
          ...day,
        }),
        this.usage.count({
          tenantId,
          ...month,
        }),
      ]);

    const dailyExhausted =
      dayProcessed >=
      FREE_PLAN_LIMITS.emailsPerDay;
    const monthlyExhausted =
      monthProcessed >=
      FREE_PLAN_LIMITS.emailsPerMonth;

    return {
      planId: "free",
      permanent: true,
      mailboxes: {
        limit: FREE_PLAN_LIMITS.mailboxes,
      },
      day: {
        processed: dayProcessed,
        limit: FREE_PLAN_LIMITS.emailsPerDay,
        remaining: clampRemaining(
          FREE_PLAN_LIMITS.emailsPerDay,
          dayProcessed,
        ),
        resetAt: day.endExclusive,
        exhausted: dailyExhausted,
      },
      month: {
        processed: monthProcessed,
        limit:
          FREE_PLAN_LIMITS.emailsPerMonth,
        remaining: clampRemaining(
          FREE_PLAN_LIMITS.emailsPerMonth,
          monthProcessed,
        ),
        resetAt: month.endExclusive,
        exhausted: monthlyExhausted,
        copy: formatMonthlyEmailUsage(
          monthProcessed,
          FREE_PLAN_LIMITS.emailsPerMonth,
        ),
      },
      canProcessNewEmail:
        !dailyExhausted &&
        !monthlyExhausted,
      ...(monthlyExhausted
        ? {
            blockingReason:
              "monthly_limit" as const,
          }
        : dailyExhausted
          ? {
              blockingReason:
                "daily_limit" as const,
            }
          : {}),
      features: FREE_PLAN_FEATURES,
    };
  }
}

export class FreePlanAccountLinkStore
  implements McpAccountLinkStore
{
  constructor(
    private readonly inner: McpAccountLinkStore,
  ) {}

  async link(
    tenantId: string,
    userId: string,
    accountId: string,
    linkedAt: string,
  ): Promise<McpLinkedAccount> {
    const current = await this.inner.listLinked(
      tenantId,
      userId,
    );
    const existing = current.find(
      (account) =>
        account.accountId === accountId,
    );
    if (existing) {
      return structuredClone(existing);
    }
    if (
      current.length >=
      FREE_PLAN_LIMITS.mailboxes
    ) {
      throw new FreePlanMailboxLimitError();
    }
    return this.inner.link(
      tenantId,
      userId,
      accountId,
      linkedAt,
    );
  }

  listLinked(
    tenantId: string,
    userId: string,
  ): Promise<McpLinkedAccount[]> {
    return this.inner.listLinked(
      tenantId,
      userId,
    );
  }

  disconnect(
    tenantId: string,
    userId: string,
    accountId: string,
    disconnectedAt: string,
  ): Promise<boolean> {
    return this.inner.disconnect(
      tenantId,
      userId,
      accountId,
      disconnectedAt,
    );
  }
}
