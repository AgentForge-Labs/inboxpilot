import type { ProviderConnectionContext } from "../provider-adapter.js";

export interface MicrosoftStoredCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
}

export interface MicrosoftCredentialStore {
  get(context: ProviderConnectionContext): Promise<MicrosoftStoredCredentials | null>;
  set(context: ProviderConnectionContext, credentials: MicrosoftStoredCredentials): Promise<void>;
  delete(context: ProviderConnectionContext): Promise<void>;
}

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tenant?: string;
}

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: "text" | "html" | string; content?: string };
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  categories?: string[];
  importance?: "low" | "normal" | "high" | string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: "notFlagged" | "complete" | "flagged" | string };
  receivedDateTime?: string;
  sentDateTime?: string;
  parentFolderId?: string;
  hasAttachments?: boolean;
  internetMessageHeaders?: Array<{ name?: string; value?: string }>;
  "@removed"?: { reason?: string };
}

export interface GraphFolder {
  id: string;
  displayName?: string;
  parentFolderId?: string;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
  wellKnownName?: string;
}

export interface GraphCollection<T> {
  value?: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export interface GraphMe {
  id: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
}

export interface GraphSubscription {
  id: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: string;
  clientState?: string;
}

export interface GraphSubscriptionNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
}
