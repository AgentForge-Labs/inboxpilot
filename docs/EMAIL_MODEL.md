# Canonical Email Model

InboxPilot normalizes provider-specific mail data into a stable, versioned domain model before classification, policy evaluation, or automation.

## Schema version

The current model version is `EMAIL_SCHEMA_VERSION = 1`.

Every persisted message and thread includes `schemaVersion`. Stored entities should be wrapped in a `PersistedEnvelope` so future versions can be migrated deterministically. Runtime code rejects future schema versions rather than silently misreading them.

When introducing v2:

1. Add the new v2 fields/types.
2. Add a deterministic v1 → v2 migration in `src/domain/migrations.ts`.
3. Keep the migration side-effect free.
4. Add fixtures for old persisted records.
5. Migrate storage in batches while readers remain backward compatible during rollout.

## Provider mapping contract

Provider adapters may read provider-native structures, but must emit the canonical model before generic application code sees the message.

### Identity

Adapters must generate canonical IDs with `stableCanonicalId` using:

- tenant ID
- InboxPilot account ID
- provider kind
- entity kind
- provider-native stable ID

This makes imports and webhook retries idempotent while preventing accidental ID collisions across tenants or accounts.

Provider IDs remain available inside the `provider` block for reconciliation.

### Folders, labels, and flags

Generic classifier/policy code must use canonical fields only.

- Gmail system labels such as INBOX/TRASH/SPAM map to `mailboxes[].role`.
- Gmail STARRED/IMPORTANT map to canonical flags.
- User-created Gmail labels map to `labels`.
- Outlook folders map to `mailboxes`; importance/flag state maps to canonical flags.
- IMAP/JMAP mailboxes map to `mailboxes`; protocol flags map to canonical flags.
- Provider-only diagnostics may be retained in `providerMetadata`, but generic classifier/policy code MUST NOT branch on that object.

This prevents provider quirks from leaking into retention or AI decisions.

### Headers

Header names are lower-case and values are arrays. Repeated RFC headers are therefore preserved rather than collapsed.

### Attachments

The message model stores attachment metadata and provider-native attachment identity, not attachment bytes. Attachment fetching/extraction is a separate capability.

## Threading strategy

Thread identity is derived in this order:

1. Native provider thread/conversation ID.
   - Gmail: threadId
   - Microsoft Graph: conversationId
   - JMAP: native threadId when available
2. Root RFC `References` message ID.
3. `In-Reply-To`.
4. The message's own RFC `Message-ID`.
5. A bounded subject + sorted participant fallback for legacy imports lacking usable IDs.

The resulting provider thread key is converted into a tenant/account-scoped canonical thread ID with `stableCanonicalId`.

The subject/participant fallback is intentionally last because repeated newsletters and reused subjects can otherwise be incorrectly merged.

## Classification state

Classification is stored separately from provider state. The model supports:

- 0–100 importance score
- priority band
- multiple categories
- confidence
- action/reply-required flags
- risk score
- classifier version
- human-readable reason

An unclassified message is valid and represented explicitly.

## Retention state

Retention state records lifecycle intent independently from mailbox location:

`active → archived → pending_trash → trashed → pending_delete → deleted`

It also carries protection state and scheduled transition timestamps. This is intentionally separate from classification so no AI output can directly imply a destructive provider operation.

## Security/authentication signals

Adapters may normalize available SPF, DKIM, DMARC and transport-security results. Missing signals remain absent rather than being fabricated.

## Provider metadata boundary

`providerMetadata` exists for reconciliation/debugging and opaque adapter data. It is not a generic product API. New classifier or policy behavior must be expressed through canonical fields instead of checking provider-specific metadata.
