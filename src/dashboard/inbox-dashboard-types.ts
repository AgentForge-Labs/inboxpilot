import type {
  CanonicalMessage,
  PriorityBand,
  ProviderKind,
  RetentionStage,
} from "../domain/email-model.js";

export const INBOX_DASHBOARD_VIEWS = [
  "critical",
  "needs_action",
  "important",
  "normal",
  "read_later",
  "newsletters",
  "receipts",
  "auto_archived",
  "pending_delete",
] as const;

export type InboxDashboardView =
  (typeof INBOX_DASHBOARD_VIEWS)[number];

export interface InboxDashboardFilters {
  providers?: readonly ProviderKind[];
  categories?: readonly string[];
  receivedFrom?: string;
  receivedTo?: string;
}

export interface InboxDashboardQuery {
  tenantId: string;
  accountId: string;
  view: InboxDashboardView;
  filters?: InboxDashboardFilters;
  limit?: number;
}

export interface InboxDashboardRow {
  canonicalMessageId: string;
  providerMessageId: string;
  provider: ProviderKind;
  threadId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  importanceScore?: number;
  priority?: PriorityBand;
  categories: string[];
  explanation: string;
  actionRequired: boolean;
  replyRequired: boolean;
  classificationStatus: CanonicalMessage["classification"]["status"];
  retentionStage: RetentionStage;
  archivedAt?: string;
  trashAt?: string;
  deleteAt?: string;
}

export interface InboxDashboardNavItem {
  view: InboxDashboardView;
  label: string;
  count: number;
}

export interface InboxDashboardViewModel {
  view: InboxDashboardView;
  title: string;
  count: number;
  filters: InboxDashboardFilters;
  nav: InboxDashboardNavItem[];
  rows: InboxDashboardRow[];
  emptyState?: string;
}

export interface InboxDashboardMessageRepository {
  listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<CanonicalMessage[]>;
}
