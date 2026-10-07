# Privacy Mode: local/self-hosted classification

Privacy Mode is a deployment boundary, not a UI-only preference. Mail provider credentials, normalized email content, attachments and semantic-classifier inputs stay on the user's local or self-hosted InboxPilot node. The cloud receives only a strict classification metadata envelope.

## Data flow

```
mail provider
    |
    v
local/self-hosted connector + credential vault
    |
    v
local canonical message / attachment extraction / classifier
    |
    +--> local policy + automation workers
    |
    v
strict privacy projection
    |
    v
cloud classification-metadata store
```

The local runtime is created only with the following deployment contract:

- provider credentials: `local_only`
- email content: `local_only`
- attachment content: `local_only`
- classifier execution: `local_self_hosted`
- classifier transport: `local_or_self_hosted_only`
- cloud sync: `classification_metadata_only`

The runtime rejects a descriptor that weakens any of these requirements or adds an unknown placement field.

## What reaches the cloud

The privacy envelope contains only:

- envelope version and Privacy Mode marker
- tenant ID
- account ID
- opaque cloud message ID
- message received timestamp
- classification status
- importance score and priority
- fixed-vocabulary categories
- confidence
- action-required / reply-required flags
- optional numeric risk score
- classification timestamp

The cloud message ID is a tenant/account-scoped SHA-256-derived identifier. The local canonical message ID and provider message ID are not exported.

The cloud ingress uses an exact-field validator. Unknown top-level or classification fields are rejected. This prevents callers from adding body text, subject, sender/recipient data, headers, attachments, provider IDs, credentials, model reason text, model version text or arbitrary labels to a Privacy Mode envelope.

## What remains local

For supported Privacy Mode deployments, these remain on the local/self-hosted node:

- OAuth refresh/access tokens and IMAP/JMAP/provider credentials
- provider message/thread/attachment IDs
- subject, snippet and body
- HTML and raw headers
- sender, recipients and reply-to identities
- labels/mailbox metadata not required by the cloud envelope
- attachment filenames and attachment contents
- extracted attachment text
- semantic prompts and thread context
- model reason text and other free-form classifier explanations
- provider mutation execution
- full-text indexes
- local automation state that needs message/provider content

The encrypted credential vault can therefore be hosted with the local connector/worker deployment; cloud classification metadata does not require provider credentials.

## Attachment-aware classification

Issue #36's attachment enrichment runs before the privacy projection and on the same local/self-hosted side of the boundary. Extracted text is transient local classifier input. The cloud envelope intentionally omits both extracted text and the attachment-enrichment summary, avoiding a secondary metadata channel about private documents.

## MCP behavior

The regular hosted MCP tool set includes tools that require cloud access to full messages or provider mutations. A supported Privacy Mode cloud deployment must register tools through the Privacy Mode tool filter.

Cloud-safe control-plane tools are limited to:

- rule create/update/list/delete
- automation status/configure
- usage

Without a separately authenticated local bridge, the cloud does not register:

- search/read/thread-read/inbox-summary
- cloud classification / bulk classification
- archive/trash/restore/move/mark-important
- natural-language rule creation that needs mailbox message resolution or preview

This is deliberate. Enabling those existing hosted tools against a full cloud message repository would violate the Privacy Mode content boundary.

## Local automation

Provider actions and unattended automation can continue when their workers run on the local/self-hosted node, because that node owns the provider credentials and full message state.

Cloud-side rule and automation configuration can be metadata/control-plane state, but execution that needs provider content or credentials must be performed locally. A deployment must not interpret the cloud control-plane configuration as permission to upload the underlying message content.

## Trade-offs

Privacy Mode improves data minimization but reduces cloud-only functionality:

- Cloud full-text search is unavailable.
- Cloud message body, subject, sender/recipient and attachment views are unavailable.
- Cloud provider mutations are unavailable unless a separate local bridge performs them.
- A local/self-hosted classifier and worker node must be online for new messages to be classified and automated.
- Local/self-hosted model quality, latency and hardware requirements may differ from a hosted model.
- The operator is responsible for securing and backing up the local node and its credential vault.
- Cloud dashboards can build counts, priority/category views and similar aggregate experiences from classification metadata, but cannot reconstruct the original message.
- Free-form classifier explanations are deliberately omitted because they may quote private email content.
- Privacy Mode is data minimization, not anonymity: the cloud still knows the InboxPilot tenant/account and the classification metadata that the user chooses to synchronize.

## Failure behavior

If cloud synchronization is unavailable, local classification does not need to expose the message to another service. The local runtime can retain/retry only the metadata envelope according to the deployment's queue policy.

The cloud metadata store revalidates every envelope and is tenant/account scoped. A malformed or content-bearing payload fails closed with `PRIVACY_BOUNDARY_VIOLATION`.

## Supported deployment boundary

A deployment qualifies as Privacy Mode only when connectors, provider credential storage, attachment extraction and any semantic model endpoint all run within the local/self-hosted trust boundary. Merely running the InboxPilot process locally while sending semantic prompts to a public hosted model does not satisfy the `local_or_self_hosted_only` classifier-transport contract.
