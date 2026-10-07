import type {
  DashboardRule,
  RuleAction,
  RuleCondition,
} from "../rules/rule-types.js";

export interface NaturalLanguageRuleDraft {
  name: string;
  sourceCommand: string;
  condition: RuleCondition;
  action: RuleAction;
  broad: boolean;
  dangerous: boolean;
  resolutionNotes: string[];
}

export interface NaturalLanguageRulePreviewRow {
  canonicalMessageId: string;
  providerMessageId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  importanceScore?: number;
  categories: string[];
  effective: boolean;
  conflicts: string[];
}

export interface NaturalLanguageRulePreview {
  affectedMessageCount: number;
  sample: NaturalLanguageRulePreviewRow[];
}

export type NaturalLanguageRuleProposal =
  | {
      status: "created";
      draft: NaturalLanguageRuleDraft;
      rule: DashboardRule;
    }
  | {
      status: "confirmation_required";
      draft: NaturalLanguageRuleDraft;
      preview: NaturalLanguageRulePreview;
      confirmationToken: string;
      expiresAt: string;
      warnings: string[];
    }
  | {
      status: "needs_clarification";
      message: string;
      candidates?: string[];
    };

export interface PendingNaturalLanguageRule {
  token: string;
  tenantId: string;
  accountId: string;
  draft: NaturalLanguageRuleDraft;
  createdAt: string;
  expiresAt: string;
}

export interface NaturalLanguageRuleConfirmationStore {
  issue(input: Omit<PendingNaturalLanguageRule, "token">): Promise<PendingNaturalLanguageRule>;
  consume(
    token: string,
    tenantId: string,
    accountId: string,
    now: string,
  ): Promise<PendingNaturalLanguageRule>;
}
