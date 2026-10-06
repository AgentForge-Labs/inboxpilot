# Pending Delete review queue

InboxPilot exposes a review queue for messages that are still inside an active retention-deletion lifecycle.

## Queue contents

Each row is projected from the current canonical message plus the durable retention job. No duplicate email copy is maintained.

Rows show:

- sender/name
- subject
- received date
- importance score and priority
- categories
- classification explanation
- matched retention policy/rule ID
- scheduled Trash date
- scheduled permanent-delete date when InboxPilot has an explicit permanent-delete path
- provider-managed expiry date where the provider controls Trash expiry

Only active scheduled or provider-managed deletion jobs are shown.

## Schedule projection

When the next job stage is Archive, the projected Trash date is the archive due time plus the configured archive-retention delay.

When the next stage is Trash, the job due time is the Trash date.

When explicit permanent deletion is enabled and supported, the projected permanent-delete date is the Trash date plus the configured Trash-retention delay, or the current delete-stage due time.

Provider-managed expiry is kept separate from InboxPilot permanent deletion so the UI never misrepresents provider behavior as an InboxPilot delete action.

## Review actions

### Keep

Keep cancels the active deletion schedule.

If the message is already in provider Trash or under provider-managed Trash expiry, Keep first restores it out of Trash so cancelling the local job cannot leave it exposed to provider expiry.

### Restore to Inbox

A trusted user-confirmed Restore action is executed through the existing provider-safe action executor. The retention job is then cancelled and canonical retention state returns to active.

### Never delete sender/domain

These actions create explicit personal-learning protection features:

- sender -> `never_delete_sender`
- domain -> `never_delete_domain`

The current retention job is cancelled. If the message is already in Trash, it is restored first.

This makes the protection effective for future policy evaluations rather than merely cancelling one job.

### Change rule

The queue returns an `edit_rule` intent containing the matched `policyId`. The rules UI can open that exact rule without Pending Delete implementing a second rule engine.

### Delete now

Delete Now is available only when the durable retention job's current next stage is already destructive:

- Trash
- permanent delete, when explicit permanent-delete configuration and provider capability allow it

It cannot skip an Archive stage and jump directly to deletion.

The action requires actor ID plus a user-confirmation ID, records an `expedited_by_user` retention audit event, reuses normal retention policy revalidation, safeguards and provider-safe action execution, and only advances the current retention stage.

## Safety

Pending Delete never bypasses:

- Never Auto Delete safeguards
- Shadow Mode retention gating
- retention policy revalidation
- provider capabilities
- protected-message preconditions
- action idempotency

The queue is tenant/account scoped.
