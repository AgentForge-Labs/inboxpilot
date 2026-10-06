# Mailbox onboarding and provider discovery

Issue #10 establishes the backend/domain contract for the dashboard onboarding flow. The visual dashboard itself is implemented by the dashboard epic and consumes these exported types/services.

## Entry screen

The onboarding surface exposes four explicit choices:

- Connect Google
- Connect Microsoft
- Connect another email
- Connect local mailbox

Google and Microsoft route directly to their OAuth connectors.

"Connect another email" always attempts discovery before advanced server fields are shown.

## Discovery order

For a generic email address InboxPilot:

1. validates and normalizes the email/domain
2. checks known provider presets for common consumer providers
3. resolves MX and recognizes Google Workspace / Microsoft 365 hosted domains
4. checks RFC-style IMAP/Submission SRV records
5. falls back to the advanced setup screen only when no safe configuration was discovered

DNS errors do not block onboarding; they reduce the result to advanced/manual setup.

Discovery never requires the user's mailbox password.

The default implementation intentionally performs DNS discovery only. It does **not** fetch arbitrary autoconfig URLs from user-controlled domains, avoiding an SSRF-capable onboarding primitive. A future hardened egress/autoconfig service can implement additional discovery behind the same contract.

## Generic provider behavior

Detected Google or Microsoft hosting redirects to the matching OAuth flow rather than requesting IMAP credentials.

Detected JMAP presets return the known JMAP session endpoint.

Detected IMAP returns host, port, TLS mode, username and recommended authentication mode. Submission details are exposed as discovery metadata for the outbound SMTP epic but are not activated by this issue.

When no provider is found, the wizard shows advanced IMAP setup.

## Advanced IMAP safety

Manual IMAP profiles:

- require a hostname, not localhost or a literal IPv4 address
- require a valid TCP port
- require implicit TLS or STARTTLS
- enable certificate verification
- do not accept normal account-password auth during onboarding
- support OAuth2 or app-password mode
- never contain the actual password/token value

Credential collection/persistence is connected to the encrypted credential vault in issue #11.

## Local mailbox onboarding

Local Maildir/mbox profiles default to:

- read-only
- destructive actions disabled

Destructive local operations may only be selected when writable mode is explicitly enabled. Filesystem path enforcement remains the responsibility of the local mailbox adapter's allowed-root validation.

## Connection health DTO

`buildConnectionHealth()` gives the dashboard a provider-neutral status model:

- healthy
- syncing
- degraded
- reauth_required
- disconnected

It includes granted OAuth scopes, last sync, last successful sync, the current error if any, and valid UI actions such as Re-authorize, Retry sync, Disconnect or Reconnect.

Provider-specific secrets and token values are never part of the health view.
