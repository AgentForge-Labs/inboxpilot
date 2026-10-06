# Provider Adapter Contract

InboxPilot provider adapters isolate Gmail, Microsoft Graph, IMAP, JMAP and local mailbox differences behind one interface.

## Required interface

Every adapter implements:

- `connect`
- `capabilities`
- `listFolders`
- `listLabels`
- `syncChanges`
- `getMessage`
- `getThread`
- `archive`
- `move`
- `trash`
- `deletePermanent`
- `addLabel`
- `removeLabel`
- `markImportant`
- `star`
- `markRead`

The method surface is stable even when a provider does not implement every feature.

## Capability discovery

Adapters publish a complete boolean map for every capability. Callers should inspect it before enabling UI actions or planning automation.

Example:

```ts
const capabilities = adapter.capabilities();

if (capabilities.archive) {
  await adapter.archive(providerMessageId);
}
```

Unsupported features are represented as `false` and throw `ProviderCapabilityError` if invoked. This prevents provider-specific behavior from leaking into generic classifier, policy, MCP, or dashboard code.

## Connection state

Provider actions require a successful `connect()`. Calls before connection fail with `ProviderNotConnectedError`.

Authentication details remain adapter-specific. The common connection context only carries InboxPilot tenant/account scope.

## Sync contract

`syncChanges()` returns:

- normalized canonical messages
- provider message IDs deleted upstream
- an optional opaque next cursor
- `hasMore`

The cursor is opaque to generic code. Gmail history IDs, Graph delta links, IMAP/JMAP state tokens, or filesystem checkpoints therefore remain private to their adapters.

## Folders and labels

Folders and labels are intentionally separate capabilities.

- Gmail can expose both system/user labels and canonical mailbox roles.
- Microsoft/IMAP/JMAP commonly expose mailbox/folder semantics.
- A future POP3 adapter can explicitly advertise both as unsupported.

Generic code must never infer support from provider kind.

## Mutations

All mutation methods operate on provider-native message IDs. Future policy/action layers are responsible for authorization, safety gates, idempotency and audit before invoking an adapter.

`deletePermanent` is distinct from `trash` so destructive retention behavior cannot accidentally map one action to the other.
