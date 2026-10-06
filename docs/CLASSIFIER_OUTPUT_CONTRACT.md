# Canonical classifier output contract

InboxPilot classifier implementations return a versioned, provider-neutral result before any policy or mailbox action is evaluated.

## Required result

`CanonicalClassifierResult` contains:

- `importanceScore`: integer 0–100
- `priority`: deterministic bucket derived from the importance score
- one or more classifier categories
- `actionRequired`
- `replyRequired`
- `spamRisk`: integer 0–100
- `phishingRisk`: integer 0–100
- `confidence`: 0–1
- `recommendedAction`
- retention recommendation
- human-readable `reason`
- optional classifier/model version

The runtime validator rejects unknown fields. This keeps structured model output bounded and prevents arbitrary generated properties from becoming implicit product behavior.

## Priority mapping

Importance maps deterministically:

| Score | Priority |
| --- | --- |
| 90–100 | critical |
| 75–89 | important |
| 50–74 | normal |
| 30–49 | low |
| 10–29 | very_low |
| 0–9 | disposable |

A result whose supplied priority does not match its score is rejected.

## Initial multi-label vocabulary

The v1 category vocabulary is:

`personal`, `work`, `customer`, `finance`, `invoice`, `receipt`, `security`, `legal`, `government`, `appointment`, `travel`, `shopping`, `delivery`, `newsletter`, `promotion`, `social`, `notification`, `system`, `spam`, `phishing`.

A message may have several unique categories. Unknown categories are rejected by contract v1 instead of silently entering policy evaluation.

## Recommended action is not authorization

`recommendedAction` is one of:

- `keep_in_inbox`
- `mark_important`
- `archive`
- `trash`
- `needs_review`

This field is **advisory only**. It must never call a provider mutation directly. The policy engine and provider-safe action executor remain the authorization boundary, including protected-message and destructive-action checks.

## Retention recommendation

The classifier may recommend:

- `keep`
- `archive`
- `trash_later`
- `protect`

Retention includes a `protected` boolean and explicit protection reasons. `protect` requires `protected=true`. Protected recommendations require at least one reason.

`archiveAfterDays` is accepted only for `archive`; `trashAfterDays` only for `trash_later`. The classifier contract intentionally has no permanent-delete recommendation.

## Risk and confidence

Spam and phishing are independent 0–100 risk values, not replacements for categories. A message can therefore be both `invoice` and `phishing`, for example.

When converted into the existing `ClassificationState`, `riskScore` is the maximum of spam and phishing risk so existing storage remains compatible while the canonical result retains both signals.

## Structured-output schema

`CLASSIFIER_OUTPUT_JSON_SCHEMA` mirrors the model-facing JSON shape with `additionalProperties=false` and bounded enums/ranges. Future LLM and conventional classifiers should validate their output with `parseClassifierResult()` before persistence or policy evaluation.
