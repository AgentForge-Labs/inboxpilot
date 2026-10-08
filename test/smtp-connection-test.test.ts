import test from "node:test";
import assert from "node:assert/strict";

import {
  SmtpAuthenticationError,
  SmtpConnectionError,
  testSmtpConnection,
  type ResolvedSmtpConnectionConfig,
  type SmtpCommandResult,
  type SmtpCommandSession,
} from "../src/index.js";

class ConnectionTestSession
  implements SmtpCommandSession
{
  commands: string[] = [];
  dataCalls = 0;
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
  ): Promise<SmtpCommandResult> {
    this.commands.push(command);
    const result = this.responder(
      command,
      this.commands.length - 1,
    );
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }

  async data(): Promise<SmtpCommandResult> {
    this.dataCalls += 1;
    return {
      code: 250,
      lines: ["queued"],
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

function successfulImplicitSession():
  ConnectionTestSession {
  return new ConnectionTestSession(
    true,
    (command) => {
      if (command.startsWith("EHLO ")) {
        return {
          code: 250,
          lines: [
            "smtp.example.test",
            "AUTH PLAIN LOGIN XOAUTH2",
            "SIZE 52428800",
            "SMTPUTF8",
            "8BITMIME",
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
      if (command === "QUIT") {
        return {
          code: 221,
          lines: ["bye"],
        };
      }
      throw new Error(
        "Unexpected SMTP command: " +
          command,
      );
    },
  );
}

test("SMTP connection test returns connect/TLS/auth and EHLO capability details without sending email", async () => {
  const session =
    successfulImplicitSession();

  const result =
    await testSmtpConnection(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
      },
      {
        username:
          "sender@example.test",
        authMethod: "app_password",
        secret: "secret",
      },
      async () => session,
    );

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    connect: "passed",
    tls: "passed",
    auth: "passed",
  });
  assert.equal(
    result.certificateStatus,
    "validated",
  );
  assert.equal(result.encrypted, true);
  assert.equal(
    result.smtpUtf8,
    true,
  );
  assert.equal(
    result.maxMessageBytes,
    52_428_800,
  );
  assert.deepEqual(
    result.advertisedAuthMechanisms,
    ["LOGIN", "PLAIN", "XOAUTH2"],
  );
  assert.ok(
    result.advertisedEhloCapabilities.includes(
      "8BITMIME",
    ),
  );
  assert.equal(
    result.sentTestMessage,
    false,
  );
  assert.equal(session.dataCalls, 0);
  assert.equal(
    session.commands.some(
      (command) =>
        command.startsWith(
          "MAIL FROM:",
        ) ||
        command.startsWith(
          "RCPT TO:",
        ) ||
        command === "DATA",
    ),
    false,
  );
  assert.equal(session.closed, true);
});

test("STARTTLS connection test reports validated encryption after upgrade and repeats EHLO", async () => {
  const session =
    new ConnectionTestSession(
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
            lines: ["ready"],
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
              "SIZE 1000000",
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
        if (command === "QUIT") {
          return {
            code: 221,
            lines: ["bye"],
          };
        }
        throw new Error(
          "Unexpected SMTP command",
        );
      },
    );

  const result =
    await testSmtpConnection(
      {
        host: "smtp.example.test",
        tlsMode: "starttls",
      },
      {
        username:
          "sender@example.test",
        authMethod: "password",
        secret: "secret",
      },
      async () => session,
    );

  assert.equal(result.ok, true);
  assert.equal(session.upgraded, true);
  assert.equal(
    result.certificateStatus,
    "validated",
  );
  assert.equal(result.encrypted, true);
  assert.deepEqual(
    result.advertisedEhloCapabilities,
    ["AUTH", "SIZE", "SMTP.EXAMPLE.TEST"],
  );
});

test("SMTP connection test returns actionable auth failure without leaking credentials", async () => {
  const password =
    "do-not-leak-this-secret";
  const session =
    new ConnectionTestSession(
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
          return new SmtpAuthenticationError(
            "SMTP authentication was rejected",
          );
        }
        throw new Error(
          "Unexpected SMTP command",
        );
      },
    );

  const result =
    await testSmtpConnection(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
      },
      {
        username:
          "sender@example.test",
        authMethod: "password",
        secret: password,
      },
      async () => session,
    );

  assert.equal(result.ok, false);
  assert.deepEqual(result.checks, {
    connect: "passed",
    tls: "passed",
    auth: "failed",
  });
  assert.equal(
    result.error?.code,
    "SMTP_AUTH_FAILED",
  );
  assert.match(
    result.error?.action ?? "",
    /username|password|OAuth2/i,
  );
  assert.equal(
    JSON.stringify(result).includes(
      password,
    ),
    false,
  );
  assert.equal(result.sentTestMessage, false);
});

test("SMTP connection test converts connect/DNS failure into actionable safe diagnostics", async () => {
  const result =
    await testSmtpConnection(
      {
        host:
          "missing.example.test",
        tlsMode: "implicit_tls",
      },
      {
        username:
          "sender@example.test",
        authMethod: "app_password",
        secret: "secret",
      },
      async () => {
        throw new SmtpConnectionError(
          "getaddrinfo ENOTFOUND missing.example.test",
        );
      },
    );

  assert.equal(result.ok, false);
  assert.equal(
    result.checks.connect,
    "failed",
  );
  assert.equal(
    result.checks.auth,
    "not_run",
  );
  assert.equal(
    result.certificateStatus,
    "not_validated",
  );
  assert.equal(
    result.error?.code,
    "SMTP_CONNECTION_FAILED",
  );
  assert.match(
    result.error?.action ?? "",
    /hostname\/DNS|port|firewall/i,
  );
  assert.equal(result.sentTestMessage, false);
});

test("SMTP connection test makes disabled certificate validation visible", async () => {
  const session =
    successfulImplicitSession();
  const result =
    await testSmtpConnection(
      {
        host: "smtp.example.test",
        tlsMode: "implicit_tls",
        rejectUnauthorized: false,
      },
      {
        username:
          "sender@example.test",
        authMethod: "app_password",
        secret: "secret",
      },
      async () => session,
    );

  assert.equal(result.ok, true);
  assert.equal(
    result.certificateStatus,
    "validation_disabled",
  );
});
