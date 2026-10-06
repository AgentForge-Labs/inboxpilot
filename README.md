# InboxPilot

AI-powered email triage, priority classification, retention and automation platform with MCP plugin support.

## Core architecture

InboxPilot separates four concerns:

1. Provider adapters normalize Gmail, Microsoft Graph, IMAP, JMAP and local mailboxes.
2. Classifiers assign importance, categories, confidence and actionability.
3. Policy evaluates user rules and safe-retention protections.
4. Action executors apply provider mutations idempotently.

The canonical provider-neutral message/thread contract lives in `src/domain`.

See [Canonical Email Model](docs/EMAIL_MODEL.md).

## Development

```bash
npm install
npm test
```

Current schema version: **v1**.
