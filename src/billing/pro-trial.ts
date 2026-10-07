import type {
  PolicyPlanCapabilities,
} from "../policy/policy-types.js";
import type {
  McpLinkedAccount,
} from "../mcp/hosted/hosted-mcp-types.js";
import type {
  McpAccountLinkStore,
} from "../mcp/hosted/hosted-mcp-store.js";

export const PRO_TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProTrialRecord {
  tenantId: string;
  startedAt: string;
  endsAt: string;
  createdByAccountId: string;
}

export interface ProTrialStore {
  get(
    tenantId: string,
  ): Promise<ProTrialRecord | undefined>;
  create(
    record: ProTrialRecord,
  ): Promise<void>;
  exportTenantData?(
    tenantId: string,
  ): Promise<ProTrialRecord[]>;
  deleteTenantData?(
    tenantId: string,
  ): Promise<number>;
}

export interface ProTrialState {
  tenantId: string;
  status: "active" | "expired";
  startedAt: string;
  endsAt: string;
  evaluatedAt: string;
  daysRemaining: number;
  millisecondsRemaining: number;
  capabilities: "pro" | "free";
  automationPaused: boolean;
  downgradePlan: "free";
}

export interface ProTrialDashboardView
  extends ProTrialState {
  headline: string;
  countdown: string;
  safeDowngradeCopy: string;
}

export interface AutomationEntitlementResolver {
  resolvePlanCapabilities(
    tenantId: string,
    accountId: string,
    requested: PolicyPlanCapabilities,
  ): Promise<PolicyPlanCapabilities>;
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

function timestamp(
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

function trialEndsAt(startedAt: string): string {
  return new Date(
    Date.parse(startedAt) +
      PRO_TRIAL_DAYS * DAY_MS,
  ).toISOString();
}

export class InMemoryProTrialStore
  implements ProTrialStore
{
  readonly records =
    new Map<string, ProTrialRecord>();

  async get(
    tenantIdInput: string,
  ): Promise<ProTrialRecord | undefined> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    const record = this.records.get(tenantId);
    return record
      ? structuredClone(record)
      : undefined;
  }

  async create(
    record: ProTrialRecord,
  ): Promise<void> {
    const tenantId = required(
      record.tenantId,
      "tenantId",
    );
    if (this.records.has(tenantId)) {
      throw new Error(
        "Pro trial already exists for tenant",
      );
    }
    const startedAt = timestamp(
      record.startedAt,
      "startedAt",
    );
    const endsAt = timestamp(
      record.endsAt,
      "endsAt",
    );
    if (endsAt <= startedAt) {
      throw new RangeError(
        "Pro trial endsAt must be after startedAt",
      );
    }
    this.records.set(tenantId, {
      tenantId,
      startedAt,
      endsAt,
      createdByAccountId: required(
        record.createdByAccountId,
        "createdByAccountId",
      ),
    });
  }

  async exportTenantData(
    tenantIdInput: string,
  ): Promise<ProTrialRecord[]> {
    const record = await this.get(
      tenantIdInput,
    );
    return record ? [record] : [];
  }

  async deleteTenantData(
    tenantIdInput: string,
  ): Promise<number> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    return this.records.delete(tenantId)
      ? 1
      : 0;
  }
}

export class ProTrialService
  implements AutomationEntitlementResolver
{
  constructor(
    private readonly store: ProTrialStore,
    private readonly now: () => Date =
      () => new Date(),
  ) {}

  async ensureStarted(
    tenantIdInput: string,
    accountIdInput: string,
    startedAtInput:
      | string
      | Date = this.now(),
  ): Promise<ProTrialRecord> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    const accountId = required(
      accountIdInput,
      "accountId",
    );
    const existing =
      await this.store.get(tenantId);
    if (existing) return existing;

    const startedAt = timestamp(
      startedAtInput,
      "startedAt",
    );
    const record: ProTrialRecord = {
      tenantId,
      startedAt,
      endsAt: trialEndsAt(startedAt),
      createdByAccountId: accountId,
    };

    try {
      await this.store.create(record);
      return structuredClone(record);
    } catch (error) {
      const concurrent =
        await this.store.get(tenantId);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  async getState(
    tenantIdInput: string,
    evaluatedAtInput:
      | string
      | Date = this.now(),
  ): Promise<ProTrialState | undefined> {
    const tenantId = required(
      tenantIdInput,
      "tenantId",
    );
    const record =
      await this.store.get(tenantId);
    if (!record) return undefined;

    const evaluatedAt = timestamp(
      evaluatedAtInput,
      "evaluatedAt",
    );
    const remaining = Math.max(
      0,
      Date.parse(record.endsAt) -
        Date.parse(evaluatedAt),
    );
    const active =
      Date.parse(evaluatedAt) <
      Date.parse(record.endsAt);

    return {
      tenantId,
      status: active ? "active" : "expired",
      startedAt: record.startedAt,
      endsAt: record.endsAt,
      evaluatedAt,
      daysRemaining: active
        ? Math.ceil(remaining / DAY_MS)
        : 0,
      millisecondsRemaining: remaining,
      capabilities: active ? "pro" : "free",
      automationPaused: !active,
      downgradePlan: "free",
    };
  }

  async dashboard(
    tenantId: string,
    evaluatedAt:
      | string
      | Date = this.now(),
  ): Promise<
    ProTrialDashboardView | undefined
  > {
    const state = await this.getState(
      tenantId,
      evaluatedAt,
    );
    if (!state) return undefined;

    return {
      ...state,
      headline:
        state.status === "active"
          ? "Pro trial active"
          : "Pro trial ended",
      countdown:
        state.status === "active"
          ? state.daysRemaining +
            (state.daysRemaining === 1
              ? " day left"
              : " days left")
          : "Trial ended",
      safeDowngradeCopy:
        state.status === "active"
          ? "Pro automation remains available until the trial ends."
          : "Automatic archive/delete is paused. Existing mail and recommendations remain available on Free.",
    };
  }

  async resolvePlanCapabilities(
    tenantId: string,
    _accountId: string,
    requested: PolicyPlanCapabilities,
  ): Promise<PolicyPlanCapabilities> {
    const state = await this.getState(
      tenantId,
    );
    if (!state || state.status === "expired") {
      return {
        ...requested,
        automaticArchive: false,
        automaticTrash: false,
      };
    }
    return { ...requested };
  }
}

export class ProTrialAccountLinkStore
  implements McpAccountLinkStore
{
  constructor(
    private readonly inner:
      McpAccountLinkStore,
    private readonly trials:
      ProTrialService,
  ) {}

  async link(
    tenantId: string,
    userId: string,
    accountId: string,
    linkedAt: string,
  ): Promise<McpLinkedAccount> {
    const linked = await this.inner.link(
      tenantId,
      userId,
      accountId,
      linkedAt,
    );
    await this.trials.ensureStarted(
      tenantId,
      accountId,
      linkedAt,
    );
    return linked;
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
