# Gmail Connector

InboxPilot uses the Gmail REST API directly for first-class Gmail accounts. Gmail is not routed through generic IMAP.

## OAuth and scopes

The normal connector requests only:

`https://www.googleapis.com/auth/gmail.modify`

This supports reading mail and normal InboxPilot mutations such as labels, archive, trash, restore, star, important and read/unread.

Permanent Gmail deletion is intentionally disabled by default. Enabling it changes authorization to the broader:

`https://mail.google.com/`

The UI/API must treat that as an explicit high-risk opt-in and require reauthorization when the broader scope was not previously granted.

Refresh/access credentials are written through `GmailCredentialStore`. The connector never defines a plaintext persistence mechanism; production must bind this interface to the encrypted credential vault.

## Initial sync and reconciliation

`syncChanges()` has two modes:

1. No cursor: Gmail `messages.list` backfill with bounded pages, then captures the current profile `historyId`.
2. History cursor: Gmail `history.list` from the previous cursor and fetches changed messages.

Paging state is encoded as an opaque cursor so generic workers never need Gmail page/history semantics.

Duplicate message IDs inside history records are collapsed. Messages that disappear before fetch are returned as deleted provider IDs.

## Push/watch

`watchPush(topicName)` registers Gmail push delivery to a configured Google Cloud Pub/Sub topic. The returned expiration must be renewed by the background webhook-renewal worker.

Pub/Sub push payloads contain a base64 JSON body with `emailAddress` and `historyId`. The connector parses this notification, but the worker should reconcile from its **previous persisted history cursor** rather than treating the notification as the complete change set.

This guarantees eventual reconciliation if a push event is duplicated or missed.

## Canonical normalization

Gmail resources are converted to `CanonicalMessage` / `CanonicalThread`:

- Gmail message/thread IDs become tenant/account-scoped canonical IDs.
- Gmail system labels map to canonical folders/flags.
- user/system label IDs remain available as canonical labels.
- MIME text/html parts become canonical body content.
- attachment metadata is normalized without automatically downloading bytes.
- Message-ID, sender/recipients and auth results are normalized from RFC headers.
- SPF/DKIM/DMARC signals are captured where Gmail exposes Authentication-Results.

## Actions

Supported actions:

- archive → remove `INBOX`
- move → add target Gmail label and remove `INBOX`
- trash → Gmail trash endpoint
- restore → Gmail untrash endpoint
- add/remove label
- mark important/unimportant
- star/unstar
- mark read/unread
- permanent delete only when the connector was explicitly created with that capability

## Retry behavior

The REST client retries Gmail HTTP 429 and 5xx responses with bounded exponential backoff and honors numeric `Retry-After` seconds.

A single HTTP 401 triggers one forced OAuth refresh before failure is surfaced. Secrets/tokens are never included in connector error messages.

## Disconnect

Disconnect attempts to stop Gmail watch delivery, revokes the stored Google token, deletes the credential-store record and marks the adapter disconnected. Token removal is attempted even if stopping the watch fails.
