# Personal learning engine

InboxPilot learns account-specific preferences from explicit corrections and repeated user behavior without modifying the global classifier.

## Inputs

The v1 learning engine accepts typed events for:

- explicit "this is important" / "not important"
- explicit "always archive this sender"
- explicit "never delete this domain"
- manual important/not-important changes
- manual archive / keep-in-inbox / trash
- restoring archived mail
- restoring trashed mail
- replying to senders/threads

Events are tenant/account scoped and idempotent by event ID.

## Explicit rules vs inferred behavior

Explicit commands are strong personal rules:

- `always_archive_sender` creates an explicit sender archive preference
- `never_delete_domain` creates an explicit domain protection preference

Observed behavior is weaker. One restore, archive, trash or reply does not create a permanent rule. Repeated evidence raises confidence.

The engine deliberately **never infers permanent-delete permission** from manual trash/delete-like behavior.

## Learned features

Profiles contain personal features such as:

- sender/domain importance adjustment
- always archive sender
- never delete domain
- avoid archive after repeated restores
- avoid trash after repeated trash restores
- reply affinity for sender/thread

Importance adjustments are bounded so personal history cannot create unbounded scores.

## Separation from global classification

`PersonalLearningEngine.evaluate()` produces a personal overlay. It does not mutate deterministic or semantic classifier weights.

`applyPersonalLearning()` combines the immutable base importance result with that account's overlay and returns a personalized score/priority plus advisory handling.

The base result remains included unchanged for audit/debugging.

## Safety

Personalization recommendations are advisory. They do not call provider mutations and do not bypass the policy/action executor.

`never_delete` is protective only. `always_archive` still requires the normal policy/action execution path.

Repeated manual trash behavior lowers importance but does not create destructive authorization.

## Reset and export

`export()` returns the account's raw personal learning events plus the derived profile.

`reset()` deletes only that tenant/account's personal learning events. After reset, the profile is empty and global classifier behavior remains unchanged.

Production persistence should keep event IDs unique within tenant/account scope and enforce tenant isolation in the database.
