import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryDashboardRuleStore,
  InMemoryInboxDashboardMessageRepository,
  RuleRevisionConflictError,
  RulesDashboardService,
  compileRulesForPolicyEngine,
  resolveDashboardRules,
  type CanonicalMessage,
  type DashboardRule,
} from "../src/index.js";

function message(
  id: string,
  options: {
    sender?: string;
    categories?: string[];
    score?: number;
    receivedAt?: string;
  } = {},
): CanonicalMessage {
  const receivedAt =
    options.receivedAt ?? "2026-10-07T08:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-" + id,
    provider: {
      kind: "gmail",
      messageId: "provider-" + id,
    },
    subject: "Subject " + id,
    body: {
      text: "BODY SECRET " + id,
      html: "<p>HTML SECRET " + id + "</p>",
      truncated: false,
    },
    from: {
      address:
        options.sender ?? "news@example.com",
    },
    to: [{ address: "me@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {
      authorization: ["Bearer secret-" + id],
    },
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
    receivedAt,
    authentication: {},
    classification: {
      status: "classified",
      categories: options.categories ?? ["promotion"],
      importanceScore: options.score ?? 15,
      priority: "very_low",
      confidence: 0.95,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: receivedAt,
    updatedAt: receivedAt,
  };
}

function fixedClock() {
  return () => new Date("2026-10-07T08:30:00.000Z");
}

function service() {
  const rules = new InMemoryDashboardRuleStore();
  const messages =
    new InMemoryInboxDashboardMessageRepository();
  return {
    rules,
    messages,
    service: new RulesDashboardService(
      rules,
      messages,
      fixedClock(),
    ),
  };
}

test("dashboard CRUD supports sender/domain/category/score rules and normalizes inputs", async () => {
  const env = service();

  const important = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Boss always important",
    condition: {
      kind: "sender",
      address: " BOSS@Example.COM ",
    },
    action: { kind: "always_important" },
  });
  assert.deepEqual(important.condition, {
    kind: "sender",
    address: "boss@example.com",
  });

  const neverDelete = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Protect company",
    condition: {
      kind: "domain",
      domain: ".Example.org.",
    },
    action: { kind: "never_delete" },
  });
  assert.deepEqual(neverDelete.condition, {
    kind: "domain",
    domain: "example.org",
  });

  const newsletter = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Archive newsletters",
    condition: {
      kind: "category",
      category: "NEWSLETTER",
    },
    action: {
      kind: "archive_after_days",
      days: 7,
    },
  });
  assert.deepEqual(newsletter.condition, {
    kind: "category",
    category: "newsletter",
  });

  const score = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Low score cleanup",
    condition: {
      kind: "score",
      operator: "lte",
      value: 20,
    },
    action: {
      kind: "archive_after_days",
      days: 3,
    },
  });
  assert.equal(score.condition.kind, "score");

  assert.equal((await env.service.list(
    "tenant-1",
    "account-1",
  )).length, 4);
});

test("delete-after rule requires explicit destructive acknowledgement and at least one-day delay", async () => {
  const env = service();

  await assert.rejects(
    () =>
      env.service.create({
        tenantId: "tenant-1",
        accountId: "account-1",
        name: "Delete promotions",
        condition: {
          kind: "category",
          category: "promotion",
        },
        action: {
          kind: "delete_after_days",
          days: 30,
        },
      }),
    /destructive acknowledgement/,
  );

  await assert.rejects(
    () =>
      env.service.create({
        tenantId: "tenant-1",
        accountId: "account-1",
        name: "Immediate delete",
        condition: {
          kind: "category",
          category: "promotion",
        },
        action: {
          kind: "delete_after_days",
          days: 0,
        },
        destructiveAcknowledged: true,
      }),
    /between 1 and 36500/,
  );

  const created = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Delete promotions after 30 days",
    condition: {
      kind: "category",
      category: "promotion",
    },
    action: {
      kind: "delete_after_days",
      days: 30,
    },
    destructiveAcknowledged: true,
  });
  assert.deepEqual(created.action, {
    kind: "delete_after_days",
    days: 30,
  });
});

test("edit/delete use optimistic revisions and stale dashboard writes fail", async () => {
  const env = service();
  const created = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Keep receipts",
    condition: {
      kind: "category",
      category: "receipt",
    },
    action: { kind: "keep_indefinitely" },
  });

  const updated = await env.service.update(
    "tenant-1",
    "account-1",
    created.id,
    {
      expectedRevision: 1,
      name: "Keep receipts forever",
      priority: 80,
    },
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.priority, 80);

  await assert.rejects(
    () =>
      env.service.update(
        "tenant-1",
        "account-1",
        created.id,
        {
          expectedRevision: 1,
          name: "stale",
        },
      ),
    RuleRevisionConflictError,
  );

  await assert.rejects(
    () =>
      env.service.delete(
        "tenant-1",
        "account-1",
        created.id,
        1,
      ),
    RuleRevisionConflictError,
  );

  assert.equal(
    await env.service.delete(
      "tenant-1",
      "account-1",
      created.id,
      2,
    ),
    true,
  );
});

test("Never Delete / Keep indefinitely always suppress destructive retention matches", async () => {
  const env = service();
  const protect = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Keep receipts",
    condition: {
      kind: "category",
      category: "receipt",
    },
    action: { kind: "keep_indefinitely" },
    priority: 1,
  });
  const remove = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Delete low scores",
    condition: {
      kind: "score",
      operator: "lte",
      value: 20,
    },
    action: {
      kind: "delete_after_days",
      days: 7,
    },
    priority: 100,
    destructiveAcknowledged: true,
  });

  const resolution = await env.service.resolve(
    message("receipt", {
      categories: ["receipt"],
      score: 10,
    }),
  );

  assert.equal(resolution.protectedFromDelete, true);
  assert.equal(resolution.retention, undefined);
  assert.ok(resolution.appliedRuleIds.includes(protect.id));
  assert.ok(!resolution.appliedRuleIds.includes(remove.id));
  assert.equal(
    resolution.conflicts[0]?.type,
    "protected_over_destructive",
  );
  assert.equal(
    resolution.conflicts[0]?.winnerRuleId,
    protect.id,
  );
});

test("retention precedence is sender > domain > category > score, then explicit priority", async () => {
  const env = service();

  const score = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Score archive",
    condition: {
      kind: "score",
      operator: "lte",
      value: 30,
    },
    action: {
      kind: "archive_after_days",
      days: 30,
    },
    priority: 100,
  });
  const category = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Promotion archive",
    condition: {
      kind: "category",
      category: "promotion",
    },
    action: {
      kind: "archive_after_days",
      days: 20,
    },
    priority: 100,
  });
  const domain = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Domain archive",
    condition: {
      kind: "domain",
      domain: "example.com",
    },
    action: {
      kind: "archive_after_days",
      days: 10,
    },
    priority: 100,
  });
  const sender = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Sender archive",
    condition: {
      kind: "sender",
      address: "news@example.com",
    },
    action: {
      kind: "archive_after_days",
      days: 2,
    },
    priority: 0,
  });

  const resolution = await env.service.resolve(
    message("all-match", {
      sender: "news@example.com",
      categories: ["promotion"],
      score: 10,
    }),
  );

  assert.equal(resolution.retention?.ruleId, sender.id);
  assert.equal(resolution.retention?.afterDays, 2);
  assert.ok(resolution.matchedRuleIds.includes(score.id));
  assert.ok(resolution.matchedRuleIds.includes(category.id));
  assert.ok(resolution.matchedRuleIds.includes(domain.id));
  assert.ok(resolution.matchedRuleIds.includes(sender.id));
  assert.ok(
    resolution.conflicts.some(
      (item) =>
        item.winnerRuleId === sender.id &&
        item.loserRuleId === domain.id,
    ),
  );
});

test("equal-precedence archive/delete conflict chooses archive as less destructive", async () => {
  const env = service();
  const archive = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Archive promotion",
    condition: {
      kind: "category",
      category: "promotion",
    },
    action: {
      kind: "archive_after_days",
      days: 5,
    },
    priority: 50,
  });
  const remove = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Delete promotion",
    condition: {
      kind: "category",
      category: "promotion",
    },
    action: {
      kind: "delete_after_days",
      days: 5,
    },
    priority: 50,
    destructiveAcknowledged: true,
  });

  const resolution = await env.service.resolve(
    message("promo"),
  );
  assert.equal(resolution.retention?.ruleId, archive.id);
  assert.equal(resolution.retention?.action, "archive");
  assert.ok(
    resolution.conflicts.some(
      (item) =>
        item.type === "less_destructive_tiebreak" &&
        item.winnerRuleId === archive.id &&
        item.loserRuleId === remove.id,
    ),
  );
});

test("Always Important coexists with retention winner", async () => {
  const env = service();
  const important = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "VIP",
    condition: {
      kind: "sender",
      address: "news@example.com",
    },
    action: { kind: "always_important" },
  });
  const archive = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Archive promotions",
    condition: {
      kind: "category",
      category: "promotion",
    },
    action: {
      kind: "archive_after_days",
      days: 10,
    },
  });

  const resolution = await env.service.resolve(
    message("vip-promo"),
  );
  assert.equal(resolution.alwaysImportant, true);
  assert.equal(resolution.retention?.ruleId, archive.id);
  assert.ok(resolution.appliedRuleIds.includes(important.id));
  assert.ok(resolution.appliedRuleIds.includes(archive.id));
});

test("preview works for disabled rules, shows effective conflict outcome and never exposes body/html/headers", async () => {
  const env = service();
  env.messages.seed(
    message("one", {
      categories: ["newsletter"],
      receivedAt: "2026-10-07T09:00:00.000Z",
    }),
  );
  env.messages.seed(
    message("two", {
      categories: ["newsletter"],
      receivedAt: "2026-10-06T09:00:00.000Z",
    }),
  );

  const rule = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Newsletter preview",
    enabled: false,
    condition: {
      kind: "category",
      category: "newsletter",
    },
    action: {
      kind: "archive_after_days",
      days: 7,
    },
  });

  const preview = await env.service.preview(
    "tenant-1",
    "account-1",
    rule.id,
  );

  assert.deepEqual(
    preview.map((row) => row.canonicalMessageId),
    ["one", "two"],
  );
  assert.equal(preview.every((row) => !row.effective), true);

  const serialized = JSON.stringify(preview);
  assert.equal(serialized.includes("BODY SECRET"), false);
  assert.equal(serialized.includes("HTML SECRET"), false);
  assert.equal(serialized.includes("authorization"), false);
  assert.equal(serialized.includes("secret-one"), false);
});

test("dashboard shows normalized labels, affected counts and aggregated conflicts", async () => {
  const env = service();
  env.messages.seed(
    message("receipt-low", {
      categories: ["receipt"],
      score: 5,
    }),
  );

  const keep = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Keep receipts",
    condition: {
      kind: "category",
      category: "receipt",
    },
    action: { kind: "keep_indefinitely" },
  });
  const remove = await env.service.create({
    tenantId: "tenant-1",
    accountId: "account-1",
    name: "Low score cleanup",
    condition: {
      kind: "score",
      operator: "lte",
      value: 10,
    },
    action: {
      kind: "delete_after_days",
      days: 30,
    },
    destructiveAcknowledged: true,
  });

  const dashboard = await env.service.dashboard(
    "tenant-1",
    "account-1",
  );

  assert.equal(dashboard.rows.length, 2);
  assert.equal(
    dashboard.rows.find((row) => row.rule.id === keep.id)
      ?.affectedMessageCount,
    1,
  );
  assert.equal(
    dashboard.rows.find((row) => row.rule.id === keep.id)
      ?.actionLabel,
    "Keep indefinitely",
  );
  assert.match(
    dashboard.rows.find((row) => row.rule.id === keep.id)
      ?.precedenceLabel ?? "",
    /safety override/,
  );
  assert.ok(
    dashboard.conflicts.some(
      (item) =>
        item.winnerRuleId === keep.id &&
        item.loserRuleId === remove.id,
    ),
  );
});

test("policy compiler maps only semantics the current policy engine can preserve exactly", () => {
  const base = {
    tenantId: "tenant-1",
    accountId: "account-1",
    enabled: true,
    priority: 50,
    revision: 1,
    createdAt: "2026-10-07T08:00:00.000Z",
    updatedAt: "2026-10-07T08:00:00.000Z",
  };

  const rules: DashboardRule[] = [
    {
      ...base,
      id: "important",
      name: "Important sender",
      condition: {
        kind: "sender",
        address: "boss@example.com",
      },
      action: { kind: "always_important" },
    },
    {
      ...base,
      id: "protect",
      name: "Protect domain",
      condition: {
        kind: "domain",
        domain: "example.org",
      },
      action: { kind: "never_delete" },
    },
    {
      ...base,
      id: "delayed",
      name: "Archive newsletter",
      condition: {
        kind: "category",
        category: "newsletter",
      },
      action: {
        kind: "archive_after_days",
        days: 7,
      },
    },
    {
      ...base,
      id: "score",
      name: "Score rule",
      condition: {
        kind: "score",
        operator: "lt",
        value: 20,
      },
      action: {
        kind: "archive_after_days",
        days: 5,
      },
    },
  ];

  const compiled = compileRulesForPolicyEngine(rules);
  assert.deepEqual(compiled.policyOverrides, [
    {
      id: "important",
      scope: "sender",
      key: "boss@example.com",
      action: "mark_important",
      enabled: true,
    },
    {
      id: "protect",
      scope: "domain",
      key: "example.org",
      action: "protect",
      enabled: true,
    },
  ]);
  assert.deepEqual(
    compiled.resolverManagedRuleIds.sort(),
    ["delayed", "score"],
  );
});
