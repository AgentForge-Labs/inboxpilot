import { assertTenantAccountAccess } from "../../security/tenant-boundary.js";
import type {
  McpControlPlaneUsageStore,
} from "./hosted-mcp-store.js";
import type {
  McpOAuthPrincipal,
} from "./hosted-mcp-types.js";

export interface HostedMcpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface HostedMcpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  annotations: HostedMcpToolAnnotations;
}

export interface HostedMcpToolContext {
  tenantId: string;
  userId: string;
  grantId: string;
  accountIds: readonly string[];
  scopes: readonly string[];
  requestId: string;
  accountId?: string;
}

export interface HostedMcpTool {
  descriptor: HostedMcpToolDescriptor;
  requiredScopes?: readonly string[];
  requiresAccount?: boolean;
  execute(
    args: Readonly<Record<string, unknown>>,
    context: HostedMcpToolContext,
  ): Promise<unknown>;
}

export class HostedMcpToolError extends Error {
  constructor(
    readonly code:
      | "TOOL_NOT_FOUND"
      | "TOOL_SCOPE_DENIED"
      | "TOOL_ACCOUNT_DENIED"
      | "TOOL_INVALID_ARGUMENTS",
    message: string,
  ) {
    super(message);
    this.name = "HostedMcpToolError";
  }
}

function hasScopes(
  principal: McpOAuthPrincipal,
  required: readonly string[],
): boolean {
  const granted = new Set(principal.scopes);
  return required.every((scope) => granted.has(scope));
}

function argsRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new HostedMcpToolError(
      "TOOL_INVALID_ARGUMENTS",
      "Tool arguments must be an object",
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

export class HostedMcpToolRegistry {
  private readonly tools = new Map<string, HostedMcpTool>();

  constructor(
    private readonly usage: McpControlPlaneUsageStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(tool: HostedMcpTool): void {
    const name = tool.descriptor.name.trim();
    if (!name) {
      throw new TypeError("MCP tool name is required");
    }
    if (this.tools.has(name)) {
      throw new Error("MCP tool already registered: " + name);
    }
    this.tools.set(name, tool);
  }

  list(
    principal: McpOAuthPrincipal,
  ): HostedMcpToolDescriptor[] {
    return [...this.tools.values()]
      .filter((tool) =>
        hasScopes(
          principal,
          tool.requiredScopes ?? [],
        ),
      )
      .map((tool) => structuredClone(tool.descriptor))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async call(
    toolName: string,
    rawArgs: unknown,
    principal: McpOAuthPrincipal,
    requestId: string,
  ): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new HostedMcpToolError(
        "TOOL_NOT_FOUND",
        "Unknown MCP tool: " + toolName,
      );
    }

    let accountId: string | undefined;
    try {
      if (
        !hasScopes(
          principal,
          tool.requiredScopes ?? [],
        )
      ) {
        throw new HostedMcpToolError(
          "TOOL_SCOPE_DENIED",
          "OAuth grant lacks a required tool scope",
        );
      }

      const args = argsRecord(rawArgs ?? {});
      if (Object.prototype.hasOwnProperty.call(args, "tenantId")) {
        throw new HostedMcpToolError(
          "TOOL_INVALID_ARGUMENTS",
          "tenantId is derived from OAuth and must not be supplied by tool arguments",
        );
      }

      const rawAccountId = args.accountId;
      if (rawAccountId !== undefined) {
        if (
          typeof rawAccountId !== "string" ||
          !rawAccountId.trim()
        ) {
          throw new HostedMcpToolError(
            "TOOL_INVALID_ARGUMENTS",
            "accountId must be a non-empty string",
          );
        }
        accountId = rawAccountId.trim();
        try {
          assertTenantAccountAccess(
            {
              tenantId: principal.tenantId,
              accountIds: principal.accountIds,
            },
            {
              tenantId: principal.tenantId,
              accountId,
            },
          );
        } catch {
          throw new HostedMcpToolError(
            "TOOL_ACCOUNT_DENIED",
            "Mailbox account is not authorized by this OAuth grant",
          );
        }
      } else if (tool.requiresAccount) {
        throw new HostedMcpToolError(
          "TOOL_INVALID_ARGUMENTS",
          "accountId is required for this tool",
        );
      }

      const result = await tool.execute(args, {
        tenantId: principal.tenantId,
        userId: principal.userId,
        grantId: principal.grantId,
        accountIds: principal.accountIds,
        scopes: principal.scopes,
        requestId,
        ...(accountId ? { accountId } : {}),
      });
      await this.writeUsage(
        principal,
        requestId,
        toolName,
        "succeeded",
        accountId,
      );
      return result;
    } catch (error) {
      await this.writeUsage(
        principal,
        requestId,
        toolName,
        error instanceof HostedMcpToolError
          ? "denied"
          : "failed",
        accountId,
      );
      throw error;
    }
  }

  private async writeUsage(
    principal: McpOAuthPrincipal,
    requestId: string,
    toolName: string,
    outcome: "succeeded" | "failed" | "denied",
    accountId: string | undefined,
  ): Promise<void> {
    await this.usage.append({
      tenantId: principal.tenantId,
      userId: principal.userId,
      grantId: principal.grantId,
      requestId,
      toolName,
      outcome,
      timestamp: this.now().toISOString(),
      ...(accountId ? { accountId } : {}),
      billable: false,
    });
  }
}
