# Retention scheduler

InboxPilot retention cleanup is a delayed, auditable lifecycle. It does not jump directly from classification to permanent deletion.

## Lifecycle

A scheduled cleanup job progresses one durable step at a time:

1. Archive now.
2. Keep the message archived for `archiveRetentionDays`.
3. Re-evaluate current policy.
4. Move the message to provider Trash.
5. Keep it in Trash for `trashRetentionDays`.
6. Re-evaluate current policy again.
7. Permanently delete only when explicit retention configuration still permits it and the provider supports it.

Every call to `RetentionScheduler.run()` performs at most one lifecycle mutation. Archive, Trash and permanent delete therefore cannot collapse into one worker tick.

## Separate due times and transition timestamps

Job fields hold future due times in `nextRunAt`.

Canonical `RetentionState.archiveAt`, `trashAt` and `deleteAt` represent actual successful transition times. This avoids mixing a planned due time with the time a provider operation really happened.

## Destructive-stage policy revalidation

Archive is non-destructive. Before Trash and before permanent delete the scheduler calls `RetentionPolicyRevalidator` with the current canonical message and current job.

If policy no longer allows the action, the job becomes `blocked`; no provider mutation is attempted.

A message that becomes protected also blocks the lifecycle before the next mutation.

Permanent deletion additionally requires `allowPermanentDelete=true` in the durable retention configuration. This is independent of the classifier recommendation.

## Action execution path

The scheduler never calls a provider adapter directly.

It emits trusted `system_retention` MailboxActionPlans and sends them through the existing provider-safe action executor. Destructive plans carry the retention policy ID and `requireUnprotected` precondition.

Permanent-delete plans also require the message to still be in the provider Trash mailbox.

## Restore behavior

`cancelOnRestore()` resets the canonical retention stage to active and cancels the pending retention job.

The scheduler also detects messages restored outside its direct API. If an archived message becomes active before Trash, or a trashed message leaves the retention Trash state before permanent deletion, the pending job is cancelled.

## Provider Trash semantics

`resolveProviderTrashSemantics()` records provider behavior alongside each job.

Gmail is represented as provider-managed Trash expiry with a 30-day provider expiry behavior, while explicit permanent deletion is still used only if the connector capability and retention policy both permit it.

For other providers, explicit permanent delete is used only when the adapter advertises that capability. Without an explicit capability, InboxPilot does not assume that provider Trash means permanent deletion.

If permanent deletion is requested but only provider-managed expiry is available, the job enters `provider_managed`. If no known deletion mechanism exists, the job is blocked instead of pretending the message was deleted.

## Audit

Retention audit events record:

- scheduling
- action planning
- successful archive/trash/delete transitions
- policy blocks
- provider-managed expiry handoff
- restore cancellation
- failures
- completion

Events include tenant/account/message/job identity, action, retention stage, policy reason where relevant, provider Trash behavior and timestamp.

## Durability and concurrency

`RetentionJobStore` uses revision-based compare-and-swap semantics. Production persistence should enforce job version updates atomically and index `status + nextRunAt` for worker pickup.

The in-memory store mirrors the contract for tests.
