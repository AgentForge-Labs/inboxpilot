import type {
  ShadowModeDashboardView,
} from "../automation/shadow-mode-types.js";

export interface ShadowModeMetricCard {
  key:
    | "critical"
    | "important"
    | "normal"
    | "low"
    | "would_archive"
    | "would_delete";
  label: string;
  value: number;
}

export interface ShadowModeDashboardViewModel {
  title: string;
  statusLabel: string;
  description: string;
  daysRemaining: number;
  metrics: ShadowModeMetricCard[];
  primaryAction:
    | {
        kind: "enable_automation";
        label: "Enable Automation";
        enabled: true;
      }
    | undefined;
}

export function buildShadowModeDashboardViewModel(
  view: ShadowModeDashboardView,
): ShadowModeDashboardViewModel {
  const statusLabel =
    view.status === "shadow"
      ? "Shadow Mode"
      : view.status === "review_ready"
        ? "Ready for review"
        : "Automation enabled";

  const description =
    view.status === "shadow"
      ? "InboxPilot is classifying mail and previewing automatic archive/delete decisions without applying those actions."
      : view.status === "review_ready"
        ? "The seven-day learning period is complete. Review the preview counts, then explicitly enable automation."
        : "Reviewed mailbox automation is enabled.";

  return {
    title: "Automation Preview",
    statusLabel,
    description,
    daysRemaining: view.daysRemaining,
    metrics: [
      {
        key: "critical",
        label: "Critical",
        value: view.counts.critical,
      },
      {
        key: "important",
        label: "Important",
        value: view.counts.important,
      },
      {
        key: "normal",
        label: "Normal",
        value: view.counts.normal,
      },
      {
        key: "low",
        label: "Low",
        value: view.counts.low,
      },
      {
        key: "would_archive",
        label: "Would Archive",
        value: view.counts.wouldArchive,
      },
      {
        key: "would_delete",
        label: "Would Delete",
        value: view.counts.wouldDelete,
      },
    ],
    primaryAction: view.canEnableAutomation
      ? {
          kind: "enable_automation",
          label: "Enable Automation",
          enabled: true,
        }
      : undefined,
  };
}
