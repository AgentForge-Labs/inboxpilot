import type { CanonicalMessage } from "../domain/email-model.js";
import type {
  InboxDashboardMessageRepository,
} from "./inbox-dashboard-types.js";

export class InMemoryInboxDashboardMessageRepository
  implements InboxDashboardMessageRepository
{
  private readonly messages = new Map<string, CanonicalMessage>();

  seed(message: CanonicalMessage): void {
    this.messages.set(
      [
        message.tenantId,
        message.accountId,
        message.provider.kind,
        message.provider.messageId,
      ].join("\u0000"),
      structuredClone(message),
    );
  }

  async listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<CanonicalMessage[]> {
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.tenantId === tenantId &&
          message.accountId === accountId,
      )
      .map((message) => structuredClone(message));
  }
}
