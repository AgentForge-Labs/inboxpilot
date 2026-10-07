export interface TenantAccountScope {
  tenantId: string;
  accountId: string;
}

export interface TenantAccessContext {
  tenantId: string;
  accountIds: readonly string[];
}

export type ServiceCapability =
  | "mailbox:read"
  | "mailbox:write"
  | "classification:write"
  | "policy:evaluate"
  | "retention:write"
  | "provider:maintain"
  | "audit:write";

export type ServiceRole =
  | "api"
  | "mcp"
  | "ingestion_worker"
  | "classification_worker"
  | "policy_worker"
  | "action_worker"
  | "retention_worker"
  | "provider_maintenance_worker";

const ROLE_CAPABILITIES: Readonly<
  Record<ServiceRole, readonly ServiceCapability[]>
> = Object.freeze({
  api: [
    "mailbox:read",
    "mailbox:write",
    "classification:write",
    "policy:evaluate",
    "retention:write",
    "provider:maintain",
    "audit:write",
  ],
  mcp: [
    "mailbox:read",
    "mailbox:write",
    "classification:write",
    "policy:evaluate",
    "retention:write",
    "audit:write",
  ],
  ingestion_worker: [
    "mailbox:read",
    "mailbox:write",
    "audit:write",
  ],
  classification_worker: [
    "mailbox:read",
    "classification:write",
    "audit:write",
  ],
  policy_worker: [
    "mailbox:read",
    "policy:evaluate",
    "audit:write",
  ],
  action_worker: [
    "mailbox:read",
    "mailbox:write",
    "audit:write",
  ],
  retention_worker: [
    "mailbox:read",
    "mailbox:write",
    "retention:write",
    "audit:write",
  ],
  provider_maintenance_worker: [
    "mailbox:read",
    "provider:maintain",
    "audit:write",
  ],
});

function normalizeId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(field + " is required");
  }
  return normalized;
}

export function normalizeTenantAccountScope(
  scope: TenantAccountScope,
): TenantAccountScope {
  return {
    tenantId: normalizeId(scope.tenantId, "tenantId"),
    accountId: normalizeId(scope.accountId, "accountId"),
  };
}

export function sameTenantAccountScope(
  left: TenantAccountScope,
  right: TenantAccountScope,
): boolean {
  const a = normalizeTenantAccountScope(left);
  const b = normalizeTenantAccountScope(right);
  return (
    a.tenantId === b.tenantId &&
    a.accountId === b.accountId
  );
}

export function assertEntityScope(
  expected: TenantAccountScope,
  actual: TenantAccountScope,
  entity = "record",
): void {
  if (!sameTenantAccountScope(expected, actual)) {
    throw new Error(
      entity + " is outside the authorized tenant/account scope",
    );
  }
}

export function assertTenantAccountAccess(
  context: TenantAccessContext,
  scope: TenantAccountScope,
): TenantAccountScope {
  const normalized = normalizeTenantAccountScope(scope);
  const tenantId = normalizeId(context.tenantId, "tenantId");
  if (normalized.tenantId !== tenantId) {
    throw new Error(
      "Tenant access denied for requested resource",
    );
  }
  const allowed = new Set(
    context.accountIds.map((accountId) =>
      normalizeId(accountId, "accountId"),
    ),
  );
  if (!allowed.has(normalized.accountId)) {
    throw new Error(
      "Mailbox account access denied for requested resource",
    );
  }
  return normalized;
}

function keyPart(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError("Tenant-scoped key parts must be non-empty");
  }
  return normalized.length + ":" + normalized;
}

export function tenantScopedKey(
  scope: TenantAccountScope,
  ...parts: readonly string[]
): string {
  const normalized = normalizeTenantAccountScope(scope);
  return [
    keyPart(normalized.tenantId),
    keyPart(normalized.accountId),
    ...parts.map(keyPart),
  ].join("|");
}

export function serviceRoleCapabilities(
  role: ServiceRole,
): readonly ServiceCapability[] {
  return ROLE_CAPABILITIES[role];
}

export function serviceRoleAllows(
  role: ServiceRole,
  capability: ServiceCapability,
): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

export function assertServiceRoleCapability(
  role: ServiceRole,
  capability: ServiceCapability,
): void {
  if (!serviceRoleAllows(role, capability)) {
    throw new Error(
      "Service role " +
        role +
        " is not allowed capability " +
        capability,
    );
  }
}
