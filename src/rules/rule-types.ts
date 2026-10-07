import type { CanonicalMessage } from "../domain/email-model.js";
import type { PolicyOverride } from "../policy/policy-types.js";

export type RuleCondition =
  | { kind: "sender"; address: string }
  | { kind: "domain"; domain: string }
  | { kind: "category"; category: string }
  | {
      kind: "score";
      operator: "lt" | "lte" | "gt" | "gte" | "between";
      value: number;
      max?: number;
    };

export type RuleAction =
  | { kind: "always_important" }
  | { kind: "never_delete" }
  | { kind: "archive_after_days"; days: number }
  | { kind: "delete_after_days"; days: number }
  | { kind: "keep_indefinitely" };

export interface DashboardRule {
  id: string;
  tenantId: string;
  accountId: string;
  name: string;
  enabled: boolean;
  priority: number;
  condition: RuleCondition;
  action: RuleAction;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDashboardRuleInput {
  tenantId: string;
  accountId: string;
  name: string;
  enabled?: boolean;
  priority?: number;
  condition: RuleCondition;
  action: RuleAction;
  destructiveAcknowledged?: boolean;
}

export interface UpdateDashboardRuleInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  condition?: RuleCondition;
  action?: RuleAction;
  expectedRevision: number;
  destructiveAcknowledged?: boolean;
}

export interface RuleConflict {
  type:
    | "protected_over_destructive"
    | "shadowed_by_precedence"
    | "less_destructive_tiebreak";
  ruleIds: string[];
  winnerRuleId: string;
  loserRuleId: string;
  reason: string;
}

export interface RuleRetentionDirective {
  action: "archive" | "delete";
  afterDays: number;
  ruleId: string;
}

export interface RuleResolution {
  matchedRuleIds: string[];
  appliedRuleIds: string[];
  alwaysImportant: boolean;
  protectedFromDelete: boolean;
  retention?: RuleRetentionDirective;
  conflicts: RuleConflict[];
  explanations: string[];
}

export interface RulePreviewRow {
  canonicalMessageId: string;
  providerMessageId: string;
  subject: string;
  sender: string;
  receivedAt: string;
  importanceScore?: number;
  categories: string[];
  effective: boolean;
  resolution: RuleResolution;
}

export interface RuleDashboardRow {
  rule: DashboardRule;
  conditionLabel: string;
  actionLabel: string;
  precedenceLabel: string;
  affectedMessageCount: number;
}

export interface RulesDashboardViewModel {
  rows: RuleDashboardRow[];
  conflicts: RuleConflict[];
}

export interface DashboardRuleStore {
  create(rule: DashboardRule): Promise<void>;
  get(
    tenantId: string,
    accountId: string,
    ruleId: string,
  ): Promise<DashboardRule | undefined>;
  listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<DashboardRule[]>;
  update(
    tenantId: string,
    accountId: string,
    ruleId: string,
    expectedRevision: number,
    mutate: (current: DashboardRule) => DashboardRule,
  ): Promise<DashboardRule>;
  delete(
    tenantId: string,
    accountId: string,
    ruleId: string,
    expectedRevision: number,
  ): Promise<boolean>;
}

export interface RuleMessageRepository {
  listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<CanonicalMessage[]>;
}

export interface CompiledRuleOverlay {
  policyOverrides: PolicyOverride[];
  resolverManagedRuleIds: string[];
}
