import {
  POP3_MIN_SERVER_DELETE_DELAY_DAYS,
  type Pop3ServerDeletePolicy,
} from "../providers/pop3/pop3-delete-policy.js";

export interface Pop3ServerDeleteDashboardViewModel {
  title: "POP3 Server Retention";
  enabled: boolean;
  delayDays?: number;
  statusLabel: string;
  description: string;
  warning?: string;
  minimumDelayDays: number;
  archiveMappingNotice: string;
}

export function buildPop3ServerDeleteDashboardViewModel(
  policy: Pop3ServerDeletePolicy,
): Pop3ServerDeleteDashboardViewModel {
  const days =
    policy.deleteFromServerAfterDays;

  if (days === undefined) {
    return {
      title: "POP3 Server Retention",
      enabled: false,
      statusLabel:
        "Never delete from server",
      description:
        "InboxPilot keeps every fetched message on the POP3 server unless you explicitly enable delete-after-fetch retention.",
      minimumDelayDays:
        POP3_MIN_SERVER_DELETE_DELAY_DAYS,
      archiveMappingNotice:
        "InboxPilot Archive never maps to POP3 DELE.",
    };
  }

  return {
    title: "POP3 Server Retention",
    enabled: true,
    delayDays: days,
    statusLabel:
      "Delete from server after " +
      days +
      " days",
    description:
      "Messages become eligible for POP3 server deletion only after the configured delay and a fresh Never Auto Delete safeguard check.",
    warning:
      "POP3 DELE is destructive and may permanently remove the server copy. Keep another trusted copy or backup before enabling this setting.",
    minimumDelayDays:
      POP3_MIN_SERVER_DELETE_DELAY_DAYS,
    archiveMappingNotice:
      "InboxPilot Archive never maps to POP3 DELE.",
  };
}
