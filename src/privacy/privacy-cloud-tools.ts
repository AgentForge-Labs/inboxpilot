import type {
  HostedMcpTool,
  HostedMcpToolRegistry,
} from "../mcp/hosted/hosted-mcp-tools.js";

const CLOUD_SAFE_CONTROL_TOOLS = new Set([
  "email_rule_create",
  "email_rule_update",
  "email_rule_list",
  "email_rule_delete",
  "email_automation_status",
  "email_automation_configure",
  "email_usage",
]);

export interface PrivacyCloudToolSelection {
  registered: string[];
  blocked: string[];
}

export function isPrivacyModeCloudToolAllowed(
  toolName: string,
): boolean {
  return CLOUD_SAFE_CONTROL_TOOLS.has(toolName);
}

export function registerPrivacyModeCloudTools(
  registry: HostedMcpToolRegistry,
  tools: readonly HostedMcpTool[],
): PrivacyCloudToolSelection {
  const registered: string[] = [];
  const blocked: string[] = [];

  for (const tool of tools) {
    if (
      isPrivacyModeCloudToolAllowed(
        tool.descriptor.name,
      )
    ) {
      registry.register(tool);
      registered.push(tool.descriptor.name);
    } else {
      blocked.push(tool.descriptor.name);
    }
  }

  return {
    registered: registered.sort(),
    blocked: blocked.sort(),
  };
}
