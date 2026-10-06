import type { ProviderConnectionContext } from "../provider-adapter.js";

export const JMAP_CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const JMAP_MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

export interface JmapCredential {
  accessToken: string;
}

export interface JmapCredentialStore {
  get(context: ProviderConnectionContext): Promise<JmapCredential | null>;
  delete(context: ProviderConnectionContext): Promise<void>;
}

export interface JmapConnectionConfig {
  sessionUrl: string;
}

export interface JmapAccount {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface JmapSession {
  capabilities: Record<string, unknown>;
  accounts: Record<string, JmapAccount>;
  primaryAccounts: Record<string, string>;
  username: string;
  apiUrl: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
  state: string;
}

export interface JmapAddress {
  name?: string | null;
  email?: string | null;
}

export interface JmapBodyValue {
  value: string;
  isEncodingProblem?: boolean;
  isTruncated?: boolean;
}

export interface JmapBodyPart {
  partId?: string;
  blobId?: string;
  size?: number;
  name?: string | null;
  type?: string;
  charset?: string | null;
  disposition?: string | null;
  cid?: string | null;
}

export interface JmapEmail {
  id: string;
  blobId?: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size?: number;
  receivedAt: string;
  sentAt?: string;
  messageId?: string[];
  inReplyTo?: string[];
  references?: string[];
  sender?: JmapAddress[];
  from?: JmapAddress[];
  to?: JmapAddress[];
  cc?: JmapAddress[];
  bcc?: JmapAddress[];
  replyTo?: JmapAddress[];
  subject?: string;
  preview?: string;
  bodyValues?: Record<string, JmapBodyValue>;
  textBody?: JmapBodyPart[];
  htmlBody?: JmapBodyPart[];
  attachments?: JmapBodyPart[];
  [key: string]: unknown;
}

export interface JmapMailbox {
  id: string;
  name: string;
  parentId?: string | null;
  role?: string | null;
  sortOrder?: number;
  totalEmails?: number;
  unreadEmails?: number;
  myRights?: Record<string, boolean>;
}

export interface JmapGetResponse<T> {
  accountId: string;
  state: string;
  list: T[];
  notFound?: string[];
}

export interface JmapQueryResponse {
  accountId: string;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: string[];
  total?: number;
  limit?: number;
}

export interface JmapChangesResponse {
  accountId: string;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

export interface JmapSetResponse {
  accountId: string;
  oldState: string;
  newState: string;
  updated?: Record<string, null>;
  notUpdated?: Record<string, { type: string; description?: string }>;
}

export interface JmapThread {
  id: string;
  emailIds: string[];
}
