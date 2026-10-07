import type {
  ActionExecutionResult,
} from "../actions/action-executor.js";
import type {
  ActionExecutionContext,
  MailboxActionPlan,
} from "../actions/action-types.js";
import type {
  IncrementalIngestionPipeline,
} from "../ingestion/ingestion-pipeline.js";
import type {
  IngestionSignal,
} from "../ingestion/ingestion-types.js";
import type {
  RetentionScheduler,
} from "../retention/retention-scheduler.js";
import type {
  RetentionJobStore,
  RetentionRunResult,
} from "../retention/retention-types.js";

export const BACKGROUND_AUTOMATION_WORKERS = [
  "ingestion",
  "classification",
  "policy_evaluation",
  "action_execution",
  "retention",
  "provider_maintenance",
] as const;

export type BackgroundAutomationWorkerKind =
  (typeof BACKGROUND_AUTOMATION_WORKERS)[number];

export type BackgroundAutomationJobPayload =
  Readonly<Record<string, unknown>>;

export interface BackgroundAutomationJob<
  TPayload extends BackgroundAutomationJobPayload =
    BackgroundAutomationJobPayload,
> {
  id: string;
  kind: BackgroundAutomationWorkerKind;
  tenantId: string;
  accountId: string;
  payload: TPayload;
  createdAt: string;
  availableAt: string;
  attempt: number;
  maxAttempts: number;
  claimedAt?: string | undefined;
  lastError?: string | undefined;
}

export interface BackgroundAutomationDeadLetter {
  job: BackgroundAutomationJob;
  failedAt: string;
  error: string;
}

export interface BackgroundAutomationQueueStats {
  queued: Record<BackgroundAutomationWorkerKind, number>;
  inFlight: Record<BackgroundAutomationWorkerKind, number>;
  deadLetters: Record<
    BackgroundAutomationWorkerKind,
    number
  >;
}

export interface BackgroundAutomationQueue {
  enqueue(job: BackgroundAutomationJob): Promise<boolean>;
  claimDue(
    kind: BackgroundAutomationWorkerKind,
    now: string,
    limit: number,
    staleClaimBefore: string,
  ): Promise<BackgroundAutomationJob[]>;
  complete(jobId: string): Promise<void>;
  retry(
    jobId: string,
    availableAt: string,
    error: string,
  ): Promise<void>;
  deadLetter(
    jobId: string,
    failedAt: string,
    error: string,
  ): Promise<void>;
  stats(): Promise<BackgroundAutomationQueueStats>;
  listDeadLetters(
    kind?: BackgroundAutomationWorkerKind,
  ): Promise<BackgroundAutomationDeadLetter[]>;
}

export interface BackgroundAutomationHandler {
  (
    job: BackgroundAutomationJob,
  ): Promise<unknown>;
}

export type BackgroundAutomationHandlers = Readonly<
  Record<
    BackgroundAutomationWorkerKind,
    BackgroundAutomationHandler
  >
>;

export interface BackgroundAutomationSupervisorOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  claimTimeoutMs?: number;
}

export interface BackgroundAutomationEnqueueInput {
  id: string;
  kind: BackgroundAutomationWorkerKind;
  tenantId: string;
  accountId: string;
  payload?: BackgroundAutomationJobPayload;
  availableAt?: string;
  maxAttempts?: number;
}

export interface BackgroundWorkerHealth {
  kind: BackgroundAutomationWorkerKind;
  status: "idle" | "running" | "healthy" | "degraded";
  processed: number;
  failedAttempts: number;
  deadLettered: number;
  consecutiveFailures: number;
  lastStartedAt?: string | undefined;
  lastSuccessAt?: string | undefined;
  lastFailureAt?: string | undefined;
  lastError?: string | undefined;
}

export interface BackgroundAutomationHealth {
  running: boolean;
  startedAt?: string;
  stoppedAt?: string;
  lastCycleAt?: string;
  workers: BackgroundWorkerHealth[];
  queue: BackgroundAutomationQueueStats;
}

function assertIso(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new TypeError(
      field + " must be an ISO-compatible timestamp",
    );
  }
}

function nonEmpty(
  value: string,
  field: string,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(field + " is required");
  }
  return normalized;
}

function emptyCountRecord(): Record<
  BackgroundAutomationWorkerKind,
  number
> {
  return Object.fromEntries(
    BACKGROUND_AUTOMATION_WORKERS.map((kind) => [
      kind,
      0,
    ]),
  ) as Record<BackgroundAutomationWorkerKind, number>;
}

function normalizeJob(
  input: BackgroundAutomationEnqueueInput,
  now: string,
  defaultMaxAttempts: number,
): BackgroundAutomationJob {
  const id = nonEmpty(input.id, "id");
  const tenantId = nonEmpty(
    input.tenantId,
    "tenantId",
  );
  const accountId = nonEmpty(
    input.accountId,
    "accountId",
  );
  if (
    !BACKGROUND_AUTOMATION_WORKERS.includes(
      input.kind,
    )
  ) {
    throw new TypeError(
      "Unsupported background worker kind",
    );
  }
  const availableAt = input.availableAt ?? now;
  assertIso(availableAt, "availableAt");
  const maxAttempts =
    input.maxAttempts ?? defaultMaxAttempts;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 100
  ) {
    throw new RangeError(
      "maxAttempts must be an integer between 1 and 100",
    );
  }

  return {
    id,
    kind: input.kind,
    tenantId,
    accountId,
    payload: structuredClone(input.payload ?? {}),
    createdAt: now,
    availableAt,
    attempt: 0,
    maxAttempts,
  };
}

function safeError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : String(error);
  return message.slice(0, 1000);
}

function retryDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
): number {
  const power = Math.max(0, attempt - 1);
  return Math.min(
    maxMs,
    baseMs * Math.pow(2, power),
  );
}

function cloneJob(
  job: BackgroundAutomationJob,
): BackgroundAutomationJob {
  return structuredClone(job);
}

export class InMemoryBackgroundAutomationQueue
  implements BackgroundAutomationQueue
{
  private readonly jobs = new Map<
    string,
    BackgroundAutomationJob
  >();
  private readonly dead = new Map<
    string,
    BackgroundAutomationDeadLetter
  >();

  async enqueue(
    job: BackgroundAutomationJob,
  ): Promise<boolean> {
    if (this.jobs.has(job.id) || this.dead.has(job.id)) {
      return false;
    }
    this.jobs.set(job.id, cloneJob(job));
    return true;
  }

  async claimDue(
    kind: BackgroundAutomationWorkerKind,
    now: string,
    limit: number,
    staleClaimBefore: string,
  ): Promise<BackgroundAutomationJob[]> {
    assertIso(now, "now");
    assertIso(staleClaimBefore, "staleClaimBefore");
    const nowMs = Date.parse(now);
    const staleBeforeMs = Date.parse(staleClaimBefore);
    const selected = [...this.jobs.values()]
      .filter((job) => {
        if (job.kind !== kind) return false;
        if (Date.parse(job.availableAt) > nowMs) {
          return false;
        }
        if (
          job.claimedAt &&
          Date.parse(job.claimedAt) > staleBeforeMs
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => {
        const available =
          left.availableAt.localeCompare(
            right.availableAt,
          );
        if (available !== 0) return available;
        const created = left.createdAt.localeCompare(
          right.createdAt,
        );
        return created !== 0
          ? created
          : left.id.localeCompare(right.id);
      })
      .slice(0, Math.max(1, limit));

    for (const job of selected) {
      this.jobs.set(job.id, {
        ...job,
        claimedAt: now,
      });
    }
    return selected.map((job) => ({
      ...cloneJob(job),
      claimedAt: now,
    }));
  }

  async complete(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }

  async retry(
    jobId: string,
    availableAt: string,
    error: string,
  ): Promise<void> {
    assertIso(availableAt, "availableAt");
    const existing = this.jobs.get(jobId);
    if (!existing) {
      throw new Error(
        "Background job was not found for retry",
      );
    }
    this.jobs.set(jobId, {
      ...existing,
      attempt: existing.attempt + 1,
      availableAt,
      claimedAt: undefined,
      lastError: error.slice(0, 1000),
    });
  }

  async deadLetter(
    jobId: string,
    failedAt: string,
    error: string,
  ): Promise<void> {
    assertIso(failedAt, "failedAt");
    const existing = this.jobs.get(jobId);
    if (!existing) {
      throw new Error(
        "Background job was not found for dead-letter",
      );
    }
    const failed: BackgroundAutomationJob = {
      ...existing,
      attempt: existing.attempt + 1,
      claimedAt: undefined,
      lastError: error.slice(0, 1000),
    };
    this.jobs.delete(jobId);
    this.dead.set(jobId, {
      job: cloneJob(failed),
      failedAt,
      error: error.slice(0, 1000),
    });
  }

  async stats(): Promise<BackgroundAutomationQueueStats> {
    const queued = emptyCountRecord();
    const inFlight = emptyCountRecord();
    const deadLetters = emptyCountRecord();

    for (const job of this.jobs.values()) {
      if (job.claimedAt) {
        inFlight[job.kind] += 1;
      } else {
        queued[job.kind] += 1;
      }
    }
    for (const entry of this.dead.values()) {
      deadLetters[entry.job.kind] += 1;
    }

    return {
      queued,
      inFlight,
      deadLetters,
    };
  }

  async listDeadLetters(
    kind?: BackgroundAutomationWorkerKind,
  ): Promise<BackgroundAutomationDeadLetter[]> {
    return [...this.dead.values()]
      .filter(
        (entry) =>
          kind === undefined ||
          entry.job.kind === kind,
      )
      .sort((left, right) =>
        left.failedAt.localeCompare(right.failedAt),
      )
      .map((entry) => structuredClone(entry));
  }
}

function initialHealth(
  kind: BackgroundAutomationWorkerKind,
): BackgroundWorkerHealth {
  return {
    kind,
    status: "idle",
    processed: 0,
    failedAttempts: 0,
    deadLettered: 0,
    consecutiveFailures: 0,
  };
}

export class BackgroundAutomationSupervisor {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly defaultMaxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly claimTimeoutMs: number;
  private readonly workerHealth = new Map<
    BackgroundAutomationWorkerKind,
    BackgroundWorkerHealth
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private cycleInFlight: Promise<void> | undefined;
  private startedAt: string | undefined;
  private stoppedAt: string | undefined;
  private lastCycleAt: string | undefined;

  constructor(
    private readonly queue: BackgroundAutomationQueue,
    private readonly handlers: BackgroundAutomationHandlers,
    private readonly options: BackgroundAutomationSupervisorOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.pollIntervalMs = Math.max(
      10,
      options.pollIntervalMs ?? 1_000,
    );
    this.batchSize = Math.max(
      1,
      Math.min(options.batchSize ?? 25, 500),
    );
    this.defaultMaxAttempts = Math.max(
      1,
      Math.min(options.maxAttempts ?? 5, 100),
    );
    this.retryBaseDelayMs = Math.max(
      10,
      options.retryBaseDelayMs ?? 1_000,
    );
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      options.retryMaxDelayMs ?? 5 * 60_000,
    );
    this.claimTimeoutMs = Math.max(
      1_000,
      options.claimTimeoutMs ?? 5 * 60_000,
    );

    for (const kind of BACKGROUND_AUTOMATION_WORKERS) {
      if (typeof handlers[kind] !== "function") {
        throw new TypeError(
          "Missing background worker handler for " + kind,
        );
      }
      this.workerHealth.set(
        kind,
        initialHealth(kind),
      );
    }
  }

  async enqueue(
    input: BackgroundAutomationEnqueueInput,
  ): Promise<{ enqueued: boolean; job: BackgroundAutomationJob }> {
    const now = this.now().toISOString();
    const job = normalizeJob(
      input,
      now,
      this.defaultMaxAttempts,
    );
    return {
      enqueued: await this.queue.enqueue(job),
      job: cloneJob(job),
    };
  }

  async runWorkerOnce(
    kind: BackgroundAutomationWorkerKind,
  ): Promise<void> {
    const started = this.now();
    const startedAt = started.toISOString();
    const staleClaimBefore = new Date(
      started.getTime() - this.claimTimeoutMs,
    ).toISOString();
    const current =
      this.workerHealth.get(kind) ??
      initialHealth(kind);
    this.workerHealth.set(kind, {
      ...current,
      status: "running",
      lastStartedAt: startedAt,
    });

    let claimed: BackgroundAutomationJob[];
    try {
      claimed = await this.queue.claimDue(
        kind,
        startedAt,
        this.batchSize,
        staleClaimBefore,
      );
    } catch (error) {
      this.recordWorkerFailure(
        kind,
        startedAt,
        safeError(error),
        false,
      );
      return;
    }

    if (claimed.length === 0) {
      const state =
        this.workerHealth.get(kind) ??
        initialHealth(kind);
      this.workerHealth.set(kind, {
        ...state,
        status:
          state.consecutiveFailures > 0
            ? "degraded"
            : "healthy",
      });
      return;
    }

    for (const job of claimed) {
      try {
        await this.handlers[kind](cloneJob(job));
        await this.queue.complete(job.id);
        const state =
          this.workerHealth.get(kind) ??
          initialHealth(kind);
        this.workerHealth.set(kind, {
          ...state,
          status: "healthy",
          processed: state.processed + 1,
          consecutiveFailures: 0,
          lastSuccessAt: this.now().toISOString(),
          lastError: undefined,
        });
      } catch (error) {
        const errorText = safeError(error);
        const failureAt = this.now();
        const nextAttempt = job.attempt + 1;
        const exhausted =
          nextAttempt >= job.maxAttempts;
        try {
          if (exhausted) {
            await this.queue.deadLetter(
              job.id,
              failureAt.toISOString(),
              errorText,
            );
          } else {
            const delay = retryDelay(
              nextAttempt,
              this.retryBaseDelayMs,
              this.retryMaxDelayMs,
            );
            await this.queue.retry(
              job.id,
              new Date(
                failureAt.getTime() + delay,
              ).toISOString(),
              errorText,
            );
          }
        } catch (queueError) {
          this.recordWorkerFailure(
            kind,
            failureAt.toISOString(),
            errorText +
              "; queue transition failed: " +
              safeError(queueError),
            false,
          );
          continue;
        }
        this.recordWorkerFailure(
          kind,
          failureAt.toISOString(),
          errorText,
          exhausted,
        );
      }
    }
  }

  async runCycle(): Promise<void> {
    if (this.cycleInFlight) {
      return this.cycleInFlight;
    }

    const cycle = Promise.all(
      BACKGROUND_AUTOMATION_WORKERS.map((kind) =>
        this.runWorkerOnce(kind),
      ),
    ).then(() => {
      this.lastCycleAt = this.now().toISOString();
    });
    this.cycleInFlight = cycle.finally(() => {
      this.cycleInFlight = undefined;
    });
    return this.cycleInFlight;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = this.now().toISOString();
    this.stoppedAt = undefined;

    void this.runCycle();
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.cycleInFlight) {
      await this.cycleInFlight;
    }
    this.stoppedAt = this.now().toISOString();
  }

  async health(): Promise<BackgroundAutomationHealth> {
    return {
      running: Boolean(this.timer),
      ...(this.startedAt
        ? { startedAt: this.startedAt }
        : {}),
      ...(this.stoppedAt
        ? { stoppedAt: this.stoppedAt }
        : {}),
      ...(this.lastCycleAt
        ? { lastCycleAt: this.lastCycleAt }
        : {}),
      workers: BACKGROUND_AUTOMATION_WORKERS.map(
        (kind) =>
          structuredClone(
            this.workerHealth.get(kind) ??
              initialHealth(kind),
          ),
      ),
      queue: await this.queue.stats(),
    };
  }

  async deadLetters(
    kind?: BackgroundAutomationWorkerKind,
  ): Promise<BackgroundAutomationDeadLetter[]> {
    return this.queue.listDeadLetters(kind);
  }

  private recordWorkerFailure(
    kind: BackgroundAutomationWorkerKind,
    at: string,
    error: string,
    deadLettered: boolean,
  ): void {
    const state =
      this.workerHealth.get(kind) ??
      initialHealth(kind);
    this.workerHealth.set(kind, {
      ...state,
      status: "degraded",
      failedAttempts: state.failedAttempts + 1,
      deadLettered:
        state.deadLettered +
        (deadLettered ? 1 : 0),
      consecutiveFailures:
        state.consecutiveFailures + 1,
      lastFailureAt: at,
      lastError: error,
    });
  }
}

function requiredPayloadValue<T>(
  job: BackgroundAutomationJob,
  name: string,
): T {
  if (!(name in job.payload)) {
    throw new TypeError(
      "Background job payload." + name + " is required",
    );
  }
  return job.payload[name] as T;
}

export function createIngestionWorkerHandler(
  pipeline: Pick<IncrementalIngestionPipeline, "handle">,
): BackgroundAutomationHandler {
  return async (job) => {
    const signal = requiredPayloadValue<IngestionSignal>(
      job,
      "signal",
    );
    if (
      signal.tenantId !== job.tenantId ||
      signal.accountId !== job.accountId
    ) {
      throw new Error(
        "Ingestion job tenant/account context does not match signal",
      );
    }
    return pipeline.handle(signal);
  };
}

export interface BackgroundClassificationService {
  classifyMessage(
    tenantId: string,
    accountId: string,
    canonicalMessageId: string,
  ): Promise<unknown>;
}

export function createClassificationWorkerHandler(
  service: BackgroundClassificationService,
): BackgroundAutomationHandler {
  return async (job) =>
    service.classifyMessage(
      job.tenantId,
      job.accountId,
      nonEmpty(
        requiredPayloadValue<string>(
          job,
          "canonicalMessageId",
        ),
        "payload.canonicalMessageId",
      ),
    );
}

export interface BackgroundPolicyEvaluationService {
  evaluateMessage(
    tenantId: string,
    accountId: string,
    canonicalMessageId: string,
  ): Promise<unknown>;
}

export function createPolicyEvaluationWorkerHandler(
  service: BackgroundPolicyEvaluationService,
): BackgroundAutomationHandler {
  return async (job) =>
    service.evaluateMessage(
      job.tenantId,
      job.accountId,
      nonEmpty(
        requiredPayloadValue<string>(
          job,
          "canonicalMessageId",
        ),
        "payload.canonicalMessageId",
      ),
    );
}

export interface BackgroundActionExecutor {
  execute(
    plan: MailboxActionPlan,
    context: ActionExecutionContext,
  ): Promise<ActionExecutionResult>;
}

export function createActionExecutionWorkerHandler(
  executor: BackgroundActionExecutor,
): BackgroundAutomationHandler {
  return async (job) => {
    const plan = requiredPayloadValue<MailboxActionPlan>(
      job,
      "plan",
    );
    if (
      plan.tenantId !== job.tenantId ||
      plan.accountId !== job.accountId
    ) {
      throw new Error(
        "Action job tenant/account context does not match plan",
      );
    }
    return executor.execute(plan, {
      tenantId: job.tenantId,
      accountId: job.accountId,
      actorType: "system",
      actorId: "background-worker",
    });
  };
}

export function createRetentionWorkerHandler(
  scheduler: Pick<RetentionScheduler, "run">,
  jobs: Pick<RetentionJobStore, "get">,
): BackgroundAutomationHandler {
  return async (job) => {
    const retentionJobId = nonEmpty(
      requiredPayloadValue<string>(
        job,
        "retentionJobId",
      ),
      "payload.retentionJobId",
    );
    const retentionJob = await jobs.get(
      retentionJobId,
    );
    if (!retentionJob) {
      throw new Error(
        "Retention job was not found",
      );
    }
    if (
      retentionJob.tenantId !== job.tenantId ||
      retentionJob.accountId !== job.accountId
    ) {
      throw new Error(
        "Retention job tenant/account context does not match queue job",
      );
    }
    return scheduler.run(
      retentionJobId,
    ) as Promise<RetentionRunResult>;
  };
}

export interface BackgroundProviderMaintenanceService {
  reconcileAndRenew(input: {
    tenantId: string;
    accountId: string;
  }): Promise<unknown>;
}

export function createProviderMaintenanceWorkerHandler(
  service: BackgroundProviderMaintenanceService,
): BackgroundAutomationHandler {
  return async (job) =>
    service.reconcileAndRenew({
      tenantId: job.tenantId,
      accountId: job.accountId,
    });
}
