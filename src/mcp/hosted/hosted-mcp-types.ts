export const HOSTED_MCP_PROTOCOL_VERSION = "2025-06-18" as const;

export interface McpOAuthClient {
  clientId: string;
  redirectUris: readonly string[];
  allowedScopes: readonly string[];
}

export interface McpProductSession {
  userId: string;
  tenantId: string;
}

export interface McpAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  responseType: "code";
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scopes: readonly string[];
  accountIds: readonly string[];
  state?: string;
  consentGranted: boolean;
}

export interface McpAuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  tenantId: string;
  userId: string;
  accountIds: string[];
  createdAt: string;
  expiresAt: string;
}

export interface McpOAuthGrant {
  grantId: string;
  clientId: string;
  tenantId: string;
  userId: string;
  accountIds: string[];
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export type McpTokenKind = "access" | "refresh";

export interface McpOAuthTokenRecord {
  tokenHash: string;
  kind: McpTokenKind;
  grantId: string;
  clientId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface McpOAuthPrincipal {
  grantId: string;
  clientId: string;
  tenantId: string;
  userId: string;
  accountIds: readonly string[];
  scopes: readonly string[];
  accessTokenExpiresAt: string;
}

export interface McpTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface McpLinkedAccount {
  tenantId: string;
  userId: string;
  accountId: string;
  linkedAt: string;
  disconnectedAt?: string;
}

export interface McpControlPlaneUsageEvent {
  tenantId: string;
  userId: string;
  grantId: string;
  requestId: string;
  toolName: string;
  outcome: "succeeded" | "failed" | "denied";
  timestamp: string;
  accountId?: string;
  billable: false;
}

export interface McpHttpRequest {
  method: "GET" | "POST";
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  query?: Readonly<Record<string, string | undefined>>;
  body?: unknown;
  productSession?: McpProductSession;
}

export interface McpHttpResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface McpJsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type McpJsonRpcResponse =
  | McpJsonRpcSuccess
  | McpJsonRpcError;
