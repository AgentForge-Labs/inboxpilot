import type {
  CanonicalMessage,
  CanonicalThread,
  MailboxRole,
} from "../../domain/email-model.js";
import { BaseProviderAdapter } from "../base-provider-adapter.js";
import type {
  MessageMoveTarget,
  ProviderCapabilities,
  ProviderConnectResult,
  ProviderConnectionContext,
  ProviderFolder,
  SyncChangesRequest,
  SyncChangesResult,
} from "../provider-adapter.js";
import { JmapClient, JmapMethodError } from "./jmap-client.js";
import {
  normalizeJmapEmail,
  normalizeJmapThread,
  type JmapMailboxInfo,
} from "./jmap-normalizer.js";
import {
  JMAP_MAIL_CAPABILITY,
  type JmapChangesResponse,
  type JmapEmail,
  type JmapGetResponse,
  type JmapMailbox,
  type JmapQueryResponse,
  type JmapSession,
  type JmapSetResponse,
  type JmapThread,
} from "./jmap-types.js";

const EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "sentAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "header:Authentication-Results:asText",
  "header:Received:asText",
] as const;

const JMAP_CAPABILITIES = [
  "listFolders",
  "syncChanges",
  "getMessage",
  "getThread",
  "archive",
  "move",
  "trash",
  "restore",
  "markImportant",
  "star",
  "markRead",
] as const;

type JmapSyncCursor =
  | { mode: "query"; position: number }
  | { mode: "changes"; state: string };

function encodeCursor(cursor: JmapSyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value?: string): JmapSyncCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<JmapSyncCursor>;
    if (
      parsed.mode === "query" &&
      Number.isInteger(parsed.position) &&
      Number(parsed.position) >= 0
    ) {
      return { mode: "query", position: Number(parsed.position) };
    }
    if (
      parsed.mode === "changes" &&
      typeof parsed.state === "string" &&
      parsed.state.length > 0
    ) {
      return { mode: "changes", state: parsed.state };
    }
  } catch {
    // Fall through to typed cursor error.
  }
  throw new TypeError("Invalid JMAP sync cursor");
}

function roleOf(mailbox: JmapMailbox): MailboxRole {
  switch (mailbox.role?.toLowerCase()) {
    case "inbox":
      return "inbox";
    case "archive":
      return "archive";
    case "sent":
      return "sent";
    case "drafts":
      return "drafts";
    case "trash":
      return "trash";
    case "junk":
      return "spam";
    default:
      return "custom";
  }
}

export class JmapAdapter extends BaseProviderAdapter {
  private context: ProviderConnectionContext | undefined;
  private session: JmapSession | undefined;
  private accountId: string | undefined;
  private mailboxCache = new Map<string, JmapMailboxInfo>();
  private mailboxRoleIds = new Map<MailboxRole, string>();

  constructor(
    private readonly client: JmapClient,
  ) {
    super("jmap", JMAP_CAPABILITIES);
  }

  override capabilities(): ProviderCapabilities {
    const capabilities = { ...super.capabilities() };
    const account =
      this.session && this.accountId
        ? this.session.accounts[this.accountId]
        : undefined;

    if (account?.isReadOnly) {
      for (const name of [
        "archive",
        "move",
        "trash",
        "restore",
        "markImportant",
        "star",
        "markRead",
      ] as const) {
        capabilities[name] = false;
      }
    }

    if (this.session) {
      if (!this.mailboxRoleIds.has("archive")) capabilities.archive = false;
      if (!this.mailboxRoleIds.has("trash")) capabilities.trash = false;
      if (!this.mailboxRoleIds.has("inbox")) capabilities.restore = false;
    }
    return Object.freeze(capabilities);
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    const session = await this.client.discoverSession(context);
    const accountId = session.primaryAccounts[JMAP_MAIL_CAPABILITY];
    if (!accountId || !session.accounts[accountId]) {
      throw new TypeError("JMAP primary mail account is unavailable");
    }

    this.context = context;
    this.session = session;
    this.accountId = accountId;
    await this.loadMailboxes();

    return {
      connected: true,
      provider: "jmap",
      accountExternalId: accountId,
    };
  }

  private requireContext(): ProviderConnectionContext {
    this.assertConnected();
    if (!this.context) throw new Error("JMAP context is unavailable");
    return this.context;
  }

  private requireSession(): JmapSession {
    this.assertConnected();
    if (!this.session) throw new Error("JMAP session is unavailable");
    return this.session;
  }

  private requireAccountId(): string {
    this.assertConnected();
    if (!this.accountId) throw new Error("JMAP account is unavailable");
    return this.accountId;
  }

  private async invoke<T extends object>(
    methodName: string,
    argumentsObject: Record<string, unknown>,
  ): Promise<T> {
    return this.client.invoke<T>(
      this.requireContext(),
      this.requireSession(),
      methodName,
      argumentsObject,
    );
  }

  private async loadMailboxes(): Promise<JmapMailbox[]> {
    if (!this.context || !this.session || !this.accountId) {
      throw new Error("JMAP connection is not initialized");
    }
    const response = await this.client.invoke<JmapGetResponse<JmapMailbox>>(
      this.context,
      this.session,
      "Mailbox/get",
      {
        accountId: this.accountId,
        ids: null,
        properties: [
          "id",
          "name",
          "parentId",
          "role",
          "sortOrder",
          "totalEmails",
          "unreadEmails",
          "myRights",
        ],
      },
    );

    this.mailboxCache.clear();
    this.mailboxRoleIds.clear();
    for (const mailbox of response.list) {
      const role = roleOf(mailbox);
      this.mailboxCache.set(mailbox.id, {
        name: mailbox.name,
        role,
      });
      if (role !== "custom" && !this.mailboxRoleIds.has(role)) {
        this.mailboxRoleIds.set(role, mailbox.id);
      }
    }
    return response.list;
  }

  override async listFolders(): Promise<ProviderFolder[]> {
    this.assertConnected();
    this.assertCapability("listFolders");
    const mailboxes = await this.loadMailboxes();
    return mailboxes.map((mailbox) => ({
      id: `jmap:${mailbox.id}`,
      displayName: mailbox.name,
      role: roleOf(mailbox),
      providerFolderId: mailbox.id,
    }));
  }

  private async emailGet(ids: string[]): Promise<JmapGetResponse<JmapEmail>> {
    return this.invoke<JmapGetResponse<JmapEmail>>("Email/get", {
      accountId: this.requireAccountId(),
      ids,
      properties: [...EMAIL_PROPERTIES],
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      maxBodyValueBytes: 1_000_000,
    });
  }

  private normalizeEmails(resources: JmapEmail[]): CanonicalMessage[] {
    const context = this.requireContext();
    return resources.map((resource) =>
      normalizeJmapEmail(resource, context, this.mailboxCache),
    );
  }

  private async initialQuery(
    position: number,
    limit: number,
  ): Promise<SyncChangesResult> {
    const query = await this.invoke<JmapQueryResponse>("Email/query", {
      accountId: this.requireAccountId(),
      position,
      limit,
      sort: [{ property: "receivedAt", isAscending: true }],
    });
    const emails = await this.emailGet(query.ids);
    const nextPosition = position + query.ids.length;
    const hasMore =
      typeof query.total === "number"
        ? nextPosition < query.total
        : query.ids.length === limit;

    return {
      messages: this.normalizeEmails(emails.list),
      deletedProviderMessageIds: [],
      nextCursor: hasMore
        ? encodeCursor({ mode: "query", position: nextPosition })
        : encodeCursor({ mode: "changes", state: emails.state }),
      hasMore,
    };
  }

  override async syncChanges(
    request: SyncChangesRequest = {},
  ): Promise<SyncChangesResult> {
    this.assertCapability("syncChanges");
    const limit = Math.max(1, Math.min(request.limit ?? 100, 500));
    const cursor = decodeCursor(request.cursor);

    if (!cursor || cursor.mode === "query") {
      return this.initialQuery(cursor?.position ?? 0, limit);
    }

    let changes: JmapChangesResponse;
    try {
      changes = await this.invoke<JmapChangesResponse>("Email/changes", {
        accountId: this.requireAccountId(),
        sinceState: cursor.state,
        maxChanges: limit,
      });
    } catch (error) {
      if (
        error instanceof JmapMethodError &&
        error.type === "cannotCalculateChanges"
      ) {
        return this.initialQuery(0, limit);
      }
      throw error;
    }

    const changedIds = [...new Set([...changes.created, ...changes.updated])];
    const emails = changedIds.length
      ? await this.emailGet(changedIds)
      : undefined;

    return {
      messages: emails ? this.normalizeEmails(emails.list) : [],
      deletedProviderMessageIds: changes.destroyed,
      nextCursor: encodeCursor({
        mode: "changes",
        state: changes.newState,
      }),
      hasMore: changes.hasMoreChanges,
    };
  }

  override async getMessage(providerMessageId: string): Promise<CanonicalMessage> {
    this.assertCapability("getMessage");
    const response = await this.emailGet([providerMessageId]);
    const resource = response.list[0];
    if (!resource) throw new Error("JMAP email not found");
    return normalizeJmapEmail(
      resource,
      this.requireContext(),
      this.mailboxCache,
    );
  }

  override async getThread(providerThreadId: string): Promise<CanonicalThread> {
    this.assertCapability("getThread");
    const threadResponse = await this.invoke<JmapGetResponse<JmapThread>>(
      "Thread/get",
      {
        accountId: this.requireAccountId(),
        ids: [providerThreadId],
      },
    );
    const thread = threadResponse.list[0];
    if (!thread) throw new Error("JMAP thread not found");

    const emailResponse = await this.emailGet(thread.emailIds);
    return normalizeJmapThread(
      providerThreadId,
      emailResponse.list,
      this.requireContext(),
      this.mailboxCache,
    );
  }

  private async rawEmail(
    providerMessageId: string,
  ): Promise<Pick<JmapEmail, "id" | "mailboxIds" | "keywords">> {
    const response = await this.invoke<JmapGetResponse<JmapEmail>>(
      "Email/get",
      {
        accountId: this.requireAccountId(),
        ids: [providerMessageId],
        properties: ["id", "mailboxIds", "keywords"],
      },
    );
    const email = response.list[0];
    if (!email) throw new Error("JMAP email not found");
    return email;
  }

  private async updateEmail(
    providerMessageId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.invoke<JmapSetResponse>("Email/set", {
      accountId: this.requireAccountId(),
      update: {
        [providerMessageId]: patch,
      },
    });
    const failure = response.notUpdated?.[providerMessageId];
    if (failure) {
      throw new JmapMethodError(
        failure.type,
        "Email/set",
        failure.description,
      );
    }
  }

  private mailboxIdForRole(role: MailboxRole): string {
    const id = this.mailboxRoleIds.get(role);
    if (!id) {
      throw new Error(`JMAP mailbox role "${role}" is unavailable`);
    }
    return id;
  }

  override async move(
    providerMessageId: string,
    target: MessageMoveTarget,
  ): Promise<void> {
    this.assertCapability("move");
    const mailboxId = target.folderId.replace(/^jmap:/, "");
    if (!this.mailboxCache.has(mailboxId)) {
      throw new Error("JMAP destination mailbox is unavailable");
    }
    await this.updateEmail(providerMessageId, {
      mailboxIds: { [mailboxId]: true },
    });
  }

  override async archive(providerMessageId: string): Promise<void> {
    this.assertCapability("archive");
    await this.updateEmail(providerMessageId, {
      mailboxIds: { [this.mailboxIdForRole("archive")]: true },
    });
  }

  override async trash(providerMessageId: string): Promise<void> {
    this.assertCapability("trash");
    await this.updateEmail(providerMessageId, {
      mailboxIds: { [this.mailboxIdForRole("trash")]: true },
    });
  }

  override async restore(providerMessageId: string): Promise<void> {
    this.assertCapability("restore");
    await this.updateEmail(providerMessageId, {
      mailboxIds: { [this.mailboxIdForRole("inbox")]: true },
    });
  }

  private async updateKeyword(
    providerMessageId: string,
    keyword: string,
    enabled: boolean,
  ): Promise<void> {
    const email = await this.rawEmail(providerMessageId);
    const keywords = { ...(email.keywords ?? {}) };
    if (enabled) keywords[keyword] = true;
    else delete keywords[keyword];
    await this.updateEmail(providerMessageId, { keywords });
  }

  override async markImportant(
    providerMessageId: string,
    important = true,
  ): Promise<void> {
    this.assertCapability("markImportant");
    await this.updateKeyword(providerMessageId, "$important", important);
  }

  override async star(
    providerMessageId: string,
    starred = true,
  ): Promise<void> {
    this.assertCapability("star");
    await this.updateKeyword(providerMessageId, "$flagged", starred);
  }

  override async markRead(
    providerMessageId: string,
    read = true,
  ): Promise<void> {
    this.assertCapability("markRead");
    await this.updateKeyword(providerMessageId, "$seen", read);
  }

  async disconnect(removeCredentials = false): Promise<void> {
    const context = this.context;
    if (removeCredentials && context) {
      await this.client.removeCredentials(context);
    }
    this.context = undefined;
    this.session = undefined;
    this.accountId = undefined;
    this.mailboxCache.clear();
    this.mailboxRoleIds.clear();
    this.setDisconnected();
  }
}
