import { randomBytes } from "node:crypto";
import type {
  NaturalLanguageRuleConfirmationStore,
  PendingNaturalLanguageRule,
} from "./natural-language-rule-types.js";

export class RuleConfirmationError extends Error {
  readonly code:
    | "RULE_CONFIRMATION_NOT_FOUND"
    | "RULE_CONFIRMATION_SCOPE_MISMATCH"
    | "RULE_CONFIRMATION_EXPIRED";

  constructor(
    code: RuleConfirmationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RuleConfirmationError";
    this.code = code;
  }
}

export class InMemoryNaturalLanguageRuleConfirmationStore
  implements NaturalLanguageRuleConfirmationStore
{
  private readonly pending = new Map<
    string,
    PendingNaturalLanguageRule
  >();

  async issue(
    input: Omit<PendingNaturalLanguageRule, "token">,
  ): Promise<PendingNaturalLanguageRule> {
    const token = randomBytes(24).toString("base64url");
    const record: PendingNaturalLanguageRule = {
      ...structuredClone(input),
      token,
    };
    this.pending.set(token, record);
    return structuredClone(record);
  }

  async consume(
    token: string,
    tenantId: string,
    accountId: string,
    now: string,
  ): Promise<PendingNaturalLanguageRule> {
    const record = this.pending.get(token);
    if (!record) {
      throw new RuleConfirmationError(
        "RULE_CONFIRMATION_NOT_FOUND",
        "Rule confirmation token is missing, invalid, or already used",
      );
    }

    if (
      record.tenantId !== tenantId ||
      record.accountId !== accountId
    ) {
      throw new RuleConfirmationError(
        "RULE_CONFIRMATION_SCOPE_MISMATCH",
        "Rule confirmation token is not valid for this account",
      );
    }

    this.pending.delete(token);

    if (record.expiresAt <= now) {
      throw new RuleConfirmationError(
        "RULE_CONFIRMATION_EXPIRED",
        "Rule confirmation token has expired",
      );
    }

    return structuredClone(record);
  }
}
