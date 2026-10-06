import {
  SAFEGUARD_OVERRIDE_VERSION,
  type DangerousOverrideConfirmation,
  type DangerousOverrideCreateInput,
  type DangerousSafeguardOverride,
  type SafeguardOverrideStore,
} from "./safeguard-types.js";

const VALID_SCOPES = new Set([
  "category",
  "sender",
  "domain",
  "thread",
  "signal",
]);

function requiredString(
  value: unknown,
  field: string,
  max = 512,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(field + " is required");
  }
  const normalized = value.trim();
  if (normalized.length > max) {
    throw new RangeError(field + " is too long");
  }
  return normalized;
}

function validateConfirmation(
  confirmation: DangerousOverrideConfirmation | undefined,
): DangerousOverrideConfirmation {
  if (!confirmation) {
    throw new TypeError(
      "Safeguard override requires explicit confirmation",
    );
  }
  const confirmationId = requiredString(
    confirmation.confirmationId,
    "confirmation.confirmationId",
  );
  const actorId = requiredString(
    confirmation.actorId,
    "confirmation.actorId",
  );
  const statement = requiredString(
    confirmation.statement,
    "confirmation.statement",
    1000,
  );
  if (Number.isNaN(Date.parse(confirmation.confirmedAt))) {
    throw new TypeError(
      "confirmation.confirmedAt must be an ISO-compatible timestamp",
    );
  }
  return {
    confirmationId,
    actorId,
    statement,
    confirmedAt: new Date(
      confirmation.confirmedAt,
    ).toISOString(),
  };
}

export class SafeguardOverrideManager {
  constructor(
    private readonly store: SafeguardOverrideStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    input: DangerousOverrideCreateInput,
  ): Promise<DangerousSafeguardOverride> {
    const id = requiredString(input.id, "id");
    const tenantId = requiredString(
      input.tenantId,
      "tenantId",
    );
    const accountId = requiredString(
      input.accountId,
      "accountId",
    );
    if (!VALID_SCOPES.has(input.scope)) {
      throw new TypeError("Unsupported safeguard override scope");
    }
    const key = requiredString(input.key, "key");
    const confirmation = validateConfirmation(
      input.confirmation,
    );
    const now = this.now().toISOString();

    const override: DangerousSafeguardOverride = {
      version: SAFEGUARD_OVERRIDE_VERSION,
      id,
      tenantId,
      accountId,
      scope: input.scope,
      key:
        input.scope === "thread"
          ? key
          : key.toLowerCase(),
      enabled: true,
      confirmation,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.create(override);
    await this.store.appendAudit({
      overrideId: id,
      tenantId,
      accountId,
      action: "created",
      scope: override.scope,
      key: override.key,
      actorId: confirmation.actorId,
      confirmationId: confirmation.confirmationId,
      timestamp: now,
    });
    return override;
  }

  async setEnabled(
    tenantId: string,
    accountId: string,
    overrideId: string,
    enabled: boolean,
    confirmation?: DangerousOverrideConfirmation,
  ): Promise<DangerousSafeguardOverride> {
    const current = await this.store.get(
      tenantId,
      accountId,
      overrideId,
    );
    if (!current) throw new Error("Safeguard override not found");

    const confirmed = validateConfirmation(confirmation);
    const now = this.now().toISOString();
    const updated = await this.store.setEnabled(
      tenantId,
      accountId,
      overrideId,
      enabled,
      now,
    );
    await this.store.appendAudit({
      overrideId,
      tenantId,
      accountId,
      action: enabled ? "enabled" : "disabled",
      scope: current.scope,
      key: current.key,
      actorId: confirmed.actorId,
      confirmationId: confirmed.confirmationId,
      timestamp: now,
    });
    return updated;
  }
}
