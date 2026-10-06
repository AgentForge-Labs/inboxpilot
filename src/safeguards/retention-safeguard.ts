import type {
  RetentionJob,
  RetentionPolicyDecision,
  RetentionPolicyRevalidator,
} from "../retention/retention-types.js";
import type { CanonicalMessage } from "../domain/email-model.js";
import {
  NeverAutoDeleteProtectionService,
} from "./safeguard-service.js";

export class SafeguardedRetentionPolicyRevalidator
  implements RetentionPolicyRevalidator
{
  constructor(
    private readonly protection: NeverAutoDeleteProtectionService,
    private readonly delegate: RetentionPolicyRevalidator,
  ) {}

  async evaluate(
    message: CanonicalMessage,
    action: "trash" | "delete_permanent",
    job: RetentionJob,
  ): Promise<RetentionPolicyDecision> {
    const safeguard = await this.protection.evaluate(message);
    if (safeguard.protected) {
      return {
        allowed: false,
        policyId: job.policyId,
        reason:
          "Never Auto Delete safeguard: " +
          safeguard.reasons
            .map((reason) => reason.code)
            .join(", "),
      };
    }
    return this.delegate.evaluate(message, action, job);
  }
}
