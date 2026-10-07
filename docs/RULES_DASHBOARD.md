# Rules dashboard

InboxPilot rules can be managed directly by the product dashboard without ChatGPT.

## Conditions

Rules support:

- sender
- domain
- classifier category
- importance-score threshold/range

Score operators are `lt`, `lte`, `gt`, `gte` and `between`.

## Actions

Rules support:

- Always Important
- Never Delete
- Archive after N days
- Delete after N days
- Keep indefinitely

This directly supports patterns such as:

- always mark a sender important
- never delete a domain
- archive newsletters after N days
- delete promotions after N days
- keep receipts indefinitely
- apply an action to messages above/below a score threshold

Delete-after rules require an explicit destructive acknowledgement when created or changed. Delete delay must be at least one day.

## Precedence

Rules may overlap. Resolution is deterministic:

1. Never Delete / Keep indefinitely suppress destructive retention rules.
2. More specific match wins: sender > domain > category > score.
3. Higher user rule priority wins within the same specificity.
4. If otherwise equivalent archive/delete rules conflict, archive wins as the less destructive action.
5. Always Important is independent and can coexist with retention/protection rules.

Every resolution returns matched rules, applied rules, explanations and explicit conflicts with winner/loser IDs.

## Policy integration

Immediate sender/domain Always Important and protection rules compile into the existing policy-engine override contract.

Category, score and delayed retention rules remain resolver-managed. They are deliberately not converted into immediate archive/trash policy overrides because doing so would silently discard their delay or broader condition semantics.

## Dashboard and preview

The dashboard lists normalized condition/action labels, precedence, enabled state and affected-message count.

Preview evaluates the selected rule against current account messages, including disabled rules, and shows whether that rule would actually be effective after conflict resolution.

Preview rows contain message identity, sender, subject, received date, score and categories. Bodies, HTML and raw headers are not exposed.

CRUD uses optimistic rule revisions, preventing stale dashboard edits from silently overwriting newer changes.
