import type { ProviderConnectionContext } from "../provider-adapter.js";
import { GmailOAuthClient } from "./gmail-oauth.js";

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export interface GmailApiClientOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class GmailApiClient {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly oauth: GmailOAuthClient,
    private readonly fetchImpl: typeof fetch = fetch,
    options: GmailApiClientOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async request<T>(
    context: ProviderConnectionContext,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt += 1) {
      const accessToken = refreshedAfter401
        ? await this.oauth.forceRefresh(context)
        : await this.oauth.accessToken(context);

      const response = await this.fetchImpl(
        `https://gmail.googleapis.com/gmail/v1/users/me${path}`,
        {
          ...init,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${accessToken}`,
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...Object.fromEntries(new Headers(init.headers).entries()),
          },
        },
      );

      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        continue;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : this.baseDelayMs * 2 ** attempt;
        await this.sleep(delay);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new GmailApiError(
          response.status,
          init.method ?? "GET",
          path,
          `Gmail API request failed (${response.status}): ${body.slice(0, 500)}`,
        );
      }

      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }
}
