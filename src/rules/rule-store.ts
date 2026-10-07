import { tenantScopedKey } from "../security/tenant-boundary.js";
import type {
  DashboardRule,
  DashboardRuleStore,
} from "./rule-types.js";

function key(
  tenantId: string,
  accountId: string,
  ruleId: string,
): string {
  return tenantScopedKey({ tenantId, accountId }, "rule", ruleId);
}

export class RuleRevisionConflictError extends Error {
  readonly code = "RULE_REVISION_CONFLICT";

  constructor() {
    super("Rule revision changed; reload before saving");
    this.name = "RuleRevisionConflictError";
  }
}

export class InMemoryDashboardRuleStore
  implements DashboardRuleStore
{
  private readonly rules = new Map<string, DashboardRule>();

  async create(rule: DashboardRule): Promise<void> {
    const ruleKey = key(rule.tenantId, rule.accountId, rule.id);
    if (this.rules.has(ruleKey)) {
      throw new Error("Rule already exists");
    }
    this.rules.set(ruleKey, structuredClone(rule));
  }

  async get(
    tenantId: string,
    accountId: string,
    ruleId: string,
  ): Promise<DashboardRule | undefined> {
    const found = this.rules.get(
      key(tenantId, accountId, ruleId),
    );
    return found ? structuredClone(found) : undefined;
  }

  async listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<DashboardRule[]> {
    return [...this.rules.values()]
      .filter(
        (rule) =>
          rule.tenantId === tenantId &&
          rule.accountId === accountId,
      )
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map((rule) => structuredClone(rule));
  }

  async update(
    tenantId: string,
    accountId: string,
    ruleId: string,
    expectedRevision: number,
    mutate: (current: DashboardRule) => DashboardRule,
  ): Promise<DashboardRule> {
    const ruleKey = key(tenantId, accountId, ruleId);
    const current = this.rules.get(ruleKey);
    if (!current) throw new Error("Rule not found");
    if (current.revision !== expectedRevision) {
      throw new RuleRevisionConflictError();
    }

    const next = mutate(structuredClone(current));
    this.rules.set(ruleKey, structuredClone(next));
    return structuredClone(next);
  }

  async delete(
    tenantId: string,
    accountId: string,
    ruleId: string,
    expectedRevision: number,
  ): Promise<boolean> {
    const ruleKey = key(tenantId, accountId, ruleId);
    const current = this.rules.get(ruleKey);
    if (!current) return false;
    if (current.revision !== expectedRevision) {
      throw new RuleRevisionConflictError();
    }
    return this.rules.delete(ruleKey);
  }
}
