import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryPersonalLearningStore,
  PersonalLearningEngine,
  applyPersonalLearning,
  scoreDeterministicImportance,
  type CanonicalMessage,
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
    threadId: `thread-${id}`,
    provider: {
      kind: "gmail",
      messageId: `provider-${id}`,
      threadId: `provider-thread-${id}`,
    },
    subject: "General message",
    body: { text: "Hello", truncated: false },
    from: { address: "Sender@Example.COM" },
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
    receivedAt: "2026-10-06T13:50:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["work"],
      importanceScore: 50,
      confidence: 0.8,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-06T13:50:00.000Z",
    updatedAt: "2026-10-06T13:50:00.000Z",
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

async function record(
  engine: PersonalLearningEngine,
  type: Parameters<PersonalLearningEngine["record"]>[0]["type"],
  id: string,
  msg = message(),
  source: Parameters<PersonalLearningEngine["record"]>[0]["source"] =
    "manual_action",
) {
  return engine.record({
    id,
    type,
    source,
    occurredAt: "2026-10-06T13:51:00.000Z",
    message: msg,
  });
}

test("learning events are idempotent and sender/domain are normalized", async () => {
  const store = new InMemoryPersonalLearningStore();
  const engine = new PersonalLearningEngine(store);

  assert.equal(
    await record(engine, "manual_mark_important", "event-1"),
    true,
  );
  assert.equal(
    await record(engine, "manual_mark_important", "event-1"),
    false,
  );

  const exported = await engine.export("tenant-1", "account-1");
  assert.equal(exported.events.length, 1);
  assert.equal(exported.events[0]?.subject.sender, "sender@example.com");
  assert.equal(exported.events[0]?.subject.domain, "example.com");
});

test("explicit always-archive sender becomes a full-confidence personal rule", async () => {
  const engine = new PersonalLearningEngine(
    new InMemoryPersonalLearningStore(),
  );

  await record(
    engine,
    "always_archive_sender",
    "archive-rule",
    message(),
    "explicit_correction",
  );

  const evaluation = await engine.evaluate(message("other"));
  assert.equal(evaluation.alwaysArchive, true);
  assert.equal(
    evaluation.matchedFeatures.some(
      (feature) =>
        feature.kind === "always_archive" &&
        feature.explicit &&
        feature.confidence === 1,
    ),
    true,
  );
});

test("explicit never-delete domain is protective and account scoped", async () => {
  const store = new InMemoryPersonalLearningStore();
  const engine = new PersonalLearningEngine(store);

  await record(
    engine,
    "never_delete_domain",
    "protect-domain",
    message(),
    "explicit_correction",
  );

  const sameDomain = await engine.evaluate(
    message("same-domain", {
      from: { address: "other@example.com" },
    }),
  );
  assert.equal(sameDomain.neverDelete, true);

  const otherDomain = await engine.evaluate(
    message("other-domain", {
      from: { address: "other@different.example" },
    }),
  );
  assert.equal(otherDomain.neverDelete, false);

  const otherAccount = message("other-account", {
    accountId: "account-2",
    from: { address: "other@example.com" },
  });
  assert.equal(
    (await engine.evaluate(otherAccount)).neverDelete,
    false,
  );
});

test("repeated restore from archive creates avoid-archive behavior only after repeated evidence", async () => {
  const engine = new PersonalLearningEngine(
    new InMemoryPersonalLearningStore(),
  );

  await record(engine, "restore_from_archive", "r1");
  let evaluation = await engine.evaluate(message("after-one"));
  assert.equal(evaluation.avoidArchive, false);

  await record(engine, "restore_from_archive", "r2");
  evaluation = await engine.evaluate(message("after-two"));
  assert.equal(evaluation.avoidArchive, true);
  assert.ok(evaluation.importanceDelta > 0);
});

test("repeated restore from trash learns avoid-trash but never creates destructive permission", async () => {
  const engine = new PersonalLearningEngine(
    new InMemoryPersonalLearningStore(),
  );

  await record(engine, "restore_from_trash", "t1");
  await record(engine, "restore_from_trash", "t2");

  const evaluation = await engine.evaluate(message("after-trash"));
  assert.equal(evaluation.avoidTrash, true);
  assert.equal(evaluation.neverDelete, false);
  assert.equal(evaluation.alwaysArchive, false);
});

test("repeated manual trash lowers importance but never creates delete rule", async () => {
  const engine = new PersonalLearningEngine(
    new InMemoryPersonalLearningStore(),
  );

  await record(engine, "manual_trash", "trash-1");
  await record(engine, "manual_trash", "trash-2");
  await record(engine, "manual_trash", "trash-3");

  const evaluation = await engine.evaluate(message("trash-target"));
  assert.ok(evaluation.importanceDelta < 0);
  assert.equal(evaluation.neverDelete, false);
  assert.equal(
    evaluation.matchedFeatures.some(
      (feature) => feature.kind === "always_archive",
    ),
    false,
  );
});

test("repeated replies create sender/thread reply affinity without changing global engine", async () => {
  const store = new InMemoryPersonalLearningStore();
  const engine = new PersonalLearningEngine(store);
  const msg = message("reply-target");

  const baseBefore = scoreDeterministicImportance(msg, {
    userAddresses: ["me@example.com"],
  });

  await record(engine, "user_replied", "reply-1", msg, "observed_behavior");
  await record(engine, "user_replied", "reply-2", msg, "observed_behavior");

  const evaluation = await engine.evaluate(msg);
  assert.ok(evaluation.replyAffinity > 0);

  const baseAfter = scoreDeterministicImportance(msg, {
    userAddresses: ["me@example.com"],
  });
  assert.deepEqual(baseAfter, baseBefore);
});

test("personalization overlay adjusts score while preserving immutable base result", async () => {
  const engine = new PersonalLearningEngine(
    new InMemoryPersonalLearningStore(),
  );
  const msg = message("personalized");

  await record(
    engine,
    "explicit_important",
    "important-1",
    msg,
    "explicit_correction",
  );
  await record(
    engine,
    "never_delete_domain",
    "never-delete-1",
    msg,
    "explicit_correction",
  );

  const base = scoreDeterministicImportance(msg, {
    userAddresses: ["me@example.com"],
  });
  const baseSnapshot = structuredClone(base);
  const personal = await engine.evaluate(msg);
  const personalized = applyPersonalLearning(base, personal);

  assert.deepEqual(base, baseSnapshot);
  assert.deepEqual(personalized.base, baseSnapshot);
  assert.ok(personalized.importanceScore > base.importanceScore);
  assert.equal(personalized.recommendedHandling, "protect");
});

test("export includes raw events and derived profile, reset removes only target account learning", async () => {
  const store = new InMemoryPersonalLearningStore();
  const engine = new PersonalLearningEngine(store);

  await record(engine, "manual_mark_important", "a1");
  await engine.record({
    id: "b1",
    type: "manual_mark_important",
    source: "manual_action",
    occurredAt: "2026-10-06T13:52:00.000Z",
    message: message("other-account", {
      accountId: "account-2",
    }),
  });

  const exported = await engine.export("tenant-1", "account-1");
  assert.equal(exported.events.length, 1);
  assert.equal(exported.profile.eventCount, 1);
  assert.ok(exported.profile.features.length > 0);

  const removed = await engine.reset("tenant-1", "account-1");
  assert.equal(removed, 1);
  assert.equal(
    (await engine.profile("tenant-1", "account-1")).eventCount,
    0,
  );
  assert.equal(
    (await engine.profile("tenant-1", "account-2")).eventCount,
    1,
  );
});

test("importance adjustment is bounded despite repeated corrections", async () => {
  const engine = new PersonalLearningEngine(
    new InMemoryPersonalLearningStore(),
  );

  for (let index = 0; index < 20; index += 1) {
    await record(
      engine,
      "manual_mark_important",
      `boost-${index}`,
    );
  }

  const evaluation = await engine.evaluate(message("bounded"));
  assert.ok(evaluation.importanceDelta <= 35);

  const base = scoreDeterministicImportance(message("bounded"), {
    userAddresses: ["me@example.com"],
  });
  const personalized = applyPersonalLearning(base, evaluation);
  assert.ok(personalized.importanceScore <= 100);
});

test("same learning store keeps tenants fully isolated", async () => {
  const store = new InMemoryPersonalLearningStore();
  const engine = new PersonalLearningEngine(store);

  await record(
    engine,
    "always_archive_sender",
    "tenant-1-rule",
    message(),
    "explicit_correction",
  );

  const tenant2 = message("tenant-2", {
    tenantId: "tenant-2",
  });
  const evaluation = await engine.evaluate(tenant2);
  assert.equal(evaluation.alwaysArchive, false);
  assert.equal(evaluation.matchedFeatures.length, 0);
});
