import { randomUUID } from "node:crypto";
import type { CanonicalMessage } from "../domain/email-model.js";
import {
  actionLabel,
  compileRulesForPolicyEngine,
  conditionLabel,
  conditionMatchesMessage,
  precedenceLabel,
  resolveDashboardRules,
  validateRuleAction,
  validateRuleCondition,
  validateRulePriority,
} from "../rules/rule-engine.js";
import type {
  CompiledRuleOverlay,
  CreateDashboardRuleInput,
  DashboardRule,
  DashboardRuleStore,
  RuleConflict,
  RuleMessageRepository,
  RulePreviewRow,
  RuleResolution,
  RulesDashboardViewModel,
  UpdateDashboardRuleInput,
} from "../rules/rule-types.js";

function requireId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(field + " is required");
  return normalized;
}

function requireName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError("Rule name is required");
  if (normalized.length > 160) {
    throw new RangeError("Rule name is too long");
  }
  return normalized;
}

function senderLabel(message: CanonicalMessage): string {
  const name = message.from?.name?.trim();
  const address = message.from?.address?.trim();
  if (name && address) return name + " <" + address + ">";
  return address || name || "Unknown sender";
}

function previewRow(
  ruleId: string,
  message: CanonicalMessage,
  resolution: RuleResolution,
): RulePreviewRow {
  return {
    canonicalMessageId: message.id,
    providerMessageId: message.provider.messageId,
    subject: message.subject || "(no subject)",
    sender: senderLabel(message),
    receivedAt: message.receivedAt,
    ...(message.classification.importanceScore !== undefined
      ? {
          importanceScore:
            message.classification.importanceScore,
        }
      : {}),
    categories: [...message.classification.categories],
    effective: resolution.appliedRuleIds.includes(ruleId),
    resolution,
  };
}

function conflictKey(conflict: RuleConflict): string {
  return [
    conflict.type,
    conflict.winnerRuleId,
    conflict.loserRuleId,
  ].join("\u0000");
}

export class RulesDashboardService {
  constructor(
    private readonly rules: DashboardRuleStore,
    private readonly messages: RuleMessageRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    raw: CreateDashboardRuleInput,
  ): Promise<DashboardRule> {
    const tenantId = requireId(raw.tenantId, "tenantId");
    const accountId = requireId(raw.accountId, "accountId");
    const now = this.now().toISOString();
    const rule: DashboardRule = {
      id: randomUUID(),
      tenantId,
      accountId,
      name: requireName(raw.name),
      enabled: raw.enabled ?? true,
      priority: validateRulePriority(raw.priority ?? 50),
      condition: validateRuleCondition(raw.condition),
      action: validateRuleAction(
        raw.action,
        raw.destructiveAcknowledged === true,
      ),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.rules.create(rule);
    return structuredClone(rule);
  }

  async update(
    tenantId: string,
    accountId: string,
    ruleId: string,
    input: UpdateDashboardRuleInput,
  ): Promise<DashboardRule> {
    requireId(tenantId, "tenantId");
    requireId(accountId, "accountId");
    requireId(ruleId, "ruleId");

    return this.rules.update(
      tenantId,
      accountId,
      ruleId,
      input.expectedRevision,
      (current) => ({
        ...current,
        ...(input.name !== undefined
          ? { name: requireName(input.name) }
          : {}),
        ...(input.enabled !== undefined
          ? { enabled: input.enabled }
          : {}),
        ...(input.priority !== undefined
          ? {
              priority: validateRulePriority(input.priority),
            }
          : {}),
        ...(input.condition !== undefined
          ? {
              condition: validateRuleCondition(
                input.condition,
              ),
            }
          : {}),
        ...(input.action !== undefined
          ? {
              action: validateRuleAction(
                input.action,
                input.destructiveAcknowledged === true,
              ),
            }
          : {}),
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
      }),
    );
  }

  async delete(
    tenantId: string,
    accountId: string,
    ruleId: string,
    expectedRevision: number,
  ): Promise<boolean> {
    return this.rules.delete(
      requireId(tenantId, "tenantId"),
      requireId(accountId, "accountId"),
      requireId(ruleId, "ruleId"),
      expectedRevision,
    );
  }

  async list(
    tenantId: string,
    accountId: string,
  ): Promise<DashboardRule[]> {
    return this.rules.listForAccount(
      requireId(tenantId, "tenantId"),
      requireId(accountId, "accountId"),
    );
  }

  async resolve(
    message: CanonicalMessage,
  ): Promise<RuleResolution> {
    return resolveDashboardRules(
      await this.rules.listForAccount(
        message.tenantId,
        message.accountId,
      ),
      message,
    );
  }

  async compilePolicyOverlay(
    tenantId: string,
    accountId: string,
  ): Promise<CompiledRuleOverlay> {
    return compileRulesForPolicyEngine(
      await this.list(tenantId, accountId),
    );
  }

  async preview(
    tenantId: string,
    accountId: string,
    ruleId: string,
    limit = 50,
  ): Promise<RulePreviewRow[]> {
    const rule = await this.rules.get(
      requireId(tenantId, "tenantId"),
      requireId(accountId, "accountId"),
      requireId(ruleId, "ruleId"),
    );
    if (!rule) throw new Error("Rule not found");

    const allRules = await this.rules.listForAccount(
      tenantId,
      accountId,
    );
    const boundedLimit = Math.max(
      1,
      Math.min(limit, 500),
    );

    return (await this.messages.listForAccount(
      tenantId,
      accountId,
    ))
      .filter((message) =>
        conditionMatchesMessage(rule.condition, message),
      )
      .sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      )
      .slice(0, boundedLimit)
      .map((message) =>
        previewRow(
          rule.id,
          message,
          resolveDashboardRules(allRules, message),
        ),
      );
  }

  async dashboard(
    tenantId: string,
    accountId: string,
  ): Promise<RulesDashboardViewModel> {
    const currentRules = await this.list(
      tenantId,
      accountId,
    );
    const messages = await this.messages.listForAccount(
      tenantId,
      accountId,
    );

    const conflicts = new Map<string, RuleConflict>();
    for (const message of messages) {
      const resolution = resolveDashboardRules(
        currentRules,
        message,
      );
      for (const conflict of resolution.conflicts) {
        conflicts.set(conflictKey(conflict), conflict);
      }
    }

    return {
      rows: currentRules.map((rule) => ({
        rule: structuredClone(rule),
        conditionLabel: conditionLabel(rule.condition),
        actionLabel: actionLabel(rule.action),
        precedenceLabel: precedenceLabel(rule),
        affectedMessageCount: messages.filter((message) =>
          conditionMatchesMessage(
            rule.condition,
            message,
          ),
        ).length,
      })),
      conflicts: [...conflicts.values()].map((conflict) =>
        structuredClone(conflict),
      ),
    };
  }
}
