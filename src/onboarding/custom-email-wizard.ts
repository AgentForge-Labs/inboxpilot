import type {
  ImapAuthMode,
  ImapConnectionConfig,
  ImapCredentialStore,
  ImapSecretRecord,
} from "../providers/imap/imap-types.js";
import { createImapFlowClient } from "../providers/imap/imap-client.js";
import { testPop3Connection } from "../providers/pop3/pop3-client.js";
import type {
  Pop3AuthMode,
  Pop3ConnectionConfig,
  Pop3CredentialStore,
  Pop3SecretRecord,
} from "../providers/pop3/pop3-types.js";
import {
  resolveSmtpConnectionConfig,
  testSmtpConnection,
} from "../providers/smtp/smtp-client.js";
import type {
  SmtpAuthMethod,
  SmtpConnectionConfig,
  SmtpConnectionTestResult,
  SmtpCredentials,
  SmtpTlsMode,
} from "../providers/smtp/smtp-types.js";
import type { ProviderConnectionContext } from "../providers/provider-adapter.js";
import { CredentialVault } from "../security/vault/credential-vault.js";
import type {
  SecretRef,
  VaultPrincipal,
} from "../security/vault/vault-types.js";
import { tenantScopedKey } from "../security/tenant-boundary.js";

export type CustomReceiveProtocol = "imap" | "pop3";
export type CustomAccountMode =
  | "imap_smtp"
  | "pop3_smtp"
  | "receive_only"
  | "send_only";

export interface CustomReceiveDraft {
  protocol: CustomReceiveProtocol;
  host: string;
  port?: number;
  tlsMode: "implicit" | "starttls";
  authMode: ImapAuthMode | Pop3AuthMode;
  username?: string;
  secret?: string;
  accessToken?: string;
  rejectUnauthorized?: boolean;
  allowPasswordAuth?: boolean;
}

export interface CustomSmtpDraft {
  host: string;
  port?: number;
  tlsMode: SmtpTlsMode;
  authMethod: SmtpAuthMethod;
  username?: string;
  secret?: string;
  accessToken?: string;
  rejectUnauthorized?: boolean;
  allowPlaintextAuth?: boolean;
  ehloName?: string;
}

export interface CustomEmailAccountDraft {
  tenantId: string;
  accountId: string;
  email: string;
  displayName?: string;
  receive?: CustomReceiveDraft;
  send?: CustomSmtpDraft;
}

export interface CustomReceiveProfile {
  protocol: CustomReceiveProtocol;
  host: string;
  port: number;
  tlsMode: "implicit" | "starttls";
  authMode: ImapAuthMode | Pop3AuthMode;
  username: string;
  rejectUnauthorized: boolean;
  allowPasswordAuth: boolean;
  credentialRef: string;
}

export interface CustomSmtpProfile {
  protocol: "smtp";
  host: string;
  port: number;
  tlsMode: SmtpTlsMode;
  authMethod: SmtpAuthMethod;
  username: string;
  rejectUnauthorized: boolean;
  allowPlaintextAuth: boolean;
  ehloName: string;
  credentialRef: string;
}


export interface CustomEmailAccountProfile {
  tenantId: string;
  accountId: string;
  email: string;
  displayName?: string;
  mode: CustomAccountMode;
  receive?: CustomReceiveProfile;
  send?: CustomSmtpProfile;
  createdAt: string;
  updatedAt: string;
}

export interface CustomEmailAccountStore {
  get(
    tenantId: string,
    accountId: string,
  ): Promise<CustomEmailAccountProfile | undefined>;
  put(
    profile: CustomEmailAccountProfile,
  ): Promise<void>;
}

export class InMemoryCustomEmailAccountStore
  implements CustomEmailAccountStore
{
  readonly profiles = new Map<string, CustomEmailAccountProfile>();

  async get(
    tenantId: string,
    accountId: string,
  ): Promise<CustomEmailAccountProfile | undefined> {
    const value = this.profiles.get(
      tenantScopedKey({ tenantId, accountId }, "custom_email_account"),
    );
    return value ? structuredClone(value) : undefined;
  }

  async put(profile: CustomEmailAccountProfile): Promise<void> {
    this.profiles.set(
      tenantScopedKey(
        { tenantId: profile.tenantId, accountId: profile.accountId },
        "custom_email_account",
      ),
      structuredClone(profile),
    );
  }
}

export interface CustomReceiveConnectionTestResult {
  ok: boolean;
  protocol: CustomReceiveProtocol;
  host: string;
  port: number;
  tlsMode: "implicit" | "starttls";
  accountExternalId?: string;
  capabilities?: readonly string[];
  error?: {
    code: string;
    message: string;
    action: string;
  };
}

export type CustomReceiveWizardTestResult =
  | CustomReceiveConnectionTestResult
  | { ok: true; skipped: true; reason: "receive_disabled" };

export type CustomSendWizardTestResult =
  | SmtpConnectionTestResult
  | { ok: true; skipped: true; reason: "send_disabled" };

export interface CustomEmailConnectionTesters {
  testImap(
    context: ProviderConnectionContext,
    config: ImapConnectionConfig,
    credentials: ImapSecretRecord,
  ): Promise<CustomReceiveConnectionTestResult>;
  testPop3(
    context: ProviderConnectionContext,
    config: Pop3ConnectionConfig,
    credentials: Pop3SecretRecord,
  ): Promise<CustomReceiveConnectionTestResult>;
  testSmtp(
    config: SmtpConnectionConfig,
    credentials: SmtpCredentials,
  ): Promise<SmtpConnectionTestResult>;
}

function requiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(field + " is required");
  return normalized;
}

function normalizedEmail(value: string): string {
  const email = requiredString(value, "email").toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || /\s/.test(email)) {
    throw new TypeError("A valid email address is required");
  }
  return email;
}

function normalizedHost(value: string, field: string): string {
  const host = requiredString(value, field).toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || host.includes("/") || /\s/.test(host)) {
    throw new TypeError(field + " must be a valid hostname");
  }
  return host;
}

function port(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65_535) {
    throw new RangeError(field + " must be between 1 and 65535");
  }
  return resolved;
}

function receivePort(receive: CustomReceiveDraft): number {
  if (receive.protocol === "imap") {
    return port(
      receive.port,
      receive.tlsMode === "implicit" ? 993 : 143,
      "receive.port",
    );
  }
  return port(
    receive.port,
    receive.tlsMode === "implicit" ? 995 : 110,
    "receive.port",
  );
}


function validateReceiveCredentials(receive: CustomReceiveDraft): void {
  if (receive.authMode === "oauth2") {
    if (!receive.accessToken?.trim()) {
      throw new TypeError("Receive OAuth2 authentication requires an access token");
    }
  } else if (!receive.secret) {
    throw new TypeError("Receive password authentication requires a secret");
  }
  if (receive.authMode === "password" && !receive.allowPasswordAuth) {
    throw new Error(
      "Normal receive password authentication requires the advanced allowPasswordAuth setting",
    );
  }
}

function validateSmtpCredentials(send: CustomSmtpDraft): void {
  if (send.authMethod === "oauth2") {
    if (!send.accessToken?.trim()) {
      throw new TypeError("SMTP OAuth2 authentication requires an access token");
    }
  } else if (!send.secret) {
    throw new TypeError("SMTP password authentication requires a secret");
  }
  if (send.tlsMode === "none" && !send.allowPlaintextAuth) {
    throw new Error(
      "Plaintext SMTP authentication requires the advanced unsafe allowPlaintextAuth setting",
    );
  }
}

function modeOf(draft: CustomEmailAccountDraft): CustomAccountMode {
  if (draft.receive && draft.send) {
    return draft.receive.protocol === "imap" ? "imap_smtp" : "pop3_smtp";
  }
  if (draft.receive) return "receive_only";
  if (draft.send) return "send_only";
  throw new TypeError("Custom email account must enable receive, send, or both");
}

function receiveRef(tenantId: string, accountId: string): SecretRef {
  return { tenantId, accountId, name: "custom_email_receive" };
}

function smtpRef(tenantId: string, accountId: string): SecretRef {
  return { tenantId, accountId, name: "custom_email_smtp" };
}

function imapConfig(receive: CustomReceiveDraft): ImapConnectionConfig {
  return {
    host: normalizedHost(receive.host, "receive.host"),
    port: receivePort(receive),
    tlsMode: receive.tlsMode,
    rejectUnauthorized: receive.rejectUnauthorized ?? true,
    allowPasswordAuth: receive.allowPasswordAuth ?? false,
  };
}

function pop3Config(receive: CustomReceiveDraft): Pop3ConnectionConfig {
  return {
    host: normalizedHost(receive.host, "receive.host"),
    port: receivePort(receive),
    tlsMode: receive.tlsMode,
    rejectUnauthorized: receive.rejectUnauthorized ?? true,
    allowPasswordAuth: receive.allowPasswordAuth ?? false,
  };
}

function smtpConfig(send: CustomSmtpDraft): SmtpConnectionConfig {
  return {
    host: normalizedHost(send.host, "send.host"),
    ...(send.port !== undefined
      ? { port: port(send.port, send.port, "send.port") }
      : {}),
    tlsMode: send.tlsMode,
    rejectUnauthorized: send.rejectUnauthorized ?? true,
    allowPlaintextAuth: send.allowPlaintextAuth ?? false,
    ...(send.ehloName?.trim() ? { ehloName: send.ehloName.trim() } : {}),
  };
}

function receiveCredentials(
  email: string,
  receive: CustomReceiveDraft,
): ImapSecretRecord & Pop3SecretRecord {
  validateReceiveCredentials(receive);
  return {
    username: receive.username?.trim() || email,
    authMode: receive.authMode,
    ...(receive.secret ? { secret: receive.secret } : {}),
    ...(receive.accessToken ? { accessToken: receive.accessToken } : {}),
  };
}

function smtpCredentials(email: string, send: CustomSmtpDraft): SmtpCredentials {
  validateSmtpCredentials(send);
  return {
    username: send.username?.trim() || email,
    authMethod: send.authMethod,
    ...(send.secret ? { secret: send.secret } : {}),
    ...(send.accessToken ? { accessToken: send.accessToken } : {}),
  };
}


async function defaultImapTest(
  context: ProviderConnectionContext,
  config: ImapConnectionConfig,
  credentials: ImapSecretRecord,
): Promise<CustomReceiveConnectionTestResult> {
  const store: ImapCredentialStore = {
    async get() {
      return credentials;
    },
    async delete() {},
  };
  try {
    const client = await createImapFlowClient(context, config, store);
    try {
      return {
        ok: true,
        protocol: "imap",
        host: config.host,
        port: config.port,
        tlsMode: config.tlsMode,
        accountExternalId: credentials.username,
      };
    } finally {
      await client.logout();
    }
  } catch {
    return {
      ok: false,
      protocol: "imap",
      host: config.host,
      port: config.port,
      tlsMode: config.tlsMode,
      error: {
        code: "IMAP_CONNECTION_TEST_FAILED",
        message: "IMAP connection test failed.",
        action:
          "Check the IMAP host, port, TLS mode, username and authentication credentials.",
      },
    };
  }
}

async function defaultPop3Test(
  context: ProviderConnectionContext,
  config: Pop3ConnectionConfig,
  credentials: Pop3SecretRecord,
): Promise<CustomReceiveConnectionTestResult> {
  const store: Pop3CredentialStore = {
    async get() {
      return credentials;
    },
  };
  try {
    const result = await testPop3Connection(context, config, store);
    return {
      ok: true,
      protocol: "pop3",
      host: config.host,
      port: config.port ?? (config.tlsMode === "implicit" ? 995 : 110),
      tlsMode: config.tlsMode,
      accountExternalId: result.accountExternalId,
      capabilities: result.serverCapabilities,
    };
  } catch {
    return {
      ok: false,
      protocol: "pop3",
      host: config.host,
      port: config.port ?? (config.tlsMode === "implicit" ? 995 : 110),
      tlsMode: config.tlsMode,
      error: {
        code: "POP3_CONNECTION_TEST_FAILED",
        message: "POP3 connection test failed.",
        action:
          "Check the POP3 host, port, TLS mode, username and authentication credentials.",
      },
    };
  }
}

const DEFAULT_TESTERS: CustomEmailConnectionTesters = {
  testImap: defaultImapTest,
  testPop3: defaultPop3Test,
  testSmtp: testSmtpConnection,
};

export class CustomEmailAccountWizardService {
  constructor(
    private readonly accounts: CustomEmailAccountStore,
    private readonly vault: CredentialVault,
    private readonly vaultPrincipal: VaultPrincipal,
    private readonly testers: CustomEmailConnectionTesters = DEFAULT_TESTERS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async testReceive(
    draft: CustomEmailAccountDraft,
  ): Promise<CustomReceiveWizardTestResult> {
    this.validateIdentity(draft);
    if (!draft.receive) {
      return { ok: true, skipped: true, reason: "receive_disabled" };
    }

    const email = normalizedEmail(draft.email);
    const context = {
      tenantId: requiredString(draft.tenantId, "tenantId"),
      accountId: requiredString(draft.accountId, "accountId"),
    };
    const credentials = receiveCredentials(email, draft.receive);

    return draft.receive.protocol === "imap"
      ? this.testers.testImap(context, imapConfig(draft.receive), credentials)
      : this.testers.testPop3(context, pop3Config(draft.receive), credentials);
  }

  async testSend(
    draft: CustomEmailAccountDraft,
  ): Promise<CustomSendWizardTestResult> {
    this.validateIdentity(draft);
    if (!draft.send) {
      return { ok: true, skipped: true, reason: "send_disabled" };
    }
    const email = normalizedEmail(draft.email);
    return this.testers.testSmtp(
      smtpConfig(draft.send),
      smtpCredentials(email, draft.send),
    );
  }


  async save(
    draft: CustomEmailAccountDraft,
  ): Promise<CustomEmailAccountProfile> {
    const identity = this.validateIdentity(draft);
    const mode = modeOf(draft);
    const existing = await this.accounts.get(
      identity.tenantId,
      identity.accountId,
    );
    const now = this.now().toISOString();

    const receive = draft.receive
      ? this.receiveProfile(identity.email, draft.receive)
      : undefined;
    const send = draft.send
      ? this.smtpProfile(identity.email, draft.send)
      : undefined;

    if (draft.receive) {
      await this.vault.putJson(
        this.vaultPrincipal,
        receiveRef(identity.tenantId, identity.accountId),
        receiveCredentials(identity.email, draft.receive),
      );
    }

    if (draft.send) {
      await this.vault.putJson(
        this.vaultPrincipal,
        smtpRef(identity.tenantId, identity.accountId),
        smtpCredentials(identity.email, draft.send),
      );
    }

    const profile: CustomEmailAccountProfile = {
      tenantId: identity.tenantId,
      accountId: identity.accountId,
      email: identity.email,
      ...(draft.displayName?.trim()
        ? { displayName: draft.displayName.trim() }
        : {}),
      mode,
      ...(receive ? { receive } : {}),
      ...(send ? { send } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.accounts.put(profile);
    return structuredClone(profile);
  }

  private validateIdentity(
    draft: CustomEmailAccountDraft,
  ): {
    tenantId: string;
    accountId: string;
    email: string;
  } {
    modeOf(draft);
    return {
      tenantId: requiredString(draft.tenantId, "tenantId"),
      accountId: requiredString(draft.accountId, "accountId"),
      email: normalizedEmail(draft.email),
    };
  }

  private receiveProfile(
    email: string,
    receive: CustomReceiveDraft,
  ): CustomReceiveProfile {
    const credentials = receiveCredentials(email, receive);
    return {
      protocol: receive.protocol,
      host: normalizedHost(receive.host, "receive.host"),
      port: receivePort(receive),
      tlsMode: receive.tlsMode,
      authMode: receive.authMode,
      username: credentials.username,
      rejectUnauthorized: receive.rejectUnauthorized ?? true,
      allowPasswordAuth: receive.allowPasswordAuth ?? false,
      credentialRef: "custom_email_receive",
    };
  }

  private smtpProfile(
    email: string,
    send: CustomSmtpDraft,
  ): CustomSmtpProfile {
    const credentials = smtpCredentials(email, send);
    const resolved = resolveSmtpConnectionConfig(smtpConfig(send));
    return {
      protocol: "smtp",
      host: resolved.host,
      port: resolved.port,
      tlsMode: resolved.tlsMode,
      authMethod: send.authMethod,
      username: credentials.username,
      rejectUnauthorized: resolved.rejectUnauthorized,
      allowPlaintextAuth: resolved.allowPlaintextAuth,
      ehloName: resolved.ehloName,
      credentialRef: "custom_email_smtp",
    };
  }
}
