import type {
  ProviderConnectionContext,
} from "../providers/provider-adapter.js";
import type {
  ProviderKind,
} from "../domain/email-model.js";

export const OPERATIONAL_METRICS = [
  "ingestion_lag_ms",
  "ingestion_result",
  "classify_latency_ms",
  "classifier_version",
  "action_result",
  "provider_retry",
  "provider_throttled",
  "webhook_health",
  "queue_depth",
  "queue_in_flight",
  "queue_dead_letters",
  "worker_retry",
  "worker_dead_letter",
] as const;

export type OperationalMetricName =
  (typeof OPERATIONAL_METRICS)[number];

export type OperationalMetricStatus =
  | "ok"
  | "received"
  | "processed"
  | "deduplicated"
  | "coalesced"
  | "retrying"
  | "throttled"
  | "succeeded"
  | "failed"
  | "dead_lettered";

export interface OperationalMetricEvent {
  metric: OperationalMetricName;
  timestamp: string;
  value: number;
  status?: OperationalMetricStatus;
  tenantId?: string;
  accountId?: string;
  provider?: ProviderKind;
  worker?: string;
  action?: string;
  source?: string;
  classifierVersion?: string;
  attempt?: number;
  retryAfterMs?: number;
}

export interface OperationalTelemetry {
  record(event: OperationalMetricEvent): Promise<void>;
}

export interface OperationalMetricSnapshot {
  counters: Readonly<Record<string, number>>;
  gauges: Readonly<Record<string, number>>;
  observations: Readonly<Record<string, {
    count: number;
    min: number;
    max: number;
    average: number;
  }>>;
  latestAt?: string;
}

const COUNTER_METRICS = new Set<OperationalMetricName>([
  "ingestion_result",
  "classifier_version",
  "action_result",
  "provider_retry",
  "provider_throttled",
  "webhook_health",
  "worker_retry",
  "worker_dead_letter",
]);

const GAUGE_METRICS = new Set<OperationalMetricName>([
  "queue_depth",
  "queue_in_flight",
  "queue_dead_letters",
]);

const OBSERVATION_METRICS = new Set<OperationalMetricName>([
  "ingestion_lag_ms",
  "classify_latency_ms",
]);

const UNSAFE_DIMENSION =
  new RegExp("[\\x00-\\x1F\\x7F]", "g");

function safeDimension(
  value: string | undefined,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value
    .replace(UNSAFE_DIMENSION, "")
    .trim();
  if (!normalized) {
    throw new TypeError(field + " must be non-empty when provided");
  }
  if (normalized.length > 120) {
    throw new RangeError(field + " must be 120 characters or fewer");
  }
  return normalized;
}

const ALLOWED_EVENT_FIELDS = new Set([
  "metric",
  "timestamp",
  "value",
  "status",
  "tenantId",
  "accountId",
  "provider",
  "worker",
  "action",
  "source",
  "classifierVersion",
  "attempt",
  "retryAfterMs",
]);

function assertEvent(
  event: OperationalMetricEvent,
): OperationalMetricEvent {
  for (const key of Object.keys(
    event as unknown as Record<string, unknown>,
  )) {
    if (!ALLOWED_EVENT_FIELDS.has(key)) {
      throw new TypeError(
        'Operational telemetry field "' +
          key +
          '" is not allowed',
      );
    }
  }
  if (!OPERATIONAL_METRICS.includes(event.metric)) {
    throw new TypeError("Unknown operational metric");
  }
  if (
    !Number.isFinite(event.value) ||
    event.value < 0
  ) {
    throw new RangeError(
      "Operational metric value must be a finite non-negative number",
    );
  }
  if (Number.isNaN(Date.parse(event.timestamp))) {
    throw new TypeError(
      "Operational metric timestamp must be ISO-compatible",
    );
  }
  if (
    event.retryAfterMs !== undefined &&
    (!Number.isFinite(event.retryAfterMs) ||
      event.retryAfterMs < 0)
  ) {
    throw new RangeError(
      "retryAfterMs must be a finite non-negative number",
    );
  }
  if (
    event.attempt !== undefined &&
    (!Number.isInteger(event.attempt) ||
      event.attempt < 0 ||
      event.attempt > 100)
  ) {
    throw new RangeError(
      "attempt must be an integer between 0 and 100",
    );
  }

  return {
    ...event,
    timestamp: new Date(event.timestamp).toISOString(),
    ...(event.tenantId
      ? { tenantId: safeDimension(event.tenantId, "tenantId")! }
      : {}),
    ...(event.accountId
      ? { accountId: safeDimension(event.accountId, "accountId")! }
      : {}),
    ...(event.worker
      ? { worker: safeDimension(event.worker, "worker")! }
      : {}),
    ...(event.action
      ? { action: safeDimension(event.action, "action")! }
      : {}),
    ...(event.source
      ? { source: safeDimension(event.source, "source")! }
      : {}),
    ...(event.classifierVersion
      ? {
          classifierVersion: safeDimension(
            event.classifierVersion,
            "classifierVersion",
          )!,
        }
      : {}),
  };
}

function dimensions(
  event: OperationalMetricEvent,
): string {
  return [
    event.metric,
    event.status ?? "",
    event.provider ?? "",
    event.worker ?? "",
    event.action ?? "",
    event.source ?? "",
    event.classifierVersion ?? "",
  ].join("|");
}

export class InMemoryOperationalTelemetry
  implements OperationalTelemetry
{
  readonly events: OperationalMetricEvent[] = [];

  constructor(
    private readonly maxEvents = 5000,
  ) {}

  async record(event: OperationalMetricEvent): Promise<void> {
    const safe = assertEvent(event);
    this.events.push(structuredClone(safe));
    const overflow =
      this.events.length - Math.max(1, this.maxEvents);
    if (overflow > 0) {
      this.events.splice(0, overflow);
    }
  }

  list(filter: {
    tenantId?: string;
    accountId?: string;
    metric?: OperationalMetricName;
  } = {}): OperationalMetricEvent[] {
    return this.events
      .filter(
        (event) =>
          (filter.tenantId === undefined ||
            event.tenantId === filter.tenantId) &&
          (filter.accountId === undefined ||
            event.accountId === filter.accountId) &&
          (filter.metric === undefined ||
            event.metric === filter.metric),
      )
      .map((event) => structuredClone(event));
  }

  snapshot(): OperationalMetricSnapshot {
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const rawObservations = new Map<
      string,
      { count: number; min: number; max: number; total: number }
    >();
    let latestAt: string | undefined;

    for (const event of this.events) {
      const key = dimensions(event);
      if (
        !latestAt ||
        event.timestamp.localeCompare(latestAt) > 0
      ) {
        latestAt = event.timestamp;
      }

      if (COUNTER_METRICS.has(event.metric)) {
        counters[key] =
          (counters[key] ?? 0) + event.value;
      } else if (GAUGE_METRICS.has(event.metric)) {
        gauges[key] = event.value;
      } else if (OBSERVATION_METRICS.has(event.metric)) {
        const current = rawObservations.get(key);
        rawObservations.set(
          key,
          current
            ? {
                count: current.count + 1,
                min: Math.min(current.min, event.value),
                max: Math.max(current.max, event.value),
                total: current.total + event.value,
              }
            : {
                count: 1,
                min: event.value,
                max: event.value,
                total: event.value,
              },
        );
      }
    }

    const observations: Record<
      string,
      {
        count: number;
        min: number;
        max: number;
        average: number;
      }
    > = {};
    for (const [key, value] of rawObservations) {
      observations[key] = {
        count: value.count,
        min: value.min,
        max: value.max,
        average: value.total / value.count,
      };
    }

    return {
      counters,
      gauges,
      observations,
      ...(latestAt ? { latestAt } : {}),
    };
  }
}

export interface ProviderThrottleScope
  extends ProviderConnectionContext {
  provider: ProviderKind;
}

function throttleKey(
  scope: ProviderThrottleScope,
): string {
  return [
    scope.tenantId,
    scope.accountId,
    scope.provider,
  ].join("\u0000");
}

export class ProviderRateLimitTracker {
  private readonly until = new Map<string, string>();

  noteThrottle(
    scope: ProviderThrottleScope,
    retryAfterMs: number,
    now = new Date(),
  ): string {
    if (
      !Number.isFinite(retryAfterMs) ||
      retryAfterMs < 0
    ) {
      throw new RangeError(
        "retryAfterMs must be a finite non-negative number",
      );
    }
    const retryAt = new Date(
      now.getTime() + retryAfterMs,
    ).toISOString();
    const key = throttleKey(scope);
    const current = this.until.get(key);
    if (!current || retryAt.localeCompare(current) > 0) {
      this.until.set(key, retryAt);
    }
    return this.until.get(key)!;
  }

  remainingMs(
    scope: ProviderThrottleScope,
    now = new Date(),
  ): number {
    const key = throttleKey(scope);
    const retryAt = this.until.get(key);
    if (!retryAt) return 0;
    const remaining = Math.max(
      0,
      Date.parse(retryAt) - now.getTime(),
    );
    if (remaining === 0) {
      this.until.delete(key);
    }
    return remaining;
  }

  clear(scope: ProviderThrottleScope): void {
    this.until.delete(throttleKey(scope));
  }

  snapshot(): ReadonlyArray<{
    tenantId: string;
    accountId: string;
    provider: ProviderKind;
    retryAt: string;
  }> {
    const rows: Array<{
      tenantId: string;
      accountId: string;
      provider: ProviderKind;
      retryAt: string;
    }> = [];
    for (const [key, retryAt] of this.until) {
      const [tenantId, accountId, provider] =
        key.split("\u0000");
      if (!tenantId || !accountId || !provider) continue;
      rows.push({
        tenantId,
        accountId,
        provider: provider as ProviderKind,
        retryAt,
      });
    }
    return rows;
  }
}

export interface ProviderRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export function parseRetryAfterMs(
  value: string | null,
  now = new Date(),
): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (
    Number.isFinite(seconds) &&
    seconds >= 0
  ) {
    return seconds * 1000;
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}

export function providerRetryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  policy: ProviderRetryPolicy,
  now = new Date(),
): number {
  const base = Math.max(1, policy.baseDelayMs);
  const max = Math.max(base, policy.maxDelayMs);
  const retryAfter = parseRetryAfterMs(
    retryAfterHeader,
    now,
  );
  const exponential =
    base * 2 ** Math.max(0, attempt);
  return Math.min(
    max,
    retryAfter ?? exponential,
  );
}

export function isWebhookLikeSource(
  source: string,
): boolean {
  return (
    source === "gmail_push" ||
    source === "microsoft_graph_webhook" ||
    source === "imap_idle" ||
    source === "jmap_change"
  );
}
