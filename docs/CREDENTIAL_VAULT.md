# Encrypted credential vault

InboxPilot stores OAuth tokens and mailbox secrets behind a provider-neutral encrypted vault.

## Envelope encryption

Each secret record receives a fresh 256-bit data-encryption key (DEK).

- Secret JSON is encrypted with AES-256-GCM.
- Tenant ID, account ID and secret name are authenticated as additional data.
- The DEK is wrapped by a key-encryption provider (KEK/KMS).
- Persistent storage receives only ciphertext, IV/auth tags, wrapped DEK and the wrapping-key ID.

The normal application database never needs the KEK and never stores plaintext access tokens, refresh tokens, app passwords or mailbox passwords.

`DataKeyWrapper` is the production integration boundary for AWS KMS, Google Cloud KMS, Azure Key Vault, Vault Transit, HSM or an equivalent managed key service. `InMemoryAesKeyWrapper` exists for tests/development and must not be used as a production key-management service.

## Tenant and service isolation

Every vault operation requires a `VaultPrincipal` containing:

- service identity
- allowed operations: read/write/delete/rotate
- allowed tenant IDs
- optional allowed account IDs

Authorization occurs before storage/decryption. A connector worker can therefore receive read/write access only to the tenant/account it currently serves, while a rotation worker can receive rotate-only access.

Vault audit events contain metadata only: service ID, operation, tenant/account, logical secret name, outcome and timestamp. They never contain secret values or decrypted payloads.

## Provider credential stores

Vault-backed adapters implement the existing connector contracts:

- `GmailVaultCredentialStore`
- `MicrosoftVaultCredentialStore`
- `ImapVaultCredentialStore`
- `JmapVaultCredentialStore`

Logical secret names are stable and scoped by tenant/account. Future SMTP/POP3/provider-specific secrets can use the same vault API without adding plaintext columns.

## Rotation

Changing the active KEK does not require re-encrypting the provider credential payload.

`rotateRecord()`:

1. unwraps only the existing DEK
2. wraps that DEK with the current KEK
3. replaces wrapped-key metadata
4. leaves the encrypted secret payload unchanged

`rotateAllFromKey()` rotates only records the caller is authorized to rotate. Old KEKs must remain available until all records using them are rewrapped and verified.

## Revoke/delete

Provider revocation should happen first when supported (for example Google token revoke), then the connector calls its credential store's `delete()`. Vault deletion removes the encrypted record.

Deleting local ciphertext is not a substitute for revoking provider-side OAuth consent/token grants.

## Logging and traces

`redactSecrets()` recursively replaces fields whose names indicate tokens, secrets, passwords, authorization, cookies, credentials, API keys or private keys.

Application logging/tracing should redact structured metadata before export. Connector code must never include raw token/secret values in errors.

## Operational requirements

Production storage should enforce a unique key on `tenant_id + account_id + secret_name`, encrypt backups, restrict DB access, and keep KMS unwrap permission away from normal reporting/admin services.

KMS key material must not live in application configuration or the same database as ciphertext. Rotation and KMS unwrap activity should be auditable independently at the KMS layer.
