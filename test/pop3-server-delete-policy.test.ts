import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryPop3ServerDeletePolicyStore,
  POP3_MIN_SERVER_DELETE_DELAY_DAYS,
  Pop3Adapter,
  Pop3ServerDeletePolicyService,
  Pop3ServerDeleteService,
  ProviderCapabilityError,
  buildPop3ServerDeleteDashboardViewModel,
  type CanonicalMessage,
  type ManualDecisionAuditInput,
  type Pop3FetchedMessage,
  type Pop3MessageRef,
  type Pop3Transport,
} from "../src/index.js";

function message(
  receivedAt = "2026-09-01T00:00:00.000Z",
): CanonicalMessage {
  const now = "2026-10-08T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "canonical-pop3-1",
    tenantId: "tenant-1",
    accountId: "account-1",
    threadId: "thread-1",
    provider: {
      kind: "pop3",
      messageId: "pop3:stable-1",
    },
    subject: "Ordinary newsletter",
    body: {
      text: "Low value update",
      truncated: false,
    },
    from: {
      address: "news@example.test",
    },
    to: [{ address: "me@example.test" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {},
    labels: [],
    mailboxes: [
      {
        id: "pop3:inbox",
        role: "inbox",
      },
    ],
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
      categories: ["newsletter"],
    },
    retention: {
      stage: "active",
      protected: false,
      protectionReasons: [],
    },
    providerMetadata: {
      sequenceNumber: 7,
      uidl: "server-uidl-7",
      sizeBytes: 1234,
    },
    ingestedAt: now,
    updatedAt: now,
  };
}

test("POP3 server deletion defaults to never delete", async () => {
  const store =
    new InMemoryPop3ServerDeletePolicyStore();
  const policies =
    new Pop3ServerDeletePolicyService(
      store,
      () =>
        new Date(
          "2026-10-08T00:00:00.000Z",
        ),
    );

  const policy = await policies.get(
    "tenant-1",
    "account-1",
  );
  assert.equal(
    policy.deleteFromServerAfterDays,
    undefined,
  );

  let deleteCalls = 0;
  const service =
    new Pop3ServerDeleteService(
      store,
      {
        async deleteOnServer() {
          deleteCalls += 1;
        },
      },
      {
        async evaluate() {
          throw new Error(
            "safeguard must not run when deletion is disabled",
          );
        },
      },
      () =>
        new Date(
          "2026-10-08T00:00:00.000Z",
        ),
    );

  assert.deepEqual(
    await service.deleteIfDue(message()),
    { outcome: "disabled" },
  );
  assert.equal(deleteCalls, 0);
});

test("delete_from_server_after_days enforces a minimum safety delay", async () => {
  const store =
    new InMemoryPop3ServerDeletePolicyStore();
  const service =
    new Pop3ServerDeletePolicyService(
      store,
    );

  await assert.rejects(
    () =>
      service.setDeleteFromServerAfterDays(
        "tenant-1",
        "account-1",
        POP3_MIN_SERVER_DELETE_DELAY_DAYS -
          1,
        "user-1",
      ),
    /at least/,
  );

  const policy =
    await service.setDeleteFromServerAfterDays(
      "tenant-1",
      "account-1",
      POP3_MIN_SERVER_DELETE_DELAY_DAYS,
      "user-1",
    );
  assert.equal(
    policy.deleteFromServerAfterDays,
    POP3_MIN_SERVER_DELETE_DELAY_DAYS,
  );

  const disabled =
    await service.setDeleteFromServerAfterDays(
      "tenant-1",
      "account-1",
      undefined,
      "user-1",
    );
  assert.equal(
    disabled.deleteFromServerAfterDays,
    undefined,
  );
});

test("dashboard clearly previews disabled and destructive enabled states", async () => {
  const store =
    new InMemoryPop3ServerDeletePolicyStore();
  const policies =
    new Pop3ServerDeletePolicyService(
      store,
    );

  const disabled =
    buildPop3ServerDeleteDashboardViewModel(
      await policies.get(
        "tenant-1",
        "account-1",
      ),
    );
  assert.equal(disabled.enabled, false);
  assert.match(
    disabled.statusLabel,
    /Never delete/i,
  );
  assert.match(
    disabled.archiveMappingNotice,
    /Archive never maps to POP3 DELE/i,
  );
  assert.equal(
    disabled.warning,
    undefined,
  );

  const enabled =
    buildPop3ServerDeleteDashboardViewModel(
      await policies.setDeleteFromServerAfterDays(
        "tenant-1",
        "account-1",
        30,
        "user-1",
      ),
    );
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.delayDays, 30);
  assert.match(
    enabled.warning ?? "",
    /destructive/i,
  );
  assert.equal(
    enabled.minimumDelayDays,
    POP3_MIN_SERVER_DELETE_DELAY_DAYS,
  );
});

test("not-yet-due POP3 messages are not deleted and protections are not evaluated early", async () => {
  const store =
    new InMemoryPop3ServerDeletePolicyStore();
  await new Pop3ServerDeletePolicyService(
    store,
  ).setDeleteFromServerAfterDays(
    "tenant-1",
    "account-1",
    30,
    "user-1",
  );

  let protectionCalls = 0;
  let deleteCalls = 0;
  const service =
    new Pop3ServerDeleteService(
      store,
      {
        async deleteOnServer() {
          deleteCalls += 1;
        },
      },
      {
        async evaluate() {
          protectionCalls += 1;
          return {
            protected: false,
            reasons: [],
            suppressedReasons: [],
            matchedOverrideIds: [],
          };
        },
      },
      () =>
        new Date(
          "2026-10-08T00:00:00.000Z",
        ),
    );

  const result =
    await service.deleteIfDue(
      message(
        "2026-10-01T00:00:00.000Z",
      ),
    );
  assert.equal(result.outcome, "not_due");
  assert.equal(deleteCalls, 0);
  assert.equal(protectionCalls, 0);
});

test("Never Auto Delete is re-checked immediately before due server deletion", async () => {
  const store =
    new InMemoryPop3ServerDeletePolicyStore();
  await new Pop3ServerDeletePolicyService(
    store,
  ).setDeleteFromServerAfterDays(
    "tenant-1",
    "account-1",
    30,
    "user-1",
  );

  let deleteCalls = 0;
  let protectionCalls = 0;
  const service =
    new Pop3ServerDeleteService(
      store,
      {
        async deleteOnServer() {
          deleteCalls += 1;
        },
      },
      {
        async evaluate() {
          protectionCalls += 1;
          return {
            protected: true,
            reasons: [
              {
                code: "category:finance",
                kind: "category",
                key: "finance",
                description:
                  "Default Never Auto Delete category: finance",
                bypassable: true,
              },
            ],
            suppressedReasons: [],
            matchedOverrideIds: [],
          };
        },
      },
      () =>
        new Date(
          "2026-10-08T00:00:00.000Z",
        ),
    );

  const result =
    await service.deleteIfDue(message());
  assert.equal(
    result.outcome,
    "protected",
  );
  assert.deepEqual(
    result.protectionReasons,
    ["category:finance"],
  );
  assert.equal(protectionCalls, 1);
  assert.equal(deleteCalls, 0);
});

test("due unprotected POP3 deletion executes DELE once and writes audit metadata", async () => {
  const store =
    new InMemoryPop3ServerDeletePolicyStore();
  await new Pop3ServerDeletePolicyService(
    store,
  ).setDeleteFromServerAfterDays(
    "tenant-1",
    "account-1",
    30,
    "user-1",
  );

  const deleted: Pop3MessageRef[] = [];
  const audits: ManualDecisionAuditInput[] =
    [];
  const service =
    new Pop3ServerDeleteService(
      store,
      {
        async deleteOnServer(ref) {
          deleted.push(ref);
        },
      },
      {
        async evaluate() {
          return {
            protected: false,
            reasons: [],
            suppressedReasons: [],
            matchedOverrideIds: [],
          };
        },
      },
      () =>
        new Date(
          "2026-10-08T00:00:00.000Z",
        ),
      {
        async recordManualDecision(input) {
          audits.push(input);
          return {} as never;
        },
      },
    );

  const result =
    await service.deleteIfDue(message());
  assert.equal(result.outcome, "deleted");
  assert.deepEqual(deleted, [
    {
      sequenceNumber: 7,
      uidl: "server-uidl-7",
      sizeBytes: 1234,
    },
  ]);
  assert.equal(audits.length, 1);
  assert.equal(
    audits[0]?.requestedAction,
    "pop3_delete_from_server",
  );
  assert.equal(
    audits[0]?.executedAction,
    "pop3_dele",
  );
  assert.equal(
    audits[0]?.metadata
      ?.deleteFromServerAfterDays,
    30,
  );
});

class MinimalTransport
  implements Pop3Transport
{
  async connect(): Promise<{
    accountExternalId: string;
  }> {
    return {
      accountExternalId:
        "user@example.test",
    };
  }
  async list(): Promise<
    readonly Pop3MessageRef[]
  > {
    return [];
  }
  async fetch(
    ref: Pop3MessageRef,
  ): Promise<Pop3FetchedMessage> {
    return {
      ref,
      raw: Buffer.from("Subject: x\r\n\r\nx"),
    };
  }
  async deleteOnServer(): Promise<void> {}
  async close(): Promise<void> {}
}

test("InboxPilot archive remains unsupported for POP3 and cannot alias to DELE", async () => {
  const adapter = new Pop3Adapter(
    new MinimalTransport(),
    { allowServerDelete: true },
  );
  await adapter.connect({
    tenantId: "tenant-1",
    accountId: "account-1",
  });

  await assert.rejects(
    () => adapter.archive("pop3:stable-1"),
    (error: unknown) =>
      error instanceof
        ProviderCapabilityError &&
      error.provider === "pop3" &&
      error.capability === "archive",
  );
});
