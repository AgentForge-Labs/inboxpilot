import type { ProviderConnectionContext } from "../provider-adapter.js";

export interface GmailStoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface GmailCredentialStore {
  get(context: ProviderConnectionContext): Promise<GmailStoredCredentials | null>;
  set(context: ProviderConnectionContext, credentials: GmailStoredCredentials): Promise<void>;
  delete(context: ProviderConnectionContext): Promise<void>;
}

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartBody {
  size?: number;
  data?: string;
  attachmentId?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePart;
}

export interface GmailThreadResource {
  id: string;
  historyId?: string;
  messages?: GmailMessageResource[];
}

export interface GmailLabelResource {
  id: string;
  name: string;
  type?: "system" | "user" | string;
  messageListVisibility?: string;
  labelListVisibility?: string;
}

export interface GmailProfileResource {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
}

export interface GmailHistoryRecord {
  id: string;
  messages?: Array<Pick<GmailMessageResource, "id" | "threadId">>;
  messagesAdded?: Array<{ message: Pick<GmailMessageResource, "id" | "threadId"> }>;
  messagesDeleted?: Array<{ message: Pick<GmailMessageResource, "id" | "threadId"> }>;
  labelsAdded?: unknown[];
  labelsRemoved?: unknown[];
}

export interface GmailHistoryListResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

export interface GmailMessageListResponse {
  messages?: Array<Pick<GmailMessageResource, "id" | "threadId">>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailWatchResponse {
  historyId: string;
  expiration: string;
}

export interface GmailPushNotification {
  emailAddress: string;
  historyId: string;
}
