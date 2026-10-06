import type {
  ShadowModeAccountState,
  ShadowModeAuditEvent,
  ShadowModeObservation,
  ShadowModeStore,
} from "./shadow-mode-types.js";

function scopeKey(tenantId: string, accountId: string): string {
  return tenantId + "\u0000" + accountId;
}

function observationKey(
  tenantId: string,
  accountId: string,
  providerMessageId: string,
): string {
  return [tenantId, accountId, providerMessageId].join("\u0000");
}

export class ShadowModeConflictError extends Error {
  readonly code = "SHADOW_MODE_CONFLICT";

  constructor() {
    super("Shadow Mode state changed concurrently");
    this.name = "ShadowModeConflictError";
  }
}

export class InMemoryShadowModeStore
  implements ShadowModeStore
{
  readonly states = new Map<string, ShadowModeAccountState>();
  readonly observations = new Map<
    string,
    ShadowModeObservation
  >();
  readonly audit: ShadowModeAuditEvent[] = [];

  async get(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeAccountState | undefined> {
    const value = this.states.get(scopeKey(tenantId, accountId));
    return value ? structuredClone(value) : undefined;
  }

  async create(state: ShadowModeAccountState): Promise<void> {
    const key = scopeKey(state.tenantId, state.accountId);
    if (this.states.has(key)) {
      throw new ShadowModeConflictError();
    }
    this.states.set(key, structuredClone(state));
  }

  async update(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    mutate: (
      state: ShadowModeAccountState,
    ) => ShadowModeAccountState,
  ): Promise<ShadowModeAccountState> {
    const key = scopeKey(tenantId, accountId);
    const current = this.states.get(key);
    if (!current) throw new Error("Shadow Mode state not found");
    if (current.revision !== expectedRevision) {
      throw new ShadowModeConflictError();
    }
    const next = mutate(structuredClone(current));
    if (
      next.tenantId !== tenantId ||
      next.accountId !== accountId
    ) {
      throw new Error("Shadow Mode scope cannot change");
    }
    next.revision = current.revision + 1;
    this.states.set(key, structuredClone(next));
    return structuredClone(next);
  }

  async upsertObservation(
    observation: ShadowModeObservation,
  ): Promise<void> {
    this.observations.set(
      observationKey(
        observation.tenantId,
        observation.accountId,
        observation.providerMessageId,
      ),
      structuredClone(observation),
    );
  }

  async listObservations(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeObservation[]> {
    return [...this.observations.values()]
      .filter(
        (item) =>
          item.tenantId === tenantId &&
          item.accountId === accountId,
      )
      .map((item) => structuredClone(item))
      .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }

  async appendAudit(
    event: ShadowModeAuditEvent,
  ): Promise<void> {
    this.audit.push(structuredClone(event));
  }

  async listAudit(
    tenantId: string,
    accountId: string,
  ): Promise<ShadowModeAuditEvent[]> {
    return this.audit
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.accountId === accountId,
      )
      .map((event) => structuredClone(event));
  }
}
