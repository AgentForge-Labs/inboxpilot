import type {
  PendingDeleteActionAvailability,
  PendingDeleteQueueItem,
} from "../pending-delete/pending-delete-types.js";

export interface PendingDeleteDashboardRow {
  id: string;
  sender: string;
  subject: string;
  date: string;
  scoreLabel: string;
  categoryLabel: string;
  explanation: string;
  matchedRuleLabel: string;
  scheduleLabel: string;
  actions: PendingDeleteActionAvailability[];
}

export interface PendingDeleteDashboardViewModel {
  title: "Pending Delete";
  count: number;
  emptyState?: string;
  rows: PendingDeleteDashboardRow[];
}

function scheduleLabel(item: PendingDeleteQueueItem): string {
  const parts: string[] = [];
  if (item.scheduledTrashAt) {
    parts.push("Trash: " + item.scheduledTrashAt);
  }
  if (item.scheduledPermanentDeleteAt) {
    parts.push(
      "Permanent delete: " +
        item.scheduledPermanentDeleteAt,
    );
  }
  if (item.providerManagedExpiryAt) {
    parts.push(
      "Provider-managed expiry: " +
        item.providerManagedExpiryAt,
    );
  }
  return parts.length
    ? parts.join(" · ")
    : "No destructive date currently scheduled";
}

export function buildPendingDeleteDashboardViewModel(
  items: readonly PendingDeleteQueueItem[],
): PendingDeleteDashboardViewModel {
  return {
    title: "Pending Delete",
    count: items.length,
    ...(items.length === 0
      ? {
          emptyState:
            "No messages are currently scheduled for deletion.",
        }
      : {}),
    rows: items.map((item) => ({
      id: item.jobId,
      sender:
        item.senderName && item.sender
          ? item.senderName + " <" + item.sender + ">"
          : item.sender ??
            item.senderName ??
            "Unknown sender",
      subject: item.subject || "(no subject)",
      date: item.receivedAt,
      scoreLabel:
        item.importanceScore !== undefined
          ? String(item.importanceScore) +
            (item.priority ? " · " + item.priority : "")
          : item.priority ?? "Unscored",
      categoryLabel:
        item.categories.length > 0
          ? item.categories.join(", ")
          : "Uncategorized",
      explanation: item.explanation,
      matchedRuleLabel: item.matchedRule.label,
      scheduleLabel: scheduleLabel(item),
      actions: item.actions.map((action) => ({
        ...action,
      })),
    })),
  };
}
