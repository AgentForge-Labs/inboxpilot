import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { DataKeyWrapper } from "./vault-types.js";

const ALG = "aes-256-gcm";

export class InMemoryAesKeyWrapper implements DataKeyWrapper {
  private activeKeyId: string;

  constructor(
    private readonly keys: Map<string, Buffer>,
    activeKeyId: string,
  ) {
    this.activeKeyId = activeKeyId;
    this.assertKey(activeKeyId);
  }

  currentKeyId(): string {
    return this.activeKeyId;
  }

  setCurrentKeyId(keyId: string): void {
    this.assertKey(keyId);
    this.activeKeyId = keyId;
  }

  async wrap(dataKey: Buffer, keyId = this.activeKeyId) {
    const key = this.assertKey(keyId);
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, key, iv);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return {
      keyId,
      ciphertext,
      iv,
      authTag: cipher.getAuthTag(),
    };
  }

  async unwrap(input: {
    keyId: string;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
  }): Promise<Buffer> {
    const key = this.assertKey(input.keyId);
    const decipher = createDecipheriv(ALG, key, input.iv);
    decipher.setAuthTag(input.authTag);
    return Buffer.concat([
      decipher.update(input.ciphertext),
      decipher.final(),
    ]);
  }

  private assertKey(keyId: string): Buffer {
    const key = this.keys.get(keyId);
    if (!key || key.length !== 32) {
      throw new Error(`Wrapping key "${keyId}" is unavailable or invalid`);
    }
    return key;
  }
}
