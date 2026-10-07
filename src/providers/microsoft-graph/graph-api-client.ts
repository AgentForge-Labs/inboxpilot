import {
  providerRetryDelayMs,
  type OperationalTelemetry,
  type ProviderRateLimitTracker,
} from "../../observability/operational-telemetry.js";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import {
  MicrosoftOAuthClient,
  MicrosoftReauthorizationRequiredError,
} from "./graph-oauth.js";

export class MicrosoftGraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "MicrosoftGraphApiError";
  }
}

export interface MicrosoftGraphApiClientOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRetryDelayMs?: number;
  telemetry?: OperationalTelemetry;
  rateLimits?: ProviderRateLimitTracker;
  now?: () => Date;
}

export class MicrosoftGraphApiClient {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetryDelayMs: number;
  private readonly telemetry: OperationalTelemetry | undefined;
  private readonly rateLimits: ProviderRateLimitTracker | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly oauth: MicrosoftOAuthClient,
    private readonly fetchImpl: typeof fetch = fetch,
    options: MicrosoftGraphApiClientOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.baseDelayMs = options.baseDelayMs ?? 300;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetryDelayMs = Math.max(
      this.baseDelayMs,
      options.maxRetryDelayMs ?? 5 * 60_000,
    );
    this.telemetry = options.telemetry;
    this.rateLimits = options.rateLimits;
    this.now = options.now ?? (() => new Date());
  }

  request<T>(
    context: ProviderConnectionContext,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const url = path.startsWith("https://")
      ? path
      : `https://graph.microsoft.com/v1.0${path}`;
    return this.requestUrl<T>(context, url, init);
  }

  async requestUrl<T>(
    context: ProviderConnectionContext,
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt += 1) {
      const token = refreshedAfter401
        ? await this.oauth.forceRefresh(context)
        : await this.oauth.accessToken(context);

      const response = await this.fetchImpl(url, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...Object.fromEntries(new Headers(init.headers).entries()),
        },
      });

      if (response.status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        continue;
      }

      if (
        (response.status === 429 ||
          response.status === 503 ||
          response.status >= 500) &&
        attempt < this.maxRetries
      ) {
        const delay = providerRetryDelayMs(
          attempt,
          response.headers.get("retry-after"),
          {
            baseDelayMs: this.baseDelayMs,
            maxDelayMs: this.maxRetryDelayMs,
          },
          this.now(),
        );
        const throttled = response.status === 429;
        if (throttled) {
          this.rateLimits?.noteThrottle(
            {
              tenantId: context.tenantId,
              accountId: context.accountId,
              provider: "microsoft_graph",
            },
            delay,
            this.now(),
          );
        }
        await this.telemetry?.record({
          metric: throttled
            ? "provider_throttled"
            : "provider_retry",
          tenantId: context.tenantId,
          accountId: context.accountId,
          provider: "microsoft_graph",
          value: 1,
          status: throttled ? "throttled" : "retrying",
          attempt: attempt + 1,
          retryAfterMs: delay,
          timestamp: this.now().toISOString(),
        });
        await this.sleep(delay);
        if (throttled) {
          this.rateLimits?.clear({
            tenantId: context.tenantId,
            accountId: context.accountId,
            provider: "microsoft_graph",
          });
        }
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        throw new MicrosoftReauthorizationRequiredError(
          "Microsoft Graph authorization is no longer valid",
        );
      }

      if (!response.ok) {
        const body = await response.text();
        throw new MicrosoftGraphApiError(
          response.status,
          init.method ?? "GET",
          url,
          `Microsoft Graph request failed (${response.status}): ${body.slice(0, 500)}`,
        );
      }

      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }
}
