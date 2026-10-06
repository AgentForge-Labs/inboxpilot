import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreDeterministicImportance,
  type CanonicalMessage,
} from "../src/index.js";

function baseMessage(
  overrides: Partial<CanonicalMessage> = {},
): CanonicalMessage {
  const message: CanonicalMessage = {
    schemaVersion: 1,
    id: "m1",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-1",
    provider: {
      kind: "gmail",
      messageId: "provider-1",
      threadId: "provider-thread-1",
    },
    subject: "Hello",
    body: { text: "General message", truncated: false },
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
    receivedAt: "2026-10-06T13:00:00.000Z",
    authentication: {
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
    },
    classification: {
      status: "unclassified",
      categories: [],
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {},
    ingestedAt: "2026-10-06T13:00:00.000Z",
    updatedAt: "2026-10-06T13:00:00.000Z",
  };

  return {
    ...message,
    ...overrides,
    provider: overrides.provider ?? message.provider,
    body: overrides.body ?? message.body,
    headers: overrides.headers ?? message.headers,
    authentication:
      overrides.authentication ?? message.authentication,
    classification:
      overrides.classification ?? message.classification,
    retention: overrides.retention ?? message.retention,
    flags: overrides.flags ?? message.flags,
    mailboxes: overrides.mailboxes ?? message.mailboxes,
  };
}

test("trusted active reply thread with deadline/invoice/action signals bypasses LLM as important", () => {
  const message = baseMessage({
    subject: "Re: Invoice 2026-104 — action required",
    body: {
      text:
        "Please reply and confirm payment of €1,240 by the deadline tomorrow.",
      truncated: false,
    },
    headers: {
      "in-reply-to": ["<previous@example.com>"],
      references: ["<root@example.com>"],
    },
  });

  const result = scoreDeterministicImportance(message, {
    userAddresses: ["me@example.com"],
    trustedContacts: ["sender@example.com"],
    sender: {
      receivedCount: 20,
      repliedByUserCount: 8,
      sentByUserCount: 5,
    },
    domain: {
      receivedCount: 40,
      repliedByUserCount: 7,
    },
    thread: {
      userParticipated: true,
      userSentCount: 3,
      messageCount: 8,
    },
  });

  assert.equal(result.importanceScore, 100);
  assert.equal(result.priority, "critical");
  assert.equal(result.needsLlm, false);
  assert.equal(
    result.llmDecisionReason,
    "high_confidence_important",
  );
  assert.equal(result.actionRequiredHint, true);
  assert.equal(result.replyRequiredHint, true);
  assert.ok(result.categoryHints.includes("invoice"));
  assert.ok(result.categoryHints.includes("finance"));

  const codes = new Set(result.contributions.map((item) => item.code));
  for (const expected of [
    "trusted_contact",
    "prior_user_replies",
    "domain_interaction_history",
    "direct_recipient",
    "thread_participation",
    "deadline_language",
    "monetary_amount",
    "action_language",
    "invoice_indicator",
    "reply_pattern",
  ]) {
    assert.equal(codes.has(expected as never), true, expected);
  }
});

test("clear mailing-list bulk mail bypasses LLM as low importance", () => {
  const message = baseMessage({
    from: { address: "newsletter@shop.example" },
    to: [{ address: "me@example.com" }],
    subject: "Weekly offers",
    body: { text: "Here are this week's updates.", truncated: false },
    headers: {
      "list-id": ["Shop newsletter <news.shop.example>"],
      "list-unsubscribe": ["<https://shop.example/unsub>"],
      precedence: ["bulk"],
    },
  });

  const result = scoreDeterministicImportance(message, {
    userAddresses: ["me@example.com"],
    sender: {
      receivedCount: 50,
      repliedByUserCount: 0,
      sentByUserCount: 0,
    },
  });

  assert.ok(result.importanceScore <= 28);
  assert.equal(result.needsLlm, false);
  assert.equal(result.llmDecisionReason, "high_confidence_bulk");
  assert.ok(result.categoryHints.includes("newsletter"));

  const negative = result.contributions.filter(
    (item) => item.weight < 0,
  );
  assert.ok(negative.length >= 3);
});

test("conflicting trusted-security and bulk-list signals require semantic model", () => {
  const message = baseMessage({
    from: { address: "security@example.com" },
    subject: "Security alert",
    body: {
      text: "New login detected. Verification code 123456.",
      truncated: false,
    },
    headers: {
      "list-id": ["Alerts <alerts.example.com>"],
      "list-unsubscribe": ["<https://example.com/unsub>"],
      precedence: ["bulk"],
    },
  });

  const result = scoreDeterministicImportance(message, {
    userAddresses: ["me@example.com"],
    trustedContacts: ["security@example.com"],
  });

  assert.equal(result.needsLlm, true);
  assert.equal(result.llmDecisionReason, "conflicting_signals");
  assert.ok(result.categoryHints.includes("security"));
});

test("weak new conversation with insufficient evidence routes to LLM", () => {
  const result = scoreDeterministicImportance(baseMessage(), {
    userAddresses: ["me@example.com"],
  });

  assert.equal(result.needsLlm, true);
  assert.equal(result.llmDecisionReason, "insufficient_signals");
  assert.equal(
    result.contributions.some(
      (item) => item.code === "new_conversation",
    ),
    true,
  );
});

test("allowlisted domain and repeated interaction history raise importance", () => {
  const result = scoreDeterministicImportance(
    baseMessage({
      from: { address: "person@partner.example" },
      to: [{ address: "me@example.com" }],
      subject: "Project update",
    }),
    {
      userAddresses: ["me@example.com"],
      allowlistedDomains: ["partner.example"],
      sender: {
        receivedCount: 15,
        repliedByUserCount: 4,
      },
      domain: {
        receivedCount: 80,
        repliedByUserCount: 12,
      },
    },
  );

  assert.ok(result.importanceScore >= 75);
  assert.ok(
    result.contributions.some(
      (item) => item.code === "allowlisted_domain",
    ),
  );
  assert.ok(
    result.contributions.some(
      (item) => item.code === "domain_interaction_history",
    ),
  );
});

test("security/authentication signals increase attention and emit phishing hint without auto-final classification", () => {
  const result = scoreDeterministicImportance(
    baseMessage({
      subject: "Password reset requested",
      body: {
        text: "Reset your password using this verification code.",
        truncated: false,
      },
      authentication: {
        spf: "pass",
        dkim: "fail",
        dmarc: "fail",
        suspicious: true,
      },
    }),
    { userAddresses: ["me@example.com"] },
  );

  assert.ok(
    result.contributions.some(
      (item) => item.code === "security_context",
    ),
  );
  assert.ok(
    result.contributions.some(
      (item) => item.code === "suspicious_authentication",
    ),
  );
  assert.ok(result.categoryHints.includes("security"));
  assert.ok(result.categoryHints.includes("phishing"));
  assert.equal(result.needsLlm, true);
});

test("receipt and amount indicators are detected separately from invoice", () => {
  const result = scoreDeterministicImportance(
    baseMessage({
      subject: "Payment confirmation",
      body: {
        text: "Payment received: 49.90 EUR. Your receipt is attached.",
        truncated: false,
      },
    }),
    { userAddresses: ["me@example.com"] },
  );

  assert.ok(result.categoryHints.includes("receipt"));
  assert.equal(result.categoryHints.includes("invoice"), false);
  assert.ok(
    result.contributions.some(
      (item) => item.code === "monetary_amount",
    ),
  );
  assert.ok(
    result.contributions.some(
      (item) => item.code === "receipt_indicator",
    ),
  );
});

test("reply pattern scores a participated thread higher than an unrelated reply", () => {
  const reply = baseMessage({
    subject: "Re: Existing topic",
    headers: {
      "in-reply-to": ["<prior@example.com>"],
    },
  });

  const unrelated = scoreDeterministicImportance(reply, {
    userAddresses: ["me@example.com"],
    thread: {
      userParticipated: false,
    },
  });

  const participated = scoreDeterministicImportance(reply, {
    userAddresses: ["me@example.com"],
    thread: {
      userParticipated: true,
      userSentCount: 1,
    },
  });

  assert.ok(
    participated.importanceScore >
      unrelated.importanceScore,
  );
  assert.ok(
    participated.contributions.some(
      (item) => item.code === "thread_participation",
    ),
  );
});
