import { randomUUID } from "node:crypto";
import type { RulesDashboardService } from "../dashboard/rules-dashboard-service.js";
import type { CanonicalMessage } from "../domain/email-model.js";
import {
  conditionMatchesMessage,
  resolveDashboardRules,
} from "../rules/rule-engine.js";
import type {
  DashboardRule,
  RuleMessageRepository,
} from "../rules/rule-types.js";
import type {
  NaturalLanguageRuleConfirmationStore,
  NaturalLanguageRuleDraft,
  NaturalLanguageRulePreview,
  NaturalLanguageRuleProposal,
} from "./natural-language-rule-types.js";
import type {
  NaturalLanguageRuleParser,
} from "./natural-language-rule-parser.js";

export interface ProposeNaturalLanguageRuleInput {
  tenantId: string;
  accountId: string;
  command: string;
}

export interface ConfirmNaturalLanguageRuleInput {
  tenantId: string;
  accountId: string;
  confirmationToken: string;
}

function requireId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(field + " is required");
  return normalized;
}

function senderLabel(message: CanonicalMessage): string {
  const name = message.from?.name?.trim();
  const address = message.from?.address?.trim();
  if (name && address) return name + " <" + address + ">";
  return address || name || "Unknown sender";
}

function pendingRule(
  draft: NaturalLanguageRuleDraft,
  tenantId: string,
  accountId: string,
  now: string,
): DashboardRule {
  return {
    id: "pending-" + randomUUID(),
    tenantId,
    accountId,
    name: draft.name,
    enabled: true,
    priority: 50,
    condition: structuredClone(draft.condition),
    action: structuredClone(draft.action),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export class NaturalLanguageRuleService {
  constructor(
    private readonly parser: NaturalLanguageRuleParser,
    private readonly rules: RulesDashboardService,
    private readonly messages: RuleMessageRepository,
    private readonly confirmations: NaturalLanguageRuleConfirmationStore,
    private readonly now: () => Date = () => new Date(),
    private readonly confirmationTtlMs = 10 * 60 * 1000,
  ) {}

  async propose(
    input: ProposeNaturalLanguageRuleInput,
  ): Promise<NaturalLanguageRuleProposal> {
    const tenantId = requireId(input.tenantId, "tenantId");
    const accountId = requireId(input.accountId, "accountId");
    const messages = await this.messages.listForAccount(
      tenantId,
      accountId,
    );
    const parsed = this.parser.parse(input.command, messages);

    if (parsed.kind === "clarification") {
      return {
        status: "needs_clarification",
        message: parsed.message,
        ...(parsed.candidates
          ? { candidates: [...parsed.candidates] }
          : {}),
      };
    }

    const draft = parsed.draft;
    if (!draft.broad && !draft.dangerous) {
      const rule = await this.rules.create({
        tenantId,
        accountId,
        name: draft.name,
        condition: draft.condition,
        action: draft.action,
      });
      return {
        status: "created",
        draft,
        rule,
      };
    }

    const createdAt = this.now().toISOString();
    const expiresAt = new Date(
      Date.parse(createdAt) + this.confirmationTtlMs,
    ).toISOString();
    const preview = await this.preview(
      tenantId,
      accountId,
      draft,
      messages,
      createdAt,
    );
    const pending = await this.confirmations.issue({
      tenantId,
      accountId,
      draft,
      createdAt,
      expiresAt,
    });

    const warnings: string[] = [];
    if (draft.broad) {
      warnings.push(
        "This rule has broad scope and requires explicit confirmation.",
      );
    }
    if (draft.dangerous) {
      warnings.push(
        "This rule can enter messages into the deletion lifecycle and requires explicit confirmation.",
      );
    }
    warnings.push(...draft.resolutionNotes);

    return {
      status: "confirmation_required",
      draft,
      preview,
      confirmationToken: pending.token,
      expiresAt,
      warnings,
    };
  }

  async confirm(
    input: ConfirmNaturalLanguageRuleInput,
  ): Promise<NaturalLanguageRuleProposal> {
    const tenantId = requireId(input.tenantId, "tenantId");
    const accountId = requireId(input.accountId, "accountId");
    const token = requireId(
      input.confirmationToken,
      "confirmationToken",
    );

    const pending = await this.confirmations.consume(
      token,
      tenantId,
      accountId,
      this.now().toISOString(),
    );
    const rule = await this.rules.create({
      tenantId,
      accountId,
      name: pending.draft.name,
      condition: pending.draft.condition,
      action: pending.draft.action,
      ...(pending.draft.dangerous
        ? { destructiveAcknowledged: true }
        : {}),
    });

    return {
      status: "created",
      draft: pending.draft,
      rule,
    };
  }

  private async preview(
    tenantId: string,
    accountId: string,
    draft: NaturalLanguageRuleDraft,
    messages: readonly CanonicalMessage[],
    now: string,
  ): Promise<NaturalLanguageRulePreview> {
    const existing = await this.rules.list(
      tenantId,
      accountId,
    );
    const candidate = pendingRule(
      draft,
      tenantId,
      accountId,
      now,
    );

    const affected = messages
      .filter((message) =>
        conditionMatchesMessage(draft.condition, message),
      )
      .sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      );

    return {
      affectedMessageCount: affected.length,
      sample: affected.slice(0, 25).map((message) => {
        const resolution = resolveDashboardRules(
          [...existing, candidate],
          message,
        );
        return {
          canonicalMessageId: message.id,
          providerMessageId: message.provider.messageId,
          sender: senderLabel(message),
          subject: message.subject || "(no subject)",
          receivedAt: message.receivedAt,
          ...(message.classification.importanceScore !== undefined
            ? {
                importanceScore:
                  message.classification.importanceScore,
              }
            : {}),
          categories: [
            ...message.classification.categories,
          ],
          effective:
            resolution.appliedRuleIds.includes(candidate.id),
          conflicts: resolution.conflicts
            .filter((conflict) =>
              conflict.ruleIds.includes(candidate.id),
            )
            .map((conflict) => conflict.reason),
        };
      }),
    };
  }
}
