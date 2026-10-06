# Seven-day Shadow Mode

Every mailbox automation account starts in Shadow Mode for seven full days before archive/trash automation can run.

## Account lifecycle

The automation state is account-scoped:

- `shadow`: the seven-day learning/review window is still running
- `review_ready`: seven days have elapsed; automation is still disabled
- `enabled`: the user explicitly reviewed the preview and selected Enable Automation

The transition from `shadow` to `review_ready` is automatic. The transition to `enabled` is never automatic.

`ShadowModeService.startAccount()` should be called when the mailbox account is persisted/connected. As a fail-closed fallback, any account first seen by the Shadow Mode service without state is initialized into a fresh seven-day Shadow Mode period.

## Policy preview versus execution

`ShadowModePolicyCoordinator` always runs the normal mailbox policy engine first. The resulting action is therefore the real intended action under the account's current thresholds, safeguards, provider capabilities and plan entitlements.

During `shadow` and `review_ready`:

- mark-important plans may remain executable because they are non-destructive and do not remove mail from the inbox
- archive plans are retained as intended plans but not executed
- trash plans are retained as intended plans but not executed

Once the account is explicitly enabled, archive/trash plans can be exposed as executable plans.

The original `PolicyDecision` and intended plan are preserved for explainability.

## Preview observations

While automation is not enabled, every evaluated message is stored as a latest observation keyed by provider-message identity.

Re-evaluating or retrying the same message replaces its previous observation instead of increasing dashboard counts.

The dashboard exposes:

- Critical
- Important
- Normal
- Low
- Would Archive
- Would Delete

For the compact dashboard, Low includes classifier priorities `low`, `very_low` and `disposable`.

Would Archive and Would Delete are calculated from policy-generated archive/trash plans, not directly from the raw classifier recommendation. A safeguard-blocked deletion therefore does not appear as a deletion the system would actually perform.

## Enable Automation

After seven days, the account becomes `review_ready`.

`enableAutomation()` requires:

- the seven-day period to have completed
- an explicit review acknowledgement
- an actor ID

Early enable attempts are rejected. Merely reaching the end of seven days does not enable mailbox mutations.

The transition is audited with actor and timestamp.

## Retention defense in depth

`ShadowModeRetentionPolicyRevalidator` can wrap the normal retention revalidator.

If a delayed retention job somehow exists while an account is still in `shadow` or `review_ready`, Trash and permanent-delete stages are blocked before the underlying retention policy is evaluated.

This is defense in depth; the normal Shadow Mode policy coordinator suppresses archive/trash automation before a new retention flow should begin.

## Persistence

The store contract persists:

- account Shadow Mode state and revision
- latest per-message preview observations
- Shadow Mode audit events

The included in-memory store is a reference/test implementation. Production storage should enforce unique tenant/account state, compare-and-swap revisions and a unique latest observation per tenant/account/provider-message identity.
