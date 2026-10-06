import test from "node:test";
import assert from "node:assert/strict";
import {
  EMAIL_SCHEMA_VERSION,
  assertCanonicalMessage,
  createDefaultRetentionState,
  createUnclassifiedState,
  deriveProviderThreadKey,
  migrateEnvelope,
  stableCanonicalId,
  type CanonicalMessage,
} from "../src/index.js";

function sampleMessage(): CanonicalMessage {
  const now = "2026-10-06T06:00:00.000Z";
  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: "msg_test",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thr_test",
    provider: {
      kind: "gmail",
      messageId: "provider-message-123",
      threadId: "provider-thread-456",
    },
    internetMessageId: "<message@example.com>",
    subject: "Invoice due",
    body: { text: "Please review the invoice.", truncated: false },
    from: { address: "billing@example.com", name: "Billing" },
    to: [{ address: "user@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {
      "message-id": ["<message@example.com>"],
      "content-type": ["text/plain"],
    },
    labels: ["finance"],
    mailboxes: [{ id: "mbx_inbox", role: "inbox" }],
    flags: {
      read: false,
      starred: false,
      important: false,
      draft: false,
      answered: false,
      forwarded: false,
    },
    attachments: [],
    receivedAt: now,
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass", transportEncrypted: true },
    classification: createUnclassifiedState(),
    retention: createDefaultRetentionState(),
    providerMetadata: { historyId: "42" },
    ingestedAt: now,
    updatedAt: now,
  };
}

test("stableCanonicalId is deterministic and tenant/account scoped", () => {
  const base = {
    tenantId: "tenant-a",
    accountId: "account-a",
    provider: "gmail" as const,
    kind: "message" as const,
    providerId: "abc123",
  };

  const first = stableCanonicalId(base);
  const second = stableCanonicalId(base);
  const otherTenant = stableCanonicalId({ ...base, tenantId: "tenant-b" });

  assert.equal(first, second);
  assert.match(first, /^msg_[a-f0-9]{32}$/);
  assert.notEqual(first, otherTenant);
});

test("thread key prefers native provider conversation identity", () => {
  assert.equal(
    deriveProviderThreadKey({
      nativeThreadId: "gmail-thread-1",
      internetMessageId: "<m1@example.com>",
    }),
    "native:gmail-thread-1",
  );
});

test("thread key groups RFC replies by root reference", () => {
  const firstReply = deriveProviderThreadKey({
    references: ["<root@example.com>", "<reply-1@example.com>"],
    inReplyTo: "<reply-1@example.com>",
  });
  const secondReply = deriveProviderThreadKey({
    references: ["<root@example.com>", "<reply-2@example.com>"],
    inReplyTo: "<reply-2@example.com>",
  });

  assert.equal(firstReply, "rfc-root:<root@example.com>");
  assert.equal(firstReply, secondReply);
});

test("canonical message validation enforces normalized header keys", () => {
  const message = sampleMessage();
  message.headers["X-Unsafe"] = ["value"];

  assert.throws(() => assertCanonicalMessage(message), /Header key must be lower-case/);
});

test("canonical message validation rejects invalid classifier scores", () => {
  const message = sampleMessage();
  message.classification = {
    status: "classified",
    categories: ["finance"],
    importanceScore: 101,
  };

  assert.throws(() => assertCanonicalMessage(message), /between 0 and 100/);
});

test("current schema envelope is accepted and future schema is rejected", () => {
  const current = migrateEnvelope({
    schemaVersion: EMAIL_SCHEMA_VERSION,
    entityType: "message",
    data: { id: "msg_test" },
  });
  assert.equal(current.schemaVersion, EMAIL_SCHEMA_VERSION);

  assert.throws(
    () =>
      migrateEnvelope({
        schemaVersion: EMAIL_SCHEMA_VERSION + 1,
        entityType: "message",
        data: {},
      }),
    /future schema/,
  );
});
