# Natural-language rule creation through MCP

InboxPilot exposes the `email_rule_create_natural_language` control-plane tool for creating validated dashboard rules from conversational instructions.

## Safety model

Natural language is never treated as an executable action plan. The command is parsed into the existing dashboard rule contract and then passed through the same condition/action validators used by the dashboard.

Broad or destructive rules are not persisted immediately. They return:

- the normalized rule draft
- affected-message count
- a body-free sample preview
- conflict/precedence effects
- warnings
- a short-lived confirmation token

The confirmation token is tenant/account bound, single use and expires after ten minutes by default.

Delete rules always require confirmation and a positive delay. The existing retention lifecycle remains archive-first; a command such as "Archive Zalando promotions and delete them after 7 days" becomes a delayed deletion-lifecycle rule, not an immediate permanent-delete operation.

## Supported targets

The deterministic parser recognizes:

- exact sender email
- explicit sender domain
- classifier categories such as promotion, newsletter and receipt
- importance-score thresholds/ranges
- sender/brand names already observable in the connected mailbox

A brand name such as "Vodafone" is resolved only when current mailbox data maps it to one unique sender domain. Zero or multiple candidate domains returns clarification rather than guessing.

Compound commands are represented as AND conditions. For example "Zalando promotions" resolves to both the Zalando sender domain and the promotion classifier category, avoiding accidental scope widening.

## Examples

- `Never delete Vodafone emails`
- `Archive Zalando promotions and delete them after 7 days`
- `Anything below importance 20 should be archived and deleted after 30 days`
- `Always important from boss@example.com`

Exact-sender, non-destructive rules may be created immediately. Domain, category, score and destructive rules require explicit confirmation because they are broad, dangerous, or both.

## MCP authorization boundary

The MCP input does not accept a tenant ID. Tenant identity comes from the authenticated MCP context. The supplied account ID must already be in that context's authorized account list.
