# Inbox dashboard

The dashboard exposes nine decision-oriented views over canonical messages:

- Critical
- Needs Action
- Important
- Normal
- Read Later
- Newsletters
- Receipts
- Auto Archived
- Pending Delete

Views intentionally overlap. A critical receipt that requires a reply can appear in all relevant views.

## View rules

Critical, Important and Normal are driven by classifier priority.

Needs Action includes messages that require an action, require a reply, or are explicitly in classifier needs-review state.

Read Later groups low, very-low and disposable priority.

Newsletters and Receipts are category views.

Auto Archived includes archived messages that have a retention policy ID, distinguishing policy-driven archive from arbitrary provider folder state.

Pending Delete covers pending-trash, trashed and pending-delete retention stages.

## Filters

All views support account-scoped filtering by:

- provider
- category
- received-from timestamp
- received-to timestamp

Date boundaries are inclusive. Invalid ranges are rejected. Navigation counts are recomputed from the same filtered message set, so the sidebar and active view remain consistent.

## Row data

Dashboard rows expose message identity, sender, subject, received timestamp, provider, score, priority, categories, concise classifier explanation, action/reply flags and retention timing metadata.

Message body, HTML, raw headers and attachments are never copied into the dashboard row contract.

Rows are sorted newest first and query results are bounded to 1,000 messages per request.
