import { tenantScopedKey } from "../security/tenant-boundary.js";
import type {
  DangerousSafeguardOverride,
  SafeguardOverrideAuditEvent,
  SafeguardOverrideStore,
} from "./safeguard-types.js";

function scopeKey(tenantId: string, accountId: string): string {
  return tenantScopedKey({ tenantId, accountId }, "safeguard_scope");
}

export class InMemorySafeguardOverrideStore
  implements SafeguardOverrideStore
{
  readonly overrides = new Map<
    string,
    Map<string, DangerousSafeguardOverride>
  >();
  readonly audit: SafeguardOverrideAuditEvent[] = [];

  async create(
    override: DangerousSafeguardOverride,
  ): Promise<void> {
    const key = scopeKey(override.tenantId, override.accountId);
    let scoped = this.overrides.get(key);
    if (!scoped) {
      scoped = new Map();
      this.overrides.set(key, scoped);
    }
    if (scoped.has(override.id)) {
      throw new Error("Safeguard override already exists");
    }
    scoped.set(override.id, structuredClone(override));
  }

  async get(
    tenantId: string,
    accountId: string,
    overrideId: string,
  ): Promise<DangerousSafeguardOverride | undefined> {
    const value = this.overrides
      .get(scopeKey(tenantId, accountId))
      ?.get(overrideId);
    return value ? structuredClone(value) : undefined;
  }

  async list(
    tenantId: string,
    accountId: string,
  ): Promise<DangerousSafeguardOverride[]> {
    return [
      ...(this.overrides.get(scopeKey(tenantId, accountId))
        ?.values() ?? []),
    ]
      .map((value) => structuredClone(value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async setEnabled(
    tenantId: string,
    accountId: string,
    overrideId: string,
    enabled: boolean,
    updatedAt: string,
  ): Promise<DangerousSafeguardOverride> {
    const scoped = this.overrides.get(
      scopeKey(tenantId, accountId),
    );
    const current = scoped?.get(overrideId);
    if (!current) throw new Error("Safeguard override not found");
    const next = {
      ...current,
      enabled,
      updatedAt,
    };
    scoped!.set(overrideId, structuredClone(next));
    return structuredClone(next);
  }

  async appendAudit(
    event: SafeguardOverrideAuditEvent,
  ): Promise<void> {
    this.audit.push(structuredClone(event));
  }

  async listAudit(
    tenantId: string,
    accountId: string,
  ): Promise<SafeguardOverrideAuditEvent[]> {
    return this.audit
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.accountId === accountId,
      )
      .map((event) => structuredClone(event));
  }
}
