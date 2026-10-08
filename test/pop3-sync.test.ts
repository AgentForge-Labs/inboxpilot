import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  CustomerUsageAccountingService,
  FilePop3SyncStateStore,
  InMemoryCustomerUsageStore,
  InMemoryPop3SyncStateStore,
  Pop3IncrementalSync,
  pop3ContentIdentity,
  pop3UidlIdentity,
  type CanonicalMessage,
  type Pop3FetchedMessage,
  type Pop3MessageRef,
  type ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

class SyncTransport {
  fetchCalls: number[] = [];

  constructor(
    readonly refs: readonly Pop3MessageRef[],
    private readonly rawBySequence = new Map<
      number,
      Uint8Array
    >(),
  ) {}

  async list(): Promise<readonly Pop3MessageRef[]> {
    return this.refs;
  }

  async fetch(
    ref: Pop3MessageRef,
  ): Promise<Pop3FetchedMessage> {
    this.fetchCalls.push(ref.sequenceNumber);
    return {
      ref,
      raw:
        this.rawBySequence.get(
          ref.sequenceNumber,
        ) ??
        Buffer.from(
          "Subject: " +
            ref.sequenceNumber +
            "\r\n\r\nBody",
        ),
    };
  }
}

function canonical(
  stableMessageId: string,
): CanonicalMessage {
  const now =
    "2026-10-08T04:00:00.000Z";
  return {
    schemaVersion: 1,
    id: stableMessageId,
    tenantId: context.tenantId,
    accountId: context.accountId,
    threadId: stableMessageId,
    provider: {
      kind: "pop3",
      messageId: stableMessageId,
    },
    subject: "POP3 fixture",
    body: { text: "Body", truncated: false },
    from: {
      address: "sender@example.test",
    },
    to: [{ address: "me@example.test" }],
    cc: [],
    bcc: [],
    replyTo: [],
    headers: {},
    labels: [],
    mailboxes: [
      { id: "pop3-inbox", role: "inbox" },
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
    receivedAt: now,
    authentication: {},
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
    ingestedAt: now,
    updatedAt: now,
  };
}

test("UIDL identities are stable per account and change across accounts", () => {
  const first = pop3UidlIdentity(
    context,
    "server-uid-123",
  );
  const retry = pop3UidlIdentity(
    context,
    "server-uid-123",
  );
  const otherAccount = pop3UidlIdentity(
    {
      ...context,
      accountId: "account-2",
    },
    "server-uid-123",
  );

  assert.deepEqual(first, retry);
  assert.notEqual(
    first.stableMessageId,
    otherAccount.stableMessageId,
  );
  assert.match(
    first.stableMessageId,
    /^pop3:[a-f0-9]{64}$/,
  );
});

test("UIDL polling fetches only unseen messages and reconnect polls remain deduplicated", async () => {
  const refs: Pop3MessageRef[] = [
    {
      sequenceNumber: 1,
      uidl: "u-1",
      sizeBytes: 10,
    },
    {
      sequenceNumber: 2,
      uidl: "u-2",
      sizeBytes: 20,
    },
  ];
  const state =
    new InMemoryPop3SyncStateStore();
  const firstTransport =
    new SyncTransport(refs);
  const firstSync =
    new Pop3IncrementalSync(
      firstTransport,
      state,
    );

  const first = await firstSync.poll(
    context,
  );
  assert.equal(first.items.length, 2);
  assert.deepEqual(
    firstTransport.fetchCalls,
    [1, 2],
  );

  // An unacknowledged retry is intentionally returned with the same stable
  // identity, so downstream idempotency/quota accounting can safely retry.
  const retryBeforeAck =
    await firstSync.poll(context);
  assert.deepEqual(
    retryBeforeAck.items.map(
      (item) => item.stableMessageId,
    ),
    first.items.map(
      (item) => item.stableMessageId,
    ),
  );

  await firstSync.acknowledgeAll(
    context,
    first.items,
  );

  const reconnectTransport =
    new SyncTransport(refs);
  const reconnectSync =
    new Pop3IncrementalSync(
      reconnectTransport,
      state,
    );
  const reconnect =
    await reconnectSync.poll(context);

  assert.equal(reconnect.items.length, 0);
  assert.equal(reconnect.alreadySeen, 2);
  assert.deepEqual(
    reconnectTransport.fetchCalls,
    [],
  );
});

test("file state persists UIDL index across process-style store recreation", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "inboxpilot-pop3-"),
  );
  try {
    const path = join(
      directory,
      "state.json",
    );
    const refs: Pop3MessageRef[] = [
      {
        sequenceNumber: 1,
        uidl: "persisted-uidl",
      },
    ];

    const first = new Pop3IncrementalSync(
      new SyncTransport(refs),
      new FilePop3SyncStateStore(path),
    );
    const batch = await first.poll(
      context,
    );
    assert.equal(batch.items.length, 1);
    await first.acknowledgeAll(
      context,
      batch.items,
    );

    const transport =
      new SyncTransport(refs);
    const recreated =
      new Pop3IncrementalSync(
        transport,
        new FilePop3SyncStateStore(path),
      );
    const second =
      await recreated.poll(context);

    assert.equal(second.items.length, 0);
    assert.equal(second.alreadySeen, 1);
    assert.deepEqual(
      transport.fetchCalls,
      [],
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("servers without UIDL use conservative content fingerprint fallback instead of sequence numbers", async () => {
  const raw = Buffer.from(
    "Message-ID: <same@example.test>\r\nSubject: Same\r\n\r\nBody",
  );
  const state =
    new InMemoryPop3SyncStateStore();
  const firstTransport =
    new SyncTransport(
      [{ sequenceNumber: 7 }],
      new Map([[7, raw]]),
    );
  const sync =
    new Pop3IncrementalSync(
      firstTransport,
      state,
    );

  const first = await sync.poll(context);
  assert.equal(
    first.items[0]?.mode,
    "content_fingerprint",
  );
  assert.equal(first.fallbackFetched, 1);
  const expected =
    pop3ContentIdentity(
      context,
      raw,
    );
  assert.equal(
    first.items[0]?.stableMessageId,
    expected.stableMessageId,
  );
  await sync.acknowledgeAll(
    context,
    first.items,
  );

  // Sequence changed after reconnect, but identical RFC822 content is not
  // reprocessed.
  const reconnectTransport =
    new SyncTransport(
      [{ sequenceNumber: 1 }],
      new Map([[1, raw]]),
    );
  const reconnect =
    await new Pop3IncrementalSync(
      reconnectTransport,
      state,
    ).poll(context);

  assert.equal(reconnect.items.length, 0);
  assert.equal(reconnect.alreadySeen, 1);
  assert.equal(reconnect.fallbackFetched, 1);
  assert.deepEqual(
    reconnectTransport.fetchCalls,
    [1],
  );
});

test("stable POP3 provider IDs prevent duplicate customer quota accounting on retry", async () => {
  const stable = pop3UidlIdentity(
    context,
    "quota-uidl",
  ).stableMessageId;
  const usageStore =
    new InMemoryCustomerUsageStore();
  const usage =
    new CustomerUsageAccountingService(
      usageStore,
    );

  const first =
    await usage.recordProcessed([
      canonical(stable),
    ]);
  const retry =
    await usage.recordProcessed([
      {
        ...canonical(stable),
        id: stable + "-retry-canonical",
      },
    ]);

  assert.equal(first.newlyProcessed, 1);
  assert.equal(retry.newlyProcessed, 0);
  assert.equal(retry.duplicates, 1);
  assert.equal(usageStore.events.size, 1);
});

test("poll limit signals remaining unseen UIDLs without fetching beyond the limit", async () => {
  const transport = new SyncTransport([
    { sequenceNumber: 1, uidl: "a" },
    { sequenceNumber: 2, uidl: "b" },
    { sequenceNumber: 3, uidl: "c" },
  ]);
  const batch =
    await new Pop3IncrementalSync(
      transport,
      new InMemoryPop3SyncStateStore(),
    ).poll(context, { limit: 2 });

  assert.equal(batch.items.length, 2);
  assert.equal(batch.hasMore, true);
  assert.deepEqual(
    transport.fetchCalls,
    [1, 2],
  );
});
