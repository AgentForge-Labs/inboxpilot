import test from "node:test";
import assert from "node:assert/strict";
import {
  InboxDashboardService,
  InMemoryInboxDashboardMessageRepository,
  messageMatchesDashboardView,
  type CanonicalMessage,
  type PriorityBand,
  type ProviderKind,
  type RetentionStage,
} from "../src/index.js";

function message(
  id: string,
  options: {
    provider?: ProviderKind;
    priority?: PriorityBand;
    categories?: string[];
    actionRequired?: boolean;
    replyRequired?: boolean;
    status?: CanonicalMessage["classification"]["status"];
    score?: number;
    reason?: string;
    retentionStage?: RetentionStage;
    policyId?: string;
    receivedAt?: string;
  } = {},
): CanonicalMessage {
  const receivedAt =
    options.receivedAt ?? "2026-10-07T07:00:00.000Z";
  return {
    schemaVersion: 1,
    id,
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-" + id,
    provider: {
      kind: options.provider ?? "gmail",
      messageId: "provider-" + id,
    },
    subject: "Subject " + id,
    snippet: "snippet should not be required",
    body: {
      text: "BODY SECRET " + id,
      html: "<p>HTML SECRET " + id + "</p>",
      truncated: false,
    },
    from: {
      name: "Sender " + id,
      address: id + "@example.com",
    },
    to: [{ address: "me@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {
      authorization: ["Bearer header-secret-" + id],
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
      status: options.status ?? "classified",
      categories: options.categories ?? [],
      ...(options.score !== undefined
        ? { importanceScore: options.score }
        : {}),
      ...(options.priority
        ? { priority: options.priority }
        : {}),
      confidence: 0.95,
      actionRequired: options.actionRequired ?? false,
      replyRequired: options.replyRequired ?? false,
      ...(options.reason ? { reason: options.reason } : {}),
    },
    retention: {
      stage: options.retentionStage ?? "active",
      protected: false,
      protectionReasons: [],
      ...(options.policyId ? { policyId: options.policyId } : {}),
      ...(options.retentionStage === "archived"
        ? { archiveAt: "2026-10-07T08:00:00.000Z" }
        : {}),
      ...(options.retentionStage === "trashed"
        ? { trashAt: "2026-10-07T08:00:00.000Z" }
        : {}),
    },
    providerMetadata: {},
    ingestedAt: receivedAt,
    updatedAt: receivedAt,
  };
}

async function serviceWith(
  messages: CanonicalMessage[],
) {
  const repository =
    new InMemoryInboxDashboardMessageRepository();
  messages.forEach((item) => repository.seed(item));
  return new InboxDashboardService(repository);
}

test("all nine decision views map canonical state without forcing exclusivity", () => {
  const criticalReceipt = message("critical", {
    priority: "critical",
    categories: ["receipt"],
    actionRequired: true,
    score: 98,
  });
  assert.equal(
    messageMatchesDashboardView(
      criticalReceipt,
      "critical",
    ),
    true,
  );
  assert.equal(
    messageMatchesDashboardView(
      criticalReceipt,
      "needs_action",
    ),
    true,
  );
  assert.equal(
    messageMatchesDashboardView(
      criticalReceipt,
      "receipts",
    ),
    true,
  );

  assert.equal(
    messageMatchesDashboardView(
      message("important", {
        priority: "important",
      }),
      "important",
    ),
    true,
  );
  assert.equal(
    messageMatchesDashboardView(
      message("normal", { priority: "normal" }),
      "normal",
    ),
    true,
  );
  assert.equal(
    messageMatchesDashboardView(
      message("later", { priority: "very_low" }),
      "read_later",
    ),
    true,
  );
  assert.equal(
    messageMatchesDashboardView(
      message("newsletter", {
        categories: ["newsletter"],
      }),
      "newsletters",
    ),
    true,
  );
  assert.equal(
    messageMatchesDashboardView(
      message("archived", {
        retentionStage: "archived",
        policyId: "policy-1",
      }),
      "auto_archived",
    ),
    true,
  );
  assert.equal(
    messageMatchesDashboardView(
      message("pending", {
        retentionStage: "pending_delete",
      }),
      "pending_delete",
    ),
    true,
  );
});

test("Needs Action includes action-required, reply-required and needs-review messages", async () => {
  const service = await serviceWith([
    message("action", {
      actionRequired: true,
      priority: "normal",
    }),
    message("reply", {
      replyRequired: true,
      priority: "normal",
    }),
    message("review", {
      status: "needs_review",
      priority: "normal",
    }),
    message("plain", { priority: "normal" }),
  ]);

  const view = await service.view({
    tenantId: "tenant-1",
    accountId: "account-1",
    view: "needs_action",
  });

  assert.deepEqual(
    view.rows.map((row) => row.canonicalMessageId).sort(),
    ["action", "reply", "review"],
  );
});

test("provider, category and inclusive date filters apply before view and navigation counts", async () => {
  const service = await serviceWith([
    message("gmail-receipt", {
      provider: "gmail",
      priority: "critical",
      categories: ["receipt"],
      receivedAt: "2026-10-06T00:00:00.000Z",
    }),
    message("imap-receipt", {
      provider: "imap",
      priority: "critical",
      categories: ["receipt"],
      receivedAt: "2026-10-07T00:00:00.000Z",
    }),
    message("imap-newsletter", {
      provider: "imap",
      priority: "low",
      categories: ["newsletter"],
      receivedAt: "2026-10-08T00:00:00.000Z",
    }),
  ]);

  const view = await service.view({
    tenantId: "tenant-1",
    accountId: "account-1",
    view: "critical",
    filters: {
      providers: ["imap"],
      categories: ["receipt"],
      receivedFrom: "2026-10-07T00:00:00.000Z",
      receivedTo: "2026-10-07T00:00:00.000Z",
    },
  });

  assert.deepEqual(
    view.rows.map((row) => row.canonicalMessageId),
    ["imap-receipt"],
  );
  assert.equal(
    view.nav.find((item) => item.view === "critical")?.count,
    1,
  );
  assert.equal(
    view.nav.find((item) => item.view === "receipts")?.count,
    1,
  );
  assert.equal(
    view.nav.find((item) => item.view === "newsletters")
      ?.count,
    0,
  );
});

test("rows are newest-first, bounded, explain score/category and never copy body/html/headers", async () => {
  const service = await serviceWith([
    message("old", {
      priority: "critical",
      score: 95,
      categories: ["government"],
      reason: "Government deadline requires attention.",
      receivedAt: "2026-10-05T00:00:00.000Z",
    }),
    message("new", {
      priority: "critical",
      score: 99,
      categories: ["security"],
      reason: "Security alert requires immediate review.",
      receivedAt: "2026-10-07T00:00:00.000Z",
    }),
  ]);

  const view = await service.view({
    tenantId: "tenant-1",
    accountId: "account-1",
    view: "critical",
    limit: 1,
  });

  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0]?.canonicalMessageId, "new");
  assert.equal(view.rows[0]?.importanceScore, 99);
  assert.deepEqual(view.rows[0]?.categories, ["security"]);
  assert.equal(
    view.rows[0]?.explanation,
    "Security alert requires immediate review.",
  );

  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("BODY SECRET"), false);
  assert.equal(serialized.includes("HTML SECRET"), false);
  assert.equal(serialized.includes("header-secret"), false);
  assert.equal(serialized.includes("authorization"), false);
});

test("Auto Archived requires policy-driven retention state and Pending Delete includes deletion lifecycle stages", async () => {
  const service = await serviceWith([
    message("manual-archive", {
      retentionStage: "archived",
    }),
    message("auto-archive", {
      retentionStage: "archived",
      policyId: "rule-newsletters",
    }),
    message("pending-trash", {
      retentionStage: "pending_trash",
    }),
    message("trashed", {
      retentionStage: "trashed",
    }),
    message("pending-delete", {
      retentionStage: "pending_delete",
    }),
  ]);

  const autoArchived = await service.view({
    tenantId: "tenant-1",
    accountId: "account-1",
    view: "auto_archived",
  });
  assert.deepEqual(
    autoArchived.rows.map((row) => row.canonicalMessageId),
    ["auto-archive"],
  );

  const pending = await service.view({
    tenantId: "tenant-1",
    accountId: "account-1",
    view: "pending_delete",
  });
  assert.deepEqual(
    pending.rows.map((row) => row.canonicalMessageId).sort(),
    ["pending-delete", "pending-trash", "trashed"],
  );
});

test("invalid date filters fail closed", async () => {
  const service = await serviceWith([
    message("one", { priority: "normal" }),
  ]);

  await assert.rejects(
    () =>
      service.view({
        tenantId: "tenant-1",
        accountId: "account-1",
        view: "normal",
        filters: {
          receivedFrom: "2026-10-08T00:00:00.000Z",
          receivedTo: "2026-10-07T00:00:00.000Z",
        },
      }),
    /receivedFrom must be before/,
  );

  await assert.rejects(
    () =>
      service.view({
        tenantId: "tenant-1",
        accountId: "account-1",
        view: "normal",
        filters: { receivedFrom: "not-a-date" },
      }),
    /ISO-compatible/,
  );
});
