# Hosted MCP server and OAuth account linking

InboxPilot exposes a hosted Streamable HTTP control plane at a single MCP resource endpoint.

## OAuth

The reference implementation supports public OAuth clients with authorization-code + PKCE S256.

Security properties:

- exact registered redirect URI matching
- explicit user consent before account linking
- requested mailbox IDs must already be linked to the authenticated InboxPilot user
- one-time authorization codes with five-minute default lifetime
- opaque access and refresh tokens
- only SHA-256 token/code hashes are stored
- one-hour access-token lifetime by default
- 30-day refresh-token lifetime by default
- refresh-token rotation
- grant-level revocation
- access tokens are revalidated on every MCP HTTP request
- MCP session IDs never replace bearer authentication

OAuth discovery is available through the authorization-server and protected-resource well-known endpoints.

The authorization endpoint is split into a GET consent-prompt phase and a POST consent-completion phase. Product authentication supplies tenant/user identity out of band; tenant identity is never accepted from OAuth/MCP tool arguments.

## Mailbox account isolation

OAuth grants contain an explicit mailbox-account allowlist. Tool calls containing an account ID are rejected unless that account is present in the authenticated grant.

Tool arguments containing `tenantId` are rejected. The tenant always comes from the bearer-token principal.

Disconnecting an account from MCP revokes any MCP grant containing that account. This disconnects MCP access only; it does not delete provider credentials, disable ingestion, or stop background automation workers.

## Streamable HTTP

The MCP endpoint supports JSON-RPC 2.0 over Streamable HTTP POST:

- `initialize`
- `notifications/initialized`
- `ping`
- `tools/list`
- `tools/call`

Initialize creates an opaque MCP session ID bound to the OAuth grant. Every later request requires both the bearer token and the matching session ID.

Server-initiated GET/SSE is optional in Streamable HTTP and is not enabled by this implementation; GET on the MCP resource returns 405 with `Allow: POST`.

## Tool registry

Each tool declares:

- name
- description
- JSON input schema
- MCP annotations
- required OAuth scopes
- whether an authorized mailbox account is required

The registry constructs tool context from the OAuth principal, not from model-provided tenant values.

The natural-language rule tool is adapted into the hosted registry with `rules:write` scope and account-bound access.

## Usage accounting

Every tool call writes an operational MCP control-plane usage event containing:

- tenant/user/grant IDs
- request ID
- tool name
- success/failure/denied outcome
- timestamp
- account ID when applicable

Tool arguments, tool results and email content are not copied into the usage event.

These events are explicitly `billable: false`. Customer plan quota remains based on unique incoming emails processed, not MCP calls.

## Worker independence

MCP OAuth grants and MCP sessions belong only to the conversational control plane. Background sync/classification/retention workers have no dependency on MCP bearer tokens or MCP session records. Revoking a chat integration therefore stops conversational access without stopping already-configured mailbox automation.
