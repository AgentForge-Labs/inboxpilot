# Incremental ingestion pipeline

InboxPilot ingestion runs independently from MCP conversations. Provider notifications wake a background worker; they are never treated as authoritative mailbox state.

## Wake-up sources

Supported signal sources are:

- Gmail watch / Pub/Sub
- Microsoft Graph change notifications
- IMAP IDLE
- JMAP change-state notifications when available
- Maildir filesystem watcher
- scheduled reconciliation
- initial sync

Provider hints such as Gmail history IDs or JMAP states are stored only as signal metadata. The durable provider cursor comes exclusively from the adapter's `syncChanges()` result.

This means duplicate and out-of-order webhook events cannot move the durable cursor backwards.

## Reconciliation flow

For one account/provider:

1. Deduplicate an already completed signal.
2. Acquire an account-scoped ingestion lease.
3. Resolve an already connected provider adapter.
4. Load the durable sync cursor.
5. Call `syncChanges(cursor)` in bounded pages.
6. Validate every canonical message belongs to the same tenant/account/provider.
7. Atomically persist provider changes and the resulting cursor.
8. Continue while `hasMore=true`.
9. Mark the wake-up signal processed only after all pages succeed.

If another event arrives while the account lease is held, it is coalesced. The active reconciliation already asks the provider for all changes after the durable cursor.

## Persistence contract

`IngestionRepository.commitBatch()` is the transaction boundary. Production persistence must apply message upserts, provider tombstones and cursor advancement in one database transaction with compare-and-swap semantics on the expected cursor.

The in-memory implementation mirrors this behavior for tests.

Canonical message IDs and provider IDs are uniqueness boundaries. Re-ingesting an identical provider state is an unchanged upsert rather than a duplicate row.

Provider updates preserve InboxPilot-owned classification and retention state. A provider refresh must not reset a previously classified or protected message back to defaults.

Tombstones are stored separately from the normalized message. This prevents a provider-specific removal event from being confused with InboxPilot retention deletion. If a batch contains both an older tombstone and a live message for the same provider ID, the live message wins.

## Cursor safety

A page reporting `hasMore=true` must return a different next cursor. The pipeline aborts rather than loop on a non-advancing provider cursor.

A cursor is never taken from a webhook payload. Gmail history notifications, Microsoft message IDs, JMAP state hints, IDLE notifications and filesystem events only cause reconciliation from the last committed cursor.

A failed batch does not mark its signal processed, allowing a retry or scheduled reconciliation to recover it.

## Scheduled fallback

Push systems are not assumed to be perfectly reliable. `ReconciliationPlanner` generates recurring fallback signals even for providers with push support.

Default fallback intervals are intentionally conservative:

- Gmail / Microsoft Graph: 15 minutes
- IMAP / JMAP: 10 minutes
- Maildir: 5 minutes
- mbox / other: 15 minutes

These are worker defaults and can be overridden by deployment configuration.

## Provider integrations

Gmail uses the connector's watch registration and history cursor. Microsoft Graph uses subscriptions as wake-ups and delta cursors for authoritative sync. IMAP IDLE is wrapped by `ImapIdleWakeupSource`; after IDLE returns, the worker calls the normal sync path. JMAP uses its persisted Email state with `Email/changes`. Maildir filesystem events are wrapped by `MaildirWakeupSource` and followed by a rescan.

Long-lived worker lifecycle, distributed queues and production database implementations are intentionally separate from this domain layer and are covered by the background-worker/platform work. The ingestion API itself has no MCP-session dependency.
