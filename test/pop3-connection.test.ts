import test from "node:test";
import assert from "node:assert/strict";

import {
  NodePop3Transport,
  Pop3AuthenticationError,
  Pop3ProtocolError,
  Pop3TlsError,
  resolvePop3ConnectionConfig,
  testPop3Connection,
  type Pop3CommandResult,
  type Pop3CommandSession,
  type Pop3CredentialStore,
  type Pop3SecretRecord,
  type Pop3SessionFactory,
  type ProviderConnectionContext,
  type ResolvedPop3ConnectionConfig,
} from "../src/index.js";

const context: ProviderConnectionContext = {
  tenantId: "tenant-1",
  accountId: "account-1",
};

class MemoryPop3CredentialStore
  implements Pop3CredentialStore
{
  constructor(
    private readonly value:
      | Pop3SecretRecord
      | null,
  ) {}

  async get(): Promise<Pop3SecretRecord | null> {
    return this.value;
  }
}

class FakePop3Session
  implements Pop3CommandSession
{
  readonly commands: string[] = [];
  closed = false;

  constructor(
    readonly encrypted: boolean,
    private readonly capabilities: readonly string[] = [
      "UIDL",
      "SASL XOAUTH2",
    ],
    private readonly rejectCommand?: string,
  ) {}

  async command(
    command: string,
    multiline = false,
    redactedLabel?: string,
  ): Promise<Pop3CommandResult> {
    this.commands.push(command);
    if (
      this.rejectCommand &&
      command.startsWith(this.rejectCommand)
    ) {
      throw new Pop3ProtocolError(
        redactedLabel ?? "COMMAND",
        "-ERR rejected",
      );
    }

    if (command === "CAPA") {
      return {
        statusLine: "+OK capabilities",
        lines: [...this.capabilities],
      };
    }
    if (command === "LIST") {
      return {
        statusLine: "+OK 1 messages",
        lines: ["1 42"],
      };
    }
    if (command === "UIDL") {
      return {
        statusLine: "+OK",
        lines: ["1 uidl-1"],
      };
    }
    if (command === "RETR 1") {
      return {
        statusLine: "+OK 42 octets",
        lines: [
          "Subject: Test",
          "",
          "Hello",
        ],
      };
    }
    if (multiline) {
      return {
        statusLine: "+OK",
        lines: [],
      };
    }
    return {
      statusLine: "+OK",
      lines: [],
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function factoryFor(
  session: FakePop3Session,
  seen: ResolvedPop3ConnectionConfig[],
): Pop3SessionFactory {
  return async (config) => {
    seen.push(config);
    return session;
  };
}

test("POP3 connection defaults to validated TLS settings and secure standard ports", () => {
  const implicit = resolvePop3ConnectionConfig({
    host: "pop.example.test",
    tlsMode: "implicit",
  });
  assert.equal(implicit.port, 995);
  assert.equal(
    implicit.rejectUnauthorized,
    true,
  );
  assert.equal(
    implicit.allowPasswordAuth,
    false,
  );

  const starttls = resolvePop3ConnectionConfig({
    host: "pop.example.test",
    tlsMode: "starttls",
  });
  assert.equal(starttls.port, 110);
  assert.equal(
    starttls.rejectUnauthorized,
    true,
  );
});

test("app-password authentication works over implicit TLS without exposing secret in errors", async () => {
  const session = new FakePop3Session(
    true,
    ["UIDL"],
  );
  const seen: ResolvedPop3ConnectionConfig[] =
    [];
  const store = new MemoryPop3CredentialStore({
    username: "user@example.test",
    authMode: "app_password",
    secret: "super-secret-app-password",
  });
  const transport = new NodePop3Transport(
    {
      host: "pop.example.test",
      tlsMode: "implicit",
    },
    store,
    factoryFor(session, seen),
  );

  const connected = await transport.connect(
    context,
  );
  assert.equal(
    connected.accountExternalId,
    "user@example.test",
  );
  assert.equal(seen[0]?.tlsMode, "implicit");
  assert.equal(
    seen[0]?.rejectUnauthorized,
    true,
  );
  assert.deepEqual(
    session.commands.slice(0, 3),
    [
      "CAPA",
      "USER user@example.test",
      "PASS super-secret-app-password",
    ],
  );

  const refs = await transport.list();
  assert.deepEqual(refs, [
    {
      sequenceNumber: 1,
      sizeBytes: 42,
      uidl: "uidl-1",
    },
  ]);
  const fetched = await transport.fetch(
    refs[0]!,
  );
  assert.match(
    Buffer.from(fetched.raw).toString(
      "utf8",
    ),
    /Subject: Test/,
  );

  await transport.close();
  assert.equal(session.closed, true);
});

test("normal password auth requires explicit opt-in", async () => {
  const secret = "normal-password";
  const store = new MemoryPop3CredentialStore({
    username: "user@example.test",
    authMode: "password",
    secret,
  });
  const session = new FakePop3Session(true);
  const transport = new NodePop3Transport(
    {
      host: "pop.example.test",
      tlsMode: "starttls",
    },
    store,
    factoryFor(session, []),
  );

  await assert.rejects(
    () => transport.connect(context),
    (error: unknown) =>
      error instanceof
        Pop3AuthenticationError &&
      !error.message.includes(secret),
  );
  assert.deepEqual(session.commands, []);
});

test("STARTTLS/password succeeds only when encrypted session and password policy are explicit", async () => {
  const session = new FakePop3Session(true);
  const seen: ResolvedPop3ConnectionConfig[] =
    [];
  const transport = new NodePop3Transport(
    {
      host: "pop.example.test",
      tlsMode: "starttls",
      allowPasswordAuth: true,
    },
    new MemoryPop3CredentialStore({
      username: "user@example.test",
      authMode: "password",
      secret: "password-secret",
    }),
    factoryFor(session, seen),
  );

  await transport.connect(context);
  assert.equal(seen[0]?.tlsMode, "starttls");
  assert.ok(
    session.commands.includes(
      "PASS password-secret",
    ),
  );
  await transport.close();
});

test("plaintext downgrade is refused even if a session factory returns successfully", async () => {
  const session = new FakePop3Session(false);
  const transport = new NodePop3Transport(
    {
      host: "pop.example.test",
      tlsMode: "starttls",
    },
    new MemoryPop3CredentialStore({
      username: "user@example.test",
      authMode: "app_password",
      secret: "secret",
    }),
    factoryFor(session, []),
  );

  await assert.rejects(
    () => transport.connect(context),
    (error: unknown) =>
      error instanceof Pop3TlsError &&
      /plaintext downgrade refused/.test(
        error.message,
      ),
  );
  assert.equal(session.closed, true);
});

test("XOAUTH2 is used only when the server advertises support", async () => {
  const accessToken = "oauth-access-token";
  const session = new FakePop3Session(
    true,
    ["UIDL", "SASL PLAIN XOAUTH2"],
  );
  const transport = new NodePop3Transport(
    {
      host: "pop.example.test",
      tlsMode: "implicit",
    },
    new MemoryPop3CredentialStore({
      username: "user@example.test",
      authMode: "oauth2",
      accessToken,
    }),
    factoryFor(session, []),
  );

  await transport.connect(context);
  const authCommand =
    session.commands.find((command) =>
      command.startsWith("AUTH XOAUTH2 "),
    );
  assert.ok(authCommand);
  const decoded = Buffer.from(
    authCommand!.slice(
      "AUTH XOAUTH2 ".length,
    ),
    "base64",
  ).toString("utf8");
  assert.match(
    decoded,
    /user=user@example\.test/,
  );
  assert.match(
    decoded,
    /auth=Bearer oauth-access-token/,
  );
  await transport.close();

  const unsupported =
    new NodePop3Transport(
      {
        host: "pop.example.test",
        tlsMode: "implicit",
      },
      new MemoryPop3CredentialStore({
        username: "user@example.test",
        authMode: "oauth2",
        accessToken,
      }),
      factoryFor(
        new FakePop3Session(true, [
          "SASL PLAIN",
        ]),
        [],
      ),
    );
  await assert.rejects(
    () => unsupported.connect(context),
    (error: unknown) =>
      error instanceof
        Pop3AuthenticationError &&
      /does not advertise XOAUTH2/.test(
        error.message,
      ) &&
      !error.message.includes(accessToken),
  );
});

test("authentication rejection is typed and redacts password material", async () => {
  const secret = "do-not-leak-this";
  const session = new FakePop3Session(
    true,
    ["UIDL"],
    "PASS ",
  );
  const transport = new NodePop3Transport(
    {
      host: "pop.example.test",
      tlsMode: "implicit",
    },
    new MemoryPop3CredentialStore({
      username: "user@example.test",
      authMode: "app_password",
      secret,
    }),
    factoryFor(session, []),
  );

  await assert.rejects(
    () => transport.connect(context),
    (error: unknown) =>
      error instanceof
        Pop3AuthenticationError &&
      error.code === "POP3_AUTH_FAILED" &&
      !error.message.includes(secret),
  );
  assert.equal(session.closed, true);
});

test("connection test service reports negotiated mode/capabilities and closes the session", async () => {
  const session = new FakePop3Session(
    true,
    ["UIDL", "SASL XOAUTH2"],
  );
  const result = await testPop3Connection(
    context,
    {
      host: "pop.example.test",
      tlsMode: "starttls",
    },
    new MemoryPop3CredentialStore({
      username: "user@example.test",
      authMode: "app_password",
      secret: "app-secret",
    }),
    factoryFor(session, []),
  );

  assert.deepEqual(result, {
    ok: true,
    accountExternalId:
      "user@example.test",
    tlsMode: "starttls",
    authMode: "app_password",
    serverCapabilities: [
      "UIDL",
      "SASL XOAUTH2",
    ],
  });
  assert.equal(session.closed, true);
  assert.ok(
    session.commands.includes("QUIT"),
  );
});
