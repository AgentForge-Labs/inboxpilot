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
}
