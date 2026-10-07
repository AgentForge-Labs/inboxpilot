import type {
  NaturalLanguageRuleProposal,
} from "./natural-language-rule-types.js";
import type {
  NaturalLanguageRuleService,
} from "./natural-language-rule-service.js";

export const NATURAL_LANGUAGE_RULE_MCP_TOOL = {
  name: "email_rule_create_natural_language",
  description:
    "Create a mailbox automation rule from natural language. Broad or destructive rules return a preview and require explicit confirmation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      accountId: { type: "string", minLength: 1 },
      command: { type: "string", minLength: 1, maxLength: 1000 },
      confirmationToken: { type: "string", minLength: 1 },
    },
    required: ["accountId"],
  },
  annotations: {
    title: "Create email rule from natural language",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
} as const;

export interface NaturalLanguageRuleMcpContext {
  tenantId: string;
  allowedAccountIds: readonly string[];
}

export interface NaturalLanguageRuleMcpInput {
  accountId: string;
  command?: string;
  confirmationToken?: string;
}

export class NaturalLanguageRuleMcpTool {
  constructor(
    private readonly service: NaturalLanguageRuleService,
  ) {}

  async execute(
    input: NaturalLanguageRuleMcpInput,
    context: NaturalLanguageRuleMcpContext,
  ): Promise<NaturalLanguageRuleProposal> {
    const accountId = input.accountId.trim();
    if (
      !accountId ||
      !context.allowedAccountIds.includes(accountId)
    ) {
      throw new Error(
        "MCP account is not authorized for this linked user",
      );
    }

    if (input.confirmationToken?.trim()) {
      if (input.command?.trim()) {
        throw new TypeError(
          "Provide either command or confirmationToken, not both",
        );
      }
      return this.service.confirm({
        tenantId: context.tenantId,
        accountId,
        confirmationToken: input.confirmationToken,
      });
    }

    if (!input.command?.trim()) {
      throw new TypeError(
        "command is required when confirmationToken is absent",
      );
    }

    return this.service.propose({
      tenantId: context.tenantId,
      accountId,
      command: input.command,
    });
  }
}
