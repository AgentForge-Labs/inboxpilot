import type {
  CanonicalMessage,
} from "../domain/email-model.js";
import type {
  McpLinkedAccount,
} from "../mcp/hosted/hosted-mcp-types.js";
import type {
  McpAccountLinkStore,
} from "../mcp/hosted/hosted-mcp-store.js";
import type {
  PolicyPlanCapabilities,
} from "../policy/policy-types.js";
import type {
  AutomationEntitlementResolver,
} from "./pro-trial.js";
import {
  utcDayPeriod,
  utcMonthPeriod,
  type CustomerUsageReservationResult,
  type CustomerUsageStore,
} from "./usage-accounting.js";
import type {
  CommercialPlanId,
} from "./plan-pricing.js";

export type PlanFeature =
  | "classification"
  | "importanceBuckets"
  | "basicRules"
  | "manualArchiveRecommendations"
  | "manualDeleteRecommendations"
  | "automaticArchive"
  | "automaticDelete"
  | "advancedAi"
  | "advancedRules"
  | "teams"
  | "auditLog"
  | "privacyControls"
  | "selfHosted"
  | "customLimits";

export interface PlanLimits {
  mailboxes: number | null;
  emailsPerDay: number | null;
  emailsPerMonth: number | null;
}

export interface PlanFeatures {
  classification: boolean;
  importanceBuckets: boolean;
  basicRules: boolean;
  manualArchiveRecommendations: boolean;
  manualDeleteRecommendations: boolean;
  automaticArchive: boolean;
  automaticDelete: boolean;
  advancedAi: boolean;
  advancedRules: boolean;
  teams: boolean;
  auditLog: boolean;
  privacyControls: boolean;
  selfHosted: boolean;
  customLimits: boolean;
}

export interface PlanEntitlements {
  planId: CommercialPlanId;
  limits: Readonly<PlanLimits>;
  features: Readonly<PlanFeatures>;
}

const FREE_FEATURES: PlanFeatures = {
  classification: true,
  importanceBuckets: true,
  basicRules: true,
  manualArchiveRecommendations: true,
  manualDeleteRecommendations: true,
  automaticArchive: false,
  automaticDelete: false,
  advancedAi: false,
  advancedRules: false,
  teams: false,
  auditLog: false,
  privacyControls: false,
  selfHosted: false,
  customLimits: false,
};

const PERSONAL_FEATURES: PlanFeatures = {
  ...FREE_FEATURES,
  automaticArchive: true,
  automaticDelete: true,
};

const PRO_FEATURES: PlanFeatures = {
  ...PERSONAL_FEATURES,
  advancedAi: true,
  advancedRules: true,
};

const BUSINESS_FEATURES: PlanFeatures = {
  ...PRO_FEATURES,
  teams: true,
  auditLog: true,
  privacyControls: true,
  selfHosted: true,
  customLimits: true,
};

function frozenEntitlements(
  planId: CommercialPlanId,
  limits: PlanLimits,
  features: PlanFeatures,
): PlanEntitlements {
  return Object.freeze({
    planId,
    limits: Object.freeze({ ...limits }),
    features: Object.freeze({ ...features }),
  });
}

export const PLAN_ENTITLEMENTS:
  Readonly<Record<CommercialPlanId, PlanEntitlements>> =
  Object.freeze({
    free: frozenEntitlements(
      "free",
      {
        mailboxes: 1,
        emailsPerDay: 100,
        emailsPerMonth: 3000,
      },
      FREE_FEATURES,
    ),
    personal: frozenEntitlements(
      "personal",
      {
        mailboxes: 3,
        emailsPerDay: null,
        emailsPerMonth: 20_000,
      },
      PERSONAL_FEATURES,
    ),
    pro: frozenEntitlements(
      "pro",
      {
        mailboxes: 10,
        emailsPerDay: null,
        emailsPerMonth: 100_000,
      },
      PRO_FEATURES,
    ),
    business: frozenEntitlements(
      "business",
      {
        mailboxes: null,
        emailsPerDay: null,
        emailsPerMonth: null,
      },
      BUSINESS_FEATURES,
    ),
  });

export interface BusinessLimitOverrides {
  mailboxes?: number | null;
  emailsPerDay?: number | null;
  emailsPerMonth?: number | null;
}

export interface TenantPlanAssignment {
  tenantId: string;
  planId: CommercialPlanId;
  assignedAt: string;
  revision: number;
  businessLimits?: BusinessLimitOverrides;
}

export interface TenantPlanStore {
  get(
    tenantId: string,
  ): Promise<TenantPlanAssignment | undefined>;
  put(
    assignment: TenantPlanAssignment,
    expectedRevision?: number,
  ): Promise<void>;
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

function validateLimit(
  value: number | null | undefined,
  field: string,
): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(
      field + " must be a positive safe integer or null",
    );
  }
  return value;
}

function normalizedBusinessLimits(
  planId: CommercialPlanId,
  limits: BusinessLimitOverrides | undefined,
): BusinessLimitOverrides | undefined {
  if (!limits) return undefined;
  if (planId !== "business") {
    throw new TypeError(
      "businessLimits can only be set on the business plan",
    );
  }
  const normalized: BusinessLimitOverrides = {};
  if ("mailboxes" in limits) {
    const value = validateLimit(
      limits.mailboxes,
      "businessLimits.mailboxes",
    );
    if (value !== undefined) {
      normalized.mailboxes = value;
    }
  }
  if ("emailsPerDay" in limits) {
    const value = validateLimit(
      limits.emailsPerDay,
      "businessLimits.emailsPerDay",
    );
    if (value !== undefined) {
      normalized.emailsPerDay = value;
    }
  }
  if ("emailsPerMonth" in limits) {
    const value = validateLimit(
      limits.emailsPerMonth,
      "businessLimits.emailsPerMonth",
    );
    if (value !== undefined) {
      normalized.emailsPerMonth = value;
    }
  }
  return normalized;
}

export class PlanRevisionConflictError extends Error {
  readonly code = "PLAN_REVISION_CONFLICT";

  constructor() {
    super("Tenant plan assignment revision changed");
    this.name = "PlanRevisionConflictError";
  }
}

export class PlanMailboxLimitError extends Error {
  readonly code = "PLAN_MAILBOX_LIMIT_REACHED";

  constructor(
    readonly planId: CommercialPlanId,
    readonly limit: number,
  ) {
    super(
      planId +
        " plan supports at most " +
        limit +
        " connected mailboxes",
    );
    this.name = "PlanMailboxLimitError";
  }
}

export class InMemoryTenantPlanStore
  implements TenantPlanStore
{
  readonly assignments =
    new Map<string, TenantPlanAssignment>();

  async get(
    tenantIdInput: string,
  ): Promise<TenantPlanAssignment | undefined> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    const value =
      this.assignments.get(tenantId);
    return value
      ? structuredClone(value)
      : undefined;
  }

  async put(
    assignment: TenantPlanAssignment,
    expectedRevision?: number,
  ): Promise<void> {
    const tenantId = required(
      assignment.tenantId,
      "tenantId",
    );
    const current =
      this.assignments.get(tenantId);
    if (
      expectedRevision !== undefined &&
      (current?.revision ?? 0) !== expectedRevision
    ) {
      throw new PlanRevisionConflictError();
    }
    this.assignments.set(tenantId, {
      tenantId,
      planId: assignment.planId,
      assignedAt: iso(
        assignment.assignedAt,
        "assignedAt",
      ),
      revision: assignment.revision,
      ...(assignment.businessLimits
        ? {
            businessLimits:
              structuredClone(
                assignment.businessLimits,
              ),
          }
        : {}),
    });
  }
}

function mergedLimits(
  assignment: TenantPlanAssignment,
): PlanLimits {
  const base =
    PLAN_ENTITLEMENTS[assignment.planId]
      .limits;
  if (
    assignment.planId !== "business" ||
    !assignment.businessLimits
  ) {
    return { ...base };
  }
  return {
    mailboxes:
      assignment.businessLimits.mailboxes !==
      undefined
        ? assignment.businessLimits.mailboxes
        : base.mailboxes,
    emailsPerDay:
      assignment.businessLimits.emailsPerDay !==
      undefined
        ? assignment.businessLimits.emailsPerDay
        : base.emailsPerDay,
    emailsPerMonth:
      assignment.businessLimits
        .emailsPerMonth !== undefined
        ? assignment.businessLimits
            .emailsPerMonth
        : base.emailsPerMonth,
  };
}

function safeReservationLimit(
  value: number | null,
): number {
  return value ?? Number.MAX_SAFE_INTEGER;
}

export interface PlanUsageDecision {
  allowed: boolean;
  reason:
    | "allowed"
    | "duplicate"
    | "daily_limit"
    | "monthly_limit";
  newlyCounted: boolean;
  planId: CommercialPlanId;
  dayProcessed: number;
  monthProcessed: number;
}

export class PlanEntitlementService
  implements AutomationEntitlementResolver
{
  constructor(
    private readonly plans: TenantPlanStore,
    private readonly usage: CustomerUsageStore,
    private readonly now: () => Date =
      () => new Date(),
  ) {}

  async assignment(
    tenantIdInput: string,
  ): Promise<TenantPlanAssignment> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    return (
      (await this.plans.get(tenantId)) ?? {
        tenantId,
        planId: "free",
        assignedAt:
          "1970-01-01T00:00:00.000Z",
        revision: 0,
      }
    );
  }

  async assignPlan(
    tenantIdInput: string,
    planId: CommercialPlanId,
    options: {
      businessLimits?: BusinessLimitOverrides;
      assignedAt?: string | Date;
      expectedRevision?: number;
    } = {},
  ): Promise<TenantPlanAssignment> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    const current =
      await this.plans.get(tenantId);
    const expected =
      options.expectedRevision ??
      (current?.revision ?? 0);
    const businessLimits =
      normalizedBusinessLimits(
        planId,
        options.businessLimits,
      );
    const assignment: TenantPlanAssignment = {
      tenantId,
      planId,
      assignedAt: iso(
        options.assignedAt ?? this.now(),
        "assignedAt",
      ),
      revision: expected + 1,
      ...(businessLimits
        ? { businessLimits }
        : {}),
    };
    await this.plans.put(
      assignment,
      expected,
    );
    return structuredClone(assignment);
  }

  async entitlements(
    tenantId: string,
  ): Promise<PlanEntitlements> {
    const assignment =
      await this.assignment(tenantId);
    const base =
      PLAN_ENTITLEMENTS[
        assignment.planId
      ];
    return {
      planId: base.planId,
      limits: mergedLimits(assignment),
      features: {
        ...base.features,
      },
    };
  }

  async featureEnabled(
    tenantId: string,
    feature: PlanFeature,
  ): Promise<boolean> {
    return (
      await this.entitlements(tenantId)
    ).features[feature];
  }

  async assertMailboxAvailable(
    tenantId: string,
    currentConnected: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(
        currentConnected,
      ) ||
      currentConnected < 0
    ) {
      throw new RangeError(
        "currentConnected must be a non-negative safe integer",
      );
    }
    const entitlements =
      await this.entitlements(tenantId);
    const limit =
      entitlements.limits.mailboxes;
    if (
      limit !== null &&
      currentConnected >= limit
    ) {
      throw new PlanMailboxLimitError(
        entitlements.planId,
        limit,
      );
    }
  }

  async reserveEmailProcessing(
    message: CanonicalMessage,
    processedAtInput:
      | string
      | Date = this.now(),
  ): Promise<PlanUsageDecision> {
    const processedAt = iso(
      processedAtInput,
      "processedAt",
    );
    const entitlements =
      await this.entitlements(
        message.tenantId,
      );
    const day = utcDayPeriod(processedAt);
    const month =
      utcMonthPeriod(processedAt);

    const reserved:
      CustomerUsageReservationResult =
      await this.usage.reserveUniqueWithinLimits(
        {
          tenantId: message.tenantId,
          accountId: message.accountId,
          provider: message.provider.kind,
          providerMessageId:
            message.provider.messageId,
          canonicalMessageId: message.id,
          processedAt,
        },
        {
          day: {
            ...day,
            limit: safeReservationLimit(
              entitlements.limits
                .emailsPerDay,
            ),
          },
          month: {
            ...month,
            limit: safeReservationLimit(
              entitlements.limits
                .emailsPerMonth,
            ),
          },
        },
      );

    return {
      allowed:
        reserved.status === "reserved" ||
        reserved.status === "duplicate",
      reason:
        reserved.status === "reserved"
          ? "allowed"
          : reserved.status,
      newlyCounted:
        reserved.status === "reserved",
      planId: entitlements.planId,
      dayProcessed:
        reserved.dayProcessed,
      monthProcessed:
        reserved.monthProcessed,
    };
  }

  async resolvePlanCapabilities(
    tenantId: string,
    _accountId: string,
    requested: PolicyPlanCapabilities,
  ): Promise<PolicyPlanCapabilities> {
    const features = (
      await this.entitlements(tenantId)
    ).features;
    return {
      automaticMarkImportant:
        requested.automaticMarkImportant,
      automaticArchive:
        requested.automaticArchive &&
        features.automaticArchive,
      automaticTrash:
        requested.automaticTrash &&
        features.automaticDelete,
    };
  }
}

export class PlanAccountLinkStore
  implements McpAccountLinkStore
{
  constructor(
    private readonly inner:
      McpAccountLinkStore,
    private readonly entitlements:
      PlanEntitlementService,
  ) {}

  async link(
    tenantId: string,
    userId: string,
    accountId: string,
    linkedAt: string,
  ): Promise<McpLinkedAccount> {
    const linked =
      await this.inner.listLinked(
        tenantId,
        userId,
      );
    const existing = linked.find(
      (item) =>
        item.accountId === accountId,
    );
    if (existing) {
      return structuredClone(existing);
    }
    await this.entitlements
      .assertMailboxAvailable(
        tenantId,
        linked.length,
      );
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
