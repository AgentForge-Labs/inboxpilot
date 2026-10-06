import test from "node:test";
import assert from "node:assert/strict";
import {
  MailboxPolicyEngine,
  assertExplicitActionPlan,
  parseClassifierResult,
  priorityForImportanceScore,
  unsupportedCapabilities,
  type CanonicalMessage,
  type PersonalLearningEvaluation,
  type PolicyEngineInput,
  type PolicyOverride,
} from "../src/index.js";

function message(
  id = "m1",
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  const base: CanonicalMessage = {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-" + id,
    provider: {
      kind: "gmail",
      messageId: "provider-" + id,
      threadId: "provider-thread-" + id,
    },
    subject: "General message",
    body: { text: "Hello", truncated: false },
    from: { address: "sender@example.com" },
    to: [{ address: "me@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {},
    labels: [],
    mailboxes: [{ id: "inbox", role: "inbox" }],
    flags: {
      read: false,
      starred: false,
      important: false,
      draft: false,
      answered: false,
      forwarded: false,
    },
    attachments: [],
    receivedAt: "2026-10-06T14:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["work"],
      importanceScore: 50,
      confidence: 0.9,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-06T14:00:00.000Z",
    updatedAt: "2026-10-06T14:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    provider: overrides.provider ?? base.provider,
    body: overrides.body ?? base.body,
    headers: overrides.headers ?? base.headers,
    authentication:
      overrides.authentication ?? base.authentication,
    classification:
      overrides.classification ?? base.classification,
    retention: overrides.retention ?? base.retention,
    flags: overrides.flags ?? base.flags,
    mailboxes: overrides.mailboxes ?? base.mailboxes,
  };
}

function classification(
  importanceScore: number,
  options: {
    confidence?: number;
    categories?: string[];
    recommendedAction?:
      | "keep_in_inbox"
      | "mark_important"
      | "archive"
      | "trash"
      | "needs_review";
    retention?: {
      disposition: "keep" | "archive" | "trash_later" | "protect";
      protected: boolean;
      protectionReasons: string[];
      archiveAfterDays?: number;
      trashAfterDays?: number;
    };
  } = {},
) {
  return parseClassifierResult({
    contractVersion: 1,
    importanceScore,
    priority: priorityForImportanceScore(importanceScore),
    categories: options.categories ?? ["work"],
    actionRequired: false,
    replyRequired: false,
    spamRisk: 2,
    phishingRisk: 1,
    confidence: options.confidence ?? 0.95,
    recommendedAction:
      options.recommendedAction ?? "keep_in_inbox",
    retention:
      options.retention ?? {
        disposition: "keep",
        protected: false,
        protectionReasons: [],
      },
    reason: "Policy test classifier result",
    modelVersion: "policy-test-v1",
  });
}

const providerCapabilities = unsupportedCapabilities([
  "getMessage",
  "markImportant",
  "archive",
  "trash",
]);

const planCapabilities = {
  automaticMarkImportant: true,
  automaticArchive: true,
  automaticTrash: true,
};

function input(
  score: number,
  options: Partial<PolicyEngineInput> = {},
): PolicyEngineInput {
  return {
    policyId: "policy-1",
    message: message(),
    classification: classification(score),
    providerCapabilities,
    planCapabilities,
    ...options,
  };
}

function personal(
  overrides: Partial<PersonalLearningEvaluation> = {},
): PersonalLearningEvaluation {
  return {
    importanceDelta: 0,
    alwaysArchive: false,
    neverDelete: false,
    avoidArchive: false,
    avoidTrash: false,
    replyAffinity: 0,
    matchedFeatures: [],
    reasons: [],
    ...overrides,
  };
}

test("high importance produces deterministic mark-important action plan", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(input(88));

  assert.equal(decision.outcome, "planned");
  assert.equal(decision.plan?.source, "policy_engine");
  assert.deepEqual(decision.plan?.action, {
    type: "mark_important",
    value: true,
  });
  assert.ok(decision.plan);
  assert.doesNotThrow(() =>
    assertExplicitActionPlan(decision.plan),
  );

  const repeat = engine.evaluate(input(88));
  assert.equal(
    repeat.plan?.idempotencyKey,
    decision.plan?.idempotencyKey,
  );
  assert.equal(repeat.plan?.planId, decision.plan?.planId);
});

test("protected category blocks archive and trash automation", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(8, {
      classification: classification(8, {
        categories: ["finance", "invoice"],
        recommendedAction: "trash",
        retention: {
          disposition: "trash_later",
          protected: false,
          protectionReasons: [],
          trashAfterDays: 30,
        },
      }),
    }),
  );

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.protected, true);
  assert.equal(decision.plan, undefined);
  assert.ok(decision.reasons.includes("protected_category"));
});

test("retention protection wins over explicit sender trash override", () => {
  const engine = new MailboxPolicyEngine();
  const override: PolicyOverride = {
    id: "sender-trash",
    scope: "sender",
    key: "sender@example.com",
    action: "trash",
    enabled: true,
  };
  const decision = engine.evaluate(
    input(10, {
      message: message("protected", {
        retention: {
          stage: "active",
          protected: true,
          protectionReasons: ["manual-protection"],
        },
      }),
      classification: classification(10, {
        recommendedAction: "trash",
        retention: {
          disposition: "trash_later",
          protected: false,
          protectionReasons: [],
          trashAfterDays: 30,
        },
      }),
      overrides: [override],
    }),
  );

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.plan, undefined);
  assert.ok(decision.reasons.includes("retention_protected"));
});

test("low-confidence classifier result is held for review", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(35, {
      classification: classification(35, {
        confidence: 0.4,
        recommendedAction: "archive",
        retention: {
          disposition: "archive",
          protected: false,
          protectionReasons: [],
          archiveAfterDays: 7,
        },
      }),
    }),
  );

  assert.equal(decision.outcome, "needs_review");
  assert.equal(decision.plan, undefined);
  assert.ok(
    decision.reasons.includes("low_classifier_confidence"),
  );
});

test("sender override takes precedence over domain override", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(55, {
      overrides: [
        {
          id: "domain-keep",
          scope: "domain",
          key: "example.com",
          action: "keep",
          enabled: true,
        },
        {
          id: "sender-archive",
          scope: "sender",
          key: "SENDER@EXAMPLE.COM",
          action: "archive",
          enabled: true,
        },
      ],
    }),
  );

  assert.equal(decision.outcome, "planned");
  assert.equal(decision.matchedOverride?.id, "sender-archive");
  assert.deepEqual(decision.plan?.action, { type: "archive" });
});

test("automatic trash plan carries policy authorization and stale-state preconditions", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(9, {
      classification: classification(9, {
        recommendedAction: "trash",
        retention: {
          disposition: "trash_later",
          protected: false,
          protectionReasons: [],
          trashAfterDays: 30,
        },
      }),
    }),
  );

  assert.equal(decision.outcome, "planned");
  assert.equal(decision.plan?.action.type, "trash");
  assert.equal(
    decision.plan?.destructiveAuthorization?.policyId,
    "policy-1",
  );
  assert.equal(
    decision.plan?.preconditions?.expectedCanonicalMessageId,
    "m1",
  );
  assert.equal(
    decision.plan?.preconditions?.requireUnprotected,
    true,
  );
  assert.notEqual(decision.plan?.action.type, "delete_permanent");
});

test("trash recommendation safely falls back to archive when trash entitlement is missing", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(9, {
      classification: classification(9, {
        recommendedAction: "trash",
        retention: {
          disposition: "trash_later",
          protected: false,
          protectionReasons: [],
          trashAfterDays: 30,
        },
      }),
      planCapabilities: {
        automaticMarkImportant: true,
        automaticArchive: true,
        automaticTrash: false,
      },
    }),
  );

  assert.equal(decision.outcome, "planned");
  assert.deepEqual(decision.plan?.action, { type: "archive" });
  assert.ok(decision.reasons.includes("safe_archive_fallback"));
});

test("provider capability can block an otherwise valid action", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(88, {
      providerCapabilities: unsupportedCapabilities([
        "getMessage",
        "archive",
        "trash",
      ]),
    }),
  );

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.plan, undefined);
  assert.ok(
    decision.reasons.includes("provider_capability_missing"),
  );
});

test("personal never-delete blocks trash and never grants destructive permission", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(5, {
      classification: classification(5, {
        recommendedAction: "trash",
        retention: {
          disposition: "trash_later",
          protected: false,
          protectionReasons: [],
          trashAfterDays: 30,
        },
      }),
      personal: personal({
        neverDelete: true,
        importanceDelta: -10,
      }),
    }),
  );

  assert.equal(decision.outcome, "no_action");
  assert.equal(decision.plan, undefined);
  assert.equal(decision.protected, true);
  assert.ok(decision.reasons.includes("personal_never_delete"));
});

test("personal avoid-archive suppresses threshold archive", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(30, {
      classification: classification(30, {
        recommendedAction: "archive",
        retention: {
          disposition: "archive",
          protected: false,
          protectionReasons: [],
          archiveAfterDays: 7,
        },
      }),
      personal: personal({ avoidArchive: true }),
    }),
  );

  assert.equal(decision.outcome, "no_action");
  assert.equal(decision.plan, undefined);
  assert.ok(decision.reasons.includes("personal_avoid_archive"));
});

test("explicit personal always-archive can act without trusting classifier semantics", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(55, {
      classification: classification(55, {
        confidence: 0.2,
        recommendedAction: "needs_review",
      }),
      personal: personal({ alwaysArchive: true }),
    }),
  );

  assert.equal(decision.outcome, "planned");
  assert.deepEqual(decision.plan?.action, { type: "archive" });
  assert.ok(
    decision.reasons.includes("personal_always_archive"),
  );
});

test("already archived mail does not produce duplicate archive plan", () => {
  const engine = new MailboxPolicyEngine();
  const decision = engine.evaluate(
    input(25, {
      message: message("archived", {
        retention: {
          stage: "archived",
          protected: false,
          protectionReasons: [],
        },
        mailboxes: [{ id: "archive", role: "archive" }],
      }),
      classification: classification(25, {
        recommendedAction: "archive",
        retention: {
          disposition: "archive",
          protected: false,
          protectionReasons: [],
          archiveAfterDays: 0,
        },
      }),
    }),
  );

  assert.equal(decision.outcome, "no_action");
  assert.equal(decision.plan, undefined);
  assert.ok(
    decision.reasons.includes("already_in_target_state"),
  );
});

test("custom thresholds change policy without changing classifier result", () => {
  const engine = new MailboxPolicyEngine();
  const baseClassification = classification(65, {
    recommendedAction: "mark_important",
  });

  const defaultDecision = engine.evaluate(
    input(65, { classification: baseClassification }),
  );
  assert.equal(defaultDecision.outcome, "planned");

  const customDecision = engine.evaluate(
    input(65, {
      classification: classification(65),
      thresholds: {
        importantAtOrAbove: 90,
        archiveBelow: 30,
        trashBelow: 10,
        minClassifierConfidence: 0.8,
      },
    }),
  );
  assert.equal(customDecision.outcome, "no_action");
  assert.equal(customDecision.effectiveImportanceScore, 65);
});

test("invalid threshold ordering is rejected", () => {
  const engine = new MailboxPolicyEngine();

  assert.throws(
    () =>
      engine.evaluate(
        input(50, {
          thresholds: {
            archiveBelow: 20,
            trashBelow: 40,
          },
        }),
      ),
    /trashBelow must be <= archiveBelow/,
  );
});
