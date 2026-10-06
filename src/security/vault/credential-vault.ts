import type {
  DataKeyWrapper,
  EncryptedSecretRecord,
  SecretRecordStore,
  SecretRef,
  VaultAuditEvent,
  VaultAuditSink,
  VaultOperation,
  VaultPrincipal,
} from "./vault-types.js";
import {
  decryptEnvelope,
  encryptEnvelope,
  type EncryptedPayload,
} from "./envelope-crypto.js";

export class VaultAccessDeniedError extends Error {
  readonly code = "VAULT_ACCESS_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "VaultAccessDeniedError";
  }
}

export class VaultSecretNotFoundError extends Error {
  readonly code = "VAULT_SECRET_NOT_FOUND";
  constructor() {
    super("Vault secret not found");
    this.name = "VaultSecretNotFoundError";
  }
}

export class InMemoryVaultAuditSink implements VaultAuditSink {
  readonly events: VaultAuditEvent[] = [];
  async append(event: VaultAuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

function fromRecord(record: EncryptedSecretRecord): EncryptedPayload {
  return {
    ciphertext: Buffer.from(record.ciphertext, "base64"),
    iv: Buffer.from(record.iv, "base64"),
    authTag: Buffer.from(record.authTag, "base64"),
    wrappedDataKey: Buffer.from(record.wrappedDataKey, "base64"),
    wrappedDataKeyIv: Buffer.from(record.wrappedDataKeyIv, "base64"),
    wrappedDataKeyAuthTag: Buffer.from(record.wrappedDataKeyAuthTag, "base64"),
    wrappingKeyId: record.wrappingKeyId,
  };
}

function allows(
  principal: VaultPrincipal,
  operation: VaultOperation,
  ref: SecretRef,
): boolean {
  return (
    principal.operations.includes(operation) &&
    principal.tenantIds.includes(ref.tenantId) &&
    (!principal.accountIds || principal.accountIds.includes(ref.accountId))
  );
}

export class CredentialVault {
  constructor(
    private readonly store: SecretRecordStore,
    private readonly wrapper: DataKeyWrapper,
    private readonly audit?: VaultAuditSink,
  ) {}

  private async authorize(
    principal: VaultPrincipal,
    operation: VaultOperation,
    ref: SecretRef,
  ): Promise<void> {
    const allowed = allows(principal, operation, ref);
    if (this.audit) {
      await this.audit.append({
        serviceId: principal.serviceId,
        operation,
        tenantId: ref.tenantId,
        accountId: ref.accountId,
        name: ref.name,
        outcome: allowed ? "allowed" : "denied",
        timestamp: new Date().toISOString(),
      });
    }
    if (!allowed) {
      throw new VaultAccessDeniedError(
        `Service "${principal.serviceId}" is not allowed to ${operation} this secret`,
      );
    }
  }

  async putJson(
    principal: VaultPrincipal,
    ref: SecretRef,
    value: unknown,
  ): Promise<void> {
    await this.authorize(principal, "write", ref);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    try {
      const encrypted = await encryptEnvelope(ref, plaintext, this.wrapper);
      const existing = await this.store.get(ref);
      const now = new Date().toISOString();
      await this.store.put({
        ...ref,
        version: 1,
        ciphertext: encrypted.ciphertext.toString("base64"),
        iv: encrypted.iv.toString("base64"),
        authTag: encrypted.authTag.toString("base64"),
        wrappedDataKey: encrypted.wrappedDataKey.toString("base64"),
        wrappedDataKeyIv: encrypted.wrappedDataKeyIv.toString("base64"),
        wrappedDataKeyAuthTag:
          encrypted.wrappedDataKeyAuthTag.toString("base64"),
        wrappingKeyId: encrypted.wrappingKeyId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    } finally {
      plaintext.fill(0);
    }
  }

  async getJson<T>(
    principal: VaultPrincipal,
    ref: SecretRef,
  ): Promise<T | null> {
    await this.authorize(principal, "read", ref);
    const record = await this.store.get(ref);
    if (!record) return null;
    const plaintext = await decryptEnvelope(ref, fromRecord(record), this.wrapper);
    try {
      return JSON.parse(plaintext.toString("utf8")) as T;
    } finally {
      plaintext.fill(0);
    }
  }

  async delete(
    principal: VaultPrincipal,
    ref: SecretRef,
  ): Promise<void> {
    await this.authorize(principal, "delete", ref);
    await this.store.delete(ref);
  }

  async rotateRecord(
    principal: VaultPrincipal,
    ref: SecretRef,
  ): Promise<boolean> {
    await this.authorize(principal, "rotate", ref);
    const record = await this.store.get(ref);
    if (!record) return false;
    if (record.wrappingKeyId === this.wrapper.currentKeyId()) return false;

    const oldWrapped = fromRecord(record);
    const dataKey = await this.wrapper.unwrap({
      keyId: oldWrapped.wrappingKeyId,
      ciphertext: oldWrapped.wrappedDataKey,
      iv: oldWrapped.wrappedDataKeyIv,
      authTag: oldWrapped.wrappedDataKeyAuthTag,
    });
    try {
      const wrapped = await this.wrapper.wrap(dataKey);
      await this.store.put({
        ...record,
        wrappedDataKey: wrapped.ciphertext.toString("base64"),
        wrappedDataKeyIv: wrapped.iv.toString("base64"),
        wrappedDataKeyAuthTag: wrapped.authTag.toString("base64"),
        wrappingKeyId: wrapped.keyId,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      dataKey.fill(0);
    }
    return true;
  }

  async rotateAllFromKey(
    principal: VaultPrincipal,
    oldKeyId: string,
  ): Promise<{ rotated: number; skippedUnauthorized: number }> {
    const records = await this.store.listByWrappingKey(oldKeyId);
    let rotated = 0;
    let skippedUnauthorized = 0;

    for (const record of records) {
      const ref: SecretRef = {
        tenantId: record.tenantId,
        accountId: record.accountId,
        name: record.name,
      };
      if (!allows(principal, "rotate", ref)) {
        skippedUnauthorized += 1;
        continue;
      }
      if (await this.rotateRecord(principal, ref)) rotated += 1;
    }

    return { rotated, skippedUnauthorized };
  }
}
