# LLM semantic classifier

The semantic classifier runs only after the deterministic importance engine says semantic analysis is required.

## Routing

`SemanticClassifier.classify()` first evaluates `scoreDeterministicImportance()`.

If deterministic evidence is already strong enough, the model is not called. Ambiguous, conflicting or weak evidence is routed to the semantic model.

## Structured output

Every model response is validated with `parseClassifierResult()` from the v1 classifier contract.

Unknown fields, invalid score ranges, unknown categories, malformed retention recommendations or inconsistent importance/priority combinations are rejected.

Raw model output never reaches the action executor. Even a valid `recommendedAction=trash` remains advisory; destructive authorization is still performed by policy/action layers.

## Prompt and context bounds

The prompt treats email bodies and prior thread content as untrusted data.

The model receives:

- current subject/from/to/cc
- bounded text body/snippet
- attachment metadata only, never attachment bytes
- authentication signals
- bounded recent thread context
- deterministic classifier hints
- the strict JSON schema

Body and thread budgets are configurable and capped. Long values are truncated with an explicit marker.

## Confidence gating and fallback

Responses below `confidenceThreshold` are not accepted as final high-confidence classification.

The runtime can:

1. retry the primary model a bounded number of times
2. use an optional fallback model
3. keep the best valid low-confidence result
4. return `needs_review` if no response clears the confidence threshold
5. return a failed/reviewable classification if no valid structured response is produced

## Cost and quota accounting

Model attempts emit cost telemetry containing:

- model
- primary/fallback phase
- attempt
- input/output tokens
- configured estimated cost
- success / low-confidence / invalid-output / error outcome

Customer usage is separately keyed by unique provider-message identity. A message is charged at most once even if semantic inference retries or falls back to another model.

## Batching

`classifyMany()` batches semantic candidates when the model client exposes `completeBatch()`.

Only messages that actually require semantic classification enter the batch. Batch size is bounded. Invalid or low-confidence batch results fall back to the normal per-message retry/fallback path.

## Prompt injection

The system instruction explicitly states that email content is data, not executable instructions. Mail content cannot authorize browsing, sending email, reading secrets or mailbox mutations.
