# Never Auto Delete safeguards

InboxPilot evaluates a separate safety layer before automated Trash or permanent deletion.

## Default protected categories

The initial Never Auto Delete category set is:

- finance / banking
- government
- legal
- security
- invoice
- receipt
- appointment
- travel

The central constant is `DEFAULT_NEVER_AUTO_DELETE_CATEGORIES`. The mailbox policy engine reuses this default instead of maintaining a second category list.

## Behavioral protections

Category classification is not the only protection source.

The safeguard evaluator also protects:

- trusted/known contacts
- threads the user has previously replied to
- two-factor, OTP and verification-code messages
- password-reset messages
- banking/account/payment context

The security and banking text signals are conservative fallback protections. They do not replace semantic classification.

## Protection reasons

Evaluation returns individual reasons rather than one opaque boolean.

For example a message may simultaneously have:

- `category:finance`
- `contact:person@example.com`
- `thread:replied:<thread-id>`
- `signal:banking`

This makes safety decisions explainable and prevents a narrow exception from accidentally disabling unrelated safeguards.

Existing canonical `retention.protected=true` is non-bypassable by Never Auto Delete overrides.

## Explicit exceptions

Exceptions to a safeguard are treated as dangerous configuration.

Supported override scopes are:

- category
- sender
- domain
- thread
- signal

Creating or changing an override requires an explicit confirmation record containing confirmation ID, actor ID, confirmation timestamp and statement.

A category override suppresses only that category reason. A signal override suppresses only that signal. Sender/domain/thread overrides can suppress matching bypassable reasons for that target.

An override never bypasses canonical retention protection.

## Audit history

Every override creation, enable and disable operation appends an audit event containing:

- tenant/account
- override ID
- scope/key
- action
- actor
- confirmation ID
- timestamp

Production persistence should store override records and audit events durably and append-only for audit history.

## Policy integration

The policy engine accepts a `NeverAutoDeleteEvaluation`.

When present, the centralized evaluation replaces the legacy default category-only check. Explicit custom `protectedCategories` can still add additional policy protection.

A protected evaluation yields the `never_auto_delete_safeguard` policy reason and prevents automatic archive/trash planning under that protected decision.

## Retention integration

`SafeguardedRetentionPolicyRevalidator` wraps the normal retention policy revalidator.

Before every delayed Trash or permanent-delete stage it re-evaluates current contacts, replied-thread context and active overrides. If a Never Auto Delete reason is active, the destructive stage is blocked before the underlying policy revalidator or provider action runs.

This ensures a contact/thread becoming protected after the retention job was originally scheduled is still honored.
