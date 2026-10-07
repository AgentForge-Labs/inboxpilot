import type {
  ExplainabilityAuditStore,
} from "../../audit/audit-types.js";
import type {
  ShadowModeDashboardView,
} from "../../automation/shadow-mode-types.js";
import type {
  ShadowModeService,
} from "../../automation/shadow-mode-service.js";
import type {
  RulesDashboardService,
} from "../../dashboard/rules-dashboard-service.js";
import type {
  DashboardRule,
  RuleAction,
  RuleCondition,
} from "../../rules/rule-types.js";
import type {
  McpControlPlaneUsageStore,
} from "./hosted-mcp-store.js";
import {
  HostedMcpToolError,
  type HostedMcpTool,
  type HostedMcpToolRegistry,
} from "./hosted-mcp-tools.js";

export interface HostedEmailControlDependencies {
  rules: RulesDashboardService;
  automation: ShadowModeService;
  activity: ExplainabilityAuditStore;
  usage: McpControlPlaneUsageStore;
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

function optionalString(
  args: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return invalid(name + " must be a string");
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function optionalBoolean(
  args: Readonly<Record<string, unknown>>,
  name: string,
): boolean | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    return invalid(name + " must be a boolean");
  }
  return value;
}

function requiredInteger(
  args: Readonly<Record<string, unknown>>,
  name: string,
): number {
  const value = args[name];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value)
  ) {
    return invalid(name + " must be an integer");
  }
  return value;
}

function optionalInteger(
  args: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value)
  ) {
    return invalid(name + " must be an integer");
  }
  return value;
}

function requiredObject<T>(
  args: Readonly<Record<string, unknown>>,
  name: string,
): T {
  const value = args[name];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return invalid(name + " must be an object");
  }
  return value as T;
}

function isDestructiveRuleAction(
  action: RuleAction,
): boolean {
  return action.kind === "delete_after_days";
}

function safeRulePreview(
  action: RuleAction,
  mode: "create" | "update",
  ruleId?: string,
) {
  return {
    kind: "destructive_policy_change",
    mode,
    ...(ruleId ? { ruleId } : {}),
    proposedAction: structuredClone(action),
    effect:
      action.kind === "delete_after_days"
        ? "Matching mail may become eligible for delayed deletion under the configured retention policy."
        : "No destructive deletion policy is introduced.",
    requiresConfirmation: true,
    applied: false,
  };
}

function normalizeRule(rule: DashboardRule) {
  return structuredClone(rule);
}

function limitFrom(
  args: Readonly<Record<string, unknown>>,
  fallback = 50,
  max = 500,
): number {
  const value = args.limit;
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  ) {
    return invalid(
      "limit must be an integer between 1 and " + max,
    );
  }
  return value;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function createHostedEmailControlTools(
  deps: HostedEmailControlDependencies,
): HostedMcpTool[] {
  const ruleCreate: HostedMcpTool = {
    descriptor: {
      name: "email_rule_create",
      description:
        "Create an InboxPilot email rule. Destructive delete policies are previewed first unless explicitly confirmed.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          name: { type: "string" },
          enabled: { type: "boolean" },
          priority: { type: "integer" },
          condition: { type: "object" },
          action: { type: "object" },
          confirmDestructive: {
            type: "boolean",
            default: false,
          },
        },
        required: [
          "accountId",
          "name",
          "condition",
          "action",
        ],
      },
      annotations: {
        title: "Create Email Rule",
        ...WRITE,
      },
    },
    requiredScopes: ["rules:write"],
    requiresAccount: true,
    async execute(args, context) {
      const action = requiredObject<RuleAction>(
        args,
        "action",
      );
      const confirm =
        optionalBoolean(
          args,
          "confirmDestructive",
        ) ?? false;
      if (
        isDestructiveRuleAction(action) &&
        !confirm
      ) {
        return {
          preview: safeRulePreview(
            action,
            "create",
          ),
        };
      }

      const rule = await deps.rules.create({
        tenantId: context.tenantId,
        accountId: context.accountId!,
        name: requiredString(args, "name"),
        ...(optionalBoolean(args, "enabled") !==
        undefined
          ? {
              enabled:
                optionalBoolean(args, "enabled")!,
            }
          : {}),
        ...(optionalInteger(args, "priority") !==
        undefined
          ? {
              priority:
                optionalInteger(args, "priority")!,
            }
          : {}),
        condition: requiredObject<RuleCondition>(
          args,
          "condition",
        ),
        action,
        ...(confirm
          ? { destructiveAcknowledged: true }
          : {}),
      });
      return {
        rule: normalizeRule(rule),
        ...(isDestructiveRuleAction(action)
          ? {
              preview: {
                ...safeRulePreview(
                  action,
                  "create",
                  rule.id,
                ),
                applied: true,
                requiresConfirmation: false,
              },
            }
          : {}),
      };
    },
  };

  const ruleUpdate: HostedMcpTool = {
    descriptor: {
      name: "email_rule_update",
      description:
        "Update an InboxPilot email rule using revision checks. Destructive delete policies are previewed first unless explicitly confirmed.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          ruleId: { type: "string" },
          expectedRevision: { type: "integer" },
          name: { type: "string" },
          enabled: { type: "boolean" },
          priority: { type: "integer" },
          condition: { type: "object" },
          action: { type: "object" },
          confirmDestructive: {
            type: "boolean",
            default: false,
          },
        },
        required: [
          "accountId",
          "ruleId",
          "expectedRevision",
        ],
      },
      annotations: {
        title: "Update Email Rule",
        ...WRITE,
      },
    },
    requiredScopes: ["rules:write"],
    requiresAccount: true,
    async execute(args, context) {
      const ruleId = requiredString(
        args,
        "ruleId",
      );
      const action =
        args.action === undefined
          ? undefined
          : requiredObject<RuleAction>(
              args,
              "action",
            );
      const confirm =
        optionalBoolean(
          args,
          "confirmDestructive",
        ) ?? false;

      if (
        action &&
        isDestructiveRuleAction(action) &&
        !confirm
      ) {
        return {
          preview: safeRulePreview(
            action,
            "update",
            ruleId,
          ),
        };
      }

      const name = optionalString(args, "name");
      const enabled = optionalBoolean(
        args,
        "enabled",
      );
      const priority = optionalInteger(
        args,
        "priority",
      );
      const condition =
        args.condition === undefined
          ? undefined
          : requiredObject<RuleCondition>(
              args,
              "condition",
            );

      const rule = await deps.rules.update(
        context.tenantId,
        context.accountId!,
        ruleId,
        {
          expectedRevision: requiredInteger(
            args,
            "expectedRevision",
          ),
          ...(name !== undefined ? { name } : {}),
          ...(enabled !== undefined
            ? { enabled }
            : {}),
          ...(priority !== undefined
            ? { priority }
            : {}),
          ...(condition !== undefined
            ? { condition }
            : {}),
          ...(action !== undefined
            ? { action }
            : {}),
          ...(confirm
            ? {
                destructiveAcknowledged: true,
              }
            : {}),
        },
      );

      return {
        rule: normalizeRule(rule),
        ...(action &&
        isDestructiveRuleAction(action)
          ? {
              preview: {
                ...safeRulePreview(
                  action,
                  "update",
                  rule.id,
                ),
                applied: true,
                requiresConfirmation: false,
              },
            }
          : {}),
      };
    },
  };

  const ruleList: HostedMcpTool = {
    descriptor: {
      name: "email_rule_list",
      description:
        "List InboxPilot rules for one authorized mailbox.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "List Email Rules",
        ...READ_ONLY,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(_args, context) {
      const rules = await deps.rules.list(
        context.tenantId,
        context.accountId!,
      );
      return {
        count: rules.length,
        rules: rules.map(normalizeRule),
      };
    },
  };

  const ruleDelete: HostedMcpTool = {
    descriptor: {
      name: "email_rule_delete",
      description:
        "Delete an InboxPilot rule using revision checks.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          ruleId: { type: "string" },
          expectedRevision: { type: "integer" },
        },
        required: [
          "accountId",
          "ruleId",
          "expectedRevision",
        ],
      },
      annotations: {
        title: "Delete Email Rule",
        ...WRITE,
      },
    },
    requiredScopes: ["rules:write"],
    requiresAccount: true,
    async execute(args, context) {
      const ruleId = requiredString(
        args,
        "ruleId",
      );
      const deleted = await deps.rules.delete(
        context.tenantId,
        context.accountId!,
        ruleId,
        requiredInteger(
          args,
          "expectedRevision",
        ),
      );
      return { ruleId, deleted };
    },
  };

  const automationStatus: HostedMcpTool = {
    descriptor: {
      name: "email_automation_status",
      description:
        "Return Shadow Mode and automation readiness/status for an authorized mailbox.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "Email Automation Status",
        ...READ_ONLY,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(_args, context) {
      return deps.automation.dashboard(
        context.tenantId,
        context.accountId!,
      );
    },
  };

  const automationConfigure: HostedMcpTool = {
    descriptor: {
      name: "email_automation_configure",
      description:
        "Configure automation lifecycle. Enabling automation is previewed first and requires explicit confirmation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          action: {
            type: "string",
            enum: ["start_shadow", "enable"],
          },
          confirmDestructive: {
            type: "boolean",
            default: false,
          },
        },
        required: ["accountId", "action"],
      },
      annotations: {
        title: "Configure Email Automation",
        ...WRITE,
        destructiveHint: true,
      },
    },
    requiredScopes: ["rules:write"],
    requiresAccount: true,
    async execute(args, context) {
      const action = requiredString(
        args,
        "action",
      );
      if (action === "start_shadow") {
        const state =
          await deps.automation.startAccount(
            context.tenantId,
            context.accountId!,
          );
        return {
          action,
          applied: true,
          state,
        };
      }
      if (action !== "enable") {
        return invalid(
          "action must be start_shadow or enable",
        );
      }

      const dashboard =
        await deps.automation.dashboard(
          context.tenantId,
          context.accountId!,
        );
      const preview = {
        kind: "enable_automation",
        currentStatus: dashboard.status,
        canEnableAutomation:
          dashboard.canEnableAutomation,
        counts: dashboard.counts,
        effect:
          "Enabling automation allows InboxPilot to execute eligible archive/trash retention actions instead of only simulating them.",
        applied: false,
        requiresConfirmation: true,
      };

      if (
        !(
          optionalBoolean(
            args,
            "confirmDestructive",
          ) ?? false
        )
      ) {
        return { preview };
      }

      const state =
        await deps.automation.enableAutomation({
          tenantId: context.tenantId,
          accountId: context.accountId!,
          actorId: context.userId,
          reviewed: true,
        });
      return {
        preview: {
          ...preview,
          applied: true,
          requiresConfirmation: false,
        },
        state,
      };
    },
  };

  const activity: HostedMcpTool = {
    descriptor: {
      name: "email_activity",
      description:
        "List recent explainability/audit activity for one authorized mailbox without exposing raw message bodies.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
          },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "Email Activity",
        ...READ_ONLY,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(args, context) {
      const limit = limitFrom(args);
      const events =
        await deps.activity.listForAccount(
          context.tenantId,
          context.accountId!,
          limit,
        );
      return {
        count: events.length,
        events,
      };
    },
  };

  const usage: HostedMcpTool = {
    descriptor: {
      name: "email_usage",
      description:
        "Summarize MCP tool usage for the current tenant and authorized mailbox.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "Email Usage",
        ...READ_ONLY,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(_args, context) {
      const events = (
        await deps.usage.listForTenant(
          context.tenantId,
        )
      ).filter(
        (event) =>
          event.accountId === undefined ||
          event.accountId === context.accountId,
      );
      const byTool: Record<string, number> = {};
      const byOutcome: Record<string, number> = {};
      for (const event of events) {
        byTool[event.toolName] =
          (byTool[event.toolName] ?? 0) + 1;
        byOutcome[event.outcome] =
          (byOutcome[event.outcome] ?? 0) + 1;
      }
      return {
        accountId: context.accountId!,
        totalCalls: events.length,
        byTool,
        byOutcome,
        billableCalls: events.filter(
          (event) => event.billable,
        ).length,
      };
    },
  };

  return [
    ruleCreate,
    ruleUpdate,
    ruleList,
    ruleDelete,
    automationStatus,
    automationConfigure,
    activity,
    usage,
  ];
}

export function registerHostedEmailControlTools(
  registry: HostedMcpToolRegistry,
  deps: HostedEmailControlDependencies,
): void {
  for (const tool of createHostedEmailControlTools(
    deps,
  )) {
    registry.register(tool);
  }
}
