import { EMAIL_SCHEMA_VERSION } from "./email-model.js";

export type PersistedEntityType = "message" | "thread";

export interface PersistedEnvelope<T = unknown> {
  schemaVersion: number;
  entityType: PersistedEntityType;
  data: T;
}

type Migration = (input: PersistedEnvelope) => PersistedEnvelope;

/**
 * Add migrations by source version, e.g. key 1 migrates v1 -> v2.
 * Migrations must be deterministic and side-effect free.
 */
const migrations: Readonly<Record<number, Migration>> = Object.freeze({});

export function migrateEnvelope<T = unknown>(input: PersistedEnvelope<T>): PersistedEnvelope<T> {
  if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new TypeError("Persisted envelope has an invalid schemaVersion");
  }
  if (input.schemaVersion > EMAIL_SCHEMA_VERSION) {
    throw new RangeError(
      `Cannot read future schema v${input.schemaVersion}; runtime supports v${EMAIL_SCHEMA_VERSION}`,
    );
  }

  let current: PersistedEnvelope = input;
  while (current.schemaVersion < EMAIL_SCHEMA_VERSION) {
    const migrate = migrations[current.schemaVersion];
    if (!migrate) throw new Error(`Missing migration from schema v${current.schemaVersion}`);
    const next = migrate(current);
    if (next.schemaVersion !== current.schemaVersion + 1) {
      throw new Error("Schema migrations must advance exactly one version");
    }
    current = next;
  }

  return current as PersistedEnvelope<T>;
}
