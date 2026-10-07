import type {
  ExplainabilityAuditEvent,
  ExplainabilityAuditStore,
} from "./audit-types.js";
import {
  sanitizeAuditEvent,
} from "./audit-sanitizer.js";

export class InMemoryExplainabilityAuditStore
  implements ExplainabilityAuditStore
{
  readonly events: ExplainabilityAuditEvent[] = [];

  async append(event: ExplainabilityAuditEvent): Promise<void> {
    const sanitized = sanitizeAuditEvent(event);
    this.events.push(structuredClone(sanitized));
  }

  async listForAccount(
    tenantId: string,
    accountId: string,
    limit = 500,
  ): Promise<ExplainabilityAuditEvent[]> {
    return this.events
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.accountId === accountId,
      )
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, Math.max(0, Math.min(limit, 5000)))
      .map((event) => structuredClone(event));
  }

  async listForMessage(
    tenantId: string,
    accountId: string,
    providerMessageId: string,
  ): Promise<ExplainabilityAuditEvent[]> {
    return this.events
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.accountId === accountId &&
          event.providerMessageId === providerMessageId,
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((event) => structuredClone(event));
  }

  async listForPlan(
    tenantId: string,
    accountId: string,
    planId: string,
  ): Promise<ExplainabilityAuditEvent[]> {
    return this.events
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.accountId === accountId &&
          (event.requestedAction?.planId === planId ||
            event.executedAction?.planId === planId),
      )
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((event) => structuredClone(event));
  }

  async exportAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<ExplainabilityAuditEvent[]> {
    return this.listForAccount(
      tenantId,
      accountId,
      5000,
    );
  }

  async deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    let deleted = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index]!;
      if (
        event.tenantId === tenantId &&
        event.accountId === accountId
      ) {
        this.events.splice(index, 1);
        deleted += 1;
      }
    }
    return deleted;
  }
}
