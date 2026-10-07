import type {
  CommercialPlanId,
} from "../billing/plan-pricing.js";
import type {
  PlanEntitlementService,
} from "../billing/plan-entitlements.js";
import type {
  ProTrialDashboardView,
  ProTrialService,
} from "../billing/pro-trial.js";
import type {
  CleanupConversionService,
  CleanupConversionSummary,
} from "../billing/cleanup-conversion.js";
import {
  utcDayPeriod,
  utcMonthPeriod,
  type CustomerUsageStore,
} from "../billing/usage-accounting.js";
import type {
  McpAccountLinkStore,
} from "../mcp/hosted/hosted-mcp-store.js";
import type {
  OperationalMetricEvent,
  OperationalMetricName,
} from "../observability/operational-telemetry.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CustomerDashboardTelemetrySource {
  list(filter?: {
    tenantId?: string;
    accountId?: string;
    metric?: OperationalMetricName;
  }): OperationalMetricEvent[];
}

export interface UsagePlanDashboardQuery {
  tenantId: string;
  userId: string;
  accountId?: string;
  at?: string | Date;
}

export interface UsageMeterView {
  processed: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number | null;
  resetAt: string;
  unlimited: boolean;
}

export interface MailboxMeterView {
  connected: number;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
}

export interface QuotaProjectionView {
  status:
    | "unlimited"
    | "insufficient_data"
    | "on_track"
    | "projected_exhaustion"
    | "exhausted";
  dailyRunRate: number | null;
  projectedMonthlyTotal: number | null;
  projectedExhaustionAt?: string;
}

export interface CustomerActivityBreakdown {
  classifications: number;
  automatedActions: number;
  automatedArchive: number;
  automatedTrash: number;
  automatedMarkImportant: number;
  otherAutomatedActions: number;
  manualActions: number;
}

export interface UpgradeCta {
  targetPlan: Exclude<CommercialPlanId, "free">;
  title: string;
  detail: string;
}

export interface UsagePlanDashboardView {
  asOf: string;
  billingPlan: {
    id: CommercialPlanId;
    label: string;
    revision: number;
  };
  trial?: {
    status: ProTrialDashboardView["status"];
    headline: string;
    countdown: string;
    startedAt: string;
    endsAt: string;
    daysRemaining: number;
    capabilities: ProTrialDashboardView["capabilities"];
    automationPaused: boolean;
  };
  usage: {
    today: UsageMeterView;
    month: UsageMeterView;
  };
  mailboxes: MailboxMeterView;
  projection: QuotaProjectionView;
  cleanupOpportunity: CleanupConversionSummary;
  activity: CustomerActivityBreakdown;
  upgrade?: UpgradeCta;
}

export interface UsagePlanDashboardDependencies {
  usage: CustomerUsageStore;
  plans: Pick<
    PlanEntitlementService,
    "assignment" | "entitlements"
  >;
  accounts: Pick<
    McpAccountLinkStore,
    "listLinked"
  >;
  cleanup: Pick<
    CleanupConversionService,
    "summary"
  >;
  activity: CustomerDashboardTelemetrySource;
  trials?: Pick<
    ProTrialService,
    "dashboard"
  >;
  now?: () => Date;
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

function toIso(
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

function planLabel(
  planId: CommercialPlanId,
): string {
  if (planId === "free") return "Free";
  if (planId === "personal") return "Personal";
  if (planId === "pro") return "Pro";
  return "Business";
}

function meter(
  processed: number,
  limit: number | null,
  resetAt: string,
): UsageMeterView {
  if (limit === null) {
    return {
      processed,
      limit: null,
      remaining: null,
      percentUsed: null,
      resetAt,
      unlimited: true,
    };
  }
  return {
    processed,
    limit,
    remaining: Math.max(
      0,
      limit - processed,
    ),
    percentUsed:
      Math.round(
        (processed / limit) * 1000,
      ) / 10,
    resetAt,
    unlimited: false,
  };
}

function mailboxMeter(
  connected: number,
  limit: number | null,
): MailboxMeterView {
  if (limit === null) {
    return {
      connected,
      limit: null,
      remaining: null,
      unlimited: true,
    };
  }
  return {
    connected,
    limit,
    remaining: Math.max(
      0,
      limit - connected,
    ),
    unlimited: false,
  };
}

function quotaProjection(
  processed: number,
  limit: number | null,
  monthStart: string,
  monthEnd: string,
  asOf: string,
): QuotaProjectionView {
  if (limit === null) {
    return {
      status: "unlimited",
      dailyRunRate: null,
      projectedMonthlyTotal: null,
    };
  }
  if (processed >= limit) {
    return {
      status: "exhausted",
      dailyRunRate: null,
      projectedMonthlyTotal: processed,
      projectedExhaustionAt: asOf,
    };
  }
  if (processed === 0) {
    return {
      status: "insufficient_data",
      dailyRunRate: 0,
      projectedMonthlyTotal: 0,
    };
  }

  const startMs = Date.parse(monthStart);
  const endMs = Date.parse(monthEnd);
  const nowMs = Date.parse(asOf);
  const elapsedDays = Math.max(
    1,
    (nowMs - startMs) / DAY_MS,
  );
  const monthDays =
    (endMs - startMs) / DAY_MS;
  const dailyRunRate =
    processed / elapsedDays;
  const projectedMonthlyTotal =
    Math.round(
      dailyRunRate * monthDays,
    );
  const remaining = limit - processed;
  const projectedAtMs =
    nowMs +
    (remaining / dailyRunRate) *
      DAY_MS;

  if (
    !Number.isFinite(projectedAtMs) ||
    projectedAtMs >= endMs
  ) {
    return {
      status: "on_track",
      dailyRunRate:
        Math.round(dailyRunRate * 100) /
        100,
      projectedMonthlyTotal,
    };
  }

  return {
    status: "projected_exhaustion",
    dailyRunRate:
      Math.round(dailyRunRate * 100) /
      100,
    projectedMonthlyTotal,
    projectedExhaustionAt:
      new Date(projectedAtMs).toISOString(),
  };
}

function inPeriod(
  event: OperationalMetricEvent,
  start: string,
  endExclusive: string,
): boolean {
  return (
    event.timestamp >= start &&
    event.timestamp < endExclusive
  );
}

function activityBreakdown(
  events: readonly OperationalMetricEvent[],
  start: string,
  endExclusive: string,
): CustomerActivityBreakdown {
  const result: CustomerActivityBreakdown = {
    classifications: 0,
    automatedActions: 0,
    automatedArchive: 0,
    automatedTrash: 0,
    automatedMarkImportant: 0,
    otherAutomatedActions: 0,
    manualActions: 0,
  };

  for (const event of events) {
    if (!inPeriod(event, start, endExclusive)) {
      continue;
    }
    if (
      event.metric === "classifier_version" &&
      event.status !== "failed"
    ) {
      result.classifications += event.value;
      continue;
    }
    if (
      event.metric !== "action_result" ||
      event.status !== "succeeded"
    ) {
      continue;
    }

    if (
      event.source === "policy_engine" ||
      event.source === "system_retention"
    ) {
      result.automatedActions += event.value;
      if (event.action === "archive") {
        result.automatedArchive += event.value;
      } else if (
        event.action === "trash" ||
        event.action ===
          "delete_permanent"
      ) {
        result.automatedTrash += event.value;
      } else if (
        event.action === "mark_important"
      ) {
        result.automatedMarkImportant +=
          event.value;
      } else {
        result.otherAutomatedActions +=
          event.value;
      }
      continue;
    }

    if (
      event.source === "mcp_explicit" ||
      event.source === "user_confirmed"
    ) {
      result.manualActions += event.value;
    }
  }

  return result;
}

function upgradeCta(
  planId: CommercialPlanId,
  trial:
    | ProTrialDashboardView
    | undefined,
  cleanup: CleanupConversionSummary,
): UpgradeCta | undefined {
  if (
    planId === "business"
  ) {
    return undefined;
  }

  if (
    planId === "free" &&
    trial?.status === "active"
  ) {
    return {
      targetPlan: "pro",
      title: "Keep Pro after your trial",
      detail:
        trial.countdown +
        ". " +
        cleanup.message,
    };
  }

  if (
    planId === "free" &&
    trial?.status === "expired"
  ) {
    return {
      targetPlan: "personal",
      title:
        "Restore automatic cleanup",
      detail:
        cleanup.message,
    };
  }

  if (planId === "free") {
    return {
      targetPlan: "personal",
      title:
        "Automate your cleanup",
      detail:
        cleanup.message,
    };
  }

  if (planId === "personal") {
    return {
      targetPlan: "pro",
      title:
        "Unlock advanced AI and rules",
      detail:
        "Move to Pro for higher limits, advanced AI and advanced rules.",
    };
  }

  return {
    targetPlan: "business",
    title:
      "Need teams, audit or self-hosting?",
    detail:
      "Business adds custom limits, teams, audit, privacy controls and self-hosted options.",
  };
}

export class UsagePlanDashboardService {
  private readonly now: () => Date;

  constructor(
    private readonly deps:
      UsagePlanDashboardDependencies,
  ) {
    this.now =
      deps.now ?? (() => new Date());
  }

  async view(
    query: UsagePlanDashboardQuery,
  ): Promise<UsagePlanDashboardView> {
    const tenantId = required(
      query.tenantId,
      "tenantId",
    );
    const userId = required(
      query.userId,
      "userId",
    );
    const accountId = query.accountId
      ? required(
          query.accountId,
          "accountId",
        )
      : undefined;
    const asOf = toIso(
      query.at ?? this.now(),
      "at",
    );
    const day = utcDayPeriod(asOf);
    const month = utcMonthPeriod(asOf);

    const [
      assignment,
      entitlements,
      dayProcessed,
      monthProcessed,
      linked,
      cleanup,
      trial,
    ] = await Promise.all([
      this.deps.plans.assignment(
        tenantId,
      ),
      this.deps.plans.entitlements(
        tenantId,
      ),
      this.deps.usage.count({
        tenantId,
        ...(accountId
          ? { accountId }
          : {}),
        ...day,
      }),
      this.deps.usage.count({
        tenantId,
        ...(accountId
          ? { accountId }
          : {}),
        ...month,
      }),
      this.deps.accounts.listLinked(
        tenantId,
        userId,
      ),
      this.deps.cleanup.summary(
        tenantId,
        {
          ...(accountId
            ? { accountId }
            : {}),
          at: asOf,
        },
      ),
      this.deps.trials
        ? this.deps.trials.dashboard(
            tenantId,
            asOf,
          )
        : Promise.resolve(
            undefined,
          ),
    ]);

    const telemetry =
      this.deps.activity.list({
        tenantId,
        ...(accountId
          ? { accountId }
          : {}),
      });
    const upgrade = upgradeCta(
      assignment.planId,
      trial,
      cleanup,
    );

    return {
      asOf,
      billingPlan: {
        id: assignment.planId,
        label: planLabel(
          assignment.planId,
        ),
        revision:
          assignment.revision,
      },
      ...(trial
        ? {
            trial: {
              status: trial.status,
              headline: trial.headline,
              countdown:
                trial.countdown,
              startedAt:
                trial.startedAt,
              endsAt: trial.endsAt,
              daysRemaining:
                trial.daysRemaining,
              capabilities:
                trial.capabilities,
              automationPaused:
                trial.automationPaused,
            },
          }
        : {}),
      usage: {
        today: meter(
          dayProcessed,
          entitlements.limits
            .emailsPerDay,
          day.endExclusive,
        ),
        month: meter(
          monthProcessed,
          entitlements.limits
            .emailsPerMonth,
          month.endExclusive,
        ),
      },
      mailboxes: mailboxMeter(
        linked.length,
        entitlements.limits.mailboxes,
      ),
      projection: quotaProjection(
        monthProcessed,
        entitlements.limits
          .emailsPerMonth,
        month.start,
        month.endExclusive,
        asOf,
      ),
      cleanupOpportunity: cleanup,
      activity: activityBreakdown(
        telemetry,
        month.start,
        month.endExclusive,
      ),
      ...(upgrade
        ? { upgrade }
        : {}),
    };
  }
}
