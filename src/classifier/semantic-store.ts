import type {
  CanonicalMessage,
} from "../domain/email-model.js";
import type {
  SemanticCostEvent,
  SemanticCostTelemetry,
  SemanticQuotaLedger,
} from "./semantic-types.js";

function messageKey(message: CanonicalMessage): string {
  return [
    message.tenantId,
    message.accountId,
    message.provider.kind,
    message.provider.messageId,
  ].join("\u0000");
}

export class InMemorySemanticCostTelemetry
  implements SemanticCostTelemetry
{
  readonly events: SemanticCostEvent[] = [];

  async append(event: SemanticCostEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async exportAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<SemanticCostEvent[]> {
    return this.events
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.accountId === accountId,
      )
      .map((event) => structuredClone(event));
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

export class InMemorySemanticQuotaLedger
  implements SemanticQuotaLedger
{
  readonly charged = new Set<string>();

  async chargeUnique(message: CanonicalMessage): Promise<boolean> {
    const key = messageKey(message);
    if (this.charged.has(key)) return false;
    this.charged.add(key);
    return true;
  }

  async deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    const prefix = tenantId + "\u0000" + accountId + "\u0000";
    let deleted = 0;
    for (const key of [...this.charged]) {
      if (key.startsWith(prefix)) {
        this.charged.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}
