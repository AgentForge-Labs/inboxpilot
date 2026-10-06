import type { CanonicalMessage } from "../domain/email-model.js";
import type {
  RetentionJob,
  RetentionPolicyDecision,
  RetentionPolicyRevalidator,
} from "../retention/retention-types.js";
import {
  ShadowModeService,
} from "./shadow-mode-service.js";

export class ShadowModeRetentionPolicyRevalidator
  implements RetentionPolicyRevalidator
{
  constructor(
    private readonly shadow: ShadowModeService,
    private readonly delegate: RetentionPolicyRevalidator,
  ) {}

  async evaluate(
    message: CanonicalMessage,
    action: "trash" | "delete_permanent",
    job: RetentionJob,
  ): Promise<RetentionPolicyDecision> {
    const state = await this.shadow.getState(
      message.tenantId,
      message.accountId,
    );
    if (state.status !== "enabled") {
      return {
        allowed: false,
        policyId: job.policyId,
        reason:
          state.status === "shadow"
            ? "Shadow Mode blocks destructive retention automation during the seven-day review period"
            : "Shadow Mode review is complete but Enable Automation has not been explicitly confirmed",
      };
    }

    return this.delegate.evaluate(message, action, job);
  }
}
