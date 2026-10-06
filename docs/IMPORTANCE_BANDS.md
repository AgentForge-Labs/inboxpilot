# Importance score bands and dashboard thresholds

InboxPilot uses one canonical 0–100 importance-settings model for score display and automation thresholds.

## Default importance bands

The shipped defaults are:

| Score | Band |
| --- | --- |
| 90–100 | Critical |
| 75–89 | Important |
| 50–74 | Normal |
| 30–49 | Low Priority |
| 10–29 | Very Low |
| 0–9 | Disposable |

Band boundaries are strictly ordered and configurable per mailbox/account. Changing the Important boundary therefore changes the Important band itself rather than creating a second conflicting threshold.

## Automation markers

The dashboard editor exposes three primary markers on the same 0–100 scale:

- Important at or above: default 75
- Archive below: default 45
- Auto-delete below: default 20

Auto-delete means eligibility for the safe automated retention/trash flow. It does not mean permanent deletion.

Ordering is validated:

- auto-delete must be at or below archive
- archive must be below the Important boundary
- all values must be integer scores from 0 through 100

Invalid drag/update requests are rejected before persistence.

## Visual editor contract

`buildImportanceBandEditorViewModel()` returns framework-independent UI data:

- six contiguous segments covering 0–100
- label, minimum and maximum for every band
- segment start/end/width percentages
- Important, Archive and Auto-delete marker positions
- current validated settings

The dashboard implementation can render this as a slider/band editor without reproducing business rules in frontend code.

`moveImportanceThresholdMarker()` and `moveImportanceBandBoundary()` are safe preview/update primitives used by the UI.

## Persistence

`ImportanceSettingsStore` is tenant/account scoped and revisioned.

Updates use optimistic concurrency. A stale dashboard tab receives `ImportanceSettingsConflictError` instead of overwriting a newer configuration.

`reset()` restores the shipped defaults while incrementing the revision.

The included in-memory implementation is a reference/test store; production persistence should enforce tenant/account uniqueness and compare-and-swap on revision.

## Classifier and policy integration

`priorityForImportanceScore(score, settings)` and `priorityForScoreWithSettings()` use the same band configuration.

`policyThresholdsFromImportanceSettings()` projects the saved dashboard settings into policy thresholds:

- Important boundary -> mark-important threshold
- Archive marker -> archive threshold
- Auto-delete marker -> safe trash/retention threshold
- confidence setting -> confidence gate

The policy engine accepts `importanceSettings` directly, so saved dashboard settings affect policy decisions without duplicated threshold constants.
