import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import type {
  ImapConnectionConfig,
  ImapCredentialStore,
  ImapSecretRecord,
} from "./imap-types.js";

export function assertImapAuthPolicy(
  credentials: ImapSecretRecord,
  config: ImapConnectionConfig,
): void {
  if (credentials.authMode === "oauth2" && !credentials.accessToken) {
    throw new TypeError("IMAP OAuth2 credentials require an access token");
  }
  if (
    (credentials.authMode === "app_password" || credentials.authMode === "password") &&
    !credentials.secret
  ) {
    throw new TypeError("IMAP password-based credentials require a secret");
  }
  if (credentials.authMode === "password" && !config.allowPasswordAuth) {
    throw new Error("Normal IMAP password authentication is disabled for this account");
  }
  if (!credentials.username.trim()) {
    throw new TypeError("IMAP username is required");
  }
}

export async function createImapFlowClient(
  context: ProviderConnectionContext,
  config: ImapConnectionConfig,
  credentialStore: ImapCredentialStore,
): Promise<ImapFlow> {
  const credentials = await credentialStore.get(context);
  if (!credentials) throw new Error("IMAP credentials are not configured");
  assertImapAuthPolicy(credentials, config);

  const options: ImapFlowOptions = {
    host: config.host,
    port: config.port,
    secure: config.tlsMode === "implicit",
    doSTARTTLS: config.tlsMode === "starttls",
    auth: {
      user: credentials.username,
      ...(credentials.authMode === "oauth2"
        ? { accessToken: credentials.accessToken! }
        : { pass: credentials.secret! }),
    },
    logger: false,
    logRaw: false,
    emitLogs: false,
    qresync: true,
    maxIdleTime: 120_000,
    tls: {
      rejectUnauthorized: config.rejectUnauthorized ?? true,
      servername: config.host,
    },
  };

  const client = new ImapFlow(options);
  await client.connect();
  return client;
}
