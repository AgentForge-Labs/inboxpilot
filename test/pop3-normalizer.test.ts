import test from "node:test";
import assert from "node:assert/strict";

import {
  InMemoryPop3SyncStateStore,
  Pop3Adapter,
  assertCanonicalMessage,
  normalizePop3Message,
  pop3UidlIdentity,
  type Pop3FetchedMessage,
  type Pop3MessageRef,
  type Pop3SyncItem,
  type Pop3Transport,
  type ProviderConnectionContext,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

const rootRaw = Buffer.from(
  [
    "From: Sender Name <sender@example.test>",
    "To: User <user@example.test>",
    "Cc: Finance <finance@example.test>",
    "Bcc: Audit <audit@example.test>",
    "Reply-To: Support <reply@example.test>",
    "Message-ID: <root@example.test>",
    "Date: Tue, 06 Oct 2026 10:00:00 +0000",
    "Received: from relay.example.test by mx.example.test with ESMTPS; Tue, 06 Oct 2026 10:00:05 +0000",
    "Authentication-Results: mx.example.test; spf=pass smtp.mailfrom=example.test; dkim=pass header.d=example.test; dmarc=pass",
    "Subject: Quarterly invoice",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer"',
    "",
    "--outer",
    'Content-Type: multipart/alternative; boundary="alt"',
    "",
    "--alt",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Plain invoice body",
    "--alt",
    'Content-Type: text/html; charset="utf-8"',
    "",
    "<p>HTML invoice body</p>",
    "--alt--",
    "--outer",
    'Content-Type: application/pdf; name="invoice.pdf"',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("fake-pdf").toString("base64"),
    "--outer--",
    "",
  ].join("\r\n"),
);

const replyRaw = Buffer.from(
  [
    "From: User <user@example.test>",
    "To: Sender Name <sender@example.test>",
    "Message-ID: <reply@example.test>",
    "In-Reply-To: <root@example.test>",
    "References: <root@example.test>",
    "Date: Tue, 06 Oct 2026 11:00:00 +0000",
    "Subject: Re: Quarterly invoice",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "Thanks, received.",
    "",
  ].join("\r\n"),
);

function syncItem(
  uidl: string,
  raw: Buffer,
  sequenceNumber: number,
): Pop3SyncItem {
  const identity = pop3UidlIdentity(
    context,
    uidl,
  );
  return {
    ...identity,
    fetched: {
      ref: {
        sequenceNumber,
        uidl,
        sizeBytes: raw.length,
      },
      raw,
    },
  };
}

test("POP3 RFC822 normalization maps addresses, bodies, headers, attachments, timestamps and auth signals", async () => {
  const message =
    await normalizePop3Message({
      item: syncItem(
        "uidl-root",
        rootRaw,
        1,
      ),
      context,
      now: new Date(
        "2026-10-08T00:00:00.000Z",
      ),
    });

  assert.doesNotThrow(() =>
    assertCanonicalMessage(message),
  );
  assert.equal(
    message.provider.kind,
    "pop3",
  );
  assert.match(
    message.provider.messageId,
    /^pop3:[a-f0-9]{64}$/,
  );
  assert.equal(
    message.internetMessageId,
    "<root@example.test>",
  );
  assert.equal(
    message.subject,
    "Quarterly invoice",
  );
  assert.match(
    message.body.text ?? "",
    /Plain invoice body/,
  );
  assert.match(
    message.body.html ?? "",
    /HTML invoice body/,
  );

  assert.deepEqual(message.from, {
    address: "sender@example.test",
    name: "Sender Name",
  });
  assert.deepEqual(message.to, [
    {
      address: "user@example.test",
      name: "User",
    },
  ]);
  assert.deepEqual(message.cc, [
    {
      address: "finance@example.test",
      name: "Finance",
    },
  ]);
  assert.deepEqual(message.bcc, [
    {
      address: "audit@example.test",
      name: "Audit",
    },
  ]);
  assert.deepEqual(message.replyTo, [
    {
      address: "reply@example.test",
      name: "Support",
    },
  ]);

  assert.equal(
    message.sentAt,
    "2026-10-06T10:00:00.000Z",
  );
  assert.equal(
    message.receivedAt,
    "2026-10-06T10:00:05.000Z",
  );
  assert.deepEqual(
    message.authentication,
    {
      spf: "pass",
      dkim: "pass",
      dmarc: "pass",
      transportEncrypted: true,
    },
  );
  assert.ok(
    message.headers[
      "authentication-results"
    ]?.length,
  );

  assert.equal(
    message.attachments.length,
    1,
  );
  assert.equal(
    message.attachments[0]?.filename,
    "invoice.pdf",
  );
  assert.equal(
    message.attachments[0]?.contentType,
    "application/pdf",
  );
  assert.equal(
    message.attachments[0]?.sizeBytes,
    Buffer.byteLength("fake-pdf"),
  );
  assert.equal(
    message.mailboxes[0]?.role,
    "inbox",
  );
  assert.equal(
    message.providerMetadata.uidl,
    "uidl-root",
  );
  assert.equal(
    message.providerMetadata
      .identityMode,
    "uidl",
  );
});

test("POP3 RFC References/In-Reply-To produce the same canonical thread as the root message", async () => {
  const root =
    await normalizePop3Message({
      item: syncItem(
        "uidl-root",
        rootRaw,
        1,
      ),
      context,
    });
  const reply =
    await normalizePop3Message({
      item: syncItem(
        "uidl-reply",
        replyRaw,
        2,
      ),
      context,
    });

  assert.equal(
    root.provider.threadId,
    "rfc-root:<root@example.test>",
  );
  assert.equal(
    reply.provider.threadId,
    "rfc-root:<root@example.test>",
  );
  assert.equal(
    reply.threadId,
    root.threadId,
  );
  assert.equal(
    reply.flags.answered,
    true,
  );
  assert.deepEqual(
    reply.providerMetadata.references,
    ["<root@example.test>"],
  );
  assert.equal(
    reply.providerMetadata.inReplyTo,
    "<root@example.test>",
  );
});

class AdapterTransport
  implements Pop3Transport
{
  readonly refs: Pop3MessageRef[] = [
    {
      sequenceNumber: 1,
      uidl: "uidl-root",
      sizeBytes: rootRaw.length,
    },
    {
      sequenceNumber: 2,
      uidl: "uidl-reply",
      sizeBytes: replyRaw.length,
    },
  ];

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
    return this.refs;
  }

  async fetch(
    ref: Pop3MessageRef,
  ): Promise<Pop3FetchedMessage> {
    return {
      ref,
      raw:
        ref.sequenceNumber === 1
          ? rootRaw
          : replyRaw,
    };
  }

  async deleteOnServer(): Promise<void> {}

  async close(): Promise<void> {}
}

test("POP3 adapter exposes canonical syncChanges pages without provider-specific ingestion branches", async () => {
  const adapter = new Pop3Adapter(
    new AdapterTransport(),
    {
      syncStateStore:
        new InMemoryPop3SyncStateStore(),
    },
  );
  await adapter.connect(context);

  assert.equal(
    adapter.capabilities().syncChanges,
    true,
  );

  const first =
    await adapter.syncChanges({
      limit: 1,
    });
  assert.equal(first.messages.length, 1);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  assert.equal(
    first.messages[0]?.provider.kind,
    "pop3",
  );
  assert.doesNotThrow(() =>
    assertCanonicalMessage(
      first.messages[0]!,
    ),
  );

  const second =
    await adapter.syncChanges({
      cursor: first.nextCursor,
      limit: 1,
    });
  assert.equal(second.messages.length, 1);
  assert.equal(second.hasMore, false);
  assert.ok(second.nextCursor);
  assert.equal(
    second.messages[0]?.provider.kind,
    "pop3",
  );

  const third =
    await adapter.syncChanges({
      cursor: second.nextCursor,
      limit: 1,
    });
  assert.equal(third.messages.length, 0);
  assert.equal(third.hasMore, false);
});
