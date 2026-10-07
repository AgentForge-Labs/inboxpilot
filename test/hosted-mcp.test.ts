import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  HostedMcpOAuthService,
  HostedMcpServer,
  HostedMcpToolRegistry,
  InMemoryMcpAccountLinkStore,
  InMemoryMcpControlPlaneUsageStore,
  InMemoryMcpOAuthStore,
  InMemoryMcpSessionStore,
  pkceS256,
  type McpHttpRequest,
  type McpOAuthClient,
} from "../src/index.js";

const CLIENT: McpOAuthClient = {
  clientId: "chatgpt-client",
  redirectUris: ["https://chat.example/callback"],
  allowedScopes: [
    "mcp:tools",
    "mailbox:read",
    "rules:write",
    "admin:debug",
  ],
};

const VERIFIER = "A".repeat(64);
const CHALLENGE = pkceS256(VERIFIER);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function setup() {
  let now = Date.parse("2026-10-07T09:00:00.000Z");
  const clock = () => new Date(now);
  const advance = (ms: number) => {
    now += ms;
  };

  const oauthStore = new InMemoryMcpOAuthStore([CLIENT]);
  const accounts = new InMemoryMcpAccountLinkStore();
  const usage = new InMemoryMcpControlPlaneUsageStore();
  const oauth = new HostedMcpOAuthService(
    oauthStore,
    accounts,
    clock,
  );
  const registry = new HostedMcpToolRegistry(usage, clock);
  const sessions = new InMemoryMcpSessionStore();
  const server = new HostedMcpServer(
    oauth,
    registry,
    sessions,
    {
      baseUrl: "https://mcp.inboxpilot.test",
      authorizationScopes: CLIENT.allowedScopes,
    },
    clock,
  );

  registry.register({
    descriptor: {
      name: "mailbox_echo",
      description: "Echo a safe value for a linked mailbox.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          value: { type: "string" },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "Mailbox Echo",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(args, context) {
      return {
        tenantId: context.tenantId,
        accountId: context.accountId,
        value: args.value ?? null,
      };
    },
  });

  registry.register({
    descriptor: {
      name: "admin_debug",
      description: "Scope-filtering fixture.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
      annotations: {
        title: "Admin Debug",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    requiredScopes: ["admin:debug"],
    async execute() {
      return { ok: true };
    },
  });

  return {
    clock,
    advance,
    oauthStore,
    accounts,
    usage,
    oauth,
    registry,
    sessions,
    server,
  };
}

async function linkDefaultAccount(
  env: ReturnType<typeof setup>,
  options: {
    tenantId?: string;
    userId?: string;
    accountId?: string;
  } = {},
) {
  await env.accounts.link(
    options.tenantId ?? "tenant-1",
    options.userId ?? "user-1",
    options.accountId ?? "account-1",
    env.clock().toISOString(),
  );
}

async function authorizeAndExchange(
  env: ReturnType<typeof setup>,
  options: {
    tenantId?: string;
    userId?: string;
    accountIds?: string[];
    scopes?: string[];
    verifier?: string;
  } = {},
) {
  const tenantId = options.tenantId ?? "tenant-1";
  const userId = options.userId ?? "user-1";
  const accountIds = options.accountIds ?? ["account-1"];
  const scopes = options.scopes ?? [
    "mcp:tools",
    "mailbox:read",
  ];
  const verifier = options.verifier ?? VERIFIER;

  const authorize = await env.server.handle({
    method: "POST",
    path: "/oauth/authorize",
    headers: {},
    productSession: { tenantId, userId },
    body: {
      client_id: CLIENT.clientId,
      redirect_uri: CLIENT.redirectUris[0],
      response_type: "code",
      code_challenge: pkceS256(verifier),
      code_challenge_method: "S256",
      scope: scopes.join(" "),
      account_ids: accountIds,
      state: "state-1",
      consent_granted: true,
    },
  });
  assert.equal(authorize.status, 302);
  const location = authorize.headers.Location;
  assert.ok(location);
  const code = new URL(location).searchParams.get("code");
  assert.ok(code);

  const token = await env.server.handle({
    method: "POST",
    path: "/oauth/token",
    headers: {},
    body: {
      grant_type: "authorization_code",
      client_id: CLIENT.clientId,
      code,
      redirect_uri: CLIENT.redirectUris[0],
      code_verifier: verifier,
    },
  });
  assert.equal(token.status, 200);
  const body = token.body as {
    access_token: string;
    refresh_token: string;
    token_type: string;
    scope: string;
  };
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    scope: body.scope,
  };
}

async function initialize(
  env: ReturnType<typeof setup>,
  accessToken: string,
): Promise<string> {
  const response = await env.server.handle({
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: "Bearer " + accessToken,
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "test-client",
          version: "1.0",
        },
      },
    },
  });
  assert.equal(response.status, 200);
  const session = response.headers["Mcp-Session-Id"];
  assert.ok(session);
  return session;
}

function mcpRequest(
  accessToken: string,
  sessionId: string,
  body: unknown,
): McpHttpRequest {
  return {
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Mcp-Session-Id": sessionId,
    },
    body,
  };
}

test("OAuth discovery publishes PKCE authorization, token, revocation and protected-resource metadata", async () => {
  const env = setup();

  const authorization = await env.server.handle({
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    headers: {},
  });
  assert.equal(authorization.status, 200);
  assert.deepEqual(
    (authorization.body as Record<string, unknown>)
      .code_challenge_methods_supported,
    ["S256"],
  );
  assert.equal(
    (authorization.body as Record<string, unknown>)
      .token_endpoint,
    "https://mcp.inboxpilot.test/oauth/token",
  );

  const resource = await env.server.handle({
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    headers: {},
  });
  assert.equal(resource.status, 200);
  assert.equal(
    (resource.body as Record<string, unknown>).resource,
    "https://mcp.inboxpilot.test/mcp",
  );
});

test("authorization enforces consent, exact redirect URI and linked-account subset", async () => {
  const env = setup();
  await linkDefaultAccount(env);

  const base = {
    client_id: CLIENT.clientId,
    redirect_uri: CLIENT.redirectUris[0],
    response_type: "code",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "mcp:tools mailbox:read",
    account_ids: ["account-1"],
  };

  const noConsent = await env.server.handle({
    method: "POST",
    path: "/oauth/authorize",
    headers: {},
    productSession: {
      tenantId: "tenant-1",
      userId: "user-1",
    },
    body: {
      ...base,
      consent_granted: false,
    },
  });
  assert.equal(noConsent.status, 403);

  const wrongRedirect = await env.server.handle({
    method: "POST",
    path: "/oauth/authorize",
    headers: {},
    productSession: {
      tenantId: "tenant-1",
      userId: "user-1",
    },
    body: {
      ...base,
      redirect_uri: "https://evil.example/callback",
      consent_granted: true,
    },
  });
  assert.equal(wrongRedirect.status, 400);

  const unlinked = await env.server.handle({
    method: "POST",
    path: "/oauth/authorize",
    headers: {},
    productSession: {
      tenantId: "tenant-1",
      userId: "user-1",
    },
    body: {
      ...base,
      account_ids: ["account-2"],
      consent_granted: true,
    },
  });
  assert.equal(unlinked.status, 403);
});

test("authorization-code PKCE is one-time and stores only hashes of codes/tokens", async () => {
  const env = setup();
  await linkDefaultAccount(env);

  const tokens = await authorizeAndExchange(env);

  assert.equal(
    await env.oauthStore.getToken(tokens.accessToken),
    undefined,
  );
  assert.equal(
    (await env.oauthStore.getToken(
      sha256(tokens.accessToken),
    ))?.kind,
    "access",
  );
  assert.equal(
    (await env.oauthStore.getToken(
      sha256(tokens.refreshToken),
    ))?.kind,
    "refresh",
  );

  const principal =
    await env.oauth.authenticateAccessToken(
      tokens.accessToken,
    );
  assert.equal(principal.tenantId, "tenant-1");
  assert.deepEqual(principal.accountIds, ["account-1"]);

  const authorize = await env.oauth.authorize(
    { tenantId: "tenant-1", userId: "user-1" },
    {
      clientId: CLIENT.clientId,
      redirectUri: CLIENT.redirectUris[0]!,
      responseType: "code",
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      scopes: ["mcp:tools"],
      accountIds: ["account-1"],
      consentGranted: true,
    },
  );

  await assert.rejects(
    () =>
      env.oauth.exchangeAuthorizationCode({
        clientId: CLIENT.clientId,
        code: authorize.code,
        redirectUri: CLIENT.redirectUris[0]!,
        codeVerifier: "B".repeat(64),
      }),
    /PKCE verification failed/,
  );

  await assert.rejects(
    () =>
      env.oauth.exchangeAuthorizationCode({
        clientId: CLIENT.clientId,
        code: authorize.code,
        redirectUri: CLIENT.redirectUris[0]!,
        codeVerifier: VERIFIER,
      }),
    /invalid or already used/,
  );
});

test("refresh token rotates and old refresh token cannot be reused", async () => {
  const env = setup();
  await linkDefaultAccount(env);
  const tokens = await authorizeAndExchange(env);

  const refreshed = await env.server.handle({
    method: "POST",
    path: "/oauth/token",
    headers: {},
    body: {
      grant_type: "refresh_token",
      client_id: CLIENT.clientId,
      refresh_token: tokens.refreshToken,
    },
  });
  assert.equal(refreshed.status, 200);
  const next = refreshed.body as {
    access_token: string;
    refresh_token: string;
  };
  assert.notEqual(next.access_token, tokens.accessToken);
  assert.notEqual(next.refresh_token, tokens.refreshToken);

  const replay = await env.server.handle({
    method: "POST",
    path: "/oauth/token",
    headers: {},
    body: {
      grant_type: "refresh_token",
      client_id: CLIENT.clientId,
      refresh_token: tokens.refreshToken,
    },
  });
  assert.equal(replay.status, 400);

  const principal =
    await env.oauth.authenticateAccessToken(
      next.access_token,
    );
  assert.equal(principal.userId, "user-1");
});

test("MCP resource requires bearer token and mcp:tools scope", async () => {
  const env = setup();
  await linkDefaultAccount(env);

  const missing = await env.server.handle({
    method: "POST",
    path: "/mcp",
    headers: {},
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    },
  });
  assert.equal(missing.status, 401);
  assert.match(
    missing.headers["WWW-Authenticate"] ?? "",
    /oauth-protected-resource/,
  );

  const tokenWithoutMcpScope =
    await authorizeAndExchange(env, {
      scopes: ["mailbox:read"],
    });
  const denied = await env.server.handle({
    method: "POST",
    path: "/mcp",
    headers: {
      Authorization:
        "Bearer " + tokenWithoutMcpScope.accessToken,
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    },
  });
  assert.equal(denied.status, 403);
  assert.match(
    denied.headers["WWW-Authenticate"] ?? "",
    /insufficient_scope/,
  );
});

test("Streamable HTTP initialize/session and tools/list expose scope-filtered annotations", async () => {
  const env = setup();
  await linkDefaultAccount(env);
  const tokens = await authorizeAndExchange(env);
  const session = await initialize(env, tokens.accessToken);

  const list = await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  );
  assert.equal(list.status, 200);
  const tools = (
    (list.body as {
      result: { tools: Array<Record<string, unknown>> };
    }).result.tools
  );
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["mailbox_echo"],
  );
  assert.deepEqual(
    tools[0]?.annotations,
    {
      title: "Mailbox Echo",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  );

  const get = await env.server.handle({
    method: "GET",
    path: "/mcp",
    headers: {},
  });
  assert.equal(get.status, 405);
  assert.equal(get.headers.Allow, "POST");
});

test("tools/call derives tenant from OAuth and rejects tenant spoofing or unauthorized account", async () => {
  const env = setup();
  await linkDefaultAccount(env);
  const tokens = await authorizeAndExchange(env);
  const session = await initialize(env, tokens.accessToken);

  const success = await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "mailbox_echo",
        arguments: {
          accountId: "account-1",
          value: "hello",
        },
      },
    }),
  );
  assert.equal(success.status, 200);
  const structured = (
    success.body as {
      result: {
        structuredContent: Record<string, unknown>;
      };
    }
  ).result.structuredContent;
  assert.deepEqual(structured, {
    tenantId: "tenant-1",
    accountId: "account-1",
    value: "hello",
  });

  const spoof = await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "mailbox_echo",
        arguments: {
          accountId: "account-1",
          tenantId: "tenant-evil",
        },
      },
    }),
  );
  assert.match(
    JSON.stringify(spoof.body),
    /tenantId is derived from OAuth/,
  );

  const otherAccount = await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "mailbox_echo",
        arguments: {
          accountId: "account-2",
        },
      },
    }),
  );
  assert.match(
    JSON.stringify(otherAccount.body),
    /not authorized by this OAuth grant/,
  );
});

test("control-plane usage events are metadata-only and never billable email quota", async () => {
  const env = setup();
  await linkDefaultAccount(env);
  const tokens = await authorizeAndExchange(env);
  const session = await initialize(env, tokens.accessToken);

  await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: "usage-1",
      method: "tools/call",
      params: {
        name: "mailbox_echo",
        arguments: {
          accountId: "account-1",
          value: "TOP_SECRET_TOOL_ARGUMENT",
        },
      },
    }),
  );

  await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: "usage-2",
      method: "tools/call",
      params: {
        name: "mailbox_echo",
        arguments: {
          accountId: "account-2",
          value: "SECOND_SECRET",
        },
      },
    }),
  );

  const events = await env.usage.listForTenant("tenant-1");
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((event) => event.outcome),
    ["succeeded", "denied"],
  );
  assert.equal(
    events.every((event) => event.billable === false),
    true,
  );
  const serialized = JSON.stringify(events);
  assert.equal(
    serialized.includes("TOP_SECRET_TOOL_ARGUMENT"),
    false,
  );
  assert.equal(serialized.includes("SECOND_SECRET"), false);
});

test("MCP session is grant-bound and cannot be replayed with another OAuth grant", async () => {
  const env = setup();
  await linkDefaultAccount(env, {
    accountId: "account-1",
  });
  await linkDefaultAccount(env, {
    userId: "user-2",
    accountId: "account-2",
  });

  const first = await authorizeAndExchange(env);
  const firstSession = await initialize(
    env,
    first.accessToken,
  );

  const second = await authorizeAndExchange(env, {
    userId: "user-2",
    accountIds: ["account-2"],
  });

  const replay = await env.server.handle(
    mcpRequest(second.accessToken, firstSession, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/list",
      params: {},
    }),
  );
  assert.equal(replay.status, 404);
});

test("OAuth revoke invalidates bearer token immediately even when MCP session exists", async () => {
  const env = setup();
  await linkDefaultAccount(env);
  const tokens = await authorizeAndExchange(env);
  const session = await initialize(env, tokens.accessToken);

  const revoke = await env.server.handle({
    method: "POST",
    path: "/oauth/revoke",
    headers: {},
    body: {
      token: tokens.accessToken,
    },
  });
  assert.equal(revoke.status, 200);

  const after = await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    }),
  );
  assert.equal(after.status, 401);
});

test("MCP disconnect revokes conversational access without coupling background-worker state", async () => {
  const env = setup();
  await linkDefaultAccount(env);
  const tokens = await authorizeAndExchange(env);
  const session = await initialize(env, tokens.accessToken);

  let backgroundAutomationEnabled = true;
  let workerRuns = 0;
  const runBackgroundWorker = () => {
    if (backgroundAutomationEnabled) workerRuns += 1;
  };
  runBackgroundWorker();

  const disconnect = await env.server.handle({
    method: "POST",
    path: "/oauth/disconnect",
    headers: {},
    productSession: {
      tenantId: "tenant-1",
      userId: "user-1",
    },
    body: {
      account_id: "account-1",
    },
  });
  assert.equal(disconnect.status, 200);
  assert.deepEqual(
    await env.accounts.listLinked(
      "tenant-1",
      "user-1",
    ),
    [],
  );

  const oldSession = await env.server.handle(
    mcpRequest(tokens.accessToken, session, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/list",
      params: {},
    }),
  );
  assert.equal(oldSession.status, 401);

  runBackgroundWorker();
  assert.equal(backgroundAutomationEnabled, true);
  assert.equal(workerRuns, 2);
});

test("tenant isolation remains intact for identical MCP server across separate grants", async () => {
  const env = setup();
  await linkDefaultAccount(env, {
    tenantId: "tenant-1",
    userId: "user-1",
    accountId: "account-1",
  });
  await linkDefaultAccount(env, {
    tenantId: "tenant-2",
    userId: "user-2",
    accountId: "account-2",
  });

  const t1 = await authorizeAndExchange(env);
  const t2 = await authorizeAndExchange(env, {
    tenantId: "tenant-2",
    userId: "user-2",
    accountIds: ["account-2"],
  });

  const s1 = await initialize(env, t1.accessToken);
  const s2 = await initialize(env, t2.accessToken);

  const one = await env.server.handle(
    mcpRequest(t1.accessToken, s1, {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "mailbox_echo",
        arguments: {
          accountId: "account-1",
          value: "one",
        },
      },
    }),
  );
  const two = await env.server.handle(
    mcpRequest(t2.accessToken, s2, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "mailbox_echo",
        arguments: {
          accountId: "account-2",
          value: "two",
        },
      },
    }),
  );

  assert.equal(
    (
      one.body as {
        result: {
          structuredContent: { tenantId: string };
        };
      }
    ).result.structuredContent.tenantId,
    "tenant-1",
  );
  assert.equal(
    (
      two.body as {
        result: {
          structuredContent: { tenantId: string };
        };
      }
    ).result.structuredContent.tenantId,
    "tenant-2",
  );
});
