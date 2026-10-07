import type {
  CanonicalMessage,
  ProviderKind,
} from "../domain/email-model.js";
import {
  INBOX_DASHBOARD_VIEWS,
  type InboxDashboardFilters,
  type InboxDashboardMessageRepository,
  type InboxDashboardNavItem,
  type InboxDashboardQuery,
  type InboxDashboardRow,
  type InboxDashboardView,
  type InboxDashboardViewModel,
} from "./inbox-dashboard-types.js";

const VIEW_LABELS: Readonly<Record<InboxDashboardView, string>> = {
  critical: "Critical",
  needs_action: "Needs Action",
  important: "Important",
  normal: "Normal",
  read_later: "Read Later",
  newsletters: "Newsletters",
  receipts: "Receipts",
  auto_archived: "Auto Archived",
  pending_delete: "Pending Delete",
};

function parseBoundary(
  value: string | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TypeError(field + " must be an ISO-compatible timestamp");
  }
  return parsed;
}

function normalizedCategorySet(
  categories: readonly string[] | undefined,
): Set<string> | undefined {
  if (!categories || categories.length === 0) return undefined;
  const result = new Set(
    categories
      .map((category) => category.trim().toLowerCase())
      .filter(Boolean),
  );
  return result.size > 0 ? result : undefined;
}

function normalizedProviderSet(
  providers: readonly ProviderKind[] | undefined,
): Set<ProviderKind> | undefined {
  if (!providers || providers.length === 0) return undefined;
  return new Set(providers);
}

function matchesFilters(
  message: CanonicalMessage,
  filters: InboxDashboardFilters,
): boolean {
  const providers = normalizedProviderSet(filters.providers);
  if (providers && !providers.has(message.provider.kind)) {
    return false;
  }

  const categories = normalizedCategorySet(filters.categories);
  if (categories) {
    const messageCategories = new Set(
      message.classification.categories.map((value) =>
        value.trim().toLowerCase(),
      ),
    );
    if (
      ![...categories].some((category) =>
        messageCategories.has(category),
      )
    ) {
      return false;
    }
  }

  const from = parseBoundary(
    filters.receivedFrom,
    "filters.receivedFrom",
  );
  const to = parseBoundary(
    filters.receivedTo,
    "filters.receivedTo",
  );
  if (from !== undefined && to !== undefined && from > to) {
    throw new RangeError(
      "filters.receivedFrom must be before filters.receivedTo",
    );
  }

  const received = Date.parse(message.receivedAt);
  if (from !== undefined && received < from) return false;
  if (to !== undefined && received > to) return false;

  return true;
}

function hasCategory(
  message: CanonicalMessage,
  category: string,
): boolean {
  const normalized = category.toLowerCase();
  return message.classification.categories.some(
    (value) => value.toLowerCase() === normalized,
  );
}

export function messageMatchesDashboardView(
  message: CanonicalMessage,
  view: InboxDashboardView,
): boolean {
  const classification = message.classification;
  switch (view) {
    case "critical":
      return classification.priority === "critical";
    case "needs_action":
      return (
        classification.status === "needs_review" ||
        classification.actionRequired === true ||
        classification.replyRequired === true
      );
    case "important":
      return classification.priority === "important";
    case "normal":
      return classification.priority === "normal";
    case "read_later":
      return (
        classification.priority === "low" ||
        classification.priority === "very_low" ||
        classification.priority === "disposable"
      );
    case "newsletters":
      return hasCategory(message, "newsletter");
    case "receipts":
      return hasCategory(message, "receipt");
    case "auto_archived":
      return (
        message.retention.stage === "archived" &&
        Boolean(message.retention.policyId)
      );
    case "pending_delete":
      return (
        message.retention.stage === "pending_trash" ||
        message.retention.stage === "trashed" ||
        message.retention.stage === "pending_delete"
      );
  }
}

function senderLabel(message: CanonicalMessage): string {
  const name = message.from?.name?.trim();
  const address = message.from?.address?.trim();
  if (name && address) return name + " <" + address + ">";
  return address || name || "Unknown sender";
}

function explanation(message: CanonicalMessage): string {
  const reason = message.classification.reason?.trim();
  if (reason) return reason.slice(0, 1000);

  if (message.classification.status === "needs_review") {
    return "InboxPilot needs review before taking an automated action.";
  }
  if (message.retention.stage === "archived") {
    return "Message was archived by the active retention policy.";
  }
  if (
    message.retention.stage === "pending_trash" ||
    message.retention.stage === "pending_delete" ||
    message.retention.stage === "trashed"
  ) {
    return "Message is in the deletion-retention lifecycle.";
  }
  return "No classifier explanation is available.";
}

function rowFor(message: CanonicalMessage): InboxDashboardRow {
  return {
    canonicalMessageId: message.id,
    providerMessageId: message.provider.messageId,
    provider: message.provider.kind,
    threadId: message.threadId,
    sender: senderLabel(message),
    subject: message.subject || "(no subject)",
    receivedAt: message.receivedAt,
    ...(message.classification.importanceScore !== undefined
      ? {
          importanceScore:
            message.classification.importanceScore,
        }
      : {}),
    ...(message.classification.priority
      ? { priority: message.classification.priority }
      : {}),
    categories: [...message.classification.categories],
    explanation: explanation(message),
    actionRequired:
      message.classification.actionRequired === true,
    replyRequired:
      message.classification.replyRequired === true,
    classificationStatus:
      message.classification.status,
    retentionStage: message.retention.stage,
    ...(message.retention.archiveAt
      ? { archivedAt: message.retention.archiveAt }
      : {}),
    ...(message.retention.trashAt
      ? { trashAt: message.retention.trashAt }
      : {}),
    ...(message.retention.deleteAt
      ? { deleteAt: message.retention.deleteAt }
      : {}),
  };
}

function filteredMessages(
  messages: readonly CanonicalMessage[],
  filters: InboxDashboardFilters,
): CanonicalMessage[] {
  return messages.filter((message) =>
    matchesFilters(message, filters),
  );
}

function navFor(
  messages: readonly CanonicalMessage[],
): InboxDashboardNavItem[] {
  return INBOX_DASHBOARD_VIEWS.map((view) => ({
    view,
    label: VIEW_LABELS[view],
    count: messages.filter((message) =>
      messageMatchesDashboardView(message, view),
    ).length,
  }));
}

export class InboxDashboardService {
  constructor(
    private readonly messages: InboxDashboardMessageRepository,
  ) {}

  async view(
    query: InboxDashboardQuery,
  ): Promise<InboxDashboardViewModel> {
    if (!query.tenantId.trim() || !query.accountId.trim()) {
      throw new TypeError("tenantId and accountId are required");
    }

    const filters = query.filters
      ? {
          ...(query.filters.providers
            ? { providers: [...query.filters.providers] }
            : {}),
          ...(query.filters.categories
            ? { categories: [...query.filters.categories] }
            : {}),
          ...(query.filters.receivedFrom
            ? { receivedFrom: query.filters.receivedFrom }
            : {}),
          ...(query.filters.receivedTo
            ? { receivedTo: query.filters.receivedTo }
            : {}),
        }
      : {};

    const accountMessages = filteredMessages(
      await this.messages.listForAccount(
        query.tenantId,
        query.accountId,
      ),
      filters,
    );
    const limit = Math.max(
      1,
      Math.min(query.limit ?? 200, 1000),
    );
    const rows = accountMessages
      .filter((message) =>
        messageMatchesDashboardView(message, query.view),
      )
      .sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      )
      .slice(0, limit)
      .map(rowFor);

    return {
      view: query.view,
      title: VIEW_LABELS[query.view],
      count: rows.length,
      filters,
      nav: navFor(accountMessages),
      rows,
      ...(rows.length === 0
        ? {
            emptyState:
              "No messages match this view and filter set.",
          }
        : {}),
    };
  }
}
