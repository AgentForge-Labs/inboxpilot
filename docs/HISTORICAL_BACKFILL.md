# Historical mailbox backfill

Historical backfill is a durable job flow that classifies mail already present when an account is connected. It is separate from the live ingestion cursor and therefore cannot move incremental reconciliation backwards.

## Job configuration

A job is scoped to one tenant, account and provider and contains:

- explicit `since` / `until` window
- configurable lookback in days
- bounded page size
- bounded pages per worker run
- `classify_only` or `ingest_and_classify` mode

The default mode is `classify_only`. Backfill never invokes mailbox mutation APIs, so classification-only jobs cannot archive, trash or delete provider mail.

## Resume/checkpoint behavior

Each page is fetched with a backfill-specific cursor. Messages are classified and persisted before the job cursor is advanced.

If a worker crashes after saving a page but before checkpointing, the same page may be fetched again. Canonical/provider identity makes the message save idempotent, and the unique usage ledger prevents a second customer quota charge.

The live ingestion cursor from issue #12 is never reused as the historical-job cursor.

## Pause, resume and cancel

Jobs support:

- pause
- resume
- cancel
- bounded yield after `maxPagesPerRun`

Controls are stored in the durable job record. Workers re-read job state between pages so a pause/cancel request is honored at the next safe checkpoint.

## Provider rate limits

`ProviderSyncBackfillSource` maps exhausted provider HTTP 429 failures to `BackfillRateLimitError`.

A throttled job stores `nextRunAt` and retains its cursor. Running the job before that time does not call the provider. After the deadline, the worker can resume from the same checkpoint.

Provider SDK/client retries may happen before the rate-limit error reaches the job runner.

## Unique usage accounting

Backfill quota is keyed by:

`tenant + account + provider + providerMessageId`

`BackfillUsageLedger.chargeUnique()` returns true only the first time that identity is charged. Reprocessing after a crash, explicit reclassification, or rerunning a historical job does not double-charge the same incoming email.

Production usage accounting should back this contract with a database uniqueness constraint. The in-memory ledger exists for tests.

## Progress UI contract

`buildBackfillProgress()` returns provider-neutral dashboard data:

- status
- pages processed
- messages seen/classified
- unique usage charged
- duplicate charges skipped
- optional total estimate / percentage
- retry time when throttled
- last error

This allows the dashboard issue to render progress without provider-specific logic.

## Historical source contract

`HistoricalBackfillSource` is intentionally provider-neutral. The included `ProviderSyncBackfillSource` can backfill through an existing connected adapter's paginated sync surface and applies the date window before returning messages.

Providers with richer historical search APIs can implement the same contract later without changing the durable job engine. The backfill engine validates tenant/account/provider scope again before classification.
