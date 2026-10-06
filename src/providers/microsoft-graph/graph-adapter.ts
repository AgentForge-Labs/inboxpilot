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
import { MicrosoftGraphApiClient } from "./graph-api-client.js";
import { MicrosoftOAuthClient } from "./graph-oauth.js";
import {
  normalizeGraphConversation,
  normalizeGraphMessage,
} from "./graph-normalizer.js";
import type {
  GraphCollection,
  GraphFolder,
  GraphMe,
  GraphMessage,
  GraphSubscription,
} from "./graph-types.js";

const GRAPH_CAPABILITIES = [
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

const ROLE_BY_NAME: Readonly<Record<string, MailboxRole>> = Object.freeze({
  inbox: "inbox",
  archive: "archive",
  sentitems: "sent",
  sent: "sent",
  drafts: "drafts",
  deleteditems: "trash",
  deleted: "trash",
  junkemail: "spam",
  junk: "spam",
});

function roleFromFolder(folder: GraphFolder): MailboxRole {
  const name = folder.displayName?.trim().toLowerCase().replace(/\s+/g, "");
  return name && ROLE_BY_NAME[name] ? ROLE_BY_NAME[name] : "custom";
}

function encodeDeltaCursor(url: string): string {
  return Buffer.from(url, "utf8").toString("base64url");
}

function decodeDeltaCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  if (!decoded.startsWith("https://graph.microsoft.com/")) {
    throw new TypeError("Invalid Microsoft Graph delta cursor");
  }
  return decoded;
}

function messageSelect(): string {
  return [
    "id",
    "conversationId",
    "internetMessageId",
    "subject",
    "bodyPreview",
    "body",
    "from",
    "toRecipients",
    "ccRecipients",
    "bccRecipients",
    "replyTo",
    "categories",
    "importance",
    "isRead",
    "isDraft",
    "flag",
    "receivedDateTime",
    "sentDateTime",
    "parentFolderId",
    "hasAttachments",
    "internetMessageHeaders",
  ].join(",");
}

export interface MicrosoftGraphAdapterOptions {
  deltaFolder?: string;
  defaultDeltaLimit?: number;
}

export class MicrosoftGraphAdapter extends BaseProviderAdapter {
  private context: ProviderConnectionContext | undefined;
  private readonly deltaFolder: string;
  private readonly defaultDeltaLimit: number;

  constructor(
    private readonly api: MicrosoftGraphApiClient,
    private readonly oauth: MicrosoftOAuthClient,
    options: MicrosoftGraphAdapterOptions = {},
  ) {
    super("microsoft_graph", GRAPH_CAPABILITIES);
    this.deltaFolder = options.deltaFolder ?? "inbox";
    this.defaultDeltaLimit = options.defaultDeltaLimit ?? 100;
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    const me = await this.api.request<GraphMe>(
      context,
      "/me?$select=id,displayName,mail,userPrincipalName",
    );
    this.context = context;
    return {
      connected: true,
      provider: "microsoft_graph",
      accountExternalId: me.mail ?? me.userPrincipalName ?? me.id,
    };
  }

  private requireContext(): ProviderConnectionContext {
    this.assertConnected();
    if (!this.context) throw new Error("Microsoft Graph context unavailable");
    return this.context;
  }

  override async listFolders(): Promise<ProviderFolder[]> {
    this.assertCapability("listFolders");
    const context = this.requireContext();
    const response = await this.api.request<GraphCollection<GraphFolder>>(
      context,
      "/me/mailFolders?$top=100&includeHiddenFolders=true",
    );
    return (response.value ?? []).map((folder) => ({
      id: `graph:${folder.id}`,
      displayName: folder.displayName ?? folder.id,
      role: roleFromFolder(folder),
      providerFolderId: folder.id,
    }));
  }

  override async getMessage(providerMessageId: string): Promise<CanonicalMessage> {
    this.assertCapability("getMessage");
    const context = this.requireContext();
    const resource = await this.api.request<GraphMessage>(
      context,
      `/me/messages/${encodeURIComponent(providerMessageId)}?$select=${encodeURIComponent(messageSelect())}`,
    );
    return normalizeGraphMessage(resource, context);
  }

  override async getThread(providerThreadId: string): Promise<CanonicalThread> {
    this.assertCapability("getThread");
    const context = this.requireContext();
    const filter = `conversationId eq '${providerThreadId.replace(/'/g, "''")}'`;
    const response = await this.api.request<GraphCollection<GraphMessage>>(
      context,
      `/me/messages?$filter=${encodeURIComponent(filter)}&$top=100&$select=${encodeURIComponent(messageSelect())}`,
    );
    return normalizeGraphConversation(
      providerThreadId,
      response.value ?? [],
      context,
    );
  }

  override async syncChanges(
    request: SyncChangesRequest = {},
  ): Promise<SyncChangesResult> {
    this.assertCapability("syncChanges");
    const context = this.requireContext();
    const limit = Math.max(
      1,
      Math.min(request.limit ?? this.defaultDeltaLimit, 500),
    );

    const firstPath =
      `/me/mailFolders/${encodeURIComponent(this.deltaFolder)}/messages/delta` +
      `?$top=${limit}&$select=${encodeURIComponent(messageSelect())}`;
    const response = request.cursor
      ? await this.api.requestUrl<GraphCollection<GraphMessage>>(
          context,
          decodeDeltaCursor(request.cursor),
        )
      : await this.api.request<GraphCollection<GraphMessage>>(context, firstPath);

    const messages: CanonicalMessage[] = [];
    const deletedProviderMessageIds: string[] = [];

    for (const item of response.value ?? []) {
      if (item["@removed"]) {
        deletedProviderMessageIds.push(item.id);
      } else {
        messages.push(normalizeGraphMessage(item, context));
      }
    }

    const nextLink = response["@odata.nextLink"];
    const deltaLink = response["@odata.deltaLink"];
    const nextCursor = nextLink
      ? encodeDeltaCursor(nextLink)
      : deltaLink
        ? encodeDeltaCursor(deltaLink)
        : request.cursor;

    return {
      messages,
      deletedProviderMessageIds,
      ...(nextCursor ? { nextCursor } : {}),
      hasMore: Boolean(nextLink),
    };
  }

  private async moveTo(
    providerMessageId: string,
    destinationId: string,
  ): Promise<void> {
    const context = this.requireContext();
    await this.api.request(
      context,
      `/me/messages/${encodeURIComponent(providerMessageId)}/move`,
      {
        method: "POST",
        body: JSON.stringify({ destinationId }),
      },
    );
  }

  override async archive(providerMessageId: string): Promise<void> {
    this.assertCapability("archive");
    await this.moveTo(providerMessageId, "archive");
  }

  override async move(
    providerMessageId: string,
    target: MessageMoveTarget,
  ): Promise<void> {
    this.assertCapability("move");
    await this.moveTo(providerMessageId, target.folderId.replace(/^graph:/, ""));
  }

  override async trash(providerMessageId: string): Promise<void> {
    this.assertCapability("trash");
    await this.moveTo(providerMessageId, "deleteditems");
  }

  override async restore(providerMessageId: string): Promise<void> {
    this.assertCapability("restore");
    await this.moveTo(providerMessageId, "inbox");
  }

  private async patchMessage(
    providerMessageId: string,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const context = this.requireContext();
    await this.api.request(
      context,
      `/me/messages/${encodeURIComponent(providerMessageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
  }

  override async markImportant(
    providerMessageId: string,
    important = true,
  ): Promise<void> {
    this.assertCapability("markImportant");
    await this.patchMessage(providerMessageId, {
      importance: important ? "high" : "normal",
    });
  }

  override async star(
    providerMessageId: string,
    starred = true,
  ): Promise<void> {
    this.assertCapability("star");
    await this.patchMessage(providerMessageId, {
      flag: { flagStatus: starred ? "flagged" : "notFlagged" },
    });
  }

  override async markRead(
    providerMessageId: string,
    read = true,
  ): Promise<void> {
    this.assertCapability("markRead");
    await this.patchMessage(providerMessageId, { isRead: read });
  }

  async createSubscription(
    notificationUrl: string,
    clientState: string,
    expirationDateTime: string,
  ): Promise<GraphSubscription> {
    const context = this.requireContext();
    return this.api.request<GraphSubscription>(context, "/subscriptions", {
      method: "POST",
      body: JSON.stringify({
        changeType: "created,updated,deleted",
        notificationUrl,
        resource: "/me/messages",
        expirationDateTime,
        clientState,
      }),
    });
  }

  async renewSubscription(
    subscriptionId: string,
    expirationDateTime: string,
  ): Promise<GraphSubscription> {
    const context = this.requireContext();
    return this.api.request<GraphSubscription>(
      context,
      `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ expirationDateTime }),
      },
    );
  }

  async disconnect(): Promise<void> {
    const context = this.requireContext();
    await this.oauth.revokeLocal(context);
    this.context = undefined;
    this.setDisconnected();
  }
}
