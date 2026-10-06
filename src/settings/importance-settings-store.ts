import {
  DEFAULT_IMPORTANCE_SETTINGS,
  mergeImportanceSettings,
  validateImportanceSettings,
  type ImportanceSettings,
} from "./importance-settings.js";

export interface ImportanceSettingsRecord {
  tenantId: string;
  accountId: string;
  revision: number;
  settings: ImportanceSettings;
  updatedAt: string;
}

export interface ImportanceSettingsStore {
  get(tenantId: string, accountId: string): Promise<ImportanceSettingsRecord>;
  update(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    patch: {
      bands?: Partial<ImportanceSettings["bands"]>;
      automation?: Partial<ImportanceSettings["automation"]>;
    },
  ): Promise<ImportanceSettingsRecord>;
  reset(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
  ): Promise<ImportanceSettingsRecord>;
}

function key(tenantId: string, accountId: string): string {
  return tenantId + "\u0000" + accountId;
}

export class ImportanceSettingsConflictError extends Error {
  readonly code = "IMPORTANCE_SETTINGS_CONFLICT";
  constructor() {
    super("Importance settings revision changed");
    this.name = "ImportanceSettingsConflictError";
  }
}

export class InMemoryImportanceSettingsStore
  implements ImportanceSettingsStore
{
  private readonly records = new Map<string, ImportanceSettingsRecord>();

  async get(
    tenantId: string,
    accountId: string,
  ): Promise<ImportanceSettingsRecord> {
    const existing = this.records.get(key(tenantId, accountId));
    if (existing) return structuredClone(existing);
    return {
      tenantId,
      accountId,
      revision: 0,
      settings: structuredClone(DEFAULT_IMPORTANCE_SETTINGS),
      updatedAt: new Date(0).toISOString(),
    };
  }

  async update(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    patch: {
      bands?: Partial<ImportanceSettings["bands"]>;
      automation?: Partial<ImportanceSettings["automation"]>;
    },
  ): Promise<ImportanceSettingsRecord> {
    const current = await this.get(tenantId, accountId);
    if (current.revision !== expectedRevision) {
      throw new ImportanceSettingsConflictError();
    }

    const next: ImportanceSettingsRecord = {
      tenantId,
      accountId,
      revision: current.revision + 1,
      settings: mergeImportanceSettings(current.settings, patch),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key(tenantId, accountId), structuredClone(next));
    return next;
  }

  async reset(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
  ): Promise<ImportanceSettingsRecord> {
    const current = await this.get(tenantId, accountId);
    if (current.revision !== expectedRevision) {
      throw new ImportanceSettingsConflictError();
    }
    const next: ImportanceSettingsRecord = {
      tenantId,
      accountId,
      revision: current.revision + 1,
      settings: validateImportanceSettings(
        structuredClone(DEFAULT_IMPORTANCE_SETTINGS),
      ),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(key(tenantId, accountId), structuredClone(next));
    return next;
  }
}
