import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NEVER_AUTO_DELETE_CATEGORIES,
  InMemorySafeguardOverrideStore,
  MailboxPolicyEngine,
  NeverAutoDeleteProtectionService,
  SafeguardOverrideManager,
  SafeguardedRetentionPolicyRevalidator,
  evaluateNeverAutoDelete,
  parseClassifierResult,
  priorityForImportanceScore,
  unsupportedCapabilities,
  type CanonicalMessage,
  type RetentionJob,
  type RetentionPolicyRevalidator,
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
    receivedAt: "2026-10-06T17:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["promotion"],
      importanceScore: 5,
      confidence: 0.95,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-06T17:00:00.000Z",
    updatedAt: "2026-10-06T17:00:00.000Z",
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

function confirmation(id = "confirm-1") {
  return {
    confirmationId: id,
    actorId: "user-1",
    confirmedAt: "2026-10-06T17:10:00.000Z",
    statement:
      "I understand this exception can allow automated deletion.",
  };
}

test("default category set covers all Never Auto Delete safety classes", () => {
  assert.deepEqual(
    [...DEFAULT_NEVER_AUTO_DELETE_CATEGORIES],
    [
      "finance",
      "government",
      "legal",
      "security",
      "invoice",
      "receipt",
      "appointment",
      "travel",
    ],
  );

  for (const category of DEFAULT_NEVER_AUTO_DELETE_CATEGORIES) {
    const result = evaluateNeverAutoDelete(
      message(category, {
        classification: {
          status: "classified",
          categories: [category],
        },
      }),
    );
    assert.equal(result.protected, true, category);
    assert.ok(
      result.reasons.some(
        (reason) => reason.code === "category:" + category,
      ),
    );
  }
});

test("2FA, password reset and banking text signals protect even when semantic category misses", () => {
  const samples = [
    {
      text: "Your verification code is 123456 for two-factor login.",
      code: "signal:two_factor",
    },
    {
      text: "Reset your password using the secure account page.",
      code: "signal:password_reset",
    },
    {
      text: "SEPA transfer to IBAN DE0012345678 has been received.",
      code: "signal:banking",
    },
  ];

  for (const sample of samples) {
    const result = evaluateNeverAutoDelete(
      message(sample.code, {
        classification: {
          status: "classified",
          categories: ["notification"],
        },
        body: {
          text: sample.text,
          truncated: false,
        },
      }),
    );
    assert.equal(result.protected, true);
    assert.ok(
      result.reasons.some(
        (reason) => reason.code === sample.code,
      ),
    );
  }
});

test("trusted contacts and replied threads are independently protected", () => {
  const msg = message("relationship", {
    from: { address: "Person@Example.com" },
    threadId: "thread-user-replied",
  });
  const result = evaluateNeverAutoDelete(msg, {
    trustedContacts: ["person@example.com"],
    repliedThreadIds: ["thread-user-replied"],
  });

  assert.equal(result.protected, true);
  assert.ok(
    result.reasons.some(
      (reason) => reason.kind === "trusted_contact",
    ),
  );
  assert.ok(
    result.reasons.some(
      (reason) => reason.kind === "replied_thread",
    ),
  );
});

test("canonical retention protection is non-bypassable even by confirmed sender override", () => {
  const msg = message("hold", {
    retention: {
      stage: "active",
      protected: true,
      protectionReasons: ["legal hold"],
    },
  });
  const result = evaluateNeverAutoDelete(msg, {
    overrides: [
      {
        version: 1,
        id: "sender-exception",
        tenantId: "tenant-1",
        accountId: "account-1",
        scope: "sender",
        key: "sender@example.com",
        enabled: true,
        confirmation: confirmation(),
        createdAt: "2026-10-06T17:10:00.000Z",
        updatedAt: "2026-10-06T17:10:00.000Z",
      },
    ],
  });

  assert.equal(result.protected, true);
  assert.ok(
    result.reasons.some(
      (reason) => reason.code === "retention:protected",
    ),
  );
  assert.equal(
    result.suppressedReasons.some(
      (entry) => entry.reason.code === "retention:protected",
    ),
    false,
  );
});

test("override creation requires explicit confirmation and appends audit history", async () => {
  const store = new InMemorySafeguardOverrideStore();
  const manager = new SafeguardOverrideManager(
    store,
    () => new Date("2026-10-06T17:11:00.000Z"),
  );

  await assert.rejects(
    () =>
      manager.create({
        id: "override-1",
        tenantId: "tenant-1",
        accountId: "account-1",
        scope: "category",
        key: "finance",
      }),
    /requires explicit confirmation/,
  );

  const created = await manager.create({
    id: "override-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    scope: "category",
    key: "finance",
    confirmation: confirmation("confirm-create"),
  });
  assert.equal(created.enabled, true);

  const audit = await store.listAudit(
    "tenant-1",
    "account-1",
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, "created");
  assert.equal(
    audit[0]?.confirmationId,
    "confirm-create",
  );
});

test("category exception suppresses only that category while trusted-contact protection remains", async () => {
  const store = new InMemorySafeguardOverrideStore();
  const manager = new SafeguardOverrideManager(store);
  await manager.create({
    id: "finance-exception",
    tenantId: "tenant-1",
    accountId: "account-1",
    scope: "category",
    key: "finance",
    confirmation: confirmation(),
  });

  const overrides = await store.list(
    "tenant-1",
    "account-1",
  );
  const msg = message("finance-contact", {
    from: { address: "banker@example.com" },
    classification: {
      status: "classified",
      categories: ["finance"],
    },
  });

  const result = evaluateNeverAutoDelete(msg, {
    trustedContacts: ["banker@example.com"],
    overrides,
  });

  assert.equal(result.protected, true);
  assert.ok(
    result.suppressedReasons.some(
      (entry) => entry.reason.code === "category:finance",
    ),
  );
  assert.ok(
    result.reasons.some(
      (reason) => reason.kind === "trusted_contact",
    ),
  );
});

test("confirmed sender exception can suppress all bypassable reasons for that sender", async () => {
  const store = new InMemorySafeguardOverrideStore();
  const manager = new SafeguardOverrideManager(store);
  await manager.create({
    id: "sender-exception",
    tenantId: "tenant-1",
    accountId: "account-1",
    scope: "sender",
    key: "bank@example.com",
    confirmation: confirmation(),
  });

  const msg = message("sender-exception", {
    from: { address: "bank@example.com" },
    classification: {
      status: "classified",
      categories: ["finance"],
    },
    body: {
      text: "SEPA payment to IBAN DE001234.",
      truncated: false,
    },
  });
  const result = evaluateNeverAutoDelete(msg, {
    trustedContacts: ["bank@example.com"],
    repliedThreadIds: [msg.threadId],
    overrides: await store.list("tenant-1", "account-1"),
  });

  assert.equal(result.protected, false);
  assert.equal(result.reasons.length, 0);
  assert.ok(result.suppressedReasons.length >= 3);
  assert.deepEqual(
    result.matchedOverrideIds,
    ["sender-exception"],
  );
});

test("disabling an exception requires confirmation, restores protection and is audited", async () => {
  const store = new InMemorySafeguardOverrideStore();
  const manager = new SafeguardOverrideManager(store);
  await manager.create({
    id: "finance-exception",
    tenantId: "tenant-1",
    accountId: "account-1",
    scope: "category",
    key: "finance",
    confirmation: confirmation("create"),
  });

  await assert.rejects(
    () =>
      manager.setEnabled(
        "tenant-1",
        "account-1",
        "finance-exception",
        false,
      ),
    /requires explicit confirmation/,
  );

  await manager.setEnabled(
    "tenant-1",
    "account-1",
    "finance-exception",
    false,
    confirmation("disable"),
  );

  const result = evaluateNeverAutoDelete(
    message("finance", {
      classification: {
        status: "classified",
        categories: ["finance"],
      },
    }),
    {
      overrides: await store.list(
        "tenant-1",
        "account-1",
      ),
    },
  );
  assert.equal(result.protected, true);

  const audit = await store.listAudit(
    "tenant-1",
    "account-1",
  );
  assert.deepEqual(
    audit.map((event) => event.action),
    ["created", "disabled"],
  );
});

test("override and audit records are tenant/account isolated", async () => {
  const store = new InMemorySafeguardOverrideStore();
  const manager = new SafeguardOverrideManager(store);
  await manager.create({
    id: "other-account",
    tenantId: "tenant-1",
    accountId: "account-2",
    scope: "sender",
    key: "sender@example.com",
    confirmation: confirmation(),
  });

  assert.equal(
    (await store.list("tenant-1", "account-1")).length,
    0,
  );
  assert.equal(
    (await store.listAudit("tenant-1", "account-1")).length,
    0,
  );
});

function trashClassification() {
  return parseClassifierResult({
    contractVersion: 1,
    importanceScore: 5,
    priority: priorityForImportanceScore(5),
    categories: ["promotion"],
    actionRequired: false,
    replyRequired: false,
    spamRisk: 1,
    phishingRisk: 1,
    confidence: 0.95,
    recommendedAction: "trash",
    retention: {
      disposition: "trash_later",
      protected: false,
      protectionReasons: [],
      trashAfterDays: 30,
    },
    reason: "Low-value promotion",
  });
}

test("policy engine blocks trash when centralized safeguard protects a contact", () => {
  const msg = message("policy-contact");
  const safeguard = evaluateNeverAutoDelete(msg, {
    trustedContacts: ["sender@example.com"],
  });
  const decision = new MailboxPolicyEngine().evaluate({
    policyId: "policy-1",
    message: msg,
    classification: trashClassification(),
    providerCapabilities: unsupportedCapabilities([
      "getMessage",
      "archive",
      "trash",
    ]),
    planCapabilities: {
      automaticMarkImportant: true,
      automaticArchive: true,
      automaticTrash: true,
    },
    neverAutoDelete: safeguard,
  });

  assert.equal(decision.outcome, "blocked");
  assert.equal(decision.plan, undefined);
  assert.ok(
    decision.reasons.includes(
      "never_auto_delete_safeguard",
    ),
  );
});

test("policy engine can proceed after all bypassable safeguard reasons are explicitly excepted", async () => {
  const store = new InMemorySafeguardOverrideStore();
  const manager = new SafeguardOverrideManager(store);
  await manager.create({
    id: "sender-exception",
    tenantId: "tenant-1",
    accountId: "account-1",
    scope: "sender",
    key: "sender@example.com",
    confirmation: confirmation(),
  });

  const msg = message("policy-exception");
  const safeguard = evaluateNeverAutoDelete(msg, {
    trustedContacts: ["sender@example.com"],
    overrides: await store.list("tenant-1", "account-1"),
  });
  assert.equal(safeguard.protected, false);

  const decision = new MailboxPolicyEngine().evaluate({
    policyId: "policy-1",
    message: msg,
    classification: trashClassification(),
    providerCapabilities: unsupportedCapabilities([
      "getMessage",
      "archive",
      "trash",
    ]),
    planCapabilities: {
      automaticMarkImportant: true,
      automaticArchive: true,
      automaticTrash: true,
    },
    neverAutoDelete: safeguard,
  });

  assert.equal(decision.outcome, "planned");
  assert.equal(decision.plan?.action.type, "trash");
});

test("retention revalidator checks current safeguard before delegate policy", async () => {
  const store = new InMemorySafeguardOverrideStore();
  const protection = new NeverAutoDeleteProtectionService(
    store,
    {
      async resolve() {
        return {
          trustedContacts: ["sender@example.com"],
        };
      },
    },
  );

  let delegateCalls = 0;
  const delegate: RetentionPolicyRevalidator = {
    async evaluate() {
      delegateCalls += 1;
      return {
        allowed: true,
        reason: "base policy allows",
        policyId: "policy-1",
      };
    },
  };
  const guarded = new SafeguardedRetentionPolicyRevalidator(
    protection,
    delegate,
  );

  const job: RetentionJob = {
    id: "job-1",
    version: 1,
    tenantId: "tenant-1",
    accountId: "account-1",
    canonicalMessageId: "m1",
    provider: "gmail",
    providerMessageId: "provider-m1",
    policyId: "policy-1",
    status: "scheduled",
    nextAction: "trash",
    nextRunAt: "2026-10-06T17:20:00.000Z",
    config: {
      archiveRetentionDays: 30,
      trashRetentionDays: 30,
      allowPermanentDelete: false,
    },
    trashSemantics: {
      provider: "gmail",
      behavior: "provider_managed_expiry",
      permanentDeleteSupported: false,
      providerAutoDeleteAfterDays: 30,
      note: "test",
    },
    createdAt: "2026-10-06T17:00:00.000Z",
    updatedAt: "2026-10-06T17:00:00.000Z",
  };

  const blocked = await guarded.evaluate(
    message(),
    "trash",
    job,
  );
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Never Auto Delete safeguard/);
  assert.equal(delegateCalls, 0);

  const manager = new SafeguardOverrideManager(store);
  await manager.create({
    id: "sender-exception",
    tenantId: "tenant-1",
    accountId: "account-1",
    scope: "sender",
    key: "sender@example.com",
    confirmation: confirmation(),
  });

  const allowed = await guarded.evaluate(
    message(),
    "trash",
    job,
  );
  assert.equal(allowed.allowed, true);
  assert.equal(delegateCalls, 1);
});
