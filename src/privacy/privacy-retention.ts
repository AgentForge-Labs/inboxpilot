export type PrivacyDataClass =
  | "email_body_cache"
  | "email_headers"
  | "attachment_extraction"
  | "classifier_prompt"
  | "classifier_result"
  | "tool_arguments"
  | "tool_result"
  | "audit_metadata"
  | "oauth_token"
  | "deleted_account_tombstone";

export type PrivacyPersistenceMode =
  | "content"
  | "metadata_only"
  | "forbidden";

export interface PrivacyRetentionRule {
  dataClass: PrivacyDataClass;
  retentionDays: number | null;
  persistence: PrivacyPersistenceMode;
  deleteOnAccountDeletion: boolean;
  exportable: boolean;
  purpose: string;
}

export const DEFAULT_PRIVACY_RETENTION_POLICY: Readonly<
  Record<PrivacyDataClass, PrivacyRetentionRule>
> = Object.freeze({
  email_body_cache: {
    dataClass: "email_body_cache",
    retentionDays: 30,
    persistence: "content",
    deleteOnAccountDeletion: true,
    exportable: true,
    purpose:
      "Temporary mailbox cache used for classification, search and thread context.",
  },
  email_headers: {
    dataClass: "email_headers",
    retentionDays: 30,
    persistence: "content",
    deleteOnAccountDeletion: true,
    exportable: true,
    purpose:
      "Temporary normalized headers used for threading, authentication and classification.",
  },
  attachment_extraction: {
    dataClass: "attachment_extraction",
    retentionDays: 7,
    persistence: "content",
    deleteOnAccountDeletion: true,
    exportable: true,
    purpose:
      "Short-lived extracted attachment text used only for classification.",
  },
  classifier_prompt: {
    dataClass: "classifier_prompt",
    retentionDays: 0,
    persistence: "forbidden",
    deleteOnAccountDeletion: true,
    exportable: false,
    purpose:
      "Classifier prompts are transient request material and are never persisted.",
  },
  classifier_result: {
    dataClass: "classifier_result",
    retentionDays: 30,
    persistence: "metadata_only",
    deleteOnAccountDeletion: true,
    exportable: true,
    purpose:
      "Structured classification outcome without raw email content or model prompt text.",
  },
  tool_arguments: {
    dataClass: "tool_arguments",
    retentionDays: 7,
    persistence: "metadata_only",
    deleteOnAccountDeletion: true,
    exportable: true,
    purpose:
      "Operational tool metadata excluding bodies, headers, credentials and arbitrary arguments.",
  },
  tool_result: {
    dataClass: "tool_result",
    retentionDays: 7,
    persistence: "metadata_only",
    deleteOnAccountDeletion: true,
    exportable: true,
    purpose:
      "Operational tool result metadata excluding message content and secrets.",
  },
  audit_metadata: {
    dataClass: "audit_metadata",
    retentionDays: 365,
    persistence: "metadata_only",
    deleteOnAccountDeletion: true,
    exportable: true,
    purpose:
      "Security and explainability metadata needed to reconstruct actions without retaining email content.",
  },
  oauth_token: {
    dataClass: "oauth_token",
    retentionDays: null,
    persistence: "metadata_only",
    deleteOnAccountDeletion: true,
    exportable: false,
    purpose:
      "Only token hashes and lifecycle metadata may be retained while a grant is active; raw tokens are never persisted here.",
  },
  deleted_account_tombstone: {
    dataClass: "deleted_account_tombstone",
    retentionDays: 30,
    persistence: "metadata_only",
    deleteOnAccountDeletion: false,
    exportable: false,
    purpose:
      "Minimal deletion-completion metadata used to prevent accidental resurrection and support abuse/security investigations.",
  },
});

export interface PrivacyRecordMetadata {
  [key: string]: string | number | boolean | null;
}

export interface PrivacyRecord {
  id: string;
  tenantId: string;
  accountId: string;
  dataClass: PrivacyDataClass;
  createdAt: string;
  expiresAt?: string;
  metadata: PrivacyRecordMetadata;
  payload?: unknown;
}

export interface PrivacyRetentionStore {
  put(record: PrivacyRecord): Promise<void>;
  listAccount(
    tenantId: string,
    accountId: string,
  ): Promise<PrivacyRecord[]>;
  sweepExpired(now: string): Promise<number>;
  deleteAccount(
    tenantId: string,
    accountId: string,
    options?: { preserveTombstones?: boolean },
  ): Promise<number>;
}

export interface PrivacyAccountDataTarget {
  name: string;
  exportAccountData?(
    tenantId: string,
    accountId: string,
  ): Promise<unknown>;
  deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number>;
}

export interface PrivacyExportBundle {
  generatedAt: string;
  tenantId: string;
  accountId: string;
  retainedRecords: PrivacyRecord[];
  sources: ReadonlyArray<{
    name: string;
    data: unknown;
  }>;
  disclosure: PrivacyDisclosure;
}

export interface PrivacyDeletionResult {
  deletedAt: string;
  tenantId: string;
  accountId: string;
  privacyRecordsDeleted: number;
  targetResults: ReadonlyArray<{
    name: string;
    deleted: number;
  }>;
  tombstoneId: string;
}

export interface PrivacyDisclosure {
  policyVersion: 1;
  generatedAt: string;
  rules: ReadonlyArray<{
    dataClass: PrivacyDataClass;
    persistence: PrivacyPersistenceMode;
    retentionDays: number | null;
    deleteOnAccountDeletion: boolean;
    exportable: boolean;
    purpose: string;
  }>;
}

const FORBIDDEN_METADATA_KEY =
  /(body|html|header|attachment|content|prompt|argument|result|token|secret|password|credential|authorization|cookie)/i;

function requireId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(field + " is required");
  }
  return normalized;
}

function requireIso(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError(field + " must be an ISO-compatible timestamp");
  }
  return new Date(value).toISOString();
}

function cloneRecord(record: PrivacyRecord): PrivacyRecord {
  return structuredClone(record);
}

function recordKey(record: PrivacyRecord): string {
  return [
    record.tenantId,
    record.accountId,
    record.dataClass,
    record.id,
  ].join("\u0000");
}

function sanitizeMetadata(
  metadata: PrivacyRecordMetadata,
): PrivacyRecordMetadata {
  const safe: PrivacyRecordMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!key.trim() || FORBIDDEN_METADATA_KEY.test(key)) {
      throw new TypeError(
        'Privacy metadata field "' +
          key +
          '" may contain sensitive content and is not allowed',
      );
    }
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new TypeError(
        "Privacy metadata values must be scalar JSON values",
      );
    }
    if (typeof value === "string" && value.length > 500) {
      throw new RangeError(
        "Privacy metadata string values must be 500 characters or fewer",
      );
    }
    safe[key] = value;
  }
  return safe;
}

function ruleFor(
  dataClass: PrivacyDataClass,
  policy: Readonly<
    Record<PrivacyDataClass, PrivacyRetentionRule>
  >,
): PrivacyRetentionRule {
  const rule = policy[dataClass];
  if (!rule) {
    throw new TypeError(
      "No privacy retention rule exists for " + dataClass,
    );
  }
  return rule;
}

function expiryFor(
  createdAt: string,
  rule: PrivacyRetentionRule,
): string | undefined {
  if (rule.retentionDays === null) return undefined;
  return new Date(
    Date.parse(createdAt) +
      rule.retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
}

export class InMemoryPrivacyRetentionStore
  implements PrivacyRetentionStore
{
  readonly records = new Map<string, PrivacyRecord>();

  async put(record: PrivacyRecord): Promise<void> {
    this.records.set(recordKey(record), cloneRecord(record));
  }

  async listAccount(
    tenantId: string,
    accountId: string,
  ): Promise<PrivacyRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.tenantId === tenantId &&
          record.accountId === accountId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(cloneRecord);
  }

  async sweepExpired(now: string): Promise<number> {
    const boundary = Date.parse(requireIso(now, "now"));
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (
        record.expiresAt &&
        Date.parse(record.expiresAt) <= boundary
      ) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteAccount(
    tenantId: string,
    accountId: string,
    options: { preserveTombstones?: boolean } = {},
  ): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (
        record.tenantId !== tenantId ||
        record.accountId !== accountId
      ) {
        continue;
      }
      if (
        options.preserveTombstones &&
        record.dataClass === "deleted_account_tombstone"
      ) {
        continue;
      }
      this.records.delete(key);
      deleted += 1;
    }
    return deleted;
  }
}

export class PrivacyRetentionService {
  constructor(
    private readonly store: PrivacyRetentionStore,
    private readonly targets: readonly PrivacyAccountDataTarget[] = [],
    private readonly policy: Readonly<
      Record<PrivacyDataClass, PrivacyRetentionRule>
    > = DEFAULT_PRIVACY_RETENTION_POLICY,
    private readonly now: () => Date = () => new Date(),
  ) {}

  disclosure(): PrivacyDisclosure {
    return {
      policyVersion: 1,
      generatedAt: this.now().toISOString(),
      rules: Object.values(this.policy).map((rule) => ({
        dataClass: rule.dataClass,
        persistence: rule.persistence,
        retentionDays: rule.retentionDays,
        deleteOnAccountDeletion:
          rule.deleteOnAccountDeletion,
        exportable: rule.exportable,
        purpose: rule.purpose,
      })),
    };
  }

  async retain(input: {
    id: string;
    tenantId: string;
    accountId: string;
    dataClass: PrivacyDataClass;
    metadata?: PrivacyRecordMetadata;
    payload?: unknown;
    createdAt?: string;
  }): Promise<PrivacyRecord | null> {
    const id = requireId(input.id, "id");
    const tenantId = requireId(
      input.tenantId,
      "tenantId",
    );
    const accountId = requireId(
      input.accountId,
      "accountId",
    );
    const rule = ruleFor(input.dataClass, this.policy);
    const createdAt = requireIso(
      input.createdAt ?? this.now().toISOString(),
      "createdAt",
    );
    const metadata = sanitizeMetadata(
      input.metadata ?? {},
    );

    if (rule.persistence === "forbidden") {
      if (input.payload !== undefined) {
        throw new Error(
          input.dataClass +
            " persistence is forbidden by privacy policy",
        );
      }
      return null;
    }
    if (
      rule.persistence === "metadata_only" &&
      input.payload !== undefined
    ) {
      throw new Error(
        input.dataClass +
          " may retain metadata only; content payload is forbidden",
      );
    }

    const expiresAt = expiryFor(createdAt, rule);
    const record: PrivacyRecord = {
      id,
      tenantId,
      accountId,
      dataClass: input.dataClass,
      createdAt,
      ...(expiresAt ? { expiresAt } : {}),
      metadata,
      ...(rule.persistence === "content" &&
      input.payload !== undefined
        ? { payload: structuredClone(input.payload) }
        : {}),
    };
    await this.store.put(record);
    return cloneRecord(record);
  }

  async sweep(
    now = this.now().toISOString(),
  ): Promise<number> {
    return this.store.sweepExpired(now);
  }

  async exportAccount(
    tenantIdInput: string,
    accountIdInput: string,
  ): Promise<PrivacyExportBundle> {
    const tenantId = requireId(
      tenantIdInput,
      "tenantId",
    );
    const accountId = requireId(
      accountIdInput,
      "accountId",
    );
    const records = (
      await this.store.listAccount(
        tenantId,
        accountId,
      )
    ).filter(
      (record) =>
        ruleFor(record.dataClass, this.policy)
          .exportable,
    );

    const sources: Array<{
      name: string;
      data: unknown;
    }> = [];
    for (const target of this.targets) {
      if (!target.exportAccountData) continue;
      sources.push({
        name: target.name,
        data: await target.exportAccountData(
          tenantId,
          accountId,
        ),
      });
    }

    return {
      generatedAt: this.now().toISOString(),
      tenantId,
      accountId,
      retainedRecords: records,
      sources,
      disclosure: this.disclosure(),
    };
  }

  async deleteAccount(
    tenantIdInput: string,
    accountIdInput: string,
  ): Promise<PrivacyDeletionResult> {
    const tenantId = requireId(
      tenantIdInput,
      "tenantId",
    );
    const accountId = requireId(
      accountIdInput,
      "accountId",
    );
    const deletedAt = this.now().toISOString();

    const targetResults: Array<{
      name: string;
      deleted: number;
    }> = [];
    for (const target of this.targets) {
      const deleted = await target.deleteAccountData(
        tenantId,
        accountId,
      );
      targetResults.push({
        name: target.name,
        deleted,
      });
    }

    const privacyRecordsDeleted =
      await this.store.deleteAccount(
        tenantId,
        accountId,
      );

    const tombstoneId =
      "deleted-account:" +
      tenantId +
      ":" +
      accountId +
      ":" +
      deletedAt;
    await this.retain({
      id: tombstoneId,
      tenantId,
      accountId,
      dataClass: "deleted_account_tombstone",
      metadata: {
        deletedAt,
        targetCount: targetResults.length,
      },
      createdAt: deletedAt,
    });

    return {
      deletedAt,
      tenantId,
      accountId,
      privacyRecordsDeleted,
      targetResults,
      tombstoneId,
    };
  }
}

export class PrivacyRetentionSweep {
  constructor(
    private readonly service: PrivacyRetentionService,
  ) {}

  async run(now?: string): Promise<{
    deleted: number;
    ranAt: string;
  }> {
    const ranAt = now
      ? requireIso(now, "now")
      : new Date().toISOString();
    return {
      deleted: await this.service.sweep(ranAt),
      ranAt,
    };
  }
}
