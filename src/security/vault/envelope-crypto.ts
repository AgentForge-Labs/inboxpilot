import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { DataKeyWrapper, SecretRef } from "./vault-types.js";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function aad(ref: SecretRef): Buffer {
  return Buffer.from(
    `inboxpilot-vault:v1:${ref.tenantId}:${ref.accountId}:${ref.name}`,
    "utf8",
  );
}

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  wrappedDataKey: Buffer;
  wrappedDataKeyIv: Buffer;
  wrappedDataKeyAuthTag: Buffer;
  wrappingKeyId: string;
}

export async function encryptEnvelope(
  ref: SecretRef,
  plaintext: Buffer,
  wrapper: DataKeyWrapper,
): Promise<EncryptedPayload> {
  const dataKey = randomBytes(KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, dataKey, iv);
  cipher.setAAD(aad(ref));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrapped = await wrapper.wrap(dataKey);
  dataKey.fill(0);
  return {
    ciphertext,
    iv,
    authTag,
    wrappedDataKey: wrapped.ciphertext,
    wrappedDataKeyIv: wrapped.iv,
    wrappedDataKeyAuthTag: wrapped.authTag,
    wrappingKeyId: wrapped.keyId,
  };
}

export async function decryptEnvelope(
  ref: SecretRef,
  encrypted: EncryptedPayload,
  wrapper: DataKeyWrapper,
): Promise<Buffer> {
  const dataKey = await wrapper.unwrap({
    keyId: encrypted.wrappingKeyId,
    ciphertext: encrypted.wrappedDataKey,
    iv: encrypted.wrappedDataKeyIv,
    authTag: encrypted.wrappedDataKeyAuthTag,
  });
  try {
    const decipher = createDecipheriv(ALG, dataKey, encrypted.iv);
    decipher.setAAD(aad(ref));
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([
      decipher.update(encrypted.ciphertext),
      decipher.final(),
    ]);
  } finally {
    dataKey.fill(0);
  }
}
