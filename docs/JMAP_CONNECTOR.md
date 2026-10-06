# JMAP Provider Adapter

InboxPilot supports standards-based mail providers exposing JMAP Core and JMAP Mail.

## Session discovery and authentication

A configured JMAP session URL is fetched with a bearer access token obtained from `JmapCredentialStore`.

The session must advertise:

- `urn:ietf:params:jmap:core`
- `urn:ietf:params:jmap:mail`
- a primary mail account

The connector keeps the provider API URL and account ID from the session document. Access tokens are never embedded in connector configuration or logs.

## Initial and incremental synchronization

Initial sync uses:

1. `Email/query` with a bounded page.
2. `Email/get` for the returned IDs.
3. The `Email/get` state becomes the durable change cursor after the initial query pages are exhausted.

The initial query cursor contains only an opaque page position.

Incremental sync uses `Email/changes` with the persisted Email state. Created and updated IDs are fetched through `Email/get`; destroyed IDs are returned as provider deletions.

If the server returns `cannotCalculateChanges`, InboxPilot safely falls back to a fresh bounded `Email/query`. Canonical IDs make re-ingestion idempotent.

## Mailbox mapping

`Mailbox/get` maps standard JMAP roles into canonical mailbox roles:

- inbox
- archive
- sent
- drafts
- trash
- junk → spam

Unknown or custom roles remain `custom`.

The adapter discovers mailboxes during connect, so its capability map can disable Archive, Trash, or Restore when the corresponding standard mailbox role is missing.

Read-only JMAP accounts automatically disable all mutation capabilities.

## Normalization

JMAP Email objects become `CanonicalMessage` objects using:

- native JMAP Email ID
- native JMAP Thread ID
- mailbox memberships
- standard keywords such as `$seen`, `$flagged`, `$draft`, `$answered`, and `$important`
- text/html body values
- attachment metadata
- Message-ID / References / In-Reply-To
- Authentication-Results and Received header properties when returned

`Thread/get` plus `Email/get` provides canonical thread retrieval.

## Actions

JMAP mutations use `Email/set`:

- move → replace mailbox membership with destination mailbox
- archive → Archive role
- trash → Trash role
- restore → Inbox role
- read/unread → `$seen`
- star/unstar → `$flagged`
- important/unimportant → `$important`

Existing keywords are preserved when changing one keyword.

Permanent deletion is deliberately not exposed by this adapter.

## Credential lifecycle

Disconnect clears in-memory session/account/mailbox state. Credential deletion is optional and goes through `JmapCredentialStore`.
