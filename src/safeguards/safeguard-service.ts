import type { CanonicalMessage } from "../domain/email-model.js";
import {
  evaluateNeverAutoDelete,
} from "./never-auto-delete.js";
import type {
  NeverAutoDeleteContextResolver,
  NeverAutoDeleteEvaluation,
  SafeguardOverrideStore,
} from "./safeguard-types.js";

export class NeverAutoDeleteProtectionService {
  constructor(
    private readonly store: SafeguardOverrideStore,
    private readonly contextResolver?: NeverAutoDeleteContextResolver,
  ) {}

  async evaluate(
    message: CanonicalMessage,
  ): Promise<NeverAutoDeleteEvaluation> {
    const overrides = await this.store.list(
      message.tenantId,
      message.accountId,
    );
    const context = this.contextResolver
      ? await this.contextResolver.resolve(message)
      : {};
    return evaluateNeverAutoDelete(message, {
      ...context,
      overrides,
    });
  }
}
