import type { ProviderConnectionContext } from "../provider-adapter.js";

export type ImapAuthMode = "oauth2" | "app_password" | "password";

export interface ImapSecretRecord {
  username: string;
  authMode: ImapAuthMode;
  accessToken?: string;
  secret?: string;
}

export interface ImapCredentialStore {
  get(context: ProviderConnectionContext): Promise<ImapSecretRecord | null>;
  delete(context: ProviderConnectionContext): Promise<void>;
}

export interface ImapConnectionConfig {
  host: string;
  port: number;
  tlsMode: "implicit" | "starttls";
  allowPasswordAuth?: boolean;
  rejectUnauthorized?: boolean;
  inboxPath?: string;
  archivePath?: string;
  trashPath?: string;
}

export interface ImapMessageRef {
  mailbox: string;
  uidValidity: string;
  uid: number;
}

export interface ImapSyncCursor {
  mailbox: string;
  uidValidity: string;
  lastUid: number;
}

function decodeBase64Json<T>(value: string, errorMessage: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new TypeError(errorMessage);
  }
}

export function encodeImapMessageRef(ref: ImapMessageRef): string {
  return Buffer.from(JSON.stringify(ref), "utf8").toString("base64url");
}

export function decodeImapMessageRef(value: string): ImapMessageRef {
  const parsed = decodeBase64Json<Partial<ImapMessageRef>>(
    value,
    "Invalid IMAP message reference",
  );
  if (
    !parsed.mailbox ||
    !parsed.uidValidity ||
    !Number.isInteger(parsed.uid) ||
    Number(parsed.uid) < 1
  ) {
    throw new TypeError("Invalid IMAP message reference");
  }
  return {
    mailbox: parsed.mailbox,
    uidValidity: parsed.uidValidity,
    uid: Number(parsed.uid),
  };
}

export function encodeImapCursor(cursor: ImapSyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeImapCursor(value?: string): ImapSyncCursor | undefined {
  if (!value) return undefined;
  const parsed = decodeBase64Json<Partial<ImapSyncCursor>>(
    value,
    "Invalid IMAP sync cursor",
  );
  if (
    !parsed.mailbox ||
    !parsed.uidValidity ||
    !Number.isInteger(parsed.lastUid) ||
    Number(parsed.lastUid) < 0
  ) {
    throw new TypeError("Invalid IMAP sync cursor");
  }
  return {
    mailbox: parsed.mailbox,
    uidValidity: parsed.uidValidity,
    lastUid: Number(parsed.lastUid),
  };
}
