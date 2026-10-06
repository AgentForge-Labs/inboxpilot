export type VaultOperation = "read" | "write" | "delete" | "rotate";

export interface VaultPrincipal {
  serviceId: string;
  operations: readonly VaultOperation[];
  tenantIds: readonly string[];
  accountIds?: readonly string[];
}

export interface SecretRef {
  tenantId: string;
  accountId: string;
  name: string;
}

export interface EncryptedSecretRecord extends SecretRef {
  version: 1;
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDataKey: string;
  wrappedDataKeyIv: string;
  wrappedDataKeyAuthTag: string;
  wrappingKeyId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SecretRecordStore {
  get(ref: SecretRef): Promise<EncryptedSecretRecord | undefined>;
  put(record: EncryptedSecretRecord): Promise<void>;
  delete(ref: SecretRef): Promise<void>;
  listByWrappingKey(keyId: string): Promise<EncryptedSecretRecord[]>;
}

export interface DataKeyWrapper {
  currentKeyId(): string;
  wrap(dataKey: Buffer, keyId?: string): Promise<{
    keyId: string;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
  }>;
  unwrap(input: {
    keyId: string;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
  }): Promise<Buffer>;
}

export interface VaultAuditEvent {
  serviceId: string;
  operation: VaultOperation;
  tenantId: string;
  accountId: string;
  name: string;
  outcome: "allowed" | "denied";
  timestamp: string;
}

export interface VaultAuditSink {
  append(event: VaultAuditEvent): Promise<void>;
}
