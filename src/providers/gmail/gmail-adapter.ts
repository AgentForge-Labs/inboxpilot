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
  ProviderLabel,
  SyncChangesRequest,
  SyncChangesResult,
} from "../provider-adapter.js";
import { GmailApiClient } from "./gmail-api-client.js";
import { normalizeGmailMessage, normalizeGmailThread } from "./gmail-normalizer.js";
import { GmailOAuthClient } from "./gmail-oauth.js";
import type {
  GmailHistoryListResponse,
  GmailLabelResource,
  GmailMessageListResponse,
  GmailMessageResource,
  GmailProfileResource,
  GmailPushNotification,
  GmailThreadResource,
  GmailWatchResponse,
} from "./gmail-types.js";

const GMAIL_CAPABILITIES = [
  "listFolders",
  "listLabels",
  "syncChanges",
  "getMessage",
  "getThread",
  "archive",
  "move",
  "trash",
  "addLabel",
  "removeLabel",
  "markImportant",
  "star",
  "markRead",
  "restore",
] as const;

const SYSTEM_FOLDER_ROLES: Readonly<Record<string, MailboxRole>> = Object.freeze({
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  TRASH: "trash",
  SPAM: "spam",
});

interface ListCursor {
  mode: "list";
  pageToken?: string;
}

interface HistoryCursor {
  mode: "history";
  startHistoryId: string;
  pageToken?: string;
}

type GmailCursor = ListCursor | HistoryCursor;

function encodeCursor(cursor: GmailCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string): GmailCursor | undefined {
  if (!cursor) return undefined;
  if (/^\d+$/.test(cursor)) {
    return { mode: "history", startHistoryId: cursor };
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as GmailCursor;
    if (parsed.mode === "list" || parsed.mode === "history") return parsed;
  } catch {
    // Fall through to typed invalid-cursor error.
  }
  throw new TypeError("Invalid Gmail sync cursor");
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export interface GmailAdapterOptions {
  allowPermanentDelete?: boolean;
  defaultBackfillLimit?: number;
}

export class GmailAdapter extends BaseProviderAdapter {
  private context: ProviderConnectionContext | undefined;
  private readonly allowPermanentDelete: boolean;
  private readonly defaultBackfillLimit: number;

  constructor(
    private readonly api: GmailApiClient,
    private readonly oauth: GmailOAuthClient,
    options: GmailAdapterOptions = {},
  ) {
    const allowPermanentDelete = Boolean(options.allowPermanentDelete);
    super("gmail", [
      ...GMAIL_CAPABILITIES,
      ...(allowPermanentDelete ? (["deletePermanent"] as const) : []),
    ]);
    this.allowPermanentDelete = allowPermanentDelete;
    this.defaultBackfillLimit = options.defaultBackfillLimit ?? 100;
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    const profile = await this.api.request<GmailProfileResource>(context, "/profile");
    this.context = context;
    return {
      connected: true,
      provider: "gmail",
      accountExternalId: profile.emailAddress,
    };
  }

  private requireContext(): ProviderConnectionContext {
    this.assertConnected();
    if (!this.context) throw new Error("Gmail connector context unavailable");
    return this.context;
  }

  private async labelsRaw(): Promise<GmailLabelResource[]> {
    const context = this.requireContext();
    const response = await this.api.request<{ labels?: GmailLabelResource[] }>(
      context,
      "/labels",
    );
    return response.labels ?? [];
  }

  override async listLabels(): Promise<ProviderLabel[]> {
    this.assertCapability("listLabels");
    return (await this.labelsRaw()).map((label) => ({
      id: `gmail:${label.id}`,
      displayName: label.name,
      providerLabelId: label.id,
    }));
  }

  override async listFolders(): Promise<ProviderFolder[]> {
    this.assertCapability("listFolders");
    const folders: ProviderFolder[] = [];
    for (const label of await this.labelsRaw()) {
      const role = SYSTEM_FOLDER_ROLES[label.id];
      if (!role) continue;
      folders.push({
        id: `gmail:${label.id}`,
        displayName: label.name,
        role,
        providerFolderId: label.id,
      });
    }
    folders.push({
      id: "gmail:archive",
      displayName: "Archive",
      role: "archive",
    });
    return folders;
  }

  override async getMessage(providerMessageId: string): Promise<CanonicalMessage> {
    this.assertCapability("getMessage");
    const context = this.requireContext();
    const resource = await this.api.request<GmailMessageResource>(
      context,
      `/messages/${encodeURIComponent(providerMessageId)}?format=full`,
    );
    return normalizeGmailMessage(resource, context);
  }

  override async getThread(providerThreadId: string): Promise<CanonicalThread> {
    this.assertCapability("getThread");
    const context = this.requireContext();
    const resource = await this.api.request<GmailThreadResource>(
      context,
      `/threads/${encodeURIComponent(providerThreadId)}?format=full`,
    );
    return normalizeGmailThread(resource, context);
  }

  override async syncChanges(
    request: SyncChangesRequest = {},
  ): Promise<SyncChangesResult> {
    this.assertCapability("syncChanges");
    const context = this.requireContext();
    const cursor = decodeCursor(request.cursor);
    const limit = Math.max(1, Math.min(request.limit ?? this.defaultBackfillLimit, 500));

    if (!cursor || cursor.mode === "list") {
      const response = await this.api.request<GmailMessageListResponse>(
        context,
        `/messages${query({
          maxResults: limit,
          pageToken: cursor?.pageToken,
        })}`,
      );
      const messages = await Promise.all(
        (response.messages ?? []).map(({ id }) => this.getMessage(id)),
      );

      if (response.nextPageToken) {
        return {
          messages,
          deletedProviderMessageIds: [],
          nextCursor: encodeCursor({
            mode: "list",
            pageToken: response.nextPageToken,
          }),
          hasMore: true,
        };
      }

      const profile = await this.api.request<GmailProfileResource>(context, "/profile");
      return {
        messages,
        deletedProviderMessageIds: [],
        ...(profile.historyId ? { nextCursor: profile.historyId } : {}),
        hasMore: false,
      };
    }

    const response = await this.api.request<GmailHistoryListResponse>(
      context,
      `/history${query({
        startHistoryId: cursor.startHistoryId,
        maxResults: limit,
        pageToken: cursor.pageToken,
      })}`,
    );

    const changedIds = new Set<string>();
    const deletedIds = new Set<string>();
    for (const history of response.history ?? []) {
      for (const item of history.messagesAdded ?? []) changedIds.add(item.message.id);
      for (const item of history.messages ?? []) changedIds.add(item.id);
      for (const item of history.messagesDeleted ?? []) {
        deletedIds.add(item.message.id);
        changedIds.delete(item.message.id);
      }
    }

    const messages: CanonicalMessage[] = [];
    for (const id of changedIds) {
      try {
        messages.push(await this.getMessage(id));
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error as { status?: number }).status === 404
        ) {
          deletedIds.add(id);
          continue;
        }
        throw error;
      }
    }

    const nextCursor = response.nextPageToken
      ? encodeCursor({
          mode: "history",
          startHistoryId: cursor.startHistoryId,
          pageToken: response.nextPageToken,
        })
      : response.historyId ?? cursor.startHistoryId;

    return {
      messages,
      deletedProviderMessageIds: [...deletedIds],
      nextCursor,
      hasMore: Boolean(response.nextPageToken),
    };
  }

  private async modifyLabels(
    providerMessageId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ): Promise<void> {
    const context = this.requireContext();
    await this.api.request(
      context,
      `/messages/${encodeURIComponent(providerMessageId)}/modify`,
      {
        method: "POST",
        body: JSON.stringify({ addLabelIds, removeLabelIds }),
      },
    );
  }

  override async archive(providerMessageId: string): Promise<void> {
    this.assertCapability("archive");
    await this.modifyLabels(providerMessageId, [], ["INBOX"]);
  }

  override async move(
    providerMessageId: string,
    target: MessageMoveTarget,
  ): Promise<void> {
    this.assertCapability("move");
    if (target.folderId === "gmail:archive") {
      await this.archive(providerMessageId);
      return;
    }
    const providerLabelId = target.folderId.replace(/^gmail:/, "");
    await this.modifyLabels(providerMessageId, [providerLabelId], ["INBOX"]);
  }

  override async trash(providerMessageId: string): Promise<void> {
    this.assertCapability("trash");
    const context = this.requireContext();
    await this.api.request(
      context,
      `/messages/${encodeURIComponent(providerMessageId)}/trash`,
      { method: "POST" },
    );
  }

  override async restore(providerMessageId: string): Promise<void> {
    this.assertCapability("restore");
    const context = this.requireContext();
    await this.api.request(
      context,
      `/messages/${encodeURIComponent(providerMessageId)}/untrash`,
      { method: "POST" },
    );
  }

  override async deletePermanent(providerMessageId: string): Promise<void> {
    this.assertCapability("deletePermanent");
    if (!this.allowPermanentDelete) {
      throw new Error("Permanent Gmail deletion is disabled");
    }
    const context = this.requireContext();
    await this.api.request(
      context,
      `/messages/${encodeURIComponent(providerMessageId)}`,
      { method: "DELETE" },
    );
  }

  override async addLabel(providerMessageId: string, labelId: string): Promise<void> {
    this.assertCapability("addLabel");
    await this.modifyLabels(providerMessageId, [labelId.replace(/^gmail:/, "")], []);
  }

  override async removeLabel(
    providerMessageId: string,
    labelId: string,
  ): Promise<void> {
    this.assertCapability("removeLabel");
    await this.modifyLabels(providerMessageId, [], [labelId.replace(/^gmail:/, "")]);
  }

  override async markImportant(
    providerMessageId: string,
    important = true,
  ): Promise<void> {
    this.assertCapability("markImportant");
    await this.modifyLabels(
      providerMessageId,
      important ? ["IMPORTANT"] : [],
      important ? [] : ["IMPORTANT"],
    );
  }

  override async star(providerMessageId: string, starred = true): Promise<void> {
    this.assertCapability("star");
    await this.modifyLabels(
      providerMessageId,
      starred ? ["STARRED"] : [],
      starred ? [] : ["STARRED"],
    );
  }

  override async markRead(providerMessageId: string, read = true): Promise<void> {
    this.assertCapability("markRead");
    await this.modifyLabels(
      providerMessageId,
      read ? [] : ["UNREAD"],
      read ? ["UNREAD"] : [],
    );
  }

  async watchPush(
    topicName: string,
    labelIds: string[] = ["INBOX"],
  ): Promise<GmailWatchResponse> {
    const context = this.requireContext();
    return this.api.request<GmailWatchResponse>(context, "/watch", {
      method: "POST",
      body: JSON.stringify({
        topicName,
        labelIds,
        labelFilterBehavior: "include",
      }),
    });
  }

  async stopWatch(): Promise<void> {
    const context = this.requireContext();
    await this.api.request(context, "/stop", { method: "POST" });
  }

  parsePushNotification(data: string): GmailPushNotification {
    const decoded = JSON.parse(
      Buffer.from(data, "base64").toString("utf8"),
    ) as Partial<GmailPushNotification>;
    if (!decoded.emailAddress || !decoded.historyId) {
      throw new TypeError("Invalid Gmail push notification payload");
    }
    return {
      emailAddress: decoded.emailAddress,
      historyId: decoded.historyId,
    };
  }

  async disconnect(): Promise<void> {
    const context = this.requireContext();
    try {
      await this.stopWatch();
    } catch {
      // Watch may not exist. Revocation and credential deletion must still run.
    }
    await this.oauth.revoke(context);
    this.context = undefined;
    this.setDisconnected();
  }
}
