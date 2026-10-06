# Mailbox policy engine

The policy engine is the mandatory boundary between classification and mailbox mutation.

Classifier output is advisory. It never calls provider methods and it never becomes executable until the policy engine produces an explicit MailboxActionPlan.

## Inputs

Policy evaluation includes canonical message state, validated classifier output, classifier confidence, user thresholds, protected categories, retention protection, sender/domain overrides, personal-learning signals, product-plan capabilities and provider capabilities.

## Precedence

Safety and explicit policy are evaluated in this order:

1. Terminal retention state.
2. Protected retention or protected category.
3. Explicit sender/domain overrides.
4. Personal never-delete, always-archive and restore-derived avoidance signals.
5. Needs-review and confidence gates.
6. Importance/archive/trash thresholds plus classifier recommendation.
7. Product-plan and provider capability checks.

Protected mail wins over archive/trash overrides.

## Default thresholds

Important starts at 75. Archive applies at 45 or below. Trash applies at 20 or below. Minimum classifier confidence is 0.80.

Custom thresholds are validated so trash is never broader than archive and archive remains below the important threshold.

## Protected categories

The initial protected set is finance, invoice, receipt, security, legal, government, appointment and travel.

Protected messages are not automatically archived or trashed. High-importance protected mail may still receive the non-destructive mark-important action when the plan and provider permit it.

## Destructive automation

The policy engine never emits permanent-delete actions.

Automatic trash requires an unprotected message, an eligible policy decision, product-plan entitlement, provider support and an explicit policy ID. The generated plan carries policy-based destructive authorization plus stale-message preconditions.

The separate action executor re-checks the plan, current message state and authorization before mutating the provider.

When trash is recommended but unavailable, policy may fall back to archive if archive is allowed and no personal avoid-archive signal exists.

## Idempotency

Policy plan IDs are deterministic over policy ID, message identity/version, selected action, effective personalized score and classifier confidence. The existing action-plan idempotency key is then derived from that plan.

Re-evaluating unchanged inputs produces the same executable intent.

## Personal learning

Personal importance adjustments affect only the effective policy score. They do not change global classifier weights.

Never-delete blocks automatic trash. Always-archive can request archive. Avoid-archive and avoid-trash suppress inferred automation. Personal behavior never grants permanent-delete permission.

## Capability separation

Product-plan capabilities and provider capabilities are checked independently. Provider support does not grant unattended automation entitlement, and a paid entitlement does not imply that every provider supports the operation.
