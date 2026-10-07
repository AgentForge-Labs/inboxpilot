import type {
  NaturalLanguageRuleMcpTool,
} from "../natural-language-rule-tool.js";
import {
  NATURAL_LANGUAGE_RULE_MCP_TOOL,
} from "../natural-language-rule-tool.js";
import type {
  HostedMcpTool,
} from "./hosted-mcp-tools.js";

export function createNaturalLanguageRuleHostedTool(
  tool: NaturalLanguageRuleMcpTool,
): HostedMcpTool {
  return {
    descriptor: {
      name: NATURAL_LANGUAGE_RULE_MCP_TOOL.name,
      description:
        NATURAL_LANGUAGE_RULE_MCP_TOOL.description,
      inputSchema:
        NATURAL_LANGUAGE_RULE_MCP_TOOL.inputSchema,
      annotations:
        NATURAL_LANGUAGE_RULE_MCP_TOOL.annotations,
    },
    requiredScopes: ["rules:write"],
    requiresAccount: true,
    async execute(args, context) {
      const command = args.command;
      const confirmationToken = args.confirmationToken;
      return tool.execute(
        {
          accountId: context.accountId!,
          ...(typeof command === "string"
            ? { command }
            : {}),
          ...(typeof confirmationToken === "string"
            ? { confirmationToken }
            : {}),
        },
        {
          tenantId: context.tenantId,
          allowedAccountIds: context.accountIds,
        },
      );
    },
  };
}
