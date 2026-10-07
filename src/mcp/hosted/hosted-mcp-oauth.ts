import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  McpAccountLinkStore,
  McpOAuthStore,
} from "./hosted-mcp-store.js";
import type {
  McpAuthorizationRequest,
  McpOAuthGrant,
  McpOAuthPrincipal,
  McpProductSession,
  McpTokenResponse,
} from "./hosted-mcp-types.js";

export class McpOAuthError extends Error {
  constructor(
    readonly oauthCode:
      | "invalid_request"
      | "invalid_client"
      | "invalid_grant"
      | "invalid_scope"
      | "access_denied",
    message: string,
  ) {
    super(message);
    this.name = "McpOAuthError";
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function pkceS256(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return (
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function requirePkceChallenge(value: string): string {
  const challenge = value.trim();
  if (
    challenge.length < 43 ||
    challenge.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(challenge)
  ) {
    throw new McpOAuthError(
      "invalid_request",
      "PKCE S256 code_challenge is invalid",
    );
  }
  return challenge;
}

function requireVerifier(value: string): string {
  const verifier = value.trim();
  if (
    verifier.length < 43 ||
    verifier.length > 128 ||
    !/^[A-Za-z0-9._~-]+$/.test(verifier)
  ) {
    throw new McpOAuthError(
      "invalid_grant",
      "PKCE code_verifier is invalid",
    );
  }
  return verifier;
}

export interface McpAuthorizationResult {
  code: string;
  redirectUri: string;
  state?: string;
}

export class HostedMcpOAuthService {
  constructor(
    private readonly store: McpOAuthStore,
    private readonly accounts: McpAccountLinkStore,
    private readonly now: () => Date = () => new Date(),
    private readonly authorizationCodeTtlMs = 5 * 60 * 1000,
    private readonly accessTokenTtlMs = 60 * 60 * 1000,
    private readonly refreshTokenTtlMs = 30 * 24 * 60 * 60 * 1000,
  ) {}

  async authorize(
    session: McpProductSession,
    request: McpAuthorizationRequest,
  ): Promise<McpAuthorizationResult> {
    if (request.responseType !== "code") {
      throw new McpOAuthError(
        "invalid_request",
        "Only authorization-code flow is supported",
      );
    }
    if (request.codeChallengeMethod !== "S256") {
      throw new McpOAuthError(
        "invalid_request",
        "PKCE S256 is required",
      );
    }
    if (!request.consentGranted) {
      throw new McpOAuthError(
        "access_denied",
        "Explicit account-linking consent is required",
      );
    }

    const client = await this.store.getClient(
      request.clientId.trim(),
    );
    if (!client) {
      throw new McpOAuthError(
        "invalid_client",
        "Unknown OAuth client",
      );
    }
    if (!client.redirectUris.includes(request.redirectUri)) {
      throw new McpOAuthError(
        "invalid_request",
        "redirect_uri is not registered for this client",
      );
    }

    const scopes = unique(request.scopes);
    if (
      scopes.length === 0 ||
      scopes.some(
        (scope) => !client.allowedScopes.includes(scope),
      )
    ) {
      throw new McpOAuthError(
        "invalid_scope",
        "Requested OAuth scope is not allowed",
      );
    }

    const requestedAccounts = unique(request.accountIds);
    if (requestedAccounts.length === 0) {
      throw new McpOAuthError(
        "invalid_request",
        "At least one linked mailbox account is required",
      );
    }
    const linked = await this.accounts.listLinked(
      session.tenantId,
      session.userId,
    );
    const linkedIds = new Set(
      linked.map((link) => link.accountId),
    );
    if (
      requestedAccounts.some(
        (accountId) => !linkedIds.has(accountId),
      )
    ) {
      throw new McpOAuthError(
        "access_denied",
        "Requested mailbox account is not linked to this user",
      );
    }

    const challenge = requirePkceChallenge(
      request.codeChallenge,
    );
    const rawCode = randomBytes(32).toString("base64url");
    const createdAt = this.now().toISOString();
    const expiresAt = new Date(
      Date.parse(createdAt) + this.authorizationCodeTtlMs,
    ).toISOString();

    await this.store.putAuthorizationCode({
      codeHash: tokenHash(rawCode),
      clientId: client.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: challenge,
      scopes,
      tenantId: session.tenantId,
      userId: session.userId,
      accountIds: requestedAccounts,
      createdAt,
      expiresAt,
    });

    return {
      code: rawCode,
      redirectUri: request.redirectUri,
      ...(request.state
        ? { state: request.state }
        : {}),
    };
  }

  async exchangeAuthorizationCode(input: {
    clientId: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<McpTokenResponse> {
    const record = await this.store.consumeAuthorizationCode(
      tokenHash(input.code),
    );
    if (!record) {
      throw new McpOAuthError(
        "invalid_grant",
        "Authorization code is invalid or already used",
      );
    }

    const now = this.now().toISOString();
    if (record.expiresAt <= now) {
      throw new McpOAuthError(
        "invalid_grant",
        "Authorization code has expired",
      );
    }
    if (
      record.clientId !== input.clientId ||
      record.redirectUri !== input.redirectUri
    ) {
      throw new McpOAuthError(
        "invalid_grant",
        "Authorization code binding mismatch",
      );
    }
    const verifier = requireVerifier(input.codeVerifier);
    if (
      !secureEqual(
        pkceS256(verifier),
        record.codeChallenge,
      )
    ) {
      throw new McpOAuthError(
        "invalid_grant",
        "PKCE verification failed",
      );
    }

    const linked = await this.accounts.listLinked(
      record.tenantId,
      record.userId,
    );
    const linkedIds = new Set(
      linked.map((link) => link.accountId),
    );
    if (
      record.accountIds.some(
        (accountId) => !linkedIds.has(accountId),
      )
    ) {
      throw new McpOAuthError(
        "invalid_grant",
        "A linked mailbox was disconnected before token exchange",
      );
    }

    const grant: McpOAuthGrant = {
      grantId: randomUUID(),
      clientId: record.clientId,
      tenantId: record.tenantId,
      userId: record.userId,
      accountIds: [...record.accountIds],
      scopes: [...record.scopes],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.putGrant(grant);
    return this.issueTokenPair(grant);
  }

  async refresh(input: {
    clientId: string;
    refreshToken: string;
  }): Promise<McpTokenResponse> {
    const token = await this.store.getToken(
      tokenHash(input.refreshToken),
    );
    const now = this.now().toISOString();
    if (
      !token ||
      token.kind !== "refresh" ||
      token.clientId !== input.clientId ||
      token.revokedAt ||
      token.expiresAt <= now
    ) {
      throw new McpOAuthError(
        "invalid_grant",
        "Refresh token is invalid, revoked, or expired",
      );
    }

    const grant = await this.store.getGrant(token.grantId);
    if (!grant || grant.revokedAt) {
      throw new McpOAuthError(
        "invalid_grant",
        "OAuth grant is revoked",
      );
    }

    const linked = await this.accounts.listLinked(
      grant.tenantId,
      grant.userId,
    );
    const linkedIds = new Set(
      linked.map((link) => link.accountId),
    );
    if (
      grant.accountIds.some(
        (accountId) => !linkedIds.has(accountId),
      )
    ) {
      await this.revokeGrant(grant, now);
      throw new McpOAuthError(
        "invalid_grant",
        "OAuth grant references a disconnected mailbox",
      );
    }

    await this.store.revokeToken(
      token.tokenHash,
      now,
    );
    return this.issueTokenPair(grant);
  }

  async authenticateAccessToken(
    rawAccessToken: string,
  ): Promise<McpOAuthPrincipal> {
    const token = await this.store.getToken(
      tokenHash(rawAccessToken),
    );
    const now = this.now().toISOString();

    if (
      !token ||
      token.kind !== "access" ||
      token.revokedAt ||
      token.expiresAt <= now
    ) {
      throw new McpOAuthError(
        "invalid_grant",
        "Access token is invalid, revoked, or expired",
      );
    }

    const grant = await this.store.getGrant(token.grantId);
    if (!grant || grant.revokedAt) {
      throw new McpOAuthError(
        "invalid_grant",
        "OAuth grant is revoked",
      );
    }

    const linked = await this.accounts.listLinked(
      grant.tenantId,
      grant.userId,
    );
    const linkedIds = new Set(
      linked.map((link) => link.accountId),
    );
    const activeAccounts = grant.accountIds.filter(
      (accountId) => linkedIds.has(accountId),
    );
    if (activeAccounts.length !== grant.accountIds.length) {
      await this.revokeGrant(grant, now);
      throw new McpOAuthError(
        "invalid_grant",
        "OAuth grant references a disconnected mailbox",
      );
    }

    return {
      grantId: grant.grantId,
      clientId: grant.clientId,
      tenantId: grant.tenantId,
      userId: grant.userId,
      accountIds: activeAccounts,
      scopes: [...grant.scopes],
      accessTokenExpiresAt: token.expiresAt,
    };
  }

  async revoke(rawToken: string): Promise<void> {
    const hash = tokenHash(rawToken);
    const token = await this.store.getToken(hash);
    if (!token) return;

    const now = this.now().toISOString();
    await this.store.revokeToken(hash, now);
    const grant = await this.store.getGrant(token.grantId);
    if (grant && !grant.revokedAt) {
      await this.revokeGrant(grant, now);
    }
  }

  async disconnectMcpAccount(
    session: McpProductSession,
    accountId: string,
  ): Promise<boolean> {
    const normalized = accountId.trim();
    if (!normalized) {
      throw new TypeError("accountId is required");
    }
    const now = this.now().toISOString();
    const disconnected = await this.accounts.disconnect(
      session.tenantId,
      session.userId,
      normalized,
      now,
    );
    if (!disconnected) return false;

    const grants = await this.store.listGrantsForUser(
      session.tenantId,
      session.userId,
    );
    for (const grant of grants) {
      if (
        !grant.revokedAt &&
        grant.accountIds.includes(normalized)
      ) {
        await this.revokeGrant(grant, now);
      }
    }
    return true;
  }

  private async issueTokenPair(
    grant: McpOAuthGrant,
  ): Promise<McpTokenResponse> {
    const now = this.now().toISOString();
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(48).toString("base64url");
    const accessExpiresAt = new Date(
      Date.parse(now) + this.accessTokenTtlMs,
    ).toISOString();
    const refreshExpiresAt = new Date(
      Date.parse(now) + this.refreshTokenTtlMs,
    ).toISOString();

    await this.store.putToken({
      tokenHash: tokenHash(accessToken),
      kind: "access",
      grantId: grant.grantId,
      clientId: grant.clientId,
      issuedAt: now,
      expiresAt: accessExpiresAt,
    });
    await this.store.putToken({
      tokenHash: tokenHash(refreshToken),
      kind: "refresh",
      grantId: grant.grantId,
      clientId: grant.clientId,
      issuedAt: now,
      expiresAt: refreshExpiresAt,
    });

    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(this.accessTokenTtlMs / 1000),
      refresh_token: refreshToken,
      scope: grant.scopes.join(" "),
    };
  }

  private async revokeGrant(
    grant: McpOAuthGrant,
    revokedAt: string,
  ): Promise<void> {
    await this.store.putGrant({
      ...grant,
      updatedAt: revokedAt,
      revokedAt,
    });
  }
}
