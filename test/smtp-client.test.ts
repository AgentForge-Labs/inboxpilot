import test from "node:test";
import assert from "node:assert/strict";

import {
  CustomSmtpTransport,
  SmtpAuthenticationError,
  SmtpProtocolError,
  SmtpTlsError,
  resolveSmtpConnectionConfig,
  smtpDiagnosticCode,
  type ResolvedSmtpConnectionConfig,
  type SmtpCommandResult,
  type SmtpCommandSession,
  type SmtpCredentials,
} from "../src/index.js";

class FakeSmtpSession
  implements SmtpCommandSession
{
  commands: string[] = [];
  dataPayloads: Uint8Array[] = [];
  closed = false;
  upgraded = false;

  constructor(
    public encrypted: boolean,
    private readonly responder: (
      command: string,
      index: number,
    ) => SmtpCommandResult | Error,
  ) {}

  async command(
    command: string,
    _redactedLabel?: string,
  ): Promise<SmtpCommandResult> {
    this.commands.push(command);
    const response = this.responder(
      command,
      this.commands.length - 1,
    );
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  async data(
    raw: Uint8Array,
  ): Promise<SmtpCommandResult> {
    this.dataPayloads.push(raw);
    return {
      code: 250,
      lines: ["2.0.0 queued"],
    };
  }

  async upgradeToTls(
    _config: ResolvedSmtpConnectionConfig,
  ): Promise<void> {
    this.upgraded = true;
    this.encrypted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const appPassword: SmtpCredentials = {
  username: "sender@example.test",
  authMethod: "app_password",
  secret: "app-secret",
};

function implicitSession(): FakeSmtpSession {
  return new FakeSmtpSession(
    true,
    (command) => {
      if (command.startsWith("EHLO ")) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "AUTH PLAIN LOGIN XOAUTH2",
            "SIZE 10485760",
            "SMTPUTF8",
          ],
        };
      }
      if (
        command.startsWith(
          "AUTH PLAIN ",
        )
      ) {
        return {
          code: 235,
          lines: [
            "2.7.0 authentication successful",
          ],
        };
      }
      if (command === "QUIT") {
        return {
          code: 221,
          lines: ["bye"],
        };
      }
      if (
        command.startsWith(
          "MAIL FROM:",
        ) ||
        command.startsWith(
          "RCPT TO:",
        )
      ) {
        return {
          code: 250,
          lines: ["ok"],
        };
      }
      throw new Error(
        "Unexpected command: " +
          command,
      );
    },
  );
}

test("SMTP connection defaults choose standard ports and certificate validation stays enabled", () => {
  const implicit =
    resolveSmtpConnectionConfig({
      host: "smtp.example.test",
      tlsMode: "implicit_tls",
    });
  assert.equal(implicit.port, 465);
  assert.equal(
    implicit.rejectUnauthorized,
    true,
  );

  const starttls =
    resolveSmtpConnectionConfig({
      host: "smtp.example.test",
      tlsMode: "starttls",
    });
  assert.equal(starttls.port, 587);
  assert.equal(
    starttls.rejectUnauthorized,
    true,
  );

  const plain =
    resolveSmtpConnectionConfig({
      host: "smtp.example.test",
      tlsMode: "none",
    });
  assert.equal(plain.port, 25);
});

test("implicit TLS app-password authentication discovers SMTP capabilities", async () => {
  const session = implicitSession();
  const transport =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
      },
      appPassword,
      async () => session,
    );

  const validation =
    await transport.validateConnection();

  assert.equal(validation.ok, true);
  assert.equal(
    validation.accountExternalId,
    "sender@example.test",
  );
  assert.deepEqual(
    validation.capabilities.authMethods,
    [
      "password",
      "app_password",
      "oauth2",
    ],
  );
  assert.deepEqual(
    validation.capabilities.tlsModes,
    ["implicit_tls"],
  );
  assert.equal(
    validation.capabilities.smtpUtf8,
    true,
  );
  assert.equal(
    validation.capabilities
      .maxMessageBytes,
    10_485_760,
  );
  assert.equal(session.encrypted, true);
  assert.match(
    session.commands[1] ?? "",
    /^AUTH PLAIN /,
  );
});

test("STARTTLS is required, upgraded before auth, and EHLO is repeated after encryption", async () => {
  const session = new FakeSmtpSession(
    false,
    (command, index) => {
      if (
        index === 0 &&
        command.startsWith("EHLO ")
      ) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "STARTTLS",
          ],
        };
      }
      if (command === "STARTTLS") {
        return {
          code: 220,
          lines: [
            "2.0.0 ready to start TLS",
          ],
        };
      }
      if (
        index === 2 &&
        command.startsWith("EHLO ")
      ) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "AUTH PLAIN",
          ],
        };
      }
      if (
        command.startsWith(
          "AUTH PLAIN ",
        )
      ) {
        return {
          code: 235,
          lines: ["authenticated"],
        };
      }
      throw new Error(
        "Unexpected command: " +
          command,
      );
    },
  );

  const transport =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "starttls",
      },
      appPassword,
      async () => session,
    );
  await transport.validateConnection();

  assert.equal(session.upgraded, true);
  assert.equal(session.encrypted, true);
  assert.match(
    session.commands[0] ?? "",
    /^EHLO /,
  );
  assert.equal(
    session.commands[1],
    "STARTTLS",
  );
  assert.match(
    session.commands[2] ?? "",
    /^EHLO /,
  );
  assert.match(
    session.commands[3] ?? "",
    /^AUTH PLAIN /,
  );
});

test("STARTTLS never silently downgrades when the server does not advertise it", async () => {
  const session = new FakeSmtpSession(
    false,
    (command) => {
      if (command.startsWith("EHLO ")) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "AUTH PLAIN",
          ],
        };
      }
      throw new Error(
        "Unexpected command",
      );
    },
  );

  const transport =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "starttls",
      },
      appPassword,
      async () => session,
    );

  await assert.rejects(
    () =>
      transport.validateConnection(),
    (error: unknown) =>
      error instanceof SmtpTlsError &&
      error.code === "SMTP_TLS_FAILED",
  );
  assert.equal(session.closed, true);
  assert.equal(
    session.commands.some((command) =>
      command.startsWith("AUTH "),
    ),
    false,
  );
});

test("plaintext SMTP auth is denied by default and requires an explicit unsafe opt-in", async () => {
  assert.throws(
    () =>
      new CustomSmtpTransport(
        {
          host: "smtp.example.test",
          tlsMode: "none",
        },
        appPassword,
        async () => implicitSession(),
      ),
    (error: unknown) =>
      error instanceof
        SmtpAuthenticationError &&
      /Plaintext SMTP authentication is disabled/.test(
        error.message,
      ),
  );

  const session = new FakeSmtpSession(
    false,
    (command) => {
      if (command.startsWith("EHLO ")) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "AUTH PLAIN",
          ],
        };
      }
      if (
        command.startsWith(
          "AUTH PLAIN ",
        )
      ) {
        return {
          code: 235,
          lines: ["authenticated"],
        };
      }
      throw new Error(
        "Unexpected command",
      );
    },
  );
  const unsafe =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "none",
        allowPlaintextAuth: true,
      },
      appPassword,
      async () => session,
    );
  const validation =
    await unsafe.validateConnection();
  assert.equal(validation.ok, true);
  assert.deepEqual(
    validation.capabilities.tlsModes,
    ["none"],
  );
});

test("OAuth2 uses XOAUTH2 only when advertised and never exposes the token in auth errors", async () => {
  const token =
    "oauth-super-secret-token";
  const session = new FakeSmtpSession(
    true,
    (command) => {
      if (command.startsWith("EHLO ")) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "AUTH XOAUTH2",
          ],
        };
      }
      if (
        command.startsWith(
          "AUTH XOAUTH2 ",
        )
      ) {
        return new SmtpProtocolError(
          "AUTH XOAUTH2",
          535,
          "5.7.8 credentials rejected",
        );
      }
      throw new Error(
        "Unexpected command",
      );
    },
  );

  const transport =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
      },
      {
        username:
          "sender@example.test",
        authMethod: "oauth2",
        accessToken: token,
      },
      async () => session,
    );

  await assert.rejects(
    () =>
      transport.validateConnection(),
    (error: unknown) => {
      assert.ok(
        error instanceof
          SmtpAuthenticationError,
      );
      assert.equal(
        error.message.includes(token),
        false,
      );
      assert.equal(
        smtpDiagnosticCode(error),
        "SMTP_AUTH_FAILED",
      );
      return true;
    },
  );
});

test("raw RFC822 send uses envelope sender, recipient commands, SIZE/SMTPUTF8 capabilities and DATA", async () => {
  const session = implicitSession();
  const transport =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
      },
      appPassword,
      async () => session,
    );

  const raw = Buffer.from(
    [
      "Message-ID: <m1@example.test>",
      "From: Sender <sender@example.test>",
      "To: User <user@example.test>",
      "Subject: Hello",
      "",
      "Body",
      "",
    ].join("\r\n"),
  );
  const result =
    await transport.sendMessage({
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
      cc: [
        {
          address:
            "copy@example.test",
        },
      ],
      envelopeFrom:
        "bounce@example.test",
      subject: "Hello",
      raw,
    });

  assert.deepEqual(result.accepted, [
    "user@example.test",
    "copy@example.test",
  ]);
  assert.deepEqual(result.rejected, []);
  assert.equal(
    result.messageId,
    "<m1@example.test>",
  );
  assert.equal(
    session.dataPayloads.length,
    1,
  );
  assert.ok(
    session.commands.some(
      (command) =>
        command.startsWith(
          "MAIL FROM:<bounce@example.test> SIZE=",
        ),
    ),
  );
  assert.ok(
    session.commands.includes(
      "RCPT TO:<user@example.test>",
    ),
  );
});

test("SMTP authentication diagnostics redact app passwords and structured mail waits for the MIME composer", async () => {
  const secret =
    "never-leak-this-password";
  const session = new FakeSmtpSession(
    true,
    (command) => {
      if (command.startsWith("EHLO ")) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "AUTH PLAIN",
          ],
        };
      }
      if (
        command.startsWith(
          "AUTH PLAIN ",
        )
      ) {
        return new SmtpProtocolError(
          "AUTH PLAIN",
          535,
          "5.7.8 authentication rejected",
        );
      }
      throw new Error(
        "Unexpected command",
      );
    },
  );

  const transport =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
      },
      {
        username:
          "sender@example.test",
        authMethod: "password",
        secret,
      },
      async () => session,
    );

  await assert.rejects(
    () =>
      transport.validateConnection(),
    (error: unknown) => {
      assert.ok(
        error instanceof
          SmtpAuthenticationError,
      );
      assert.equal(
        error.message.includes(secret),
        false,
      );
      return true;
    },
  );

  const sending =
    new CustomSmtpTransport(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
      },
      appPassword,
      async () => implicitSession(),
    );
  await assert.rejects(
    () =>
      sending.sendMessage({
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
        subject: "Structured",
        text: "Body",
      }),
    /raw RFC822 content/,
  );
});
