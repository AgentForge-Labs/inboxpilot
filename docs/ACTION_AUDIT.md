# Action audit and explainability

InboxPilot keeps a body-free audit trail for automated and manual decisions.

## Two audit layers

The existing action-execution store remains the low-level mutation/retry ledger.

The explainability audit is the customer/operator-facing decision timeline. It links decisions and execution through:

- policy ID
- plan ID
- idempotency key
- canonical message ID
- provider message ID

This keeps retry telemetry separate from the explanation of why a message was classified or moved.

## Policy decision events

A policy decision event records:

- tenant/account
- canonical and provider message identity
- classifier model version
- importance score and priority
- categories and confidence
- classifier reason
- recommended action
- action/reply requirements
- spam/phishing risk
- deterministic signal codes/weights/reasons when supplied
- Never Auto Delete safeguard reasons
- matched policy and override
- policy outcome/reasons
- requested action/plan
- actor and timestamp

Shadow Mode records the original policy outcome but uses audit outcome `suppressed` when archive/trash execution is intentionally withheld.

## Action execution events

When configured with an `ExplainabilityAuditRecorder`, the provider-safe action executor records:

- requested and executed action
- actor
- plan/idempotency identity
- body-free before state
- body-free after state, unavailable state, or deleted state
- success/deduplicated/failure outcome
- attempts
- sanitized failure information

The state snapshot contains only mailbox IDs/roles, labels, flags, retention metadata and message identity. It never contains the message body, HTML, headers or attachments.

## Manual decisions

Pending Delete controls can emit manual decision events for:

- Keep
- Restore to Inbox
- Never Delete sender
- Never Delete domain
- Change Rule
- Delete Now

These events retain the matched retention policy and actor and may include safe operational metadata such as the confirmation ID or retention outcome.

## Sensitive-data boundaries

The explainability event schema does not expose message body, HTML, raw MIME, headers, attachments or credential fields.

Before persistence, `sanitizeAuditEvent()`:

1. redacts Bearer-like credentials, JWT-looking values and secret assignments inside permitted text fields
2. bounds free-form classifier/signal/error text
3. rejects forbidden sensitive field names anywhere in the event tree

Classifier reason is deliberately retained because it is required for explainability, but the canonical message body is never passed into the audit event builder.

Production stores should preserve this typed contract instead of persisting arbitrary logger payloads.

## Queries and dashboard

The audit store supports:

- account timeline
- message timeline
- plan timeline

The dashboard view model exposes actor, classifier summary, matched rule, requested/executed action, outcome, reasons/signals and mailbox-state transition.

Production persistence should index tenant/account/timestamp, tenant/account/provider-message ID, and plan ID.
