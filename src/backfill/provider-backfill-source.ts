import type { ProviderAdapter } from "../providers/provider-adapter.js";
import type {
  HistoricalBackfillPage,
  HistoricalBackfillSource,
} from "./backfill-types.js";

export class BackfillRateLimitError extends Error {
  readonly code = "BACKFILL_RATE_LIMITED";

  constructor(
    readonly retryAfterMs: number,
    message = "Provider rate limit reached during backfill",
  ) {
    super(message);
    this.name = "BackfillRateLimitError";
  }
}

function rateLimitDelay(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as {
    status?: unknown;
    retryAfterMs?: unknown;
    retryAfterSeconds?: unknown;
  };
  if (value.status !== 429) return undefined;
  if (
    typeof value.retryAfterMs === "number" &&
    Number.isFinite(value.retryAfterMs) &&
    value.retryAfterMs >= 0
  ) {
    return value.retryAfterMs;
  }
  if (
    typeof value.retryAfterSeconds === "number" &&
    Number.isFinite(value.retryAfterSeconds) &&
    value.retryAfterSeconds >= 0
  ) {
    return value.retryAfterSeconds * 1000;
  }
  return 60_000;
}

export class ProviderSyncBackfillSource implements HistoricalBackfillSource {
  constructor(private readonly adapter: ProviderAdapter) {}

  async fetchPage(input: {
    cursor?: string;
    limit: number;
    since: string;
    until: string;
  }): Promise<HistoricalBackfillPage> {
    if (!this.adapter.capabilities().syncChanges) {
      throw new Error(
        `Provider "${this.adapter.kind}" does not support historical sync`,
      );
    }

    try {
      const result = await this.adapter.syncChanges({
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit,
      });
      const sinceMs = Date.parse(input.since);
      const untilMs = Date.parse(input.until);
      const messages = result.messages.filter((message) => {
        const received = Date.parse(message.receivedAt);
        return received >= sinceMs && received <= untilMs;
      });

      return {
        messages,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        hasMore: result.hasMore,
      };
    } catch (error) {
      const delay = rateLimitDelay(error);
      if (delay !== undefined) {
        throw new BackfillRateLimitError(delay);
      }
      throw error;
    }
  }
}
