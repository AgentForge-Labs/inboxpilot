import type {
  EncryptedSecretRecord,
  SecretRecordStore,
  SecretRef,
} from "./vault-types.js";

function keyOf(ref: SecretRef): string {
  return `${ref.tenantId}\u0000${ref.accountId}\u0000${ref.name}`;
}

export class InMemorySecretRecordStore implements SecretRecordStore {
  readonly records = new Map<string, EncryptedSecretRecord>();

  async get(ref: SecretRef): Promise<EncryptedSecretRecord | undefined> {
    const record = this.records.get(keyOf(ref));
    return record ? structuredClone(record) : undefined;
  }

  async put(record: EncryptedSecretRecord): Promise<void> {
    this.records.set(keyOf(record), structuredClone(record));
  }

  async delete(ref: SecretRef): Promise<void> {
    this.records.delete(keyOf(ref));
  }

  async listByWrappingKey(keyId: string): Promise<EncryptedSecretRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.wrappingKeyId === keyId)
      .map((record) => structuredClone(record));
  }
}
