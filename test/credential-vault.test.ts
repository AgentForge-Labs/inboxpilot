import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  CredentialVault,
  GmailVaultCredentialStore,
  ImapVaultCredentialStore,
  InMemoryAesKeyWrapper,
  InMemorySecretRecordStore,
  InMemoryVaultAuditSink,
  VaultAccessDeniedError,
  redactSecrets,
  type ProviderConnectionContext,
  type SecretRef,
  type VaultPrincipal,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

const ref: SecretRef = {
  tenantId: context.tenantId,
  accountId: context.accountId,
  name: "gmail/oauth",
};

function principal(
  operations: VaultPrincipal["operations"] = [
    "read",
    "write",
    "delete",
    "rotate",
  ],
  tenantIds: readonly string[] = ["tenant-1"],
  accountIds: readonly string[] | undefined = ["account-1"],
): VaultPrincipal {
  return {
    serviceId: "connector-worker",
    operations,
    tenantIds,
    ...(accountIds ? { accountIds } : {}),
  };
}

function fixture() {
  const key1 = randomBytes(32);
  const key2 = randomBytes(32);
  const wrapper = new InMemoryAesKeyWrapper(
    new Map([
      ["kek-1", key1],
      ["kek-2", key2],
    ]),
    "kek-1",
  );
  const store = new InMemorySecretRecordStore();
  const audit = new InMemoryVaultAuditSink();
  const vault = new CredentialVault(store, wrapper, audit);
  return { wrapper, store, audit, vault };
}

test("vault persists ciphertext and never plaintext OAuth tokens", async () => {
  const { vault, store } = fixture();
  const credentials = {
    accessToken: "access-super-secret-value",
    refreshToken: "refresh-super-secret-value",
    expiresAt: 123456,
    scope: "gmail.modify",
  };

  await vault.putJson(principal(), ref, credentials);
  const record = await store.get(ref);
  assert.ok(record);

  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes(credentials.accessToken), false);
  assert.equal(serialized.includes(credentials.refreshToken), false);
  assert.equal(record?.wrappingKeyId, "kek-1");

  const restored = await vault.getJson<typeof credentials>(principal(), ref);
  assert.deepEqual(restored, credentials);
});

test("AAD prevents encrypted secret from being moved to another tenant/account", async () => {
  const { vault, store } = fixture();
  await vault.putJson(principal(), ref, { accessToken: "token-value" });
  const record = await store.get(ref);
  assert.ok(record);

  const tampered = {
    ...record!,
    tenantId: "tenant-2",
    accountId: "account-2",
  };
  await store.put(tampered);

  await assert.rejects(
    () =>
      vault.getJson(
        principal(["read"], ["tenant-2"], ["account-2"]),
        {
          tenantId: "tenant-2",
          accountId: "account-2",
          name: "gmail/oauth",
        },
      ),
  );
});

test("least-privilege principal cannot cross tenant/account or perform undelegated operation", async () => {
  const { vault, audit } = fixture();
  await vault.putJson(principal(["write"]), ref, { accessToken: "token" });

  await assert.rejects(
    () => vault.getJson(principal(["write"]), ref),
    VaultAccessDeniedError,
  );

  await assert.rejects(
    () =>
      vault.getJson(
        principal(["read"], ["tenant-2"], ["account-1"]),
        ref,
      ),
    VaultAccessDeniedError,
  );

  assert.equal(
    audit.events.filter((event) => event.outcome === "denied").length,
    2,
  );
  assert.equal(
    JSON.stringify(audit.events).includes("token"),
    false,
  );
});

test("key rotation rewraps DEK without rewriting encrypted payload", async () => {
  const { vault, store, wrapper } = fixture();
  await vault.putJson(principal(), ref, {
    refreshToken: "rotation-secret-value",
  });

  const before = await store.get(ref);
  assert.ok(before);
  wrapper.setCurrentKeyId("kek-2");

  const rotated = await vault.rotateRecord(principal(["rotate"]), ref);
  assert.equal(rotated, true);

  const after = await store.get(ref);
  assert.ok(after);
  assert.equal(after?.wrappingKeyId, "kek-2");
  assert.equal(after?.ciphertext, before?.ciphertext);
  assert.notEqual(after?.wrappedDataKey, before?.wrappedDataKey);

  const restored = await vault.getJson<{ refreshToken: string }>(
    principal(["read"]),
    ref,
  );
  assert.equal(restored?.refreshToken, "rotation-secret-value");
});

test("bulk rotation skips records outside principal tenant scope", async () => {
  const { vault, store, wrapper } = fixture();

  await vault.putJson(principal(["write"]), ref, { secret: "one" });
  const otherRef = {
    tenantId: "tenant-2",
    accountId: "account-2",
    name: "imap/credentials",
  };
  await vault.putJson(
    principal(["write"], ["tenant-2"], ["account-2"]),
    otherRef,
    { secret: "two" },
  );

  wrapper.setCurrentKeyId("kek-2");
  const result = await vault.rotateAllFromKey(
    principal(["rotate"], ["tenant-1"], ["account-1"]),
    "kek-1",
  );

  assert.deepEqual(result, { rotated: 1, skippedUnauthorized: 1 });
  assert.equal((await store.get(ref))?.wrappingKeyId, "kek-2");
  assert.equal((await store.get(otherRef))?.wrappingKeyId, "kek-1");
});

test("vault-backed Gmail and IMAP stores satisfy connector credential contracts", async () => {
  const { vault } = fixture();
  const p = principal();
  const gmail = new GmailVaultCredentialStore(vault, p);
  const imap = new ImapVaultCredentialStore(vault, p);

  await gmail.set(context, {
    accessToken: "gmail-access",
    refreshToken: "gmail-refresh",
  });
  assert.equal((await gmail.get(context))?.refreshToken, "gmail-refresh");

  await imap.set(context, {
    username: "user@example.test",
    authMode: "app_password",
    secret: "imap-app-password",
  });
  assert.equal((await imap.get(context))?.secret, "imap-app-password");

  await gmail.delete(context);
  assert.equal(await gmail.get(context), null);
});

test("delete removes encrypted secret record", async () => {
  const { vault, store } = fixture();
  await vault.putJson(principal(), ref, { accessToken: "token" });
  assert.ok(await store.get(ref));

  await vault.delete(principal(["delete"]), ref);
  assert.equal(await store.get(ref), undefined);
});

test("structured redaction removes secrets from log and trace metadata", () => {
  const input = {
    provider: "gmail",
    accessToken: "access-token-value",
    nested: {
      refresh_token: "refresh-token-value",
      password: "password-value",
      authorization: "Bearer abc",
      cookie: "session=abc",
      safe: "visible",
    },
  };

  const redacted = redactSecrets(input);
  assert.equal(redacted.accessToken, "[REDACTED]");
  assert.equal(redacted.nested.refresh_token, "[REDACTED]");
  assert.equal(redacted.nested.password, "[REDACTED]");
  assert.equal(redacted.nested.authorization, "[REDACTED]");
  assert.equal(redacted.nested.cookie, "[REDACTED]");
  assert.equal(redacted.nested.safe, "visible");

  const serialized = JSON.stringify(redacted);
  for (const secret of [
    "access-token-value",
    "refresh-token-value",
    "password-value",
    "Bearer abc",
    "session=abc",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});
