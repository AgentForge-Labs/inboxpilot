import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_IMPORTANCE_SETTINGS,
  ImportanceSettingsConflictError,
  ImportanceSettingsService,
  InMemoryImportanceSettingsStore,
  MailboxPolicyEngine,
  buildImportanceBandEditorViewModel,
  importanceBandRanges,
  moveImportanceBandBoundary,
  moveImportanceThresholdMarker,
  parseClassifierResult,
  policyThresholdsFromImportanceSettings,
  priorityForImportanceScore,
  unsupportedCapabilities,
  validateImportanceSettings,
  type CanonicalMessage,
  type ImportanceSettings,
} from "../src/index.js";

test("shipped defaults exactly match the six requested score bands", () => {
  const ranges = importanceBandRanges(DEFAULT_IMPORTANCE_SETTINGS);

  assert.deepEqual(ranges, [
    { priority: "disposable", min: 0, max: 9 },
    { priority: "very_low", min: 10, max: 29 },
    { priority: "low", min: 30, max: 49 },
    { priority: "normal", min: 50, max: 74 },
    { priority: "important", min: 75, max: 89 },
    { priority: "critical", min: 90, max: 100 },
  ]);

  const covered = ranges.flatMap((range) =>
    Array.from(
      { length: range.max - range.min + 1 },
      (_, index) => range.min + index,
    ),
  );
  assert.equal(covered.length, 101);
  assert.deepEqual(covered, Array.from({ length: 101 }, (_, i) => i));
});

test("default visual editor exposes contiguous bands and three threshold markers", () => {
  const editor = buildImportanceBandEditorViewModel(
    DEFAULT_IMPORTANCE_SETTINGS,
  );

  assert.equal(editor.min, 0);
  assert.equal(editor.max, 100);
  assert.equal(editor.segments.length, 6);
  assert.equal(
    editor.segments.reduce((sum, segment) => sum + segment.widthPercent, 0),
    100,
  );
  assert.deepEqual(
    editor.markers.map((marker) => [marker.kind, marker.value]),
    [
      ["auto_delete_below", 20],
      ["archive_below", 45],
      ["important", 75],
    ],
  );
});

test("moving Important marker changes the Important band boundary itself", () => {
  const updated = moveImportanceThresholdMarker(
    DEFAULT_IMPORTANCE_SETTINGS,
    "important",
    82,
  );

  assert.equal(updated.bands.importantAt, 82);
  assert.equal(priorityForImportanceScore(81, updated), "normal");
  assert.equal(priorityForImportanceScore(82, updated), "important");

  const ranges = importanceBandRanges(updated);
  assert.deepEqual(
    ranges.find((range) => range.priority === "important"),
    { priority: "important", min: 82, max: 89 },
  );
});

test("invalid threshold and band ordering is rejected before persistence", () => {
  assert.throws(
    () =>
      moveImportanceThresholdMarker(
        DEFAULT_IMPORTANCE_SETTINGS,
        "auto_delete_below",
        60,
      ),
    /autoDeleteBelow must be <= archiveBelow/,
  );

  assert.throws(
    () =>
      moveImportanceThresholdMarker(
        DEFAULT_IMPORTANCE_SETTINGS,
        "archive_below",
        80,
      ),
    /archiveBelow must be lower than bands.importantAt/,
  );

  assert.throws(
    () =>
      moveImportanceBandBoundary(
        DEFAULT_IMPORTANCE_SETTINGS,
        "importantAt",
        95,
      ),
    /strictly ordered/,
  );
});

test("account-scoped dashboard service saves, resets and detects stale revisions", async () => {
  const store = new InMemoryImportanceSettingsStore();
  const service = new ImportanceSettingsService(store);

  const initial = await service.getEditor("tenant-1", "account-1");
  assert.equal(initial.revision, 0);
  assert.equal(
    initial.editor.settings.automation.archiveBelow,
    45,
  );

  const saved = await service.updateThreshold(
    "tenant-1",
    "account-1",
    0,
    "archive_below",
    40,
  );
  assert.equal(saved.revision, 1);
  assert.equal(saved.editor.settings.automation.archiveBelow, 40);

  await assert.rejects(
    () =>
      service.updateThreshold(
        "tenant-1",
        "account-1",
        0,
        "auto_delete_below",
        15,
      ),
    ImportanceSettingsConflictError,
  );

  const other = await service.getEditor("tenant-1", "account-2");
  assert.equal(other.revision, 0);
  assert.equal(other.editor.settings.automation.archiveBelow, 45);

  const reset = await service.reset("tenant-1", "account-1", 1);
  assert.equal(reset.revision, 2);
  assert.deepEqual(
    reset.editor.settings,
    DEFAULT_IMPORTANCE_SETTINGS,
  );
});

test("editor supports advanced band-boundary updates with validation", async () => {
  const store = new InMemoryImportanceSettingsStore();
  const service = new ImportanceSettingsService(store);

  const updated = await service.updateBandBoundary(
    "tenant-1",
    "account-1",
    0,
    "criticalAt",
    92,
  );

  assert.equal(updated.revision, 1);
  assert.equal(updated.editor.settings.bands.criticalAt, 92);
  assert.equal(
    updated.editor.segments.find(
      (segment) => segment.priority === "important",
    )?.max,
    91,
  );
});

test("saved importance settings project directly into policy thresholds", () => {
  const settings = validateImportanceSettings({
    version: 1,
    bands: {
      criticalAt: 90,
      importantAt: 85,
      normalAt: 50,
      lowAt: 30,
      veryLowAt: 10,
    },
    automation: {
      archiveBelow: 35,
      autoDeleteBelow: 12,
      minClassifierConfidence: 0.9,
    },
  });

  assert.deepEqual(
    policyThresholdsFromImportanceSettings(settings),
    {
      importantAtOrAbove: 85,
      archiveBelow: 35,
      trashBelow: 12,
      minClassifierConfidence: 0.9,
    },
  );
});

function message(): CanonicalMessage {
  return {
    schemaVersion: 1,
    id: "m-settings",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-settings",
    provider: {
      kind: "gmail",
      messageId: "provider-settings",
      threadId: "provider-thread-settings",
    },
    subject: "A message",
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
    receivedAt: "2026-10-06T16:00:00.000Z",
    authentication: {},
    classification: {
      status: "classified",
      categories: ["work"],
      importanceScore: 80,
      confidence: 0.95,
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-06T16:00:00.000Z",
    updatedAt: "2026-10-06T16:00:00.000Z",
  };
}

function classifierResult(score: number) {
  return parseClassifierResult({
    contractVersion: 1,
    importanceScore: score,
    priority: priorityForImportanceScore(score),
    categories: ["work"],
    actionRequired: false,
    replyRequired: false,
    spamRisk: 1,
    phishingRisk: 1,
    confidence: 0.95,
    recommendedAction: "keep_in_inbox",
    retention: {
      disposition: "keep",
      protected: false,
      protectionReasons: [],
    },
    reason: "Settings policy test",
  });
}

test("policy engine consumes saved importance settings instead of hard-coded defaults", () => {
  const engine = new MailboxPolicyEngine();
  const custom: ImportanceSettings = validateImportanceSettings({
    version: 1,
    bands: {
      criticalAt: 95,
      importantAt: 85,
      normalAt: 50,
      lowAt: 30,
      veryLowAt: 10,
    },
    automation: {
      archiveBelow: 40,
      autoDeleteBelow: 15,
      minClassifierConfidence: 0.8,
    },
  });

  const decision = engine.evaluate({
    policyId: "policy-settings",
    message: message(),
    classification: classifierResult(80),
    providerCapabilities: unsupportedCapabilities([
      "getMessage",
      "markImportant",
      "archive",
      "trash",
    ]),
    planCapabilities: {
      automaticMarkImportant: true,
      automaticArchive: true,
      automaticTrash: true,
    },
    importanceSettings: custom,
  });

  assert.equal(decision.outcome, "no_action");
  assert.equal(decision.plan, undefined);

  const defaultDecision = engine.evaluate({
    policyId: "policy-default",
    message: message(),
    classification: classifierResult(80),
    providerCapabilities: unsupportedCapabilities([
      "getMessage",
      "markImportant",
      "archive",
      "trash",
    ]),
    planCapabilities: {
      automaticMarkImportant: true,
      automaticArchive: true,
      automaticTrash: true,
    },
  });

  assert.equal(defaultDecision.outcome, "planned");
  assert.deepEqual(defaultDecision.plan?.action, {
    type: "mark_important",
    value: true,
  });
});
