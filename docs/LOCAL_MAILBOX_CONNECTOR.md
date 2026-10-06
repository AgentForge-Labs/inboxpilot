# Local Maildir / mbox Connector

InboxPilot can ingest mailboxes mounted on the same host without cloud credentials.

## Security boundary

Every local account requires:

- `allowedRoot`: the only filesystem tree the adapter may access.
- `sourcePath`: Maildir directory or mbox file inside that root.
- `statePath`: InboxPilot sidecar state file inside the same allowed root.

All configured paths are resolved through `realpath` and rejected when they escape the allowed root. The source must be readable. Writable/destructive modes additionally require filesystem write permission.

No OAuth token, password, or remote credential is required.

## Maildir

A Maildir source must contain `cur/` and `new/`.

Message identity is based on the SHA-256 digest of the RFC822 content, so renaming a Maildir file to update `:2,` flags does not change the InboxPilot provider identity.

Maildir filename flags map to canonical state:

- `S` → read
- `F` → starred
- `D` → draft
- `R` → answered

The adapter can watch `cur/` and `new/` for changes. Filesystem notifications are only wake-up signals; callers still run `syncChanges()` afterwards.

## mbox

mbox is treated as an import/read-only source. Messages are split on mbox envelope separators and parsed as RFC822 mail.

Provider identity uses the message content digest plus the occurrence number of that digest. This preserves separately stored duplicate messages while remaining stable when new messages are appended.

mbox mutations are deliberately unsupported.

## Incremental ingest and sidecar state

Both adapters keep a versioned JSON sidecar containing:

- seen provider message IDs and fingerprints
- stored InboxPilot classification state

The sidecar is written atomically through a temporary file and is created with mode `0600`.

Each sync rescans the mounted source and emits only entries not already recorded in the sidecar. This favors correctness for mounted/private mail sources over trusting filesystem timestamps alone.

Classification can be persisted and later restored without modifying the original RFC822 message.

## Mutation safety

Maildir defaults to read-only.

- `writable=true` enables non-destructive read/star filename-flag changes.
- `allowDestructive=true` requires `writable=true` and explicitly enables move/archive/trash/restore/permanent-delete operations.
- Archive and Trash capabilities are advertised only when their destination paths are configured.
- Mutation destinations are resolved again and must remain inside `allowedRoot`.

mbox always remains read-only even if a caller attempts to enable writable flags.

## Threading

Local messages use RFC `Message-ID`, `References`, and `In-Reply-To` through the shared InboxPilot threading strategy. Arbitrary random-access thread reconstruction is left to the normalized storage layer rather than scanning the entire mounted source on every request.
