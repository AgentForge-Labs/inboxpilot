import type {
  FetchMessageObject,
  ImapFlow,
  ListResponse,
  MailboxObject,
} from "imapflow";
import type {
  CanonicalMessage,
  CanonicalThread,
  MailboxRole,
} from "../../domain/email-model.js";
import { BaseProviderAdapter } from "../base-provider-adapter.js";
import type {
  MessageMoveTarget,
  ProviderConnectResult,
  ProviderConnectionContext,
  ProviderFolder,
  SyncChangesRequest,
  SyncChangesResult,
} from "../provider-adapter.js";
import { createImapFlowClient } from "./imap-client.js";
import { normalizeImapMessage } from "./imap-normalizer.js";
import {
  decodeImapCursor,
  decodeImapMessageRef,
  encodeImapCursor,
  type ImapConnectionConfig,
  type ImapCredentialStore,
} from "./imap-types.js";

export type ImapClientFactory = typeof createImapFlowClient;

function mailboxRole(
  folder: Pick<ListResponse, "path" | "name" | "specialUse">,
  config: ImapConnectionConfig,
): MailboxRole {
  const special = folder.specialUse?.toLowerCase();
  if (special === "\\inbox") return "inbox";
  if (special === "\\archive") return "archive";
  if (special === "\\sent") return "sent";
  if (special === "\\drafts") return "drafts";
  if (special === "\\trash") return "trash";
  if (special === "\\junk") return "spam";

  const path = folder.path.toLowerCase();
  if (path === (config.inboxPath ?? "INBOX").toLowerCase()) return "inbox";
  if (config.archivePath && path === config.archivePath.toLowerCase()) return "archive";
  if (config.trashPath && path === config.trashPath.toLowerCase()) return "trash";

  const name = folder.name.toLowerCase().replace(/[\s_-]+/g, "");
  if (name === "sent" || name === "sentitems") return "sent";
  if (name === "drafts") return "drafts";
  if (name === "junk" || name === "spam") return "spam";
  return "custom";
}

function roleForPath(path: string, config: ImapConnectionConfig): MailboxRole {
  return mailboxRole({ path, name: path.split(/[./]/).at(-1) ?? path }, config);
}

function uidValidityOf(mailbox: MailboxObject): string {
  return mailbox.uidValidity.toString();
}

function ensureRefMailbox(
  mailbox: MailboxObject,
  expectedUidValidity: string,
): void {
  if (uidValidityOf(mailbox) !== expectedUidValidity) {
    throw new Error(
      "IMAP UIDVALIDITY changed; message reference is stale and requires reconciliation",
    );
  }
}

const BASE_IMAP_CAPABILITIES = [
  "listFolders",
  "syncChanges",
  "getMessage",
  "move",
  "restore",
  "markImportant",
  "star",
  "markRead",
] as const;

export class ImapAdapter extends BaseProviderAdapter {
  private client: ImapFlow | undefined;
  private context: ProviderConnectionContext | undefined;

  constructor(
    private readonly config: ImapConnectionConfig,
    private readonly credentialStore: ImapCredentialStore,
    private readonly clientFactory: ImapClientFactory = createImapFlowClient,
  ) {
    super("imap", [
      ...BASE_IMAP_CAPABILITIES,
      ...(config.archivePath ? (["archive"] as const) : []),
      ...(config.trashPath ? (["trash"] as const) : []),
    ]);
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    const client = await this.clientFactory(context, this.config, this.credentialStore);
    const credentials = await this.credentialStore.get(context);
    this.client = client;
    this.context = context;
    return {
      connected: true,
      provider: "imap",
      ...(credentials?.username
        ? { accountExternalId: credentials.username }
        : {}),
    };
  }

  private requireClient(): ImapFlow {
    this.assertConnected();
    if (!this.client) throw new Error("IMAP client is unavailable");
    return this.client;
  }

  private requireContext(): ProviderConnectionContext {
    this.assertConnected();
    if (!this.context) throw new Error("IMAP connector context is unavailable");
    return this.context;
  }

  override async listFolders(): Promise<ProviderFolder[]> {
    this.assertCapability("listFolders");
    const folders = await this.requireClient().list();
    return folders.map((folder) => ({
      id: `imap:${folder.path}`,
      displayName: folder.name,
      role: mailboxRole(folder, this.config),
      providerFolderId: folder.path,
    }));
  }

  private async fetchNormalized(
    mailboxPath: string,
    mailbox: MailboxObject,
    fetched: FetchMessageObject,
  ): Promise<CanonicalMessage> {
    if (!fetched.source) {
      throw new Error("IMAP FETCH did not return RFC822 source");
    }
    return normalizeImapMessage({
      fetched,
      source: fetched.source,
      mailbox: mailboxPath,
      uidValidity: mailbox.uidValidity,
      mailboxRole: roleForPath(mailboxPath, this.config),
      context: this.requireContext(),
    });
  }

  override async syncChanges(
    request: SyncChangesRequest = {},
  ): Promise<SyncChangesResult> {
    this.assertCapability("syncChanges");
    const client = this.requireClient();
    const cursor = decodeImapCursor(request.cursor);
    const mailboxPath = cursor?.mailbox ?? this.config.inboxPath ?? "INBOX";
    const mailbox = await client.mailboxOpen(mailboxPath);

    const currentValidity = uidValidityOf(mailbox);
    const validityChanged =
      Boolean(cursor) && cursor!.uidValidity !== currentValidity;
    const lastUid = validityChanged ? 0 : (cursor?.lastUid ?? 0);
    const startUid = lastUid + 1;
    const limit = Math.max(1, Math.min(request.limit ?? 100, 500));

    const fetched =
      mailbox.exists > 0 && mailbox.uidNext > startUid
        ? await client.fetchAll(
            `${startUid}:*`,
            {
              uid: true,
              flags: true,
              internalDate: true,
              size: true,
              source: true,
              threadId: true,
              labels: true,
            },
            { uid: true },
          )
        : [];

    fetched.sort((a, b) => a.uid - b.uid);
    const selected = fetched.slice(0, limit);
    const messages = await Promise.all(
      selected.map((item) =>
        this.fetchNormalized(mailboxPath, mailbox, item),
      ),
    );
    const nextLastUid =
      selected.at(-1)?.uid ?? lastUid;

    return {
      messages,
      deletedProviderMessageIds: [],
      nextCursor: encodeImapCursor({
        mailbox: mailboxPath,
        uidValidity: currentValidity,
        lastUid: nextLastUid,
      }),
      hasMore: fetched.length > selected.length,
    };
  }

  override async getMessage(providerMessageId: string): Promise<CanonicalMessage> {
    this.assertCapability("getMessage");
    const ref = decodeImapMessageRef(providerMessageId);
    const client = this.requireClient();
    const mailbox = await client.mailboxOpen(ref.mailbox);
    ensureRefMailbox(mailbox, ref.uidValidity);

    const fetched = await client.fetchOne(
      ref.uid,
      {
        uid: true,
        flags: true,
        internalDate: true,
        size: true,
        source: true,
        threadId: true,
        labels: true,
      },
      { uid: true },
    );
    if (!fetched) throw new Error("IMAP message not found");
    return this.fetchNormalized(ref.mailbox, mailbox, fetched);
  }

  override async getThread(_providerThreadId: string): Promise<CanonicalThread> {
    return this.unsupported("getThread");
  }

  private async withMessageRef(
    providerMessageId: string,
    action: (client: ImapFlow, ref: ReturnType<typeof decodeImapMessageRef>) => Promise<void>,
  ): Promise<void> {
    const ref = decodeImapMessageRef(providerMessageId);
    const client = this.requireClient();
    const mailbox = await client.mailboxOpen(ref.mailbox);
    ensureRefMailbox(mailbox, ref.uidValidity);
    await action(client, ref);
  }

  override async archive(providerMessageId: string): Promise<void> {
    this.assertCapability("archive");
    await this.withMessageRef(providerMessageId, async (client, ref) => {
      await client.messageMove(ref.uid, this.config.archivePath!, { uid: true });
    });
  }

  override async move(
    providerMessageId: string,
    target: MessageMoveTarget,
  ): Promise<void> {
    this.assertCapability("move");
    const destination = target.folderId.replace(/^imap:/, "");
    if (!destination) throw new TypeError("IMAP move destination is required");
    await this.withMessageRef(providerMessageId, async (client, ref) => {
      await client.messageMove(ref.uid, destination, { uid: true });
    });
  }

  override async trash(providerMessageId: string): Promise<void> {
    this.assertCapability("trash");
    await this.withMessageRef(providerMessageId, async (client, ref) => {
      await client.messageMove(ref.uid, this.config.trashPath!, { uid: true });
    });
  }

  override async restore(providerMessageId: string): Promise<void> {
    this.assertCapability("restore");
    const inbox = this.config.inboxPath ?? "INBOX";
    await this.withMessageRef(providerMessageId, async (client, ref) => {
      await client.messageMove(ref.uid, inbox, { uid: true });
    });
  }

  override async markImportant(
    providerMessageId: string,
    important = true,
  ): Promise<void> {
    this.assertCapability("markImportant");
    await this.withMessageRef(providerMessageId, async (client, ref) => {
      if (important) {
        await client.messageFlagsAdd(ref.uid, ["$Important"], { uid: true });
      } else {
        await client.messageFlagsRemove(ref.uid, ["$Important"], { uid: true });
      }
    });
  }

  override async star(providerMessageId: string, starred = true): Promise<void> {
    this.assertCapability("star");
    await this.withMessageRef(providerMessageId, async (client, ref) => {
      if (starred) {
        await client.messageFlagsAdd(ref.uid, ["\\Flagged"], { uid: true });
      } else {
        await client.messageFlagsRemove(ref.uid, ["\\Flagged"], { uid: true });
      }
    });
  }

  override async markRead(providerMessageId: string, read = true): Promise<void> {
    this.assertCapability("markRead");
    await this.withMessageRef(providerMessageId, async (client, ref) => {
      if (read) {
        await client.messageFlagsAdd(ref.uid, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(ref.uid, ["\\Seen"], { uid: true });
      }
    });
  }

  async waitForIdleChange(mailboxPath = this.config.inboxPath ?? "INBOX"): Promise<boolean> {
    const client = this.requireClient();
    await client.mailboxOpen(mailboxPath);
    return client.idle();
  }

  async reconcile(request: SyncChangesRequest = {}): Promise<SyncChangesResult> {
    return this.syncChanges(request);
  }

  async disconnect(removeCredentials = false): Promise<void> {
    const client = this.client;
    const context = this.context;
    try {
      if (client) await client.logout();
    } finally {
      if (removeCredentials && context) {
        await this.credentialStore.delete(context);
      }
      this.client = undefined;
      this.context = undefined;
      this.setDisconnected();
    }
  }
}
