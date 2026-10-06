import type { CanonicalClassifierResult } from "../classifier/classifier-contract.js";
import type { CanonicalMessage } from "../domain/email-model.js";
import {
  MailboxPolicyEngine,
} from "../policy/policy-engine.js";
import type {
  PolicyDecision,
  PolicyEngineInput,
} from "../policy/policy-types.js";
import {
  ShadowModeService,
} from "./shadow-mode-service.js";
import type {
  ShadowIntendedAction,
  ShadowModeObservation,
  ShadowPolicyEvaluation,
} from "./shadow-mode-types.js";

function intendedAction(
  decision: PolicyDecision,
): ShadowIntendedAction {
  const type = decision.plan?.action.type;
  if (type === "archive") return "archive";
  if (type === "trash") return "trash";
  if (type === "mark_important") return "mark_important";
  return "none";
}

function shouldSuppress(
  status: ShadowPolicyEvaluation["shadow"]["status"],
  decision: PolicyDecision,
): boolean {
  if (status === "enabled") return false;
  return (
    decision.plan?.action.type === "archive" ||
    decision.plan?.action.type === "trash"
  );
}

export class ShadowModePolicyCoordinator {
  constructor(
    private readonly policy: MailboxPolicyEngine,
    private readonly shadow: ShadowModeService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async evaluate(
    input: PolicyEngineInput,
  ): Promise<ShadowPolicyEvaluation> {
    const decision = this.policy.evaluate(input);
    const state = await this.shadow.getState(
      input.message.tenantId,
      input.message.accountId,
    );

    if (state.status !== "enabled") {
      await this.shadow.recordObservation(
        this.observation(
          input.message,
          input.classification,
          decision,
        ),
      );
    }

    const suppressed = shouldSuppress(
      state.status,
      decision,
    );

    return {
      shadow: state,
      decision,
      ...(decision.plan ? { intendedPlan: decision.plan } : {}),
      ...(!suppressed && decision.plan
        ? { executablePlan: decision.plan }
        : {}),
      suppressed,
    };
  }

  private observation(
    message: CanonicalMessage,
    classification: CanonicalClassifierResult,
    decision: PolicyDecision,
  ): ShadowModeObservation {
    return {
      tenantId: message.tenantId,
      accountId: message.accountId,
      canonicalMessageId: message.id,
      providerMessageId: message.provider.messageId,
      priority: classification.priority,
      policyOutcome: decision.outcome,
      intendedAction: intendedAction(decision),
      observedAt: this.now().toISOString(),
    };
  }
}
