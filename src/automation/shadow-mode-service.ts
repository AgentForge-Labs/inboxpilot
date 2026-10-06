import {
  SHADOW_MODE_DAYS,
  SHADOW_MODE_VERSION,
  type EnableAutomationRequest,
  type ShadowModeAccountState,
  type ShadowModeCounts,
  type ShadowModeDashboardView,
  type ShadowModeObservation,
  type ShadowModeStore,
} from "./shadow-mode-types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(field + " is required");
  return normalized;
}

function plusDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * DAY_MS).toISOString();
}

function countObservations(
  observations: readonly ShadowModeObservation[],
): ShadowModeCounts {
  const counts: ShadowModeCounts = {
    critical: 0,
    important: 0,
    normal: 0,
    low: 0,
    wouldArchive: 0,
    wouldDelete: 0,
    total: observations.length,
  };

  for (const item of observations) {
    if (item.priority === "critical") counts.critical += 1;
    else if (item.priority === "important") counts.important += 1;
    else if (item.priority === "normal") counts.normal += 1;
    else counts.low += 1;

    if (item.intendedAction === "archive") {
      counts.wouldArchive += 1;
    }
    if (item.intendedAction === "trash") {
      counts.wouldDelete += 1;
    }
  }

  return counts;
}

export class ShadowModeService {
  constructor(
    private readonly store: ShadowModeStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startAccount(
    tenantId: string,
    accountId: string,
    startedAt = this.now().toISOString(),
  ): Promise<ShadowModeAccountState> {
    required(tenantId, "tenantId");
    required(accountId, "accountId");
    if (Number.isNaN(Date.parse(startedAt))) {
      throw new TypeError("startedAt must be an ISO-compatible timestamp");
    }

    const existing = await this.store.get(tenantId, accountId);
    if (existing) return this.refresh(existing);

    const normalizedStart = new Date(startedAt).toISOString();
    const state: ShadowModeAccountState = {
      version: SHADOW_MODE_VERSION,
      tenantId,
      accountId,
      revision: 1,
      status: "shadow",
      startedAt: normalizedStart,
      shadowEndsAt: plusDays(
        normalizedStart,
        SHADOW_MODE_DAYS,
      ),
    };

    try {
      await this.store.create(state);
    } catch (error) {
      const concurrent = await this.store.get(
        tenantId,
        accountId,
      );
      if (!concurrent) throw error;
      return this.refresh(concurrent);
    }

    await this.store.appendAudit({
      tenantId,
      accountId,
      event: "shadow_started",
      timestamp: normalizedStart,
    });
    return this.refresh(state);
  }

  async getState(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeAccountState> {
    const state =
      (await this.store.get(tenantId, accountId)) ??
      (await this.startAccount(tenantId, accountId));
    return this.refresh(state);
  }

  async enableAutomation(
    request: EnableAutomationRequest,
  ): Promise<ShadowModeAccountState> {
    const actorId = required(request.actorId, "actorId");
    if (request.reviewed !== true) {
      throw new TypeError(
        "Enable Automation requires explicit review confirmation",
      );
    }

    let state = await this.getState(
      request.tenantId,
      request.accountId,
    );
    if (state.status === "enabled") return state;
    if (state.status !== "review_ready") {
      throw new Error(
        "Automation cannot be enabled before the seven-day Shadow Mode review window ends",
      );
    }

    const now = this.now().toISOString();
    state = await this.store.update(
      request.tenantId,
      request.accountId,
      state.revision,
      (current) => ({
        ...current,
        status: "enabled",
        enabledAt: now,
        enabledBy: actorId,
        reviewConfirmedAt: now,
      }),
    );
    await this.store.appendAudit({
      tenantId: request.tenantId,
      accountId: request.accountId,
      event: "automation_enabled",
      actorId,
      timestamp: now,
    });
    return state;
  }

  async recordObservation(
    observation: ShadowModeObservation,
  ): Promise<void> {
    const state = await this.getState(
      observation.tenantId,
      observation.accountId,
    );
    if (state.status === "enabled") return;
    await this.store.upsertObservation(observation);
  }

  async dashboard(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeDashboardView> {
    const state = await this.getState(tenantId, accountId);
    const observations = await this.store.listObservations(
      tenantId,
      accountId,
    );
    const remainingMs = Math.max(
      0,
      Date.parse(state.shadowEndsAt) - this.now().getTime(),
    );

    return {
      status: state.status,
      startedAt: state.startedAt,
      shadowEndsAt: state.shadowEndsAt,
      daysRemaining:
        state.status === "shadow"
          ? Math.ceil(remainingMs / DAY_MS)
          : 0,
      canEnableAutomation: state.status === "review_ready",
      automationEnabled: state.status === "enabled",
      counts: countObservations(observations),
    };
  }

  private async refresh(
    state: ShadowModeAccountState,
  ): Promise<ShadowModeAccountState> {
    if (
      state.status !== "shadow" ||
      this.now().getTime() < Date.parse(state.shadowEndsAt)
    ) {
      return state;
    }

    const now = this.now().toISOString();
    try {
      const updated = await this.store.update(
        state.tenantId,
        state.accountId,
        state.revision,
        (current) => ({
          ...current,
          status: "review_ready",
        }),
      );
      await this.store.appendAudit({
        tenantId: state.tenantId,
        accountId: state.accountId,
        event: "review_ready",
        timestamp: now,
      });
      return updated;
    } catch {
      const latest = await this.store.get(
        state.tenantId,
        state.accountId,
      );
      if (!latest) throw new Error("Shadow Mode state disappeared");
      return latest;
    }
  }
}
