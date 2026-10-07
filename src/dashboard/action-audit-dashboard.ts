import type {
  ExplainabilityAuditEvent,
  ExplainabilityAuditStore,
} from "../audit/audit-types.js";

export interface ActionAuditDashboardRow {
  eventId: string;
  timestamp: string;
  kind: ExplainabilityAuditEvent["kind"];
  actorLabel: string;
  messageLabel: string;
  classifierLabel?: string;
  ruleLabel?: string;
  requestedAction?: string;
  executedAction?: string;
  outcome: string;
  reasons: string[];
  stateChangeLabel?: string;
}

export interface ActionAuditDashboardView {
  title: "Action Audit";
  count: number;
  rows: ActionAuditDashboardRow[];
}

function mailboxStateLabel(
  event: ExplainabilityAuditEvent,
): string | undefined {
  if (!event.beforeState && !event.afterState) return undefined;

  const before = event.beforeState
    ? [
        event.beforeState.retention.stage,
        ...event.beforeState.mailboxRoles,
      ].join("/")
    : "unknown";
  const after =
    event.afterStateStatus === "deleted"
      ? "deleted"
      : event.afterState
        ? [
            event.afterState.retention.stage,
            ...event.afterState.mailboxRoles,
          ].join("/")
        : event.afterStateStatus ?? "unavailable";

  return before + " → " + after;
}

export function buildActionAuditDashboardView(
  events: readonly ExplainabilityAuditEvent[],
): ActionAuditDashboardView {
  return {
    title: "Action Audit",
    count: events.length,
    rows: events.map((event) => {
      const stateLabel = mailboxStateLabel(event);
      return {
      eventId: event.eventId,
      timestamp: event.timestamp,
      kind: event.kind,
      actorLabel:
        event.actor.id
          ? event.actor.type + ":" + event.actor.id
          : event.actor.type,
      messageLabel:
        event.provider + ":" + event.providerMessageId,
      ...(event.classifier
        ? {
            classifierLabel:
              String(event.classifier.importanceScore) +
              " · " +
              event.classifier.categories.join(", ") +
              " · confidence " +
              String(event.classifier.confidence),
          }
        : {}),
      ...(event.matchedRule
        ? {
            ruleLabel:
              event.matchedRule.overrideId
                ? event.matchedRule.policyId +
                  " / " +
                  event.matchedRule.overrideId
                : event.matchedRule.policyId,
          }
        : {}),
      ...(event.requestedAction
        ? {
            requestedAction:
              event.requestedAction.type,
          }
        : {}),
      ...(event.executedAction
        ? {
            executedAction:
              event.executedAction.type,
          }
        : {}),
      outcome: event.outcome,
      reasons: [
        ...event.policyReasons,
        ...event.signals.map((signal) => signal.code),
      ],
      ...(stateLabel
        ? { stateChangeLabel: stateLabel }
        : {}),
      };
    }),
  };
}

export class ActionAuditDashboardService {
  constructor(
    private readonly store: ExplainabilityAuditStore,
  ) {}

  async accountTimeline(
    tenantId: string,
    accountId: string,
    limit = 200,
  ): Promise<ActionAuditDashboardView> {
    return buildActionAuditDashboardView(
      await this.store.listForAccount(
        tenantId,
        accountId,
        limit,
      ),
    );
  }

  async explainMessage(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
  ): Promise<ActionAuditDashboardView> {
    return buildActionAuditDashboardView(
      await this.store.listForMessage(
        tenantId,
        accountId,
        providerMessageId,
      ),
    );
  }
}
