import { randomUUID } from "node:crypto";
import {
  connect as connectNet,
  type Socket,
} from "node:net";
import {
  connect as connectTls,
  type TLSSocket,
} from "node:tls";

import type {
  OutboundConnectionValidation,
  OutboundMessageInput,
  OutboundReplyInput,
  OutboundSendResult,
  OutboundTransport,
} from "../../outbound/outbound-transport.js";
import {
  smtpCapabilities,
  type ResolvedSmtpConnectionConfig,
  type SmtpAccountCapabilities,
  type SmtpAuthMethod,
  type SmtpConnectionConfig,
  type SmtpCredentials,
} from "./smtp-types.js";

export class SmtpConnectionError extends Error {
  readonly code: string =
    "SMTP_CONNECTION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "SmtpConnectionError";
  }
}

export class SmtpTlsError
  extends SmtpConnectionError
{
  override readonly code = "SMTP_TLS_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "SmtpTlsError";
  }
}

export class SmtpAuthenticationError
  extends Error
{
  readonly code = "SMTP_AUTH_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "SmtpAuthenticationError";
  }
}

export class SmtpProtocolError extends Error {
  readonly code = "SMTP_PROTOCOL_ERROR";

  constructor(
    readonly command: string,
    readonly statusCode: number,
    readonly serverResponse: string,
  ) {
    super(
      "SMTP command " +
        command +
        " failed with " +
        statusCode +
        ": " +
        serverResponse,
    );
    this.name = "SmtpProtocolError";
  }
}

export interface SmtpCommandResult {
  code: number;
  lines: readonly string[];
}

export interface SmtpCommandSession {
  readonly encrypted: boolean;
  command(
    command: string,
    redactedLabel?: string,
  ): Promise<SmtpCommandResult>;
  data(raw: Uint8Array): Promise<SmtpCommandResult>;
  upgradeToTls(
    config: ResolvedSmtpConnectionConfig,
  ): Promise<void>;
  close(): Promise<void>;
}

export type SmtpSessionFactory = (
  config: ResolvedSmtpConnectionConfig,
) => Promise<SmtpCommandSession>;

export function resolveSmtpConnectionConfig(
  config: SmtpConnectionConfig,
): ResolvedSmtpConnectionConfig {
  const host = config.host.trim();
  if (!host) {
    throw new TypeError(
      "SMTP host is required",
    );
  }

  const port =
    config.port ??
    (config.tlsMode === "implicit_tls"
      ? 465
      : config.tlsMode === "starttls"
        ? 587
        : 25);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new RangeError(
      "SMTP port must be between 1 and 65535",
    );
  }

  const connectTimeoutMs =
    config.connectTimeoutMs ?? 10_000;
  const commandTimeoutMs =
    config.commandTimeoutMs ?? 10_000;
  if (
    connectTimeoutMs < 1 ||
    commandTimeoutMs < 1
  ) {
    throw new RangeError(
      "SMTP timeouts must be positive",
    );
  }

  const ehloName =
    config.ehloName?.trim() ||
    "inboxpilot.local";

  return {
    host,
    port,
    tlsMode: config.tlsMode,
    rejectUnauthorized:
      config.rejectUnauthorized ?? true,
    allowPlaintextAuth:
      config.allowPlaintextAuth ?? false,
    connectTimeoutMs,
    commandTimeoutMs,
    ehloName,
  };
}

export function assertSmtpAuthPolicy(
  credentials: SmtpCredentials,
  config: ResolvedSmtpConnectionConfig,
): void {
  if (!credentials.username.trim()) {
    throw new SmtpAuthenticationError(
      "SMTP username is required",
    );
  }

  if (
    credentials.authMethod === "oauth2"
  ) {
    if (!credentials.accessToken?.trim()) {
      throw new SmtpAuthenticationError(
        "SMTP OAuth2 credentials require an access token",
      );
    }
  } else if (!credentials.secret) {
    throw new SmtpAuthenticationError(
      "SMTP password-based credentials require a secret",
    );
  }

  if (
    config.tlsMode === "none" &&
    !config.allowPlaintextAuth
  ) {
    throw new SmtpAuthenticationError(
      "Plaintext SMTP authentication is disabled; enable the advanced unsafe setting explicitly to allow it",
    );
  }
}

type SmtpSocket = Socket | TLSSocket;

class NodeSmtpCommandSession
  implements SmtpCommandSession
{
  private buffer = Buffer.alloc(0);
  private _encrypted: boolean;

  constructor(
    private socket: SmtpSocket,
    private readonly commandTimeoutMs: number,
    encrypted: boolean,
  ) {
    this._encrypted = encrypted;
  }

  get encrypted(): boolean {
    return this._encrypted;
  }

  async readGreeting(): Promise<void> {
    const result = await this.readReply();
    if (result.code !== 220) {
      throw new SmtpProtocolError(
        "GREETING",
        result.code,
        result.lines.join(" "),
      );
    }
  }

  async command(
    command: string,
    redactedLabel?: string,
  ): Promise<SmtpCommandResult> {
    const label =
      redactedLabel ??
      command.split(/\s+/, 1)[0] ??
      "COMMAND";
    this.socket.write(command + "\r\n");
    const result = await this.readReply();
    if (result.code >= 400) {
      throw new SmtpProtocolError(
        label,
        result.code,
        result.lines.join(" "),
      );
    }
    return result;
  }

  async data(
    raw: Uint8Array,
  ): Promise<SmtpCommandResult> {
    const start = await this.command(
      "DATA",
      "DATA",
    );
    if (start.code !== 354) {
      throw new SmtpProtocolError(
        "DATA",
        start.code,
        start.lines.join(" "),
      );
    }

    const normalized = Buffer.from(raw)
      .toString("utf8")
      .replace(/\r?\n/g, "\r\n")
      .split("\r\n")
      .map((line) =>
        line.startsWith(".")
          ? "." + line
          : line,
      )
      .join("\r\n")
      .replace(/\r\n*$/, "");

    this.socket.write(
      normalized + "\r\n.\r\n",
    );
    const final = await this.readReply();
    if (final.code >= 400) {
      throw new SmtpProtocolError(
        "DATA",
        final.code,
        final.lines.join(" "),
      );
    }
    return final;
  }

  async upgradeToTls(
    config: ResolvedSmtpConnectionConfig,
  ): Promise<void> {
    if (this._encrypted) return;
    if (this.buffer.length > 0) {
      throw new SmtpTlsError(
        "SMTP STARTTLS cannot proceed with unread plaintext data",
      );
    }
    const tlsSocket = connectTls({
      socket: this.socket as Socket,
      servername: config.host,
      rejectUnauthorized:
        config.rejectUnauthorized,
    });
    await waitForSocketEvent(
      tlsSocket,
      "secureConnect",
      config.connectTimeoutMs,
      "SMTP STARTTLS handshake timed out",
    );
    this.socket = tlsSocket;
    this._encrypted = true;
  }

  async close(): Promise<void> {
    this.socket.end();
    this.socket.destroy();
  }

  private extractLine():
    | string
    | undefined {
    const marker =
      this.buffer.indexOf("\r\n");
    if (marker < 0) return undefined;
    const line = this.buffer
      .subarray(0, marker)
      .toString("utf8");
    this.buffer =
      this.buffer.subarray(marker + 2);
    return line;
  }

  private async readLine(): Promise<string> {
    const existing = this.extractLine();
    if (existing !== undefined) {
      return existing;
    }

    return new Promise<string>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new SmtpConnectionError(
              "SMTP command timed out",
            ),
          );
        }, this.commandTimeoutMs);

        const onData = (chunk: Buffer) => {
          this.buffer = Buffer.concat([
            this.buffer,
            chunk,
          ]);
          const line =
            this.extractLine();
          if (line !== undefined) {
            cleanup();
            resolve(line);
          }
        };
        const onError = (error: Error) => {
          cleanup();
          reject(
            new SmtpConnectionError(
              "SMTP socket error: " +
                error.message,
            ),
          );
        };
        const onClose = () => {
          cleanup();
          reject(
            new SmtpConnectionError(
              "SMTP connection closed unexpectedly",
            ),
          );
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.socket.off("data", onData);
          this.socket.off(
            "error",
            onError,
          );
          this.socket.off(
            "close",
            onClose,
          );
        };

        this.socket.on("data", onData);
        this.socket.on(
          "error",
          onError,
        );
        this.socket.on(
          "close",
          onClose,
        );
      },
    );
  }

  private async readReply():
    Promise<SmtpCommandResult> {
    const first = await this.readLine();
    const match =
      /^(\d{3})([ -])(.*)$/.exec(
        first,
      );
    if (!match) {
      throw new SmtpConnectionError(
        "Invalid SMTP server response",
      );
    }

    const code = Number(match[1]);
    const lines = [match[3] ?? ""];
    if (match[2] === " ") {
      return { code, lines };
    }

    for (;;) {
      const line = await this.readLine();
      const next =
        /^(\d{3})([ -])(.*)$/.exec(
          line,
        );
      if (!next) {
        throw new SmtpConnectionError(
          "Invalid SMTP multiline response",
        );
      }
      if (Number(next[1]) !== code) {
        throw new SmtpConnectionError(
          "SMTP multiline response code changed unexpectedly",
        );
      }
      lines.push(next[3] ?? "");
      if (next[2] === " ") {
        return { code, lines };
      }
    }
  }
}

async function waitForSocketEvent(
  socket: SmtpSocket,
  event: "connect" | "secureConnect",
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  await new Promise<void>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(
          new SmtpConnectionError(
            timeoutMessage,
          ),
        );
      }, timeoutMs);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(
          new SmtpConnectionError(
            "SMTP connection failed: " +
              error.message,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off(event, onReady);
        socket.off("error", onError);
      };
      socket.once(event, onReady);
      socket.once("error", onError);
    },
  );
}

export async function createNodeSmtpSession(
  config: ResolvedSmtpConnectionConfig,
): Promise<SmtpCommandSession> {
  if (config.tlsMode === "implicit_tls") {
    const socket = connectTls({
      host: config.host,
      port: config.port,
      servername: config.host,
      rejectUnauthorized:
        config.rejectUnauthorized,
    });
    await waitForSocketEvent(
      socket,
      "secureConnect",
      config.connectTimeoutMs,
      "SMTP TLS connection timed out",
    );
    const session =
      new NodeSmtpCommandSession(
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
    "SMTP connection timed out",
  );
  const session =
    new NodeSmtpCommandSession(
      socket,
      config.commandTimeoutMs,
      false,
    );
  await session.readGreeting();
  return session;
}

interface ParsedEhlo {
  capabilities: Set<string>;
  authMechanisms: Set<string>;
  maxMessageBytes?: number;
}

function parseEhlo(
  lines: readonly string[],
): ParsedEhlo {
  const capabilities =
    new Set<string>();
  const authMechanisms =
    new Set<string>();
  let maxMessageBytes:
    | number
    | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const [nameRaw = "", ...rest] =
      line.split(/\s+/);
    const name =
      nameRaw.toUpperCase();
    capabilities.add(name);

    if (name === "AUTH") {
      for (const mechanism of rest) {
        authMechanisms.add(
          mechanism.toUpperCase(),
        );
      }
    }
    if (name.startsWith("AUTH=")) {
      authMechanisms.add(
        name.slice(5),
      );
      for (const mechanism of rest) {
        authMechanisms.add(
          mechanism.toUpperCase(),
        );
      }
    }
    if (name === "SIZE" && rest[0]) {
      const parsed =
        Number(rest[0]);
      if (
        Number.isSafeInteger(parsed) &&
        parsed > 0
      ) {
        maxMessageBytes = parsed;
      }
    }
  }

  return {
    capabilities,
    authMechanisms,
    ...(maxMessageBytes !== undefined
      ? { maxMessageBytes }
      : {}),
  };
}

function authMethodsFromEhlo(
  parsed: ParsedEhlo,
): SmtpAuthMethod[] {
  const result: SmtpAuthMethod[] = [];
  if (
    parsed.authMechanisms.has(
      "PLAIN",
    ) ||
    parsed.authMechanisms.has(
      "LOGIN",
    )
  ) {
    result.push(
      "password",
      "app_password",
    );
  }
  if (
    parsed.authMechanisms.has(
      "XOAUTH2",
    )
  ) {
    result.push("oauth2");
  }
  return result;
}

async function authenticate(
  session: SmtpCommandSession,
  credentials: SmtpCredentials,
  ehlo: ParsedEhlo,
): Promise<void> {
  try {
    if (
      credentials.authMethod ===
      "oauth2"
    ) {
      if (
        !ehlo.authMechanisms.has(
          "XOAUTH2",
        )
      ) {
        throw new SmtpAuthenticationError(
          "SMTP server does not advertise XOAUTH2",
        );
      }
      const payload = Buffer.from(
        "user=" +
          credentials.username +
          "\x01auth=Bearer " +
          credentials.accessToken +
          "\x01\x01",
        "utf8",
      ).toString("base64");
      const result =
        await session.command(
          "AUTH XOAUTH2 " +
            payload,
          "AUTH XOAUTH2",
        );
      if (result.code !== 235) {
        throw new SmtpAuthenticationError(
          "SMTP OAuth2 authentication was rejected",
        );
      }
      return;
    }

    const secret =
      credentials.secret!;
    if (
      ehlo.authMechanisms.has(
        "PLAIN",
      )
    ) {
      const payload = Buffer.from(
        "\x00" +
          credentials.username +
          "\x00" +
          secret,
        "utf8",
      ).toString("base64");
      const result =
        await session.command(
          "AUTH PLAIN " + payload,
          "AUTH PLAIN",
        );
      if (result.code !== 235) {
        throw new SmtpAuthenticationError(
          "SMTP authentication was rejected",
        );
      }
      return;
    }

    if (
      ehlo.authMechanisms.has(
        "LOGIN",
      )
    ) {
      const start =
        await session.command(
          "AUTH LOGIN",
          "AUTH LOGIN",
        );
      if (start.code !== 334) {
        throw new SmtpAuthenticationError(
          "SMTP LOGIN authentication was rejected",
        );
      }
      const user =
        await session.command(
          Buffer.from(
            credentials.username,
            "utf8",
          ).toString("base64"),
          "AUTH USERNAME",
        );
      if (user.code !== 334) {
        throw new SmtpAuthenticationError(
          "SMTP LOGIN username was rejected",
        );
      }
      const pass =
        await session.command(
          Buffer.from(
            secret,
            "utf8",
          ).toString("base64"),
          "AUTH SECRET",
        );
      if (pass.code !== 235) {
        throw new SmtpAuthenticationError(
          "SMTP authentication was rejected",
        );
      }
      return;
    }

    throw new SmtpAuthenticationError(
      "SMTP server does not advertise a supported password authentication method",
    );
  } catch (error) {
    if (
      error instanceof
      SmtpAuthenticationError
    ) {
      throw error;
    }
    if (
      error instanceof SmtpProtocolError
    ) {
      throw new SmtpAuthenticationError(
        "SMTP authentication was rejected",
      );
    }
    throw error;
  }
}

function containsNonAscii(
  value: string,
): boolean {
  return /[^\x00-\x7F]/.test(value);
}

function rawMessageId(
  raw: Uint8Array,
): string | undefined {
  const text = Buffer.from(raw)
    .subarray(0, 64 * 1024)
    .toString("utf8");
  return /^message-id:\s*(.+)$/im.exec(
    text,
  )?.[1]?.trim();
}

export class CustomSmtpTransport
  implements OutboundTransport
{
  private session:
    | SmtpCommandSession
    | undefined;
  private discovered =
    smtpCapabilities();
  private ehlo:
    | ParsedEhlo
    | undefined;

  private readonly config:
    ResolvedSmtpConnectionConfig;

  constructor(
    config: SmtpConnectionConfig,
    private readonly credentials:
      SmtpCredentials,
    private readonly sessionFactory:
      SmtpSessionFactory =
        createNodeSmtpSession,
  ) {
    this.config =
      resolveSmtpConnectionConfig(
        config,
      );
    assertSmtpAuthPolicy(
      credentials,
      this.config,
    );
  }

  capabilities(): SmtpAccountCapabilities {
    return this.discovered;
  }

  async validateConnection(): Promise<OutboundConnectionValidation> {
    await this.ensureConnected();
    return {
      ok: true,
      capabilities: this.discovered,
      accountExternalId:
        this.credentials.username,
    };
  }

  async sendMessage(
    input: OutboundMessageInput,
  ): Promise<OutboundSendResult> {
    const raw = input.raw;
    if (!raw) {
      throw new TypeError(
        "Custom SMTP transport requires raw RFC822 content; structured MIME composition is handled separately",
      );
    }

    await this.ensureConnected();
    const session = this.session!;
    const recipients = [
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ].map((item) =>
      item.address.trim(),
    );
    const envelopeFrom = (
      input.envelopeFrom ??
      input.from.address
    ).trim();

    const utf8Required =
      containsNonAscii(envelopeFrom) ||
      recipients.some(
        containsNonAscii,
      );
    if (
      utf8Required &&
      !this.discovered.smtpUtf8
    ) {
      throw new SmtpProtocolError(
        "MAIL FROM",
        0,
        "SMTPUTF8 is required but not advertised by the server",
      );
    }

    if (
      this.discovered.maxMessageBytes !==
        undefined &&
      raw.byteLength >
        this.discovered.maxMessageBytes
    ) {
      throw new RangeError(
        "Message exceeds SMTP server SIZE limit",
      );
    }

    const mailParams: string[] = [];
    if (utf8Required) {
      mailParams.push("SMTPUTF8");
    }
    if (
      this.discovered.maxMessageBytes !==
      undefined
    ) {
      mailParams.push(
        "SIZE=" + raw.byteLength,
      );
    }
    await session.command(
      "MAIL FROM:<" +
        envelopeFrom +
        ">" +
        (mailParams.length
          ? " " +
            mailParams.join(" ")
          : ""),
      "MAIL FROM",
    );

    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const recipient of recipients) {
      try {
        const result =
          await session.command(
            "RCPT TO:<" +
              recipient +
              ">",
            "RCPT TO",
          );
        if (
          result.code === 250 ||
          result.code === 251
        ) {
          accepted.push(recipient);
        } else {
          rejected.push(recipient);
        }
      } catch (
        error
      ) {
        if (
          error instanceof
          SmtpProtocolError
        ) {
          rejected.push(recipient);
          continue;
        }
        throw error;
      }
    }

    if (accepted.length === 0) {
      throw new SmtpProtocolError(
        "RCPT TO",
        0,
        "All recipients were rejected",
      );
    }

    const result =
      await session.data(raw);
    const messageId =
      rawMessageId(raw);
    return {
      accepted,
      rejected,
      ...(messageId
        ? { messageId }
        : {}),
      providerResponse:
        result.lines.join(" "),
    };
  }

  async sendReply(
    input: OutboundReplyInput,
  ): Promise<OutboundSendResult> {
    return this.sendMessage({
      ...input,
      subject: input.subject ?? "",
    });
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.ehlo = undefined;
    if (!session) return;
    try {
      await session.command(
        "QUIT",
        "QUIT",
      );
    } catch {
      // Closing must not surface provider text that might accidentally
      // contain sensitive diagnostic material.
    } finally {
      await session.close();
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.session) return;

    const session =
      await this.sessionFactory(
        this.config,
      );
    try {
      let ehloResult =
        await session.command(
          "EHLO " +
            this.config.ehloName,
          "EHLO",
        );
      let parsed =
        parseEhlo(ehloResult.lines);

      if (
        this.config.tlsMode ===
        "starttls"
      ) {
        if (
          !parsed.capabilities.has(
            "STARTTLS",
          )
        ) {
          throw new SmtpTlsError(
            "SMTP server does not advertise STARTTLS",
          );
        }
        await session.command(
          "STARTTLS",
          "STARTTLS",
        );
        await session.upgradeToTls(
          this.config,
        );
        if (!session.encrypted) {
          throw new SmtpTlsError(
            "SMTP STARTTLS did not produce an encrypted session",
          );
        }
        ehloResult =
          await session.command(
            "EHLO " +
              this.config.ehloName,
            "EHLO",
          );
        parsed =
          parseEhlo(
            ehloResult.lines,
          );
      } else if (
        this.config.tlsMode ===
          "implicit_tls" &&
        !session.encrypted
      ) {
        throw new SmtpTlsError(
          "SMTP implicit TLS session is not encrypted",
        );
      }

      assertSmtpAuthPolicy(
        this.credentials,
        this.config,
      );
      await authenticate(
        session,
        this.credentials,
        parsed,
      );

      this.discovered =
        smtpCapabilities({
          authMethods:
            authMethodsFromEhlo(
              parsed,
            ),
          tlsModes: [
            this.config.tlsMode,
          ],
          envelopeSender: true,
          customFrom: true,
          customReplyTo: true,
          smtpUtf8:
            parsed.capabilities.has(
              "SMTPUTF8",
            ),
          ...(parsed.maxMessageBytes !==
          undefined
            ? {
                maxMessageBytes:
                  parsed.maxMessageBytes,
              }
            : {}),
        });
      this.session = session;
      this.ehlo = parsed;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
}

export function smtpDiagnosticCode(
  error: unknown,
): string {
  if (
    error instanceof SmtpTlsError
  ) {
    return error.code;
  }
  if (
    error instanceof
    SmtpAuthenticationError
  ) {
    return error.code;
  }
  if (
    error instanceof
    SmtpProtocolError
  ) {
    return error.code;
  }
  if (
    error instanceof
    SmtpConnectionError
  ) {
    return error.code;
  }
  return "SMTP_UNKNOWN_ERROR";
}
