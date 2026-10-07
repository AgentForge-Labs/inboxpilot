import { randomBytes, randomUUID } from "node:crypto";
import {
  HostedMcpToolError,
  type HostedMcpToolRegistry,
} from "./hosted-mcp-tools.js";
import {
  HostedMcpOAuthService,
  McpOAuthError,
} from "./hosted-mcp-oauth.js";
import {
  HOSTED_MCP_PROTOCOL_VERSION,
  type McpAuthorizationRequest,
  type McpHttpRequest,
  type McpHttpResponse,
  type McpJsonRpcRequest,
  type McpJsonRpcResponse,
  type McpOAuthPrincipal,
} from "./hosted-mcp-types.js";

interface McpSession {
  sessionId: string;
  grantId: string;
  createdAt: string;
  expiresAt: string;
}

export interface McpSessionStore {
  create(
    grantId: string,
    now: string,
    expiresAt: string,
  ): Promise<McpSession>;
  get(sessionId: string): Promise<McpSession | undefined>;
  delete(sessionId: string): Promise<void>;
}

export class InMemoryMcpSessionStore
  implements McpSessionStore
{
  private readonly sessions = new Map<string, McpSession>();

  async create(
    grantId: string,
    now: string,
    expiresAt: string,
  ): Promise<McpSession> {
    const value: McpSession = {
      sessionId: randomBytes(24).toString("base64url"),
      grantId,
      createdAt: now,
      expiresAt,
    };
    this.sessions.set(value.sessionId, value);
    return structuredClone(value);
  }

  async get(
    sessionId: string,
  ): Promise<McpSession | undefined> {
    const value = this.sessions.get(sessionId);
    return value ? structuredClone(value) : undefined;
  }

  async delete(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}

function header(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function objectBody(
  body: unknown,
): Readonly<Record<string, unknown>> {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new TypeError("Request body must be an object");
  }
  return body as Readonly<Record<string, unknown>>;
}

function requiredString(
  body: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(key + " is required");
  }
  return value.trim();
}

function optionalString(
  body: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function stringList(
  value: unknown,
): string[] {
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      throw new TypeError("Expected an array of strings");
    }
    return value
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

function rpcId(
  request: McpJsonRpcRequest,
): string | number | null {
  return request.id ?? null;
}

function rpcSuccess(
  request: McpJsonRpcRequest,
  result: unknown,
): McpJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: rpcId(request),
    result,
  };
}

function rpcError(
  request: McpJsonRpcRequest,
  code: number,
  message: string,
  data?: unknown,
): McpJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: rpcId(request),
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function parseRpc(body: unknown): McpJsonRpcRequest {
  const value = objectBody(body);
  if (
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    !value.method.trim()
  ) {
    throw new TypeError("Invalid JSON-RPC 2.0 request");
  }
  const id = value.id;
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== "string" &&
    typeof id !== "number"
  ) {
    throw new TypeError("JSON-RPC id must be string, number, or null");
  }
  return {
    jsonrpc: "2.0",
    ...(id !== undefined
      ? { id: id as string | number | null }
      : {}),
    method: value.method,
    ...(value.params !== undefined
      ? { params: value.params }
      : {}),
  };
}

export interface HostedMcpServerOptions {
  baseUrl: string;
  authorizationScopes: readonly string[];
  sessionTtlMs?: number;
}

export class HostedMcpServer {
  private readonly baseUrl: string;
  private readonly authorizationScopes: readonly string[];
  private readonly sessionTtlMs: number;

  constructor(
    private readonly oauth: HostedMcpOAuthService,
    private readonly tools: HostedMcpToolRegistry,
    private readonly sessions: McpSessionStore,
    options: HostedMcpServerOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.authorizationScopes = [
      ...options.authorizationScopes,
    ];
    this.sessionTtlMs =
      options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
  }

  async handle(
    request: McpHttpRequest,
  ): Promise<McpHttpResponse> {
    try {
      if (
        request.method === "GET" &&
        request.path ===
          "/.well-known/oauth-authorization-server"
      ) {
        return this.json(200, this.authorizationMetadata());
      }
      if (
        request.method === "GET" &&
        request.path ===
          "/.well-known/oauth-protected-resource"
      ) {
        return this.json(200, this.protectedResourceMetadata());
      }
      if (
        request.method === "GET" &&
        request.path === "/oauth/authorize"
      ) {
        return this.handleAuthorizationPrompt(request);
      }
      if (
        request.method === "POST" &&
        request.path === "/oauth/authorize"
      ) {
        return await this.handleAuthorize(request);
      }
      if (
        request.method === "POST" &&
        request.path === "/oauth/token"
      ) {
        return await this.handleToken(request);
      }
      if (
        request.method === "POST" &&
        request.path === "/oauth/revoke"
      ) {
        return await this.handleRevoke(request);
      }
      if (
        request.method === "POST" &&
        request.path === "/oauth/disconnect"
      ) {
        return await this.handleDisconnect(request);
      }
      if (
        request.method === "GET" &&
        request.path === "/mcp"
      ) {
        return {
          status: 405,
          headers: {
            Allow: "POST",
            "Content-Type": "application/json",
          },
          body: {
            error:
              "Server-initiated SSE stream is not enabled; use Streamable HTTP POST.",
          },
        };
      }
      if (
        request.method === "POST" &&
        request.path === "/mcp"
      ) {
        return await this.handleMcp(request);
      }

      return this.json(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof McpOAuthError) {
        const status =
          error.oauthCode === "invalid_client"
            ? 401
            : error.oauthCode === "access_denied"
              ? 403
              : 400;
        return this.json(status, {
          error: error.oauthCode,
          error_description: error.message,
        });
      }
      if (error instanceof TypeError) {
        return this.json(400, {
          error: "invalid_request",
          error_description: error.message,
        });
      }
      return this.json(500, {
        error: "server_error",
      });
    }
  }

  authorizationMetadata(): Record<string, unknown> {
    return {
      issuer: this.baseUrl,
      authorization_endpoint:
        this.baseUrl + "/oauth/authorize",
      token_endpoint: this.baseUrl + "/oauth/token",
      revocation_endpoint: this.baseUrl + "/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: [
        "authorization_code",
        "refresh_token",
      ],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [...this.authorizationScopes],
      token_endpoint_auth_methods_supported: ["none"],
    };
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.baseUrl + "/mcp",
      authorization_servers: [this.baseUrl],
      scopes_supported: [...this.authorizationScopes],
      bearer_methods_supported: ["header"],
    };
  }

  private async handleAuthorizationPrompt(
    request: McpHttpRequest,
  ): Promise<McpHttpResponse> {
    if (!request.productSession) {
      return this.json(401, {
        error: "login_required",
      });
    }

    const query = request.query ?? {};
    const clientId = query.client_id?.trim();
    const redirectUri = query.redirect_uri?.trim();
    if (!clientId || !redirectUri) {
      return this.json(400, {
        error: "invalid_request",
        error_description:
          "client_id and redirect_uri are required",
      });
    }

    const scope = stringList(query.scope);
    const accountIds = stringList(query.account_ids);
    return this.json(200, {
      consent_required: true,
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      account_ids: accountIds,
      state: query.state ?? null,
      code_challenge_method:
        query.code_challenge_method ?? null,
      linked_user: {
        tenant_id: request.productSession.tenantId,
        user_id: request.productSession.userId,
      },
    });
  }

  private async handleAuthorize(
    request: McpHttpRequest,
  ): Promise<McpHttpResponse> {
    if (!request.productSession) {
      return this.json(401, {
        error: "login_required",
      });
    }
    const body = objectBody(request.body);
    const authorizationRequest: McpAuthorizationRequest = {
      clientId: requiredString(body, "client_id"),
      redirectUri: requiredString(body, "redirect_uri"),
      responseType:
        requiredString(body, "response_type") as "code",
      codeChallenge: requiredString(
        body,
        "code_challenge",
      ),
      codeChallengeMethod: requiredString(
        body,
        "code_challenge_method",
      ) as "S256",
      scopes: stringList(body.scope),
      accountIds: stringList(body.account_ids),
      ...(optionalString(body, "state")
        ? { state: optionalString(body, "state")! }
        : {}),
      consentGranted: body.consent_granted === true,
    };

    const result = await this.oauth.authorize(
      request.productSession,
      authorizationRequest,
    );
    const destination = new URL(result.redirectUri);
    destination.searchParams.set("code", result.code);
    if (result.state) {
      destination.searchParams.set("state", result.state);
    }

    return {
      status: 302,
      headers: {
        Location: destination.toString(),
        "Cache-Control": "no-store",
      },
    };
  }

  private async handleToken(
    request: McpHttpRequest,
  ): Promise<McpHttpResponse> {
    const body = objectBody(request.body);
    const grantType = requiredString(body, "grant_type");
    const clientId = requiredString(body, "client_id");

    if (grantType === "authorization_code") {
      const result =
        await this.oauth.exchangeAuthorizationCode({
          clientId,
          code: requiredString(body, "code"),
          redirectUri: requiredString(
            body,
            "redirect_uri",
          ),
          codeVerifier: requiredString(
            body,
            "code_verifier",
          ),
        });
      return this.tokenResponse(result);
    }

    if (grantType === "refresh_token") {
      const result = await this.oauth.refresh({
        clientId,
        refreshToken: requiredString(
          body,
          "refresh_token",
        ),
      });
      return this.tokenResponse(result);
    }

    throw new McpOAuthError(
      "invalid_request",
      "Unsupported grant_type",
    );
  }

  private async handleRevoke(
    request: McpHttpRequest,
  ): Promise<McpHttpResponse> {
    const body = objectBody(request.body);
    await this.oauth.revoke(requiredString(body, "token"));
    return {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    };
  }

  private async handleDisconnect(
    request: McpHttpRequest,
  ): Promise<McpHttpResponse> {
    if (!request.productSession) {
      return this.json(401, {
        error: "login_required",
      });
    }
    const body = objectBody(request.body);
    const disconnected =
      await this.oauth.disconnectMcpAccount(
        request.productSession,
        requiredString(body, "account_id"),
      );
    return this.json(200, { disconnected });
  }

  private async handleMcp(
    request: McpHttpRequest,
  ): Promise<McpHttpResponse> {
    let principal: McpOAuthPrincipal;
    try {
      principal = await this.authenticate(request);
      if (!principal.scopes.includes("mcp:tools")) {
        return {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "WWW-Authenticate":
              'Bearer error="insufficient_scope", scope="mcp:tools"',
          },
          body: {
            error: "insufficient_scope",
          },
        };
      }
    } catch (error) {
      if (error instanceof McpOAuthError) {
        return {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "WWW-Authenticate":
              'Bearer resource_metadata="' +
              this.baseUrl +
              '/.well-known/oauth-protected-resource"',
          },
          body: {
            error: "invalid_token",
          },
        };
      }
      throw error;
    }

    let rpc: McpJsonRpcRequest;
    try {
      rpc = parseRpc(request.body);
    } catch (error) {
      return this.json(400, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message:
            error instanceof Error
              ? error.message
              : "Invalid Request",
        },
      });
    }

    if (rpc.method === "initialize") {
      const session = await this.sessions.create(
        principal.grantId,
        this.now().toISOString(),
        new Date(
          this.now().getTime() + this.sessionTtlMs,
        ).toISOString(),
      );
      return this.rpcResponse(
        rpcSuccess(rpc, {
          protocolVersion:
            HOSTED_MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "InboxPilot",
            version: "0.1.0",
          },
        }),
        {
          "Mcp-Session-Id": session.sessionId,
        },
      );
    }

    const sessionResult =
      await this.requireSession(request, principal);
    if (sessionResult instanceof Object && "status" in sessionResult) {
      return sessionResult as McpHttpResponse;
    }

    if (rpc.method === "notifications/initialized") {
      return {
        status: 202,
        headers: {
          "Mcp-Session-Id": sessionResult.sessionId,
        },
      };
    }

    if (rpc.method === "ping") {
      return this.rpcResponse(rpcSuccess(rpc, {}), {
        "Mcp-Session-Id": sessionResult.sessionId,
      });
    }

    if (rpc.method === "tools/list") {
      return this.rpcResponse(
        rpcSuccess(rpc, {
          tools: this.tools.list(principal),
        }),
        {
          "Mcp-Session-Id": sessionResult.sessionId,
        },
      );
    }

    if (rpc.method === "tools/call") {
      const params = objectBody(rpc.params);
      const name = requiredString(params, "name");
      const args =
        params.arguments === undefined
          ? {}
          : params.arguments;
      try {
        const result = await this.tools.call(
          name,
          args,
          principal,
          String(rpc.id ?? randomUUID()),
        );
        return this.rpcResponse(
          rpcSuccess(rpc, {
            content: [
              {
                type: "text",
                text: "Tool completed.",
              },
            ],
            structuredContent: result,
            isError: false,
          }),
          {
            "Mcp-Session-Id":
              sessionResult.sessionId,
          },
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Tool call failed";
        const data =
          error instanceof HostedMcpToolError
            ? { toolCode: error.code }
            : undefined;
        return this.rpcResponse(
          rpcError(rpc, -32000, message, data),
          {
            "Mcp-Session-Id":
              sessionResult.sessionId,
          },
        );
      }
    }

    return this.rpcResponse(
      rpcError(rpc, -32601, "Method not found"),
      {
        "Mcp-Session-Id": sessionResult.sessionId,
      },
    );
  }

  private async authenticate(
    request: McpHttpRequest,
  ): Promise<McpOAuthPrincipal> {
    const authorization = header(
      request.headers,
      "authorization",
    );
    if (
      !authorization ||
      !authorization.startsWith("Bearer ")
    ) {
      throw new McpOAuthError(
        "invalid_grant",
        "Bearer access token is required",
      );
    }
    return this.oauth.authenticateAccessToken(
      authorization.slice("Bearer ".length).trim(),
    );
  }

  private async requireSession(
    request: McpHttpRequest,
    principal: McpOAuthPrincipal,
  ): Promise<McpSession | McpHttpResponse> {
    const sessionId = header(
      request.headers,
      "mcp-session-id",
    );
    if (!sessionId) {
      return this.json(400, {
        error: "mcp_session_required",
      });
    }
    const session = await this.sessions.get(sessionId);
    const now = this.now().toISOString();
    if (
      !session ||
      session.expiresAt <= now ||
      session.grantId !== principal.grantId
    ) {
      if (session) {
        await this.sessions.delete(sessionId);
      }
      return this.json(404, {
        error: "mcp_session_invalid",
      });
    }
    return session;
  }

  private json(
    status: number,
    body: unknown,
  ): McpHttpResponse {
    return {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body,
    };
  }

  private tokenResponse(body: unknown): McpHttpResponse {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
      body,
    };
  }

  private rpcResponse(
    body: McpJsonRpcResponse,
    extraHeaders: Record<string, string> = {},
  ): McpHttpResponse {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "MCP-Protocol-Version":
          HOSTED_MCP_PROTOCOL_VERSION,
        ...extraHeaders,
      },
      body,
    };
  }
}
