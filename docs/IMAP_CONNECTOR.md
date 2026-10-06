# Generic IMAP Connector

InboxPilot uses IMAP for providers that do not have a first-class Gmail or Microsoft Graph adapter.

## Security and authentication

TLS is mandatory by account configuration:

- `implicit` uses TLS from connection start (typically port 993).
- `starttls` requires a STARTTLS upgrade before authentication.

Certificate validation defaults to enabled.

Credentials are loaded through `ImapCredentialStore`; the connector does not persist secrets itself and disables ImapFlow logging/raw protocol logs.

Supported auth modes:

- OAuth2/XOAUTH2 via an access token.
- App passwords.
- Normal account password only when `allowPasswordAuth` is explicitly enabled for that provider/account.

Production must bind the credential store to the encrypted secret vault.

## Stable message identity

IMAP UIDs are only stable inside one mailbox and one UIDVALIDITY epoch. InboxPilot therefore encodes provider message identity as:

`mailbox + UIDVALIDITY + UID`

A stored message reference is rejected if the mailbox UIDVALIDITY has changed.

## Incremental synchronization

The opaque sync cursor contains:

- mailbox path
- UIDVALIDITY
- last processed UID

Normal polls fetch UIDs above the cursor.

When UIDVALIDITY changes, the cursor is treated as stale and the mailbox is reconciled from the beginning of the new UID epoch. This avoids incorrectly reusing old UIDs for new messages.

`reconcile()` uses the same idempotent sync path and is intended to be scheduled periodically even when IDLE is active.

## IDLE

`waitForIdleChange()` opens the configured mailbox and enters IMAP IDLE. ImapFlow falls back to its configured polling behavior when IDLE is unavailable. IDLE is a wake-up signal; callers must run `syncChanges()` afterwards rather than treating the notification as message state.

## Folder mapping

IMAP SPECIAL-USE flags map to canonical mailbox roles:

- `\\Inbox`
- `\\Archive`
- `\\Sent`
- `\\Drafts`
- `\\Trash`
- `\\Junk`

Configured inbox/archive/trash paths are used when the server does not advertise SPECIAL-USE.

## Actions

Supported generic IMAP actions:

- move
- restore to configured Inbox
- archive when an archive mailbox is configured
- trash when a trash mailbox is configured
- mark read/unread using `\\Seen`
- star/unstar using `\\Flagged`
- mark important/unimportant using the `$Important` keyword

Permanent delete is deliberately not exposed by this adapter.

Archive and Trash capabilities are not advertised when the corresponding destination folder is not configured.

## Threading

Generic IMAP does not guarantee a server thread identifier. InboxPilot uses a native thread ID only when exposed by the server, otherwise RFC `References`, `In-Reply-To`, and `Message-ID` are used to create a canonical thread identity.

The adapter does not advertise random-access `getThread` because reconstructing an arbitrary thread on generic servers may require a mailbox-wide search. Ingested messages still receive canonical thread IDs and can be grouped by the InboxPilot storage layer.
