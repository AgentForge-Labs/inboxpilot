import type {
  CanonicalMessage,
  MailboxRole,
} from "../domain/email-model.js";
import type {
  ProviderAdapter,
  ProviderCapabilityName,
} from "../providers/provider-adapter.js";
import {
  actionPlanHash,
  assertExplicitActionPlan,
  snapshotMessage,
  type ActionExecutionContext,
  type MailboxActionPlan,
  type MessageStateSnapshot,
} from "./action-types.js";
import type {
  ActionExecutionStore,
  MutationRecord,
} from "./action-store.js";
import type {
  OperationalTelemetry,
} from "../observability/operational-telemetry.js";
import {
  classifyMutationError,
  isRetrySafeMutation,
} from "./error-classifier.js";

export class ActionAuthorizationError extends Error {
  readonly code = "ACTION_AUTHORIZATION_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "ActionAuthorizationError";
  }
}

export class ActionPreconditionError extends Error {
  readonly code = "ACTION_PRECONDITION_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "ActionPreconditionError";
  }
}

export class ActionIdempotencyConflictError extends Error {
  readonly code = "ACTION_IDEMPOTENCY_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ActionIdempotencyConflictError";
  }
}

export class ActionInProgressError extends Error {
  readonly code = "ACTION_ALREADY_IN_PROGRESS";
  constructor(message: string) {
    super(message);
    this.name = "ActionInProgressError";
  }
}

export interface ProviderAdapterResolver {
  resolve(
    tenantId: string,
    accountId: string,
    provider: MailboxActionPlan["provider"],
  ): Promise<ProviderAdapter>;
}

export interface ActionExecutionResult {
  status: "executed" | "deduplicated";
  idempotencyKey: string;
  attempts: number;
  beforeState: MessageStateSnapshot;
  afterState: MessageStateSnapshot | null;
  afterStateStatus: "captured" | "unavailable" | "deleted";
}

export interface ActionExplainabilityRecorder {
  recordActionExecution(
    plan: MailboxActionPlan,
    context: ActionExecutionContext,
    result: ActionExecutionResult,
    outcome?: "succeeded" | "deduplicated",
    timestamp?: string,
  ): Promise<unknown>;
  recordActionFailure(
    plan: MailboxActionPlan,
    context: ActionExecutionContext,
    beforeState: MessageStateSnapshot,
    error: {
      code: string;
      category?: string;
      message: string;
    },
    timestamp?: string,
  ): Promise<unknown>;
}

export interface ActionExecutorOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  auditRecorder?: ActionExplainabilityRecorder;
  operationalTelemetry?: OperationalTelemetry;
  now?: () => Date;
}

const CAPABILITY_BY_ACTION: Readonly<
  Record<MailboxActionPlan["action"]["type"], ProviderCapabilityName>
> = Object.freeze({
  archive: "archive",
  move: "move",
  trash: "trash",
  restore: "restore",
  delete_permanent: "deletePermanent",
  add_label: "addLabel",
  remove_label: "removeLabel",
  mark_important: "markImportant",
  star: "star",
  mark_read: "markRead",
});

function isDestructiveAction(
  action: MailboxActionPlan["action"]["type"],
): boolean {
  return action === "trash" || action === "delete_permanent";
}

function checkExpectedFlag(
  expected: boolean | undefined,
  actual: boolean,
  field: string,
): void {
  if (expected !== undefined && expected !== actual) {
    throw new ActionPreconditionError(
      `Expected message ${field}=${expected}, got ${actual}`,
    );
  }
}

function assertPlanAuthorization(
  plan: MailboxActionPlan,
  context: ActionExecutionContext,
): void {
  if (
    plan.tenantId !== context.tenantId ||
    plan.accountId !== context.accountId
  ) {
    throw new ActionAuthorizationError(
      "Action plan tenant/account does not match execution context",
    );
  }

  if (
    isDestructiveAction(plan.action.type) &&
    !plan.destructiveAuthorization
  ) {
    throw new ActionAuthorizationError(
      `${plan.action.type} requires destructive authorization`,
    );
  }

  if (
    plan.destructiveAuthorization &&
    !plan.destructiveAuthorization.policyId &&
    !plan.destructiveAuthorization.userConfirmationId
  ) {
    throw new ActionAuthorizationError(
      "Destructive authorization requires policyId or userConfirmationId",
    );
  }
}

function assertMessagePreconditions(
  plan: MailboxActionPlan,
  message: CanonicalMessage,
): void {
  if (
    message.tenantId !== plan.tenantId ||
    message.accountId !== plan.accountId
  ) {
    throw new ActionAuthorizationError(
      "Provider message tenant/account does not match action plan",
    );
  }
  if (
    message.provider.kind !== plan.provider ||
    message.provider.messageId !== plan.providerMessageId
  ) {
    throw new ActionPreconditionError(
      "Provider message identity changed before mutation",
    );
  }

  const preconditions = plan.preconditions;
  if (preconditions?.expectedCanonicalMessageId &&
      preconditions.expectedCanonicalMessageId !== message.id) {
    throw new ActionPreconditionError(
      "Canonical message identity changed before mutation",
    );
  }
  if (
    preconditions?.expectedUpdatedAt &&
    preconditions.expectedUpdatedAt !== message.updatedAt
  ) {
    throw new ActionPreconditionError(
      "Message changed after action plan was created",
    );
  }

  if (preconditions?.requiredMailboxRole) {
    const roles = new Set(message.mailboxes.map((mailbox) => mailbox.role));
    if (!roles.has(preconditions.requiredMailboxRole)) {
      throw new ActionPreconditionError(
        `Message is no longer in required mailbox role "${preconditions.requiredMailboxRole}"`,
      );
    }
  }

  checkExpectedFlag(
    preconditions?.expectedRead,
    message.flags.read,
    "read",
  );
  checkExpectedFlag(
    preconditions?.expectedStarred,
    message.flags.starred,
    "starred",
  );
  checkExpectedFlag(
    preconditions?.expectedImportant,
    message.flags.important,
    "important",
  );

  const requiresUnprotected =
    preconditions?.requireUnprotected ??
    isDestructiveAction(plan.action.type);
  if (requiresUnprotected && message.retention.protected) {
    throw new ActionPreconditionError(
      `Protected message cannot execute ${plan.action.type}: ${message.retention.protectionReasons.join(", ") || "protected"}`,
    );
  }
}

async function executeProviderMutation(
  adapter: ProviderAdapter,
  plan: MailboxActionPlan,
): Promise<void> {
  const messageId = plan.providerMessageId;
  switch (plan.action.type) {
    case "archive":
      return adapter.archive(messageId);
    case "move":
      return adapter.move(messageId, { folderId: plan.action.folderId });
    case "trash":
      return adapter.trash(messageId);
    case "restore":
      return adapter.restore(messageId);
    case "delete_permanent":
      return adapter.deletePermanent(messageId);
    case "add_label":
      return adapter.addLabel(messageId, plan.action.labelId);
    case "remove_label":
      return adapter.removeLabel(messageId, plan.action.labelId);
    case "mark_important":
      return adapter.markImportant(messageId, plan.action.value);
    case "star":
      return adapter.star(messageId, plan.action.value);
    case "mark_read":
      return adapter.markRead(messageId, plan.action.value);
  }
}

async function captureAfterState(
  adapter: ProviderAdapter,
  plan: MailboxActionPlan,
): Promise<{
  state: MessageStateSnapshot | null;
  status: "captured" | "unavailable" | "deleted";
}> {
  if (plan.action.type === "delete_permanent") {
    return { state: null, status: "deleted" };
  }

  try {
    const message = await adapter.getMessage(plan.providerMessageId);
    return { state: snapshotMessage(message), status: "captured" };
  } catch {
    return { state: null, status: "unavailable" };
  }
}

export class ProviderSafeActionExecutor {
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly auditRecorder: ActionExplainabilityRecorder | undefined;
  private readonly operationalTelemetry: OperationalTelemetry | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly resolver: ProviderAdapterResolver,
    private readonly store: ActionExecutionStore,
    options: ActionExecutorOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 250);
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.auditRecorder = options.auditRecorder;
    this.operationalTelemetry = options.operationalTelemetry;
    this.now = options.now ?? (() => new Date());
  }

  private async recordActionMetric(
    plan: MailboxActionPlan,
    status: "succeeded" | "deduplicated" | "retrying" | "failed",
    attempt: number,
  ): Promise<void> {
    await this.operationalTelemetry?.record({
      metric: "action_result",
      tenantId: plan.tenantId,
      accountId: plan.accountId,
      provider: plan.provider,
      action: plan.action.type,
      source: plan.source,
      status,
      attempt,
      value: 1,
      timestamp: this.now().toISOString(),
    });
  }

  async execute(
    rawPlan: unknown,
    context: ActionExecutionContext,
  ): Promise<ActionExecutionResult> {
    const plan = assertExplicitActionPlan(rawPlan);
    assertPlanAuthorization(plan, context);
    const planHash = actionPlanHash(plan);

    const existing = await this.store.get(plan.idempotencyKey);
    if (existing) {
      if (existing.planHash !== planHash) {
        throw new ActionIdempotencyConflictError(
          "Idempotency key is already bound to a different action plan",
        );
      }
      if (existing.status === "succeeded") {
        await this.store.appendAudit({
          idempotencyKey: plan.idempotencyKey,
          planId: plan.planId,
          tenantId: plan.tenantId,
          accountId: plan.accountId,
          providerMessageId: plan.providerMessageId,
          action: plan.action.type,
          actorType: context.actorType,
          ...(context.actorId ? { actorId: context.actorId } : {}),
          outcome: "deduplicated",
          attempt: existing.attemptCount,
          timestamp: new Date().toISOString(),
        });
        const result: ActionExecutionResult = {
          status: "deduplicated",
          idempotencyKey: plan.idempotencyKey,
          attempts: existing.attemptCount,
          beforeState: existing.beforeState,
          afterState: existing.afterState ?? null,
          afterStateStatus: existing.afterStateStatus ?? "unavailable",
        };
        await this.auditRecorder?.recordActionExecution(
          plan,
          context,
          result,
          "deduplicated",
        );
        await this.recordActionMetric(
          plan,
          "deduplicated",
          existing.attemptCount,
        );
        return result;
      }

      throw new ActionInProgressError(
        existing.status === "in_progress"
          ? "Mutation with this idempotency key is already in progress"
          : "Mutation with this idempotency key already failed; create a new explicit action plan to retry",
      );
    }

    const adapter = await this.resolver.resolve(
      plan.tenantId,
      plan.accountId,
      plan.provider,
    );
    if (adapter.kind !== plan.provider) {
      throw new ActionAuthorizationError(
        "Resolved provider adapter does not match action plan",
      );
    }

    const capability = CAPABILITY_BY_ACTION[plan.action.type];
    if (!adapter.capabilities()[capability]) {
      throw new ActionPreconditionError(
        `Provider does not support required capability "${capability}"`,
      );
    }

    const beforeMessage = await adapter.getMessage(plan.providerMessageId);
    assertMessagePreconditions(plan, beforeMessage);
    const beforeState = snapshotMessage(beforeMessage);

    const record: MutationRecord = {
      idempotencyKey: plan.idempotencyKey,
      planHash,
      planId: plan.planId,
      status: "in_progress",
      attemptCount: 0,
      startedAt: new Date().toISOString(),
      beforeState,
    };
    if (!(await this.store.claim(record))) {
      throw new ActionInProgressError(
        "Mutation was claimed concurrently by another executor",
      );
    }

    const retrySafe = isRetrySafeMutation(plan.provider, plan.action.type);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.store.noteAttempt(plan.idempotencyKey, attempt);
      try {
        await executeProviderMutation(adapter, plan);
        const after = await captureAfterState(adapter, plan);
        const completedAt = new Date().toISOString();
        await this.store.complete(plan.idempotencyKey, {
          completedAt,
          afterState: after.state,
          afterStateStatus: after.status,
        });
        await this.store.appendAudit({
          idempotencyKey: plan.idempotencyKey,
          planId: plan.planId,
          tenantId: plan.tenantId,
          accountId: plan.accountId,
          providerMessageId: plan.providerMessageId,
          action: plan.action.type,
          actorType: context.actorType,
          ...(context.actorId ? { actorId: context.actorId } : {}),
          outcome: "succeeded",
          attempt,
          timestamp: completedAt,
        });
        const result: ActionExecutionResult = {
          status: "executed",
          idempotencyKey: plan.idempotencyKey,
          attempts: attempt,
          beforeState,
          afterState: after.state,
          afterStateStatus: after.status,
        };
        await this.auditRecorder?.recordActionExecution(
          plan,
          context,
          result,
          "succeeded",
          completedAt,
        );
        await this.recordActionMetric(
          plan,
          "succeeded",
          attempt,
        );
        return result;
      } catch (error) {
        const failure = classifyMutationError(error);
        const canRetry =
          retrySafe &&
          failure.category === "retryable" &&
          attempt < this.maxAttempts;

        if (canRetry) {
          await this.store.appendAudit({
            idempotencyKey: plan.idempotencyKey,
            planId: plan.planId,
            tenantId: plan.tenantId,
            accountId: plan.accountId,
            providerMessageId: plan.providerMessageId,
            action: plan.action.type,
            actorType: context.actorType,
            ...(context.actorId ? { actorId: context.actorId } : {}),
            outcome: "retrying",
            attempt,
            timestamp: new Date().toISOString(),
            errorCode: failure.code,
            errorCategory: failure.category,
          });
          await this.recordActionMetric(
            plan,
            "retrying",
            attempt,
          );
          if (this.retryDelayMs > 0) {
            await this.sleep(this.retryDelayMs * attempt);
          }
          continue;
        }

        const completedAt = new Date().toISOString();
        await this.store.fail(plan.idempotencyKey, {
          completedAt,
          failure,
        });
        await this.store.appendAudit({
          idempotencyKey: plan.idempotencyKey,
          planId: plan.planId,
          tenantId: plan.tenantId,
          accountId: plan.accountId,
          providerMessageId: plan.providerMessageId,
          action: plan.action.type,
          actorType: context.actorType,
          ...(context.actorId ? { actorId: context.actorId } : {}),
          outcome: "failed",
          attempt,
          timestamp: completedAt,
          errorCode: failure.code,
          errorCategory: failure.category,
        });
        await this.auditRecorder?.recordActionFailure(
          plan,
          context,
          beforeState,
          {
            code: failure.code,
            category: failure.category,
            message: failure.message,
          },
          completedAt,
        );
        await this.recordActionMetric(
          plan,
          "failed",
          attempt,
        );
        throw error;
      }
    }

    throw new Error("Unreachable mutation executor state");
  }
}
