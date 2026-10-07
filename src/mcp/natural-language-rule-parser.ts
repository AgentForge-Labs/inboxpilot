import type { CanonicalMessage } from "../domain/email-model.js";
import { looksLikeQuotedOrInjectedToolCommand } from "../classifier/untrusted-email-content.js";
import {
  validateRuleAction,
  validateRuleCondition,
} from "../rules/rule-engine.js";
import type {
  RuleAction,
  RuleCondition,
  RuleConditionAtom,
} from "../rules/rule-types.js";
import type {
  NaturalLanguageRuleDraft,
} from "./natural-language-rule-types.js";

export type NaturalLanguageRuleParseResult =
  | {
      kind: "draft";
      draft: NaturalLanguageRuleDraft;
    }
  | {
      kind: "clarification";
      message: string;
      candidates?: string[];
    };

const CATEGORY_ALIASES: Readonly<Record<string, string>> = {
  promotion: "promotion",
  promotions: "promotion",
  promotional: "promotion",
  newsletter: "newsletter",
  newsletters: "newsletter",
  receipt: "receipt",
  receipts: "receipt",
  invoice: "invoice",
  invoices: "invoice",
  social: "social",
  notification: "notification",
  notifications: "notification",
  delivery: "delivery",
  deliveries: "delivery",
  appointment: "appointment",
  appointments: "appointment",
  travel: "travel",
  banking: "banking",
  government: "government",
  legal: "legal",
  security: "security",
};

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function extractEmail(command: string): string | undefined {
  return command.match(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  )?.[0]?.toLowerCase();
}

function extractExplicitDomain(
  command: string,
  email: string | undefined,
): string | undefined {
  const withoutEmail = email
    ? command.replace(email, " ")
    : command;
  const matches = withoutEmail.match(
    /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi,
  );
  return matches?.[0]?.toLowerCase();
}

function extractCategory(command: string): string | undefined {
  const lower = command.toLowerCase();
  for (const [alias, canonical] of Object.entries(
    CATEGORY_ALIASES,
  )) {
    if (
      new RegExp(
        "(?:^|[^a-z])" + alias + "(?:s)?(?:$|[^a-z])",
        "i",
      ).test(lower)
    ) {
      return canonical;
    }
  }
  return undefined;
}

function extractScoreCondition(
  command: string,
): RuleConditionAtom | undefined {
  const lower = command.toLowerCase();

  const belowPatterns = [
    /\bbelow\s+(?:importance(?:\s+score)?|score)?\s*(\d{1,3})\b/,
    /\b(?:importance(?:\s+score)?|score)\s+below\s+(\d{1,3})\b/,
    /\bunder\s+(?:importance(?:\s+score)?|score)?\s*(\d{1,3})\b/,
    /\bless\s+than\s+(?:importance(?:\s+score)?|score)?\s*(\d{1,3})\b/,
  ];
  for (const pattern of belowPatterns) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      return {
        kind: "score",
        operator: "lt",
        value: Number(match[1]),
      };
    }
  }

  const abovePatterns = [
    /\babove\s+(?:importance(?:\s+score)?|score)?\s*(\d{1,3})\b/,
    /\b(?:importance(?:\s+score)?|score)\s+above\s+(\d{1,3})\b/,
    /\bover\s+(?:importance(?:\s+score)?|score)?\s*(\d{1,3})\b/,
    /\bgreater\s+than\s+(?:importance(?:\s+score)?|score)?\s*(\d{1,3})\b/,
  ];
  for (const pattern of abovePatterns) {
    const match = lower.match(pattern);
    if (match?.[1]) {
      return {
        kind: "score",
        operator: "gt",
        value: Number(match[1]),
      };
    }
  }

  const between = lower.match(
    /\b(?:importance(?:\s+score)?|score)\s+between\s+(\d{1,3})\s+(?:and|to|-)\s+(\d{1,3})\b/,
  );
  if (between?.[1] && between[2]) {
    return {
      kind: "score",
      operator: "between",
      value: Number(between[1]),
      max: Number(between[2]),
    };
  }

  return undefined;
}

function extractDays(
  command: string,
  verb: "archive" | "delete",
): number | undefined {
  const lower = command.toLowerCase();
  const patterns =
    verb === "delete"
      ? [
          /\bdelete(?:d)?(?:\s+(?:them|it|emails?|messages?))?\s+after\s+(\d{1,5})\s+days?\b/,
          /\bafter\s+(\d{1,5})\s+days?.{0,24}\bdelete(?:d)?\b/,
        ]
      : [
          /\barchive(?:d)?(?:\s+(?:them|it|emails?|messages?))?\s+after\s+(\d{1,5})\s+days?\b/,
          /\bafter\s+(\d{1,5})\s+days?.{0,24}\barchive(?:d)?\b/,
        ];

  for (const pattern of patterns) {
    const match = lower.match(pattern);
    if (match?.[1]) return Number(match[1]);
  }
  return undefined;
}

function parseAction(
  command: string,
):
  | { kind: "ok"; action: RuleAction }
  | { kind: "clarification"; message: string } {
  const lower = command.toLowerCase();

  if (/\bnever\s+delete\b/.test(lower)) {
    return { kind: "ok", action: { kind: "never_delete" } };
  }
  if (
    /\bkeep\b.*\b(?:indefinitely|forever|permanently)\b/.test(
      lower,
    )
  ) {
    return {
      kind: "ok",
      action: { kind: "keep_indefinitely" },
    };
  }
  if (
    /\b(?:always\s+important|always\s+mark\b.*\bimportant|mark\b.*\balways\s+important)\b/.test(
      lower,
    )
  ) {
    return {
      kind: "ok",
      action: { kind: "always_important" },
    };
  }

  const deleteDays = extractDays(command, "delete");
  if (deleteDays !== undefined) {
    return {
      kind: "ok",
      action: {
        kind: "delete_after_days",
        days: deleteDays,
      },
    };
  }

  if (/\bdelete(?:d)?\b/.test(lower)) {
    return {
      kind: "clarification",
      message:
        "Deletion rules require an explicit delay, for example 'delete after 30 days'.",
    };
  }

  const archiveDays = extractDays(command, "archive");
  if (archiveDays !== undefined) {
    return {
      kind: "ok",
      action: {
        kind: "archive_after_days",
        days: archiveDays,
      },
    };
  }

  if (/\barchive(?:d)?\b/.test(lower)) {
    return {
      kind: "ok",
      action: {
        kind: "archive_after_days",
        days: 0,
      },
    };
  }

  return {
    kind: "clarification",
    message:
      "I could not determine the rule action. Use Never Delete, Always Important, Archive, Archive after N days, Delete after N days, or Keep indefinitely.",
  };
}

function extractEntityHint(
  command: string,
  category: string | undefined,
): string | undefined {
  const patterns = category
    ? [
        new RegExp(
          "\\b(?:archive|delete|never delete|keep)\\s+([a-z0-9][a-z0-9 ._-]{1,60}?)\\s+" +
            category +
            "s?\\b",
          "i",
        ),
      ]
    : [
        /\bnever\s+delete\s+([a-z0-9][a-z0-9 ._-]{1,60}?)\s+(?:emails?|mail|messages?)\b/i,
        /\b(?:archive|delete|keep)\s+([a-z0-9][a-z0-9 ._-]{1,60}?)\s+(?:emails?|mail|messages?)\b/i,
        /\bfrom\s+([a-z0-9][a-z0-9 ._-]{1,60}?)(?:\s+emails?|\s+mail|\s+messages?|$)/i,
      ];

  for (const pattern of patterns) {
    const value = command.match(pattern)?.[1]?.trim();
    if (
      value &&
      !/^(?:all|any|anything|emails?|mail|messages?)$/i.test(
        value,
      )
    ) {
      return value;
    }
  }
  return undefined;
}

function senderDomain(message: CanonicalMessage): string | undefined {
  const address = message.from?.address?.trim().toLowerCase();
  if (!address) return undefined;
  const at = address.lastIndexOf("@");
  return at > 0 && at < address.length - 1
    ? address.slice(at + 1)
    : undefined;
}

function resolveEntityDomain(
  entity: string,
  messages: readonly CanonicalMessage[],
):
  | { kind: "resolved"; domain: string; note: string }
  | {
      kind: "clarification";
      message: string;
      candidates?: string[];
    } {
  const needle = entity.trim().toLowerCase();
  const matching = messages.filter((message) => {
    const name = message.from?.name?.toLowerCase() ?? "";
    const address =
      message.from?.address?.toLowerCase() ?? "";
    const domain = senderDomain(message) ?? "";
    return (
      name.includes(needle) ||
      address.includes(needle) ||
      domain.includes(needle)
    );
  });

  const domains = [
    ...new Set(
      matching
        .map(senderDomain)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();

  if (domains.length === 1) {
    return {
      kind: "resolved",
      domain: domains[0]!,
      note:
        "Resolved '" +
        entity +
        "' to sender domain " +
        domains[0] +
        " from current mailbox messages.",
    };
  }

  if (domains.length > 1) {
    return {
      kind: "clarification",
      message:
        "The sender name '" +
        entity +
        "' maps to multiple domains. Choose one domain before creating the rule.",
      candidates: domains,
    };
  }

  return {
    kind: "clarification",
    message:
      "I could not resolve '" +
      entity +
      "' to a unique sender or domain from this mailbox. Provide an email address or domain.",
  };
}

function buildRuleName(
  action: RuleAction,
  condition: RuleCondition,
): string {
  const actionLabel =
    action.kind === "always_important"
      ? "Always important"
      : action.kind === "never_delete"
        ? "Never delete"
        : action.kind === "keep_indefinitely"
          ? "Keep indefinitely"
          : action.kind === "archive_after_days"
            ? "Archive after " + action.days + " days"
            : "Delete after " + action.days + " days";

  const target =
    condition.kind === "sender"
      ? condition.address
      : condition.kind === "domain"
        ? condition.domain
        : condition.kind === "category"
          ? condition.category
          : condition.kind === "score"
            ? "importance score"
            : "matched messages";

  return (actionLabel + " · " + target).slice(0, 160);
}

function isBroad(condition: RuleCondition): boolean {
  if (condition.kind === "sender") return false;
  if (condition.kind === "all") {
    return !condition.conditions.some(
      (item) => item.kind === "sender",
    );
  }
  return true;
}

export class NaturalLanguageRuleParser {
  parse(
    rawCommand: string,
    messages: readonly CanonicalMessage[],
  ): NaturalLanguageRuleParseResult {
    const command = normalizeCommand(rawCommand);
    if (!command) {
      return {
        kind: "clarification",
        message: "Rule command is required.",
      };
    }
    if (command.length > 1000) {
      return {
        kind: "clarification",
        message: "Rule command is too long.",
      };
    }

    const commandTrust =
      looksLikeQuotedOrInjectedToolCommand(command);
    if (commandTrust.suspicious) {
      return {
        kind: "clarification",
        message:
          "Rule commands must be the user's direct instruction. Quoted email content, role-spoofing text, prompt overrides, or secret/tool instructions cannot create automation rules.",
      };
    }

    const parsedAction = parseAction(command);
    if (parsedAction.kind === "clarification") {
      return parsedAction;
    }

    const atoms: RuleConditionAtom[] = [];
    const notes: string[] = [];
    const email = extractEmail(command);
    const explicitDomain = extractExplicitDomain(command, email);
    const score = extractScoreCondition(command);
    const category = extractCategory(command);

    if (email) {
      atoms.push({ kind: "sender", address: email });
    } else if (explicitDomain) {
      atoms.push({ kind: "domain", domain: explicitDomain });
    }

    if (category) {
      atoms.push({ kind: "category", category });
    }
    if (score) {
      atoms.push(score);
    }

    if (!email && !explicitDomain) {
      const entity = extractEntityHint(command, category);
      if (entity) {
        const resolution = resolveEntityDomain(entity, messages);
        if (resolution.kind === "clarification") {
          return resolution;
        }
        atoms.unshift({
          kind: "domain",
          domain: resolution.domain,
        });
        notes.push(resolution.note);
      }
    }

    if (atoms.length === 0) {
      return {
        kind: "clarification",
        message:
          "I could not determine the rule target. Provide a sender email, domain, category, brand already present in the mailbox, or importance-score threshold.",
      };
    }

    let condition: RuleCondition =
      atoms.length === 1
        ? atoms[0]!
        : {
            kind: "all",
            conditions: atoms,
          };

    try {
      condition = validateRuleCondition(condition);
      const action = validateRuleAction(
        parsedAction.action,
        parsedAction.action.kind === "delete_after_days",
      );
      if (
        action.kind === "delete_after_days" &&
        /\barchive(?:d)?\b/i.test(command)
      ) {
        notes.push(
          "Delete-after rules use the archive-first retention lifecycle before the configured deletion delay.",
        );
      }

      return {
        kind: "draft",
        draft: {
          name: buildRuleName(action, condition),
          sourceCommand: command,
          condition,
          action,
          broad: isBroad(condition),
          dangerous: action.kind === "delete_after_days",
          resolutionNotes: notes,
        },
      };
    } catch (error) {
      return {
        kind: "clarification",
        message:
          error instanceof Error
            ? error.message
            : "Rule command could not be validated.",
      };
    }
  }
}
