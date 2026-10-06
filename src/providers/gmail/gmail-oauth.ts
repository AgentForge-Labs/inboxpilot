import type { ProviderConnectionContext } from "../provider-adapter.js";
import type {
  GmailCredentialStore,
  GmailOAuthConfig,
  GmailStoredCredentials,
} from "./gmail-types.js";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_FULL_MAIL_SCOPE = "https://mail.google.com/";

export function gmailScopes(allowPermanentDelete: boolean): string[] {
  return [allowPermanentDelete ? GMAIL_FULL_MAIL_SCOPE : GMAIL_MODIFY_SCOPE];
}

export interface GmailOAuthAuthorizeOptions {
  state: string;
  allowPermanentDelete?: boolean;
  loginHint?: string;
}

export class GmailOAuthClient {
  constructor(
    private readonly config: GmailOAuthConfig,
    private readonly credentialStore: GmailCredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authorizationUrl(options: GmailOAuthAuthorizeOptions): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    url.searchParams.set("scope", gmailScopes(Boolean(options.allowPermanentDelete)).join(" "));
    url.searchParams.set("state", options.state);
    if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);
    return url.toString();
  }

  async exchangeCode(
    context: ProviderConnectionContext,
    code: string,
  ): Promise<GmailStoredCredentials> {
    const credentials = await this.tokenRequest({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: "authorization_code",
    });

    if (!credentials.refreshToken) {
      throw new Error("Google OAuth did not return a refresh token");
    }

    await this.credentialStore.set(context, credentials);
    return credentials;
  }

  async accessToken(context: ProviderConnectionContext): Promise<string> {
    const stored = await this.credentialStore.get(context);
    if (!stored) throw new Error("Gmail account is not authorized");

    const now = Date.now();
    if (stored.accessToken && (!stored.expiresAt || stored.expiresAt - now > 60_000)) {
      return stored.accessToken;
    }
    if (!stored.refreshToken) {
      throw new Error("Gmail refresh token is unavailable; reauthorization required");
    }

    const refreshed = await this.tokenRequest({
      refresh_token: stored.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
    });

    const mergedScope = refreshed.scope ?? stored.scope;
    const merged: GmailStoredCredentials = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? stored.refreshToken,
      ...(mergedScope ? { scope: mergedScope } : {}),
    };
    await this.credentialStore.set(context, merged);
    return merged.accessToken;
  }

  async forceRefresh(context: ProviderConnectionContext): Promise<string> {
    const stored = await this.credentialStore.get(context);
    if (!stored?.refreshToken) {
      throw new Error("Gmail refresh token is unavailable; reauthorization required");
    }
    const refreshed = await this.tokenRequest({
      refresh_token: stored.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "refresh_token",
    });
    const mergedScope = refreshed.scope ?? stored.scope;
    const merged: GmailStoredCredentials = {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? stored.refreshToken,
      ...(mergedScope ? { scope: mergedScope } : {}),
    };
    await this.credentialStore.set(context, merged);
    return merged.accessToken;
  }

  async revoke(context: ProviderConnectionContext): Promise<void> {
    const stored = await this.credentialStore.get(context);
    const token = stored?.refreshToken ?? stored?.accessToken;
    try {
      if (token) {
        const body = new URLSearchParams({ token });
        await this.fetchImpl("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      }
    } finally {
      await this.credentialStore.delete(context);
    }
  }

  private async tokenRequest(
    form: Record<string, string>,
  ): Promise<GmailStoredCredentials> {
    const response = await this.fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form),
    });

    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !payload.access_token) {
      throw new Error(
        `Google OAuth token exchange failed: ${payload.error_description ?? payload.error ?? response.status}`,
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
