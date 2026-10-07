import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIFIER_CATEGORIES,
  CLASSIFIER_CONTRACT_VERSION,
  CLASSIFIER_OUTPUT_JSON_SCHEMA,
  classifierResultToClassificationState,
  parseClassifierResult,
  priorityForImportanceScore,
} from "../src/index.js";

function validResult() {
  return {
    contractVersion: CLASSIFIER_CONTRACT_VERSION,
    importanceScore: 96,
    priority: "critical",
    categories: ["government", "action_required"].filter(
      (value) => CLASSIFIER_CATEGORIES.includes(
        value as (typeof CLASSIFIER_CATEGORIES)[number],
      ),
    ),
    actionRequired: true,
    replyRequired: true,
    spamRisk: 2,
    phishingRisk: 4,
    confidence: 0.97,
    recommendedAction: "mark_important",
    retention: {
      disposition: "protect",
      protected: true,
      protectionReasons: ["government"],
    },
    reason:
      "Government correspondence requests a time-sensitive response.",
    modelVersion: "classifier-v1",
  };
}

test("importance score maps deterministically to priority buckets", () => {
  assert.equal(priorityForImportanceScore(100), "critical");
  assert.equal(priorityForImportanceScore(90), "critical");
  assert.equal(priorityForImportanceScore(89), "important");
  assert.equal(priorityForImportanceScore(75), "important");
  assert.equal(priorityForImportanceScore(74), "normal");
  assert.equal(priorityForImportanceScore(50), "normal");
  assert.equal(priorityForImportanceScore(49), "low");
  assert.equal(priorityForImportanceScore(30), "low");
  assert.equal(priorityForImportanceScore(29), "very_low");
  assert.equal(priorityForImportanceScore(10), "very_low");
  assert.equal(priorityForImportanceScore(9), "disposable");
  assert.equal(priorityForImportanceScore(0), "disposable");
});

test("valid canonical classifier result supports multiple categories", () => {
  const parsed = parseClassifierResult({
    ...validResult(),
    categories: ["government", "security", "work"],
  });

  assert.equal(parsed.importanceScore, 96);
  assert.equal(parsed.priority, "critical");
  assert.deepEqual(parsed.categories, [
    "government",
    "security",
    "work",
  ]);
  assert.equal(parsed.actionRequired, true);
  assert.equal(parsed.replyRequired, true);
  assert.equal(parsed.recommendedAction, "mark_important");
  assert.equal(parsed.retention.protected, true);
});

test("classifier result rejects out-of-range scores and mismatched priority", () => {
  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        importanceScore: 101,
      }),
    /integer between 0 and 100/,
  );

  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        importanceScore: 82,
        priority: "critical",
      }),
    /does not match importanceScore/,
  );

  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        confidence: 1.1,
      }),
    /confidence must be between 0 and 1/,
  );
});

test("classifier result rejects unknown and duplicate categories", () => {
  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        categories: ["finance", "made_up"],
      }),
    /Unknown classifier category/,
  );

  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        categories: ["finance", "finance"],
      }),
    /Duplicate classifier category/,
  );
});

test("strict contract rejects unknown model-generated fields", () => {
  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        executeImmediately: true,
      }),
    /unknown field "executeImmediately"/,
  );

  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        retention: {
          ...validResult().retention,
          permanentDeleteAfterDays: 1,
        },
      }),
    /unknown field "permanentDeleteAfterDays"/,
  );
});

test("retention recommendation enforces protection and delay semantics", () => {
  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        retention: {
          disposition: "protect",
          protected: false,
          protectionReasons: [],
        },
      }),
    /requires protected=true/,
  );

  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        retention: {
          disposition: "trash_later",
          protected: false,
          protectionReasons: [],
        },
      }),
    /requires trashAfterDays/,
  );

  const archive = parseClassifierResult({
    ...validResult(),
    retention: {
      disposition: "archive",
      protected: false,
      protectionReasons: [],
      archiveAfterDays: 7,
    },
  });
  assert.equal(archive.retention.archiveAfterDays, 7);
});

test("canonical result converts to existing ClassificationState without losing core signals", () => {
  const parsed = parseClassifierResult({
    ...validResult(),
    categories: ["security", "phishing"],
    spamRisk: 20,
    phishingRisk: 91,
  });

  const state = classifierResultToClassificationState(
    parsed,
    "2026-10-06T12:45:00.000Z",
  );

  assert.equal(state.status, "classified");
  assert.equal(state.importanceScore, 96);
  assert.equal(state.priority, "critical");
  assert.deepEqual(state.categories, ["security", "phishing"]);
  assert.equal(state.actionRequired, true);
  assert.equal(state.replyRequired, true);
  assert.equal(state.riskScore, 91);
  assert.equal(state.confidence, 0.97);
  assert.equal(state.modelVersion, "classifier-v1");
  assert.equal(
    state.classifiedAt,
    "2026-10-06T12:45:00.000Z",
  );
});

test("JSON schema is strict and exposes the complete v1 category vocabulary", () => {
  assert.equal(
    CLASSIFIER_OUTPUT_JSON_SCHEMA.additionalProperties,
    false,
  );
  assert.equal(
    CLASSIFIER_OUTPUT_JSON_SCHEMA.properties.retention
      .additionalProperties,
    false,
  );
  assert.deepEqual(
    CLASSIFIER_OUTPUT_JSON_SCHEMA.properties.categories.items.enum,
    [...CLASSIFIER_CATEGORIES],
  );
  assert.equal(
    CLASSIFIER_OUTPUT_JSON_SCHEMA.properties.importanceScore.minimum,
    0,
  );
  assert.equal(
    CLASSIFIER_OUTPUT_JSON_SCHEMA.properties.importanceScore.maximum,
    100,
  );
});


test("classifier output rejects executable tool/function payloads even when nested", () => {
  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        tool_calls: [
          {
            function: {
              name: "email_trash",
              arguments: {
                accountId: "account-1",
              },
            },
          },
        ],
      }),
    /forbidden executable field "tool_calls"/,
  );

  assert.throws(
    () =>
      parseClassifierResult({
        ...validResult(),
        retention: {
          ...validResult().retention,
          protectionReasons: [
            "trusted",
            {
              functionCall: {
                name: "email_send",
              },
            },
          ],
        },
      }),
    /forbidden executable field "functionCall"/,
  );
});
