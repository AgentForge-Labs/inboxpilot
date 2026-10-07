import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_AUTOMATION_WORKERS,
  BackgroundAutomationSupervisor,
  InMemoryBackgroundAutomationQueue,
  createIngestionWorkerHandler,
  type BackgroundAutomationHandlers,
  type BackgroundAutomationJob,
  type BackgroundAutomationWorkerKind,
  type IngestionSignal,
} from "../src/index.js";

function handlers(
  fn: (
    kind: BackgroundAutomationWorkerKind,
    job: BackgroundAutomationJob,
  ) => Promise<unknown> = async () => undefined,
): BackgroundAutomationHandlers {
  return Object.fromEntries(
    BACKGROUND_AUTOMATION_WORKERS.map((kind) => [
      kind,
      (job: BackgroundAutomationJob) =>
        fn(kind, job),
    ]),
  ) as unknown as BackgroundAutomationHandlers;
}

function clock(
  initial = "2026-10-07T12:00:00.000Z",
) {
  let ms = Date.parse(initial);
  return {
    now: () => new Date(ms),
    advance(value: number) {
      ms += value;
    },
  };
}

test("autonomous supervisor runs all six workers without any MCP session", async () => {
  const queue = new InMemoryBackgroundAutomationQueue();
  const seen = new Map<
    BackgroundAutomationWorkerKind,
    string[]
  >();
  const time = clock();
  const supervisor = new BackgroundAutomationSupervisor(
    queue,
    handlers(async (kind, job) => {
      const values = seen.get(kind) ?? [];
      values.push(job.id);
      seen.set(kind, values);
    }),
    {
      pollIntervalMs: 60_000,
      batchSize: 10,
    },
    time.now,
  );

  for (const kind of BACKGROUND_AUTOMATION_WORKERS) {
    const result = await supervisor.enqueue({
      id: "job-" + kind,
      kind,
      tenantId: "tenant-1",
      accountId: "account-1",
      payload: { marker: kind },
    });
    assert.equal(result.enqueued, true);
  }

  supervisor.start();
  await supervisor.stop();

  for (const kind of BACKGROUND_AUTOMATION_WORKERS) {
    assert.deepEqual(seen.get(kind), [
      "job-" + kind,
    ]);
  }

  const health = await supervisor.health();
  assert.equal(health.running, false);
  assert.ok(health.startedAt);
  assert.ok(health.stoppedAt);
  assert.ok(health.lastCycleAt);
  for (const worker of health.workers) {
    assert.equal(worker.status, "healthy");
    assert.equal(worker.processed, 1);
    assert.equal(worker.failedAttempts, 0);
    assert.equal(worker.deadLettered, 0);
  }
  assert.equal(
    Object.values(health.queue.queued).reduce(
      (sum, value) => sum + value,
      0,
    ),
    0,
  );
});

test("transient failures retry with bounded backoff and recover health", async () => {
  const queue = new InMemoryBackgroundAutomationQueue();
  const time = clock();
  let attempts = 0;
  const supervisor = new BackgroundAutomationSupervisor(
    queue,
    handlers(async (kind) => {
      if (kind !== "classification") return;
      attempts += 1;
      if (attempts === 1) {
        throw new Error("temporary model outage");
      }
    }),
    {
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 4_000,
      maxAttempts: 3,
    },
    time.now,
  );

  await supervisor.enqueue({
    id: "classification-1",
    kind: "classification",
    tenantId: "tenant-1",
    accountId: "account-1",
    payload: {
      canonicalMessageId: "message-1",
    },
  });

  await supervisor.runWorkerOnce("classification");
  assert.equal(attempts, 1);
  let health = await supervisor.health();
  let worker = health.workers.find(
    (entry) => entry.kind === "classification",
  )!;
  assert.equal(worker.status, "degraded");
  assert.equal(worker.failedAttempts, 1);
  assert.equal(
    health.queue.queued.classification,
    1,
  );

  time.advance(999);
  await supervisor.runWorkerOnce("classification");
  assert.equal(attempts, 1);

  time.advance(1);
  await supervisor.runWorkerOnce("classification");
  assert.equal(attempts, 2);

  health = await supervisor.health();
  worker = health.workers.find(
    (entry) => entry.kind === "classification",
  )!;
  assert.equal(worker.status, "healthy");
  assert.equal(worker.processed, 1);
  assert.equal(worker.consecutiveFailures, 0);
  assert.equal(
    health.queue.queued.classification,
    0,
  );
});

test("exhausted retries move to dead-letter while other workers keep progressing", async () => {
  const queue = new InMemoryBackgroundAutomationQueue();
  const time = clock();
  let ingestionRuns = 0;
  let actionRuns = 0;
  const supervisor = new BackgroundAutomationSupervisor(
    queue,
    handlers(async (kind) => {
      if (kind === "ingestion") {
        ingestionRuns += 1;
        return;
      }
      if (kind === "action_execution") {
        actionRuns += 1;
        throw new Error("provider mutation unavailable");
      }
    }),
    {
      retryBaseDelayMs: 1_000,
      maxAttempts: 2,
    },
    time.now,
  );

  await supervisor.enqueue({
    id: "ingestion-ok",
    kind: "ingestion",
    tenantId: "tenant-1",
    accountId: "account-1",
  });
  await supervisor.enqueue({
    id: "action-fails",
    kind: "action_execution",
    tenantId: "tenant-1",
    accountId: "account-1",
    maxAttempts: 2,
  });

  await supervisor.runCycle();
  assert.equal(ingestionRuns, 1);
  assert.equal(actionRuns, 1);

  time.advance(1_000);
  await supervisor.runCycle();
  assert.equal(actionRuns, 2);

  const health = await supervisor.health();
  const action = health.workers.find(
    (entry) => entry.kind === "action_execution",
  )!;
  assert.equal(action.status, "degraded");
  assert.equal(action.failedAttempts, 2);
  assert.equal(action.deadLettered, 1);
  assert.equal(
    health.queue.deadLetters.action_execution,
    1,
  );

  const dead = await supervisor.deadLetters(
    "action_execution",
  );
  assert.equal(dead.length, 1);
  assert.equal(dead[0]?.job.id, "action-fails");
  assert.equal(dead[0]?.job.attempt, 2);
  assert.match(dead[0]?.error ?? "", /provider mutation unavailable/);
});

test("queue reclaims stale in-flight jobs after the claim timeout boundary", async () => {
  const queue = new InMemoryBackgroundAutomationQueue();
  await queue.enqueue({
    id: "stale-job",
    kind: "policy_evaluation",
    tenantId: "tenant-1",
    accountId: "account-1",
    payload: {},
    createdAt: "2026-10-07T12:00:00.000Z",
    availableAt: "2026-10-07T12:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
  });

  const first = await queue.claimDue(
    "policy_evaluation",
    "2026-10-07T12:00:00.000Z",
    10,
    "2026-10-07T11:55:00.000Z",
  );
  assert.equal(first.length, 1);

  const stillLeased = await queue.claimDue(
    "policy_evaluation",
    "2026-10-07T12:01:00.000Z",
    10,
    "2026-10-07T11:56:00.000Z",
  );
  assert.equal(stillLeased.length, 0);

  const reclaimed = await queue.claimDue(
    "policy_evaluation",
    "2026-10-07T12:06:00.000Z",
    10,
    "2026-10-07T12:01:00.000Z",
  );
  assert.equal(reclaimed.length, 1);
  assert.equal(
    reclaimed[0]?.claimedAt,
    "2026-10-07T12:06:00.000Z",
  );
});

test("ingestion adapter rejects cross-account jobs before touching the pipeline", async () => {
  const calls: IngestionSignal[] = [];
  const handler = createIngestionWorkerHandler({
    async handle(signal) {
      calls.push(signal);
      return {
        status: "processed",
        signalId: signal.id,
        pages: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deletedMarked: 0,
      };
    },
  });

  const signal: IngestionSignal = {
    id: "signal-1",
    source: "scheduled_reconciliation",
    tenantId: "tenant-1",
    accountId: "account-1",
    provider: "gmail",
    receivedAt: "2026-10-07T12:00:00.000Z",
  };
  const base: BackgroundAutomationJob = {
    id: "ingestion-1",
    kind: "ingestion",
    tenantId: "tenant-1",
    accountId: "account-1",
    payload: { signal },
    createdAt: "2026-10-07T12:00:00.000Z",
    availableAt: "2026-10-07T12:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
  };

  await handler(base);
  assert.equal(calls.length, 1);

  await assert.rejects(
    () =>
      handler({
        ...base,
        id: "ingestion-cross-account",
        accountId: "account-2",
      }),
    /tenant\/account context does not match signal/,
  );
  assert.equal(calls.length, 1);
});
