# Microsoft 365 / Outlook Connector

InboxPilot uses Microsoft Graph directly for Outlook and Microsoft 365 mailboxes. Basic Authentication is not used.

## OAuth

The connector requests delegated scopes:

- `offline_access`
- `User.Read`
- `Mail.ReadWrite`

Refresh and access tokens are persisted only through `MicrosoftCredentialStore`, which production must bind to the encrypted credential vault.

An OAuth `invalid_grant`, `interaction_required`, or `consent_required` result is surfaced as `MicrosoftReauthorizationRequiredError` and stale stored credentials are removed.

## Delta synchronization

`syncChanges()` uses Microsoft Graph message delta for the configured folder, defaulting to Inbox.

Graph `@odata.nextLink` and `@odata.deltaLink` values are encoded into opaque InboxPilot cursors. Generic workers never inspect Graph delta semantics.

Removed delta entities become `deletedProviderMessageIds`; live entities are normalized into `CanonicalMessage`.

The adapter supports one configured delta folder per instance. Workers that need several folders should keep one delta cursor per folder/adapter instance.

## Change notifications

`createSubscription()` creates a Microsoft Graph subscription for created, updated, and deleted message changes. Notifications are wake-up signals; workers must still reconcile using the persisted delta cursor to tolerate duplicate or missed notifications.

## Folders and conversations

Top-level mail folders are discovered through Graph and normalized into InboxPilot folder roles where a well-known display name can be recognized.

Graph `conversationId` becomes the provider thread identity. `getThread()` queries all messages in that conversation and returns a canonical thread.

## Actions

Supported mutations:

- archive → move to well-known `archive`
- move → Graph destination folder ID
- trash → move to `deleteditems`
- restore → move to `inbox`
- mark important/unimportant → Graph `importance`
- star/unstar → Graph follow-up flag
- mark read/unread → Graph `isRead`

Permanent deletion is not advertised by this adapter.

## Reliability

HTTP 429, 503, and other 5xx responses use bounded exponential backoff and honor numeric `Retry-After` values. A 401 triggers one forced token refresh before authorization failure is surfaced.

## Disconnect

Disconnect removes the locally stored Microsoft credentials and marks the adapter disconnected. Microsoft account-side consent revocation remains an account/provider operation and is not simulated by deleting a local token.
