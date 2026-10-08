import { connect as connectNet, type Socket } from "node:net";
import {
  connect as connectTls,
  type TLSSocket,
} from "node:tls";

import type { ProviderConnectionContext } from "../provider-adapter.js";
import type {
  Pop3AuthMode,
  Pop3ConnectionConfig,
  Pop3ConnectionTestResult,
  Pop3CredentialStore,
  Pop3FetchedMessage,
  Pop3MessageRef,
  Pop3SecretRecord,
  Pop3TlsMode,
  Pop3Transport,
  Pop3TransportConnectResult,
  ResolvedPop3ConnectionConfig,
} from "./pop3-types.js";

export class Pop3ConnectionError extends Error {
  readonly code: string = "POP3_CONNECTION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "Pop3ConnectionError";
  }
}

export class Pop3TlsError extends Pop3ConnectionError {
  override readonly code = "POP3_TLS_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "Pop3TlsError";
  }
}

export class Pop3AuthenticationError extends Error {
  readonly code = "POP3_AUTH_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "Pop3AuthenticationError";
  }
}

export class Pop3ProtocolError extends Error {
  readonly code = "POP3_PROTOCOL_ERROR";

  constructor(
    readonly command: string,
    readonly serverResponse: string,
  ) {
    super(`POP3 command ${command} failed: ${serverResponse}`);
    this.name = "Pop3ProtocolError";
  }
}

export interface Pop3CommandResult {
  statusLine: string;
  lines: readonly string[];
}

export interface Pop3CommandSession {
  readonly encrypted: boolean;
  command(
    command: string,
    multiline?: boolean,
    redactedLabel?: string,
  ): Promise<Pop3CommandResult>;
  close(): Promise<void>;
}

export type Pop3SessionFactory = (
  config: ResolvedPop3ConnectionConfig,
) => Promise<Pop3CommandSession>;

export function resolvePop3ConnectionConfig(
  config: Pop3ConnectionConfig,
): ResolvedPop3ConnectionConfig {
  const host = config.host.trim();
  if (!host) throw new TypeError("POP3 host is required");

  const port =
    config.port ??
    (config.tlsMode === "implicit" ? 995 : 110);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("POP3 port must be between 1 and 65535");
  }

  const connectTimeoutMs = config.connectTimeoutMs ?? 10_000;
  const commandTimeoutMs = config.commandTimeoutMs ?? 10_000;
  if (connectTimeoutMs < 1 || commandTimeoutMs < 1) {
    throw new RangeError("POP3 timeouts must be positive");
  }

  return {
    host,
    port,
    tlsMode: config.tlsMode,
    allowPasswordAuth: config.allowPasswordAuth ?? false,
    rejectUnauthorized: config.rejectUnauthorized ?? true,
    connectTimeoutMs,
    commandTimeoutMs,
  };
}

export function assertPop3AuthPolicy(
  credentials: Pop3SecretRecord,
  config: ResolvedPop3ConnectionConfig,
): void {
  if (!credentials.username.trim()) {
    throw new Pop3AuthenticationError("POP3 username is required");
  }
  if (
    credentials.authMode === "oauth2" &&
    !credentials.accessToken?.trim()
  ) {
    throw new Pop3AuthenticationError(
      "POP3 OAuth2 credentials require an access token",
    );
  }
  if (
    (credentials.authMode === "password" ||
      credentials.authMode === "app_password") &&
    !credentials.secret
  ) {
    throw new Pop3AuthenticationError(
      "POP3 password-based credentials require a secret",
    );
  }
  if (
    credentials.authMode === "password" &&
    !config.allowPasswordAuth
  ) {
    throw new Pop3AuthenticationError(
      "Normal POP3 password authentication is disabled for this account",
    );
  }
}

type Pop3Socket = Socket | TLSSocket;

class NodePop3CommandSession implements Pop3CommandSession {
  private buffer = Buffer.alloc(0);
  private _encrypted: boolean;

  constructor(
    private socket: Pop3Socket,
    private readonly commandTimeoutMs: number,
    encrypted: boolean,
  ) {
    this._encrypted = encrypted;
  }

  get encrypted(): boolean {
    return this._encrypted;
  }

  async readGreeting(): Promise<void> {
    const greeting = await this.readLine();
    if (!greeting.startsWith("+OK")) {
      throw new Pop3ProtocolError(
        "GREETING",
        greeting,
      );
    }
  }

  async upgradeToTls(
    config: ResolvedPop3ConnectionConfig,
  ): Promise<void> {
    if (this._encrypted) return;
    if (this.buffer.length > 0) {
      throw new Pop3TlsError(
        "POP3 STARTTLS cannot proceed with unread plaintext data",
      );
    }

    const plainSocket = this.socket as Socket;
    const tlsSocket = connectTls({
      socket: plainSocket,
      servername: config.host,
      rejectUnauthorized: config.rejectUnauthorized,
    });
    await waitForSocketEvent(
      tlsSocket,
      "secureConnect",
      config.connectTimeoutMs,
      "POP3 STARTTLS handshake timed out",
    );
    this.socket = tlsSocket;
    this._encrypted = true;
  }

  async command(
    command: string,
    multiline = false,
    redactedLabel?: string,
  ): Promise<Pop3CommandResult> {
    const label =
      redactedLabel ??
      command.split(/\s+/, 1)[0] ??
      "COMMAND";
    this.socket.write(command + "\r\n");

    const statusLine = await this.readLine();
    if (!statusLine.startsWith("+OK")) {
      throw new Pop3ProtocolError(
        label,
        statusLine,
      );
    }

    if (!multiline) {
      return { statusLine, lines: [] };
    }

    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line === ".") break;
      lines.push(
        line.startsWith("..") ? line.slice(1) : line,
      );
    }
    return { statusLine, lines };
  }

  async close(): Promise<void> {
    this.socket.end();
    this.socket.destroy();
  }

  private extractLine(): string | undefined {
    const marker = this.buffer.indexOf("\r\n");
    if (marker < 0) return undefined;
    const line = this.buffer
      .subarray(0, marker)
      .toString("utf8");
    this.buffer = this.buffer.subarray(marker + 2);
    return line;
  }

  private async readLine(): Promise<string> {
    const existing = this.extractLine();
    if (existing !== undefined) return existing;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Pop3ConnectionError(
            "POP3 command timed out",
          ),
        );
      }, this.commandTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeListener("data", onData);
        this.socket.removeListener("error", onError);
        this.socket.removeListener("close", onClose);
      };

      const onData = (chunk: Buffer) => {
        this.buffer = Buffer.concat([
          this.buffer,
          chunk,
        ]);
        const line = this.extractLine();
        if (line !== undefined) {
          cleanup();
          resolve(line);
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(
          new Pop3ConnectionError(
            `POP3 socket error: ${error.message}`,
          ),
        );
      };
      const onClose = () => {
        cleanup();
        reject(
          new Pop3ConnectionError(
            "POP3 socket closed unexpectedly",
          ),
        );
      };

      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }
}

function waitForSocketEvent(
  socket: Pop3Socket,
  event: "connect" | "secureConnect",
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Pop3ConnectionError(timeoutMessage));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener(event, onReady);
      socket.removeListener("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(
        new Pop3ConnectionError(
          `POP3 connection failed: ${error.message}`,
        ),
      );
    };

    socket.once(event, onReady);
    socket.once("error", onError);
  });
}

export async function createNodePop3Session(
  config: ResolvedPop3ConnectionConfig,
): Promise<Pop3CommandSession> {
  let session: NodePop3CommandSession | undefined;
  try {
    if (config.tlsMode === "implicit") {
      const socket = connectTls({
        host: config.host,
        port: config.port,
        servername: config.host,
        rejectUnauthorized: config.rejectUnauthorized,
      });
      await waitForSocketEvent(
        socket,
        "secureConnect",
        config.connectTimeoutMs,
        "POP3 TLS connection timed out",
      );
      session = new NodePop3CommandSession(
        socket,
        config.commandTimeoutMs,
        true,
      );
      await session.readGreeting();
      return session;
    }

    const socket = connectNet({
      host: config.host,
      port: config.port,
    });
    await waitForSocketEvent(
      socket,
      "connect",
      config.connectTimeoutMs,
      "POP3 STARTTLS connection timed out",
    );
    session = new NodePop3CommandSession(
      socket,
      config.commandTimeoutMs,
      false,
    );
    await session.readGreeting();
    await session.command("STLS", false, "STLS");
    await session.upgradeToTls(config);
    if (!session.encrypted) {
      throw new Pop3TlsError(
        "POP3 STARTTLS did not produce an encrypted session",
      );
    }
    return session;
  } catch (error) {
    await session?.close().catch(() => undefined);
    if (
      error instanceof Pop3ConnectionError ||
      error instanceof Pop3ProtocolError
    ) {
      throw error;
    }
    const message =
      error instanceof Error
        ? error.message
        : "unknown error";
    throw new Pop3ConnectionError(
      `POP3 connection failed: ${message}`,
    );
  }
}

async function readCapabilities(
  session: Pop3CommandSession,
): Promise<string[]> {
  try {
    const result = await session.command(
      "CAPA",
      true,
      "CAPA",
    );
    return result.lines
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (error instanceof Pop3ProtocolError) {
      return [];
    }
    throw error;
  }
}

function supportsXoauth2(
  capabilities: readonly string[],
): boolean {
  return capabilities.some((line) => {
    const [name, ...values] = line
      .toUpperCase()
      .split(/\s+/);
    return (
      name === "SASL" &&
      values.includes("XOAUTH2")
    );
  });
}

async function authenticate(
  session: Pop3CommandSession,
  credentials: Pop3SecretRecord,
  capabilities: readonly string[],
): Promise<void> {
  try {
    if (credentials.authMode === "oauth2") {
      if (!supportsXoauth2(capabilities)) {
        throw new Pop3AuthenticationError(
          "POP3 server does not advertise XOAUTH2 support",
        );
      }
      const sasl = Buffer.from(
        `user=${credentials.username}\x01auth=Bearer ${credentials.accessToken!}\x01\x01`,
        "utf8",
      ).toString("base64");
      await session.command(
        `AUTH XOAUTH2 ${sasl}`,
        false,
        "AUTH XOAUTH2",
      );
      return;
    }

    await session.command(
      `USER ${credentials.username}`,
      false,
      "USER",
    );
    await session.command(
      `PASS ${credentials.secret!}`,
      false,
      "PASS <redacted>",
    );
  } catch (error) {
    if (error instanceof Pop3AuthenticationError) {
      throw error;
    }
    throw new Pop3AuthenticationError(
      "POP3 authentication was rejected",
    );
  }
}

function parseListLine(
  line: string,
): Pop3MessageRef | undefined {
  const match = /^(\d+)\s+(\d+)$/.exec(line.trim());
  if (!match) return undefined;
  const sequenceNumber = Number(match[1]);
  const sizeBytes = Number(match[2]);
  if (
    !Number.isInteger(sequenceNumber) ||
    sequenceNumber < 1 ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 0
  ) {
    return undefined;
  }
  return { sequenceNumber, sizeBytes };
}

function parseUidlLines(
  lines: readonly string[],
): Map<number, string> {
  const uidls = new Map<number, string>();
  for (const line of lines) {
    const match = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const sequenceNumber = Number(match[1]);
    const uidl = match[2]!.trim();
    if (
      Number.isInteger(sequenceNumber) &&
      sequenceNumber > 0 &&
      uidl
    ) {
      uidls.set(sequenceNumber, uidl);
    }
  }
  return uidls;
}

export class NodePop3Transport implements Pop3Transport {
  private session: Pop3CommandSession | undefined;
  private serverCaps: readonly string[] = [];
  private authMode: Pop3AuthMode | undefined;
  private accountExternalId: string | undefined;

  constructor(
    private readonly config: Pop3ConnectionConfig,
    private readonly credentialStore: Pop3CredentialStore,
    private readonly sessionFactory: Pop3SessionFactory =
      createNodePop3Session,
  ) {}

  async connect(
    context: ProviderConnectionContext,
  ): Promise<Pop3TransportConnectResult> {
    const resolved =
      resolvePop3ConnectionConfig(this.config);
    const credentials =
      await this.credentialStore.get(context);
    if (!credentials) {
      throw new Pop3AuthenticationError(
        "POP3 credentials are not configured",
      );
    }
    assertPop3AuthPolicy(
      credentials,
      resolved,
    );

    const session =
      await this.sessionFactory(resolved);
    if (!session.encrypted) {
      await session.close().catch(() => undefined);
      throw new Pop3TlsError(
        `POP3 ${resolved.tlsMode} connection is not encrypted; plaintext downgrade refused`,
      );
    }

    try {
      const capabilities =
        await readCapabilities(session);
      await authenticate(
        session,
        credentials,
        capabilities,
      );
      this.session = session;
      this.serverCaps = capabilities;
      this.authMode = credentials.authMode;
      this.accountExternalId =
        credentials.username;
      return {
        accountExternalId:
          credentials.username,
      };
    } catch (error) {
      await session.close().catch(() => undefined);
      throw error;
    }
  }

  serverCapabilities(): readonly string[] {
    return this.serverCaps;
  }

  connectionTestResult(
    tlsMode: Pop3TlsMode,
  ): Pop3ConnectionTestResult {
    if (
      !this.accountExternalId ||
      !this.authMode
    ) {
      throw new Pop3ConnectionError(
        "POP3 transport is not connected",
      );
    }
    return {
      ok: true,
      accountExternalId:
        this.accountExternalId,
      tlsMode,
      authMode: this.authMode,
      serverCapabilities:
        this.serverCaps,
    };
  }

  async list(): Promise<readonly Pop3MessageRef[]> {
    const session = this.requireSession();
    const list = await session.command(
      "LIST",
      true,
      "LIST",
    );
    const refs = list.lines
      .map(parseListLine)
      .filter(
        (ref): ref is Pop3MessageRef =>
          ref !== undefined,
      );

    let uidls = new Map<number, string>();
    try {
      const uidl = await session.command(
        "UIDL",
        true,
        "UIDL",
      );
      uidls = parseUidlLines(uidl.lines);
    } catch (error) {
      if (!(error instanceof Pop3ProtocolError)) {
        throw error;
      }
    }

    return refs.map((ref) => ({
      ...ref,
      ...(uidls.get(ref.sequenceNumber)
        ? {
            uidl: uidls.get(
              ref.sequenceNumber,
            )!,
          }
        : {}),
    }));
  }

  async fetch(
    ref: Pop3MessageRef,
  ): Promise<Pop3FetchedMessage> {
    const result =
      await this.requireSession().command(
        `RETR ${ref.sequenceNumber}`,
        true,
        "RETR",
      );
    return {
      ref,
      raw: Buffer.from(
        result.lines.join("\r\n") +
          "\r\n",
        "utf8",
      ),
    };
  }

  async deleteOnServer(
    ref: Pop3MessageRef,
  ): Promise<void> {
    await this.requireSession().command(
      `DELE ${ref.sequenceNumber}`,
      false,
      "DELE",
    );
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.serverCaps = [];
    this.authMode = undefined;
    this.accountExternalId = undefined;
    if (!session) return;
    try {
      await session.command(
        "QUIT",
        false,
        "QUIT",
      );
    } catch {
      // The connection is being closed regardless; no secret-bearing data
      // from an error is logged or rethrown here.
    } finally {
      await session.close();
    }
  }

  private requireSession(): Pop3CommandSession {
    if (!this.session) {
      throw new Pop3ConnectionError(
        "POP3 transport is not connected",
      );
    }
    return this.session;
  }
}

export async function testPop3Connection(
  context: ProviderConnectionContext,
  config: Pop3ConnectionConfig,
  credentialStore: Pop3CredentialStore,
  sessionFactory?: Pop3SessionFactory,
): Promise<Pop3ConnectionTestResult> {
  const transport = new NodePop3Transport(
    config,
    credentialStore,
    sessionFactory,
  );
  const resolved =
    resolvePop3ConnectionConfig(config);
  await transport.connect(context);
  try {
    return transport.connectionTestResult(
      resolved.tlsMode,
    );
  } finally {
    await transport.close();
  }
}
