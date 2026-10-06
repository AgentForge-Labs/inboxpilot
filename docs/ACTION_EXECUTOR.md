# Provider-safe mailbox action executor

All mailbox mutations from MCP, background automation, retention workers and future UI actions must pass through `ProviderSafeActionExecutor`. Product surfaces must not call provider mutation methods directly.

## Explicit action plans only

The executor accepts a versioned runtime-validated action plan. Trusted plan sources are:

- `policy_engine`
- `user_confirmed`
- `system_retention`
- `mcp_explicit`

Raw LLM output is not a valid source and is rejected before a provider adapter is resolved.

Plans identify the tenant, account, provider-native message ID, canonical action and an explicit idempotency key.

## Authorization and preconditions

Execution checks:

1. execution context tenant/account equals the plan tenant/account
2. resolved adapter kind equals the planned provider
3. provider advertises the required capability
4. the current provider message still belongs to that tenant/account/provider/message identity
5. optional canonical ID, updated timestamp, mailbox-role and flag preconditions still hold

Trash and permanent delete require `destructiveAuthorization` referencing either a policy ID or a user-confirmation ID.

Destructive actions default to `requireUnprotected=true`. A message whose retention state is protected cannot be trashed or permanently deleted by this executor.

## Idempotency

The planner supplies an idempotency key for one intended mutation occurrence. `createActionIdempotencyKey()` generates a deterministic key from the plan identity and action.

Before calling the provider, the executor atomically claims the key and persists a reduced before-state snapshot.

- replay of a succeeded key returns `deduplicated` without calling the provider
- the same key with a different plan hash is rejected
- an in-progress key is not executed concurrently
- a failed key is not silently replayed; a new explicit plan is required

An in-progress record intentionally remains non-retryable after a process crash because the provider may already have performed the mutation.

## Retry safety

Provider errors are classified separately from the retry decision.

HTTP 408/425/429/5xx and selected JMAP server errors are classified as transient. Network disconnect/timeouts are classified as **uncertain**, because they may occur after the provider committed a change.

Only mutations with safe repeat semantics are automatically retried:

- read/unread
- star/unstar
- important/unimportant
- label add/remove
- Gmail archive/move/trash/restore
- JMAP archive/move/trash/restore

Microsoft Graph move/archive/trash/restore, generic IMAP moves, Maildir moves and permanent delete are not automatically retried after an error. These operations may change provider IDs/UIDs or be irreversible.

## Audit and before/after state

The execution store persists a body-free state snapshot containing message identity, mailbox roles/IDs, labels, flags, retention state and updated timestamp.

After successful execution the executor attempts to re-read the provider message.

- `captured`: after-state was read
- `unavailable`: mutation succeeded but the old provider ID can no longer be read, for example after an ID-changing move
- `deleted`: permanent delete completed

Audit events record success, retry, failure and deduplication with actor, action, attempt, error category and idempotency key. Email body contents are not duplicated into the action audit record.

`ActionExecutionStore` is a persistence contract. Production database implementation must make `claim()` atomic with a unique constraint on the idempotency key.
