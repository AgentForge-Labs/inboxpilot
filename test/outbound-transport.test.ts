import test from "node:test";
import assert from "node:assert/strict";

import {
  ProviderNeutralOutboundSender,
  smtpCapabilities,
  type OutboundConnectionValidation,
  type OutboundMessageInput,
  type OutboundReplyInput,
  type OutboundSendResult,
  type OutboundTransport,
  type OutboundTransportCapabilities,
} from "../src/index.js";

class StubOutboundTransport
  implements OutboundTransport
{
  closed = false;
  sent: OutboundMessageInput[] = [];
  replies: OutboundReplyInput[] = [];

  private readonly caps =
    smtpCapabilities({
      authMethods: [
        "app_password",
        "oauth2",
      ],
      tlsModes: [
        "starttls",
        "implicit_tls",
      ],
      envelopeSender: true,
      customFrom: true,
      customReplyTo: true,
      smtpUtf8: true,
      maxMessageBytes: 25_000_000,
    });

  capabilities(): OutboundTransportCapabilities {
    return this.caps;
  }

  async validateConnection(): Promise<OutboundConnectionValidation> {
    return {
      ok: true,
      capabilities: this.caps,
      accountExternalId:
        "sender@example.test",
    };
  }

  async sendMessage(
    input: OutboundMessageInput,
  ): Promise<OutboundSendResult> {
    this.sent.push(input);
    return {
      accepted: input.to.map(
        (item) => item.address,
      ),
      rejected: [],
      messageId: "<sent@example.test>",
    };
  }

  async sendReply(
    input: OutboundReplyInput,
  ): Promise<OutboundSendResult> {
    this.replies.push(input);
    return {
      accepted: input.to.map(
        (item) => item.address,
      ),
      rejected: [],
      messageId: "<reply@example.test>",
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

test("SMTP capability model exposes auth, TLS, envelope, From/Reply-To, SMTPUTF8 and size support", () => {
  const caps = smtpCapabilities({
    authMethods: [
      "password",
      "app_password",
      "oauth2",
    ],
    tlsModes: [
      "starttls",
      "implicit_tls",
    ],
    envelopeSender: true,
    customFrom: true,
    customReplyTo: true,
    smtpUtf8: true,
    maxMessageBytes: 10_000_000,
  });

  assert.deepEqual(caps.authMethods, [
    "password",
    "app_password",
    "oauth2",
  ]);
  assert.deepEqual(caps.tlsModes, [
    "starttls",
    "implicit_tls",
  ]);
  assert.equal(caps.envelopeSender, true);
  assert.equal(caps.customFrom, true);
  assert.equal(caps.customReplyTo, true);
  assert.equal(caps.smtpUtf8, true);
  assert.equal(
    caps.maxMessageBytes,
    10_000_000,
  );
  assert.throws(
    () =>
      smtpCapabilities({
        maxMessageBytes: 0,
      }),
    /positive safe integer/,
  );
});

test("provider-neutral sender validates and delegates ordinary SMTP-style mail without Gmail/Graph coupling", async () => {
  const transport =
    new StubOutboundTransport();
  const sender =
    new ProviderNeutralOutboundSender(
      transport,
    );

  assert.equal(
    sender.capabilities().smtpUtf8,
    true,
  );
  const validation =
    await sender.validateConnection();
  assert.equal(validation.ok, true);
  assert.equal(
    validation.accountExternalId,
    "sender@example.test",
  );

  const result = await sender.sendMessage({
    from: {
      address: "sender@example.test",
      name: "Sender",
    },
    to: [
      {
        address: "user@example.test",
      },
    ],
    replyTo: [
      {
        address:
          "support@example.test",
      },
    ],
    envelopeFrom:
      "bounce@example.test",
    subject: "Hello",
    text: "Message body",
  });

  assert.deepEqual(result.accepted, [
    "user@example.test",
  ]);
  assert.equal(transport.sent.length, 1);
  assert.equal(
    transport.sent[0]?.envelopeFrom,
    "bounce@example.test",
  );
});

test("provider-neutral sender supports threaded replies through the transport contract", async () => {
  const transport =
    new StubOutboundTransport();
  const sender =
    new ProviderNeutralOutboundSender(
      transport,
    );

  const result = await sender.sendReply({
    from: {
      address: "sender@example.test",
    },
    to: [
      {
        address: "user@example.test",
      },
    ],
    subject: "Re: Hello",
    text: "Reply body",
    inReplyTo: "<root@example.test>",
    references: [
      "<root@example.test>",
    ],
    threadId: "thread-123",
  });

  assert.equal(
    result.messageId,
    "<reply@example.test>",
  );
  assert.equal(
    transport.replies[0]?.inReplyTo,
    "<root@example.test>",
  );
  assert.deepEqual(
    transport.replies[0]?.references,
    ["<root@example.test>"],
  );
});

test("provider-neutral sender rejects invalid recipients, empty content and missing reply identity before transport", async () => {
  const transport =
    new StubOutboundTransport();
  const sender =
    new ProviderNeutralOutboundSender(
      transport,
    );

  await assert.rejects(
    () =>
      sender.sendMessage({
        from: {
          address:
            "sender@example.test",
        },
        to: [],
        subject: "Invalid",
        text: "Body",
      }),
    /At least one To recipient/,
  );

  await assert.rejects(
    () =>
      sender.sendMessage({
        from: {
          address:
            "sender@example.test",
        },
        to: [
          {
            address:
              "user@example.test",
          },
        ],
        subject: "Invalid",
      }),
    /requires raw, text or html/,
  );

  await assert.rejects(
    () =>
      sender.sendReply({
        from: {
          address:
            "sender@example.test",
        },
        to: [
          {
            address:
              "user@example.test",
          },
        ],
        text: "Reply",
        inReplyTo: "   ",
      }),
    /inReplyTo is required/,
  );

  assert.equal(transport.sent.length, 0);
  assert.equal(transport.replies.length, 0);
});

test("provider-neutral sender owns transport lifecycle through close", async () => {
  const transport =
    new StubOutboundTransport();
  const sender =
    new ProviderNeutralOutboundSender(
      transport,
    );
  await sender.close();
  assert.equal(transport.closed, true);
});
