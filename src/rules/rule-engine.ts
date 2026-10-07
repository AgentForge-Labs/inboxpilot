import {
  CLASSIFIER_CATEGORIES,
} from "../classifier/classifier-contract.js";
import type { CanonicalMessage } from "../domain/email-model.js";
import type { PolicyOverride } from "../policy/policy-types.js";
import type {
  CompiledRuleOverlay,
  DashboardRule,
  RuleAction,
  RuleCondition,
  RuleConditionAtom,
  RuleConflict,
  RuleResolution,
} from "./rule-types.js";

const CATEGORY_SET = new Set<string>(CLASSIFIER_CATEGORIES);

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDomain(value: string): string {
  let domain = value.trim().toLowerCase();
  while (domain.startsWith(".")) domain = domain.slice(1);
  while (domain.endsWith(".")) domain = domain.slice(0, -1);
  return domain;
}

function senderDomain(message: CanonicalMessage): string | undefined {
  const address = message.from?.address?.trim().toLowerCase();
  if (!address) return undefined;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return undefined;
  return address.slice(at + 1);
}

function assertScore(value: number, field: string): void {
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new RangeError(field + " must be between 0 and 100");
  }
}

function assertDays(
  value: number,
  field: string,
  minimum: number,
): void {
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > 36500
  ) {
    throw new RangeError(
      field +
        " must be an integer between " +
        minimum +
        " and 36500",
    );
  }
}

function validateRuleConditionAtom(
  condition: RuleConditionAtom,
): RuleConditionAtom {
  switch (condition.kind) {
    case "sender": {
      const address = normalizeAddress(condition.address);
      if (
        !address ||
        !address.includes("@") ||
        address.startsWith("@") ||
        address.endsWith("@")
      ) {
        throw new TypeError("sender condition requires a valid address");
      }
      return { kind: "sender", address };
    }
    case "domain": {
      const domain = normalizeDomain(condition.domain);
      if (
        !domain ||
        domain.includes("@") ||
        !domain.includes(".")
      ) {
        throw new TypeError("domain condition requires a valid domain");
      }
      return { kind: "domain", domain };
    }
    case "category": {
      const category = condition.category.trim().toLowerCase();
      if (!CATEGORY_SET.has(category)) {
        throw new TypeError("Unknown classifier category " + category);
      }
      return { kind: "category", category };
    }
    case "score": {
      assertScore(condition.value, "score.value");
      if (condition.operator === "between") {
        if (condition.max === undefined) {
          throw new TypeError(
            "score.max is required for between",
          );
        }
        assertScore(condition.max, "score.max");
        if (condition.value > condition.max) {
          throw new RangeError(
            "score.value must not exceed score.max",
          );
        }
        return {
          kind: "score",
          operator: "between",
          value: condition.value,
          max: condition.max,
        };
      }
      if (condition.max !== undefined) {
        throw new TypeError(
          "score.max is only valid for between",
        );
      }
      return {
        kind: "score",
        operator: condition.operator,
        value: condition.value,
      };
    }
  }
}

export function validateRuleCondition(
  condition: RuleCondition,
): RuleCondition {
  if (condition.kind !== "all") {
    return validateRuleConditionAtom(condition);
  }

  if (
    !Array.isArray(condition.conditions) ||
    condition.conditions.length < 2 ||
    condition.conditions.length > 4
  ) {
    throw new RangeError(
      "all condition requires between 2 and 4 atomic conditions",
    );
  }

  const normalized = condition.conditions.map(
    validateRuleConditionAtom,
  );
  const kinds = new Set(normalized.map((item) => item.kind));
  if (kinds.size !== normalized.length) {
    throw new TypeError(
      "all condition cannot repeat the same condition kind",
    );
  }

  return {
    kind: "all",
    conditions: normalized,
  };
}

export function validateRuleAction(
  action: RuleAction,
  destructiveAcknowledged = false,
): RuleAction {
  switch (action.kind) {
    case "always_important":
    case "never_delete":
    case "keep_indefinitely":
      return { kind: action.kind };
    case "archive_after_days":
      assertDays(action.days, "archive_after_days.days", 0);
      return { kind: action.kind, days: action.days };
    case "delete_after_days":
      assertDays(action.days, "delete_after_days.days", 1);
      if (!destructiveAcknowledged) {
        throw new TypeError(
          "delete_after_days requires explicit destructive acknowledgement",
        );
      }
      return { kind: action.kind, days: action.days };
  }
}

export function validateRulePriority(priority: number): number {
  if (
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 100
  ) {
    throw new RangeError("rule priority must be an integer from 0 to 100");
  }
  return priority;
}

function atomMatchesMessage(
  condition: RuleConditionAtom,
  message: CanonicalMessage,
): boolean {
  switch (condition.kind) {
    case "sender":
      return (
        message.from?.address?.trim().toLowerCase() ===
        condition.address
      );
    case "domain":
      return senderDomain(message) === condition.domain;
    case "category":
      return message.classification.categories.some(
        (category) =>
          category.trim().toLowerCase() ===
          condition.category,
      );
    case "score": {
      const score = message.classification.importanceScore;
      if (score === undefined) return false;
      switch (condition.operator) {
        case "lt":
          return score < condition.value;
        case "lte":
          return score <= condition.value;
        case "gt":
          return score > condition.value;
        case "gte":
          return score >= condition.value;
        case "between":
          return (
            condition.max !== undefined &&
            score >= condition.value &&
            score <= condition.max
          );
      }
    }
  }
}

export function conditionMatchesMessage(
  condition: RuleCondition,
  message: CanonicalMessage,
): boolean {
  return condition.kind === "all"
    ? condition.conditions.every((atom) =>
        atomMatchesMessage(atom, message),
      )
    : atomMatchesMessage(condition, message);
}

export function ruleMatchesMessage(
  rule: DashboardRule,
  message: CanonicalMessage,
): boolean {
  return (
    rule.enabled &&
    rule.tenantId === message.tenantId &&
    rule.accountId === message.accountId &&
    conditionMatchesMessage(rule.condition, message)
  );
}

function atomSpecificity(
  condition: RuleConditionAtom,
): number {
  switch (condition.kind) {
    case "sender":
      return 400;
    case "domain":
      return 300;
    case "category":
      return 200;
    case "score":
      return 100;
  }
}

function specificity(rule: DashboardRule): number {
  return rule.condition.kind === "all"
    ? rule.condition.conditions.reduce(
        (total, condition) =>
          total + atomSpecificity(condition),
        0,
      )
    : atomSpecificity(rule.condition);
}

function actionSafetyRank(action: RuleAction): number {
  switch (action.kind) {
    case "never_delete":
    case "keep_indefinitely":
      return 3;
    case "always_important":
      return 2;
    case "archive_after_days":
      return 1;
    case "delete_after_days":
      return 0;
  }
}

function compareRules(
  a: DashboardRule,
  b: DashboardRule,
): number {
  const specificityDelta = specificity(b) - specificity(a);
  if (specificityDelta !== 0) return specificityDelta;

  const priorityDelta = b.priority - a.priority;
  if (priorityDelta !== 0) return priorityDelta;

  const safetyDelta =
    actionSafetyRank(b.action) - actionSafetyRank(a.action);
  if (safetyDelta !== 0) return safetyDelta;

  const updateDelta = b.updatedAt.localeCompare(a.updatedAt);
  if (updateDelta !== 0) return updateDelta;
  return a.id.localeCompare(b.id);
}

function isProtective(action: RuleAction): boolean {
  return (
    action.kind === "never_delete" ||
    action.kind === "keep_indefinitely"
  );
}

function isRetention(action: RuleAction): boolean {
  return (
    action.kind === "archive_after_days" ||
    action.kind === "delete_after_days"
  );
}

function retentionDirective(rule: DashboardRule) {
  if (rule.action.kind === "archive_after_days") {
    return {
      action: "archive" as const,
      afterDays: rule.action.days,
      ruleId: rule.id,
    };
  }
  if (rule.action.kind === "delete_after_days") {
    return {
      action: "delete" as const,
      afterDays: rule.action.days,
      ruleId: rule.id,
    };
  }
  return undefined;
}

export function resolveDashboardRules(
  rules: readonly DashboardRule[],
  message: CanonicalMessage,
): RuleResolution {
  const matched = rules
    .filter((rule) => ruleMatchesMessage(rule, message))
    .sort(compareRules);

  const importantRules = matched.filter(
    (rule) => rule.action.kind === "always_important",
  );
  const protectiveRules = matched.filter((rule) =>
    isProtective(rule.action),
  );
  const retentionRules = matched.filter((rule) =>
    isRetention(rule.action),
  );

  const conflicts: RuleConflict[] = [];
  const applied = new Set<string>();
  importantRules.forEach((rule) => applied.add(rule.id));

  const protectiveWinner = protectiveRules[0];
  if (protectiveWinner) {
    applied.add(protectiveWinner.id);
    for (const loser of retentionRules) {
      conflicts.push({
        type: "protected_over_destructive",
        ruleIds: [protectiveWinner.id, loser.id],
        winnerRuleId: protectiveWinner.id,
        loserRuleId: loser.id,
        reason:
          "Never Delete / Keep Indefinitely overrides archive/delete rules.",
      });
    }
  }

  let retention:
    | ReturnType<typeof retentionDirective>
    | undefined;
  if (!protectiveWinner && retentionRules.length > 0) {
    const winner = retentionRules[0]!;
    retention = retentionDirective(winner);
    applied.add(winner.id);

    for (const loser of retentionRules.slice(1)) {
      const sameSpecificity =
        specificity(winner) === specificity(loser);
      const samePriority = winner.priority === loser.priority;
      const lessDestructiveTie =
        sameSpecificity &&
        samePriority &&
        winner.action.kind === "archive_after_days" &&
        loser.action.kind === "delete_after_days";

      conflicts.push({
        type: lessDestructiveTie
          ? "less_destructive_tiebreak"
          : "shadowed_by_precedence",
        ruleIds: [winner.id, loser.id],
        winnerRuleId: winner.id,
        loserRuleId: loser.id,
        reason: lessDestructiveTie
          ? "Equivalent-precedence retention rules resolve to the less destructive archive action."
          : "Higher specificity or rule priority wins this retention conflict.",
      });
    }
  }

  const explanations: string[] = [];
  if (importantRules.length > 0) {
    explanations.push(
      "Always Important matched: " +
        importantRules.map((rule) => rule.name).join(", "),
    );
  }
  if (protectiveWinner) {
    explanations.push(
      "Deletion protected by " + protectiveWinner.name,
    );
  }
  if (retention) {
    explanations.push(
      "Retention resolved to " +
        retention.action +
        " after " +
        retention.afterDays +
        " days.",
    );
  }

  return {
    matchedRuleIds: matched.map((rule) => rule.id),
    appliedRuleIds: [...applied],
    alwaysImportant: importantRules.length > 0,
    protectedFromDelete: Boolean(protectiveWinner),
    ...(retention ? { retention } : {}),
    conflicts,
    explanations,
  };
}

export function compileRulesForPolicyEngine(
  rules: readonly DashboardRule[],
): CompiledRuleOverlay {
  const policyOverrides: PolicyOverride[] = [];
  const resolverManagedRuleIds: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (
      rule.condition.kind !== "sender" &&
      rule.condition.kind !== "domain"
    ) {
      resolverManagedRuleIds.push(rule.id);
      continue;
    }

    const scope = rule.condition.kind;
    const key =
      scope === "sender"
        ? rule.condition.address
        : rule.condition.domain;

    let action: PolicyOverride["action"] | undefined;
    switch (rule.action.kind) {
      case "always_important":
        action = "mark_important";
        break;
      case "never_delete":
      case "keep_indefinitely":
        action = "protect";
        break;
      case "archive_after_days":
      case "delete_after_days":
        resolverManagedRuleIds.push(rule.id);
        break;
    }

    if (action) {
      policyOverrides.push({
        id: rule.id,
        scope,
        key,
        action,
        enabled: true,
      });
    }
  }

  return { policyOverrides, resolverManagedRuleIds };
}

function atomConditionLabel(
  condition: RuleConditionAtom,
): string {
  switch (condition.kind) {
    case "sender":
      return "Sender is " + condition.address;
    case "domain":
      return "Domain is " + condition.domain;
    case "category":
      return "Category is " + condition.category;
    case "score":
      return condition.operator === "between"
        ? "Score " + condition.value + "–" + String(condition.max)
        : "Score " + condition.operator + " " + condition.value;
  }
}

export function conditionLabel(condition: RuleCondition): string {
  return condition.kind === "all"
    ? condition.conditions.map(atomConditionLabel).join(" AND ")
    : atomConditionLabel(condition);
}

export function actionLabel(action: RuleAction): string {
  switch (action.kind) {
    case "always_important":
      return "Always Important";
    case "never_delete":
      return "Never Delete";
    case "keep_indefinitely":
      return "Keep indefinitely";
    case "archive_after_days":
      return "Archive after " + action.days + " days";
    case "delete_after_days":
      return "Delete after " + action.days + " days";
  }
}

export function precedenceLabel(rule: DashboardRule): string {
  const scope =
    rule.condition.kind === "all"
      ? "0 · Compound"
      : rule.condition.kind === "sender"
        ? "1 · Sender"
        : rule.condition.kind === "domain"
          ? "2 · Domain"
          : rule.condition.kind === "category"
            ? "3 · Category"
            : "4 · Score";
  const safety = isProtective(rule.action)
    ? " · safety override"
    : "";
  return scope + " · priority " + rule.priority + safety;
}
