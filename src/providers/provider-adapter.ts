import type {
  CanonicalMessage,
  CanonicalThread,
  MailboxRole,
  ProviderKind,
} from "../domain/email-model.js";

export const PROVIDER_CAPABILITIES = [
  "listFolders",
  "listLabels",
  "syncChanges",
  "getMessage",
  "getThread",
  "archive",
  "move",
  "trash",
  "restore",
  "deletePermanent",
  "addLabel",
  "removeLabel",
  "markImportant",
  "star",
  "markRead",
] as const;

export type ProviderCapabilityName = (typeof PROVIDER_CAPABILITIES)[number];

export type ProviderCapabilities = Readonly<
  Record<ProviderCapabilityName, boolean>
>;

export interface ProviderConnectionContext {
  tenantId: string;
  accountId: string;
}

export interface ProviderConnectResult {
  connected: true;
  provider: ProviderKind;
  accountExternalId?: string;
}

export interface ProviderFolder {
  id: string;
  displayName: string;
  role: MailboxRole;
  providerFolderId?: string;
}

export interface ProviderLabel {
  id: string;
  displayName: string;
  providerLabelId?: string;
}

export interface SyncChangesRequest {
  cursor?: string;
  limit?: number;
}

export interface SyncChangesResult {
  messages: CanonicalMessage[];
  deletedProviderMessageIds: string[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface MessageMoveTarget {
  folderId: string;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;

  connect(context: ProviderConnectionContext): Promise<ProviderConnectResult>;
  capabilities(): ProviderCapabilities;

  listFolders(): Promise<ProviderFolder[]>;
  listLabels(): Promise<ProviderLabel[]>;
  syncChanges(request?: SyncChangesRequest): Promise<SyncChangesResult>;
  getMessage(providerMessageId: string): Promise<CanonicalMessage>;
  getThread(providerThreadId: string): Promise<CanonicalThread>;

  archive(providerMessageId: string): Promise<void>;
  move(providerMessageId: string, target: MessageMoveTarget): Promise<void>;
  trash(providerMessageId: string): Promise<void>;
  restore(providerMessageId: string): Promise<void>;
  deletePermanent(providerMessageId: string): Promise<void>;
  addLabel(providerMessageId: string, labelId: string): Promise<void>;
  removeLabel(providerMessageId: string, labelId: string): Promise<void>;
  markImportant(providerMessageId: string, important?: boolean): Promise<void>;
  star(providerMessageId: string, starred?: boolean): Promise<void>;
  markRead(providerMessageId: string, read?: boolean): Promise<void>;
}

export function unsupportedCapabilities(
  supported: readonly ProviderCapabilityName[],
): ProviderCapabilities {
  const enabled = new Set(supported);
  return Object.freeze(
    Object.fromEntries(
      PROVIDER_CAPABILITIES.map((capability) => [
        capability,
        enabled.has(capability),
      ]),
    ) as Record<ProviderCapabilityName, boolean>,
  );
}
