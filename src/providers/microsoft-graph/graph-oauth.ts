import type { ProviderConnectionContext } from "../provider-adapter.js";
import type {
  MicrosoftCredentialStore,
  MicrosoftOAuthConfig,
  MicrosoftStoredCredentials,
} from "./graph-types.js";

export const MICROSOFT_GRAPH_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
] as const;

export class MicrosoftReauthorizationRequiredError extends Error {
  readonly code = "MICROSOFT_REAUTHORIZATION_REQUIRED";
  constructor(message = "Microsoft authorization must be renewed") {
    super(message);
    this.name = "MicrosoftReauthorizationRequiredError";
  }
}

export class MicrosoftOAuthClient {
  private readonly tenant: string;

  constructor(
    private readonly config: MicrosoftOAuthConfig,
    private readonly credentialStore: MicrosoftCredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.tenant = config.tenant ?? "common";
  }

  authorizationUrl(state: string, loginHint?: string): string {
    const url = new URL(
      `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/authorize`,
    );
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", MICROSOFT_GRAPH_SCOPES.join(" "));
    url.searchParams.set("state", state);
    if (loginHint) url.searchParams.set("login_hint", loginHint);
    return url.toString();
  }

  async exchangeCode(
    context: ProviderConnectionContext,
    code: string,
  ): Promise<MicrosoftStoredCredentials> {
    const credentials = await this.tokenRequest({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
      scope: MICROSOFT_GRAPH_SCOPES.join(" "),
    });
    if (!credentials.refreshToken) {
      throw new MicrosoftReauthorizationRequiredError(
        "Microsoft OAuth did not return a refresh token",
      );
    }
    await this.credentialStore.set(context, credentials);
    return credentials;
  }

  async accessToken(context: ProviderConnectionContext): Promise<string> {
    const stored = await this.credentialStore.get(context);
    if (!stored) throw new MicrosoftReauthorizationRequiredError();

    if (
      stored.accessToken &&
      (!stored.expiresAt || stored.expiresAt - Date.now() > 60_000)
    ) {
      return stored.accessToken;
    }
    return this.forceRefresh(context);
  }

  async forceRefresh(context: ProviderConnectionContext): Promise<string> {
    const stored = await this.credentialStore.get(context);
    if (!stored?.refreshToken) throw new MicrosoftReauthorizationRequiredError();

    try {
      const refreshed = await this.tokenRequest({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: stored.refreshToken,
        grant_type: "refresh_token",
        scope: MICROSOFT_GRAPH_SCOPES.join(" "),
      });
      const scope = refreshed.scope ?? stored.scope;
      const merged: MicrosoftStoredCredentials = {
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? stored.refreshToken,
        ...(scope ? { scope } : {}),
      };
      await this.credentialStore.set(context, merged);
      return merged.accessToken;
    } catch (error) {
      if (error instanceof MicrosoftReauthorizationRequiredError) {
        await this.credentialStore.delete(context);
      }
      throw error;
    }
  }

  async revokeLocal(context: ProviderConnectionContext): Promise<void> {
    await this.credentialStore.delete(context);
  }

  private async tokenRequest(
    form: Record<string, string>,
  ): Promise<MicrosoftStoredCredentials> {
    const response = await this.fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(this.tenant)}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form),
      },
    );
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !payload.access_token) {
      if (
        payload.error === "invalid_grant" ||
        payload.error === "interaction_required" ||
        payload.error === "consent_required"
      ) {
        throw new MicrosoftReauthorizationRequiredError(
          payload.error_description ?? payload.error,
        );
      }
      throw new Error(
        `Microsoft OAuth token request failed: ${payload.error_description ?? payload.error ?? response.status}`,
      );
    }

    return {
      accessToken: payload.access_token,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      ...(payload.expires_in
        ? { expiresAt: Date.now() + payload.expires_in * 1000 }
        : {}),
      ...(payload.scope ? { scope: payload.scope } : {}),
    };
  }
}
