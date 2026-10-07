import {
  ACTION_PLAN_VERSION,
  createActionIdempotencyKey,
  type ActionExecutionContext,
  type CanonicalMutation,
  type MailboxActionPlan,
} from "../../actions/action-types.js";
import type {
  ActionExecutionResult,
} from "../../actions/action-executor.js";
import type {
  CanonicalMessage,
} from "../../domain/email-model.js";
import type {
  SemanticBatchResult,
  SemanticClassificationResult,
} from "../../classifier/semantic-types.js";
import {
  HostedMcpToolError,
  type HostedMcpTool,
  type HostedMcpToolContext,
  type HostedMcpToolRegistry,
} from "./hosted-mcp-tools.js";

export interface HostedEmailAutomationDataSource {
  listMessages(
    tenantId: string,
    accountId: string,
  ): Promise<CanonicalMessage[]>;
}

export interface HostedEmailClassificationService {
  classify(
    message: CanonicalMessage,
  ): Promise<SemanticClassificationResult>;
  classifyMany(
    messages: readonly CanonicalMessage[],
  ): Promise<SemanticBatchResult>;
}

export interface HostedEmailMutationExecutor {
  execute(
    plan: MailboxActionPlan,
    context: ActionExecutionContext,
  ): Promise<ActionExecutionResult>;
}

export interface HostedEmailAutomationDependencies {
  source: HostedEmailAutomationDataSource;
  classifier: HostedEmailClassificationService;
  executor: HostedEmailMutationExecutor;
}

function invalid(message: string): never {
  throw new HostedMcpToolError(
    "TOOL_INVALID_ARGUMENTS",
    message,
  );
}

function requiredString(
  args: Readonly<Record<string, unknown>>,
  name: string,
): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    return invalid(name + " is required");
  }
  return value.trim();
}

function optionalBoolean(
  args: Readonly<Record<string, unknown>>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    return invalid(name + " must be a boolean");
  }
  return value;
}

function stringArray(
  args: Readonly<Record<string, unknown>>,
  name: string,
  max: number,
): string[] {
  const value = args[name];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > max ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        Boolean(entry.trim()),
    )
  ) {
    return invalid(
      name +
        " must be a non-empty string array with at most " +
        max +
        " entries",
    );
  }
  return [...new Set(value.map((entry) => entry.trim()))];
}

async function accountMessages(
  source: HostedEmailAutomationDataSource,
  context: HostedMcpToolContext,
): Promise<CanonicalMessage[]> {
  return (
    await source.listMessages(
      context.tenantId,
      context.accountId!,
    )
  ).filter(
    (message) =>
      message.tenantId === context.tenantId &&
      message.accountId === context.accountId,
  );
}

function findMessage(
  messages: readonly CanonicalMessage[],
  messageId: string,
): CanonicalMessage {
  const message = messages.find(
    (candidate) =>
      candidate.id === messageId ||
      candidate.provider.messageId === messageId,
  );
  if (!message) {
    return invalid("Email message was not found");
  }
  return message;
}

function classificationView(
  message: CanonicalMessage,
  result: SemanticClassificationResult,
) {
  return {
    messageId: message.id,
    providerMessageId: message.provider.messageId,
    provider: message.provider.kind,
    route: result.route,
    needsReview: result.needsReview,
    quotaCharged: result.quotaCharged,
    attempts: result.attempts,
    ...(result.model ? { model: result.model } : {}),
    deterministic: result.deterministic,
    ...(result.semantic
      ? { semantic: result.semantic }
      : {}),
    ...(result.classification
      ? { classification: result.classification }
      : {}),
  };
}

function actionPlan(
  message: CanonicalMessage,
  context: HostedMcpToolContext,
  action: CanonicalMutation,
  operationId: string,
  destructive = false,
): MailboxActionPlan {
  const planId = [
    "mcp",
    action.type,
    message.id,
    operationId,
  ].join(":");
  const base = {
    schemaVersion: ACTION_PLAN_VERSION,
    planId,
    source: "mcp_explicit" as const,
    tenantId: context.tenantId,
    accountId: context.accountId!,
    provider: message.provider.kind,
    providerMessageId: message.provider.messageId,
    action,
    preconditions: {
      expectedCanonicalMessageId: message.id,
      expectedUpdatedAt: message.updatedAt,
      ...(destructive
        ? { requireUnprotected: true }
        : {}),
    },
    ...(destructive
      ? {
          destructiveAuthorization: {
            userConfirmationId: context.requestId,
            reason:
              "Explicit MCP " +
              action.type +
              " request",
          },
        }
      : {}),
  };
  return {
    ...base,
    idempotencyKey: createActionIdempotencyKey(base),
  };
}

function operationId(
  args: Readonly<Record<string, unknown>>,
  context: HostedMcpToolContext,
): string {
  const value = args.idempotencyKey;
  if (value === undefined) return context.requestId;
  if (typeof value !== "string" || !value.trim()) {
    return invalid(
      "idempotencyKey must be a non-empty string",
    );
  }
  return value.trim();
}

async function mutate(
  deps: HostedEmailAutomationDependencies,
  args: Readonly<Record<string, unknown>>,
  context: HostedMcpToolContext,
  action: CanonicalMutation,
  destructive = false,
) {
  const messageId = requiredString(args, "messageId");
  const messages = await accountMessages(
    deps.source,
    context,
  );
  const message = findMessage(messages, messageId);
  const plan = actionPlan(
    message,
    context,
    action,
    operationId(args, context),
    destructive,
  );
  const result = await deps.executor.execute(plan, {
    tenantId: context.tenantId,
    accountId: context.accountId!,
    actorType: "mcp",
    actorId: context.userId,
  });
  return {
    action: action.type,
    messageId: message.id,
    providerMessageId: message.provider.messageId,
    planId: plan.planId,
    idempotencyKey: plan.idempotencyKey,
    status: result.status,
    attempts: result.attempts,
    afterStateStatus: result.afterStateStatus,
    afterState: result.afterState,
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const MUTATION = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function mutationSchema(
  extra: Record<string, unknown> = {},
  required: string[] = [],
) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      accountId: { type: "string" },
      messageId: { type: "string" },
      idempotencyKey: { type: "string" },
      ...extra,
    },
    required: ["accountId", "messageId", ...required],
  };
}

export function createHostedEmailAutomationTools(
  deps: HostedEmailAutomationDependencies,
): HostedMcpTool[] {
  const classify: HostedMcpTool = {
    descriptor: {
      name: "email_classify",
      description:
        "Classify one email through InboxPilot's canonical classification service.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          messageId: { type: "string" },
        },
        required: ["accountId", "messageId"],
      },
      annotations: {
        title: "Classify Email",
        ...READ_ONLY,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(args, context) {
      const message = findMessage(
        await accountMessages(deps.source, context),
        requiredString(args, "messageId"),
      );
      return classificationView(
        message,
        await deps.classifier.classify(message),
      );
    },
  };

  const classifyBulk: HostedMcpTool = {
    descriptor: {
      name: "email_classify_bulk",
      description:
        "Classify up to 50 emails through the same canonical classification service.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          messageIds: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: { type: "string" },
          },
        },
        required: ["accountId", "messageIds"],
      },
      annotations: {
        title: "Classify Emails",
        ...READ_ONLY,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(args, context) {
      const ids = stringArray(args, "messageIds", 50);
      const messages = await accountMessages(
        deps.source,
        context,
      );
      const selected = ids.map((id) =>
        findMessage(messages, id),
      );
      const batch =
        await deps.classifier.classifyMany(selected);
      if (batch.results.length !== selected.length) {
        throw new Error(
          "Classifier result count does not match requested messages",
        );
      }
      return {
        count: selected.length,
        semanticCandidates: batch.semanticCandidates,
        batchedRequests: batch.batchedRequests,
        results: selected.map((message, index) =>
          classificationView(
            message,
            batch.results[index]!,
          ),
        ),
      };
    },
  };

  function actionTool(
    name: string,
    title: string,
    description: string,
    actionFor: (
      args: Readonly<Record<string, unknown>>,
    ) => CanonicalMutation,
    options: {
      destructive?: boolean;
      extra?: Record<string, unknown>;
      required?: string[];
    } = {},
  ): HostedMcpTool {
    return {
      descriptor: {
        name,
        description,
        inputSchema: mutationSchema(
          options.extra,
          options.required,
        ),
        annotations: {
          title,
          ...(options.destructive
            ? {
                ...MUTATION,
                destructiveHint: true,
              }
            : MUTATION),
        },
      },
      requiredScopes: ["mailbox:write"],
      requiresAccount: true,
      async execute(args, context) {
        return mutate(
          deps,
          args,
          context,
          actionFor(args),
          options.destructive ?? false,
        );
      },
    };
  }

  return [
    classify,
    classifyBulk,
    actionTool(
      "email_archive",
      "Archive Email",
      "Archive an email through the canonical authorized, audited and idempotent action executor.",
      () => ({ type: "archive" }),
    ),
    actionTool(
      "email_trash",
      "Trash Email",
      "Move an email to trash through the canonical authorized, audited and idempotent action executor.",
      () => ({ type: "trash" }),
      { destructive: true },
    ),
    actionTool(
      "email_restore",
      "Restore Email",
      "Restore an email through the canonical authorized, audited and idempotent action executor.",
      () => ({ type: "restore" }),
    ),
    actionTool(
      "email_mark_important",
      "Mark Email Important",
      "Set or clear the important flag through the canonical authorized, audited and idempotent action executor.",
      (args) => ({
        type: "mark_important",
        value: optionalBoolean(
          args,
          "important",
          true,
        ),
      }),
      {
        extra: {
          important: {
            type: "boolean",
            default: true,
          },
        },
      },
    ),
    actionTool(
      "email_move",
      "Move Email",
      "Move an email to a target folder through the canonical authorized, audited and idempotent action executor.",
      (args) => ({
        type: "move",
        folderId: requiredString(args, "folderId"),
      }),
      {
        extra: {
          folderId: { type: "string" },
        },
        required: ["folderId"],
      },
    ),
  ];
}

export function registerHostedEmailAutomationTools(
  registry: HostedMcpToolRegistry,
  deps: HostedEmailAutomationDependencies,
): void {
  for (const tool of createHostedEmailAutomationTools(
    deps,
  )) {
    registry.register(tool);
  }
}
