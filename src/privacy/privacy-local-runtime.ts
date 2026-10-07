import type {
  SemanticClassifier,
} from "../classifier/semantic-classifier.js";
import type {
  SemanticClassifyInput,
} from "../classifier/semantic-types.js";
import {
  projectPrivacyCloudEnvelope,
} from "./privacy-envelope.js";
import {
  PRIVACY_MODE_DEPLOYMENT,
  type PrivacyModeCloudSink,
  type PrivacyModeDeploymentDescriptor,
  type PrivacyModeLocalClassifier,
  type PrivacyModeRunResult,
} from "./privacy-mode-types.js";

export function assertPrivacyModeDeployment(
  descriptor: PrivacyModeDeploymentDescriptor,
): PrivacyModeDeploymentDescriptor {
  const expected = PRIVACY_MODE_DEPLOYMENT;
  const allowed = new Set(Object.keys(expected));
  for (const key of Object.keys(descriptor)) {
    if (!allowed.has(key)) {
      throw new TypeError(
        "Privacy Mode deployment contains unknown field " +
          key,
      );
    }
  }

  for (const key of Object.keys(
    expected,
  ) as Array<keyof PrivacyModeDeploymentDescriptor>) {
    if (descriptor[key] !== expected[key]) {
      throw new TypeError(
        "Privacy Mode requires " +
          key +
          "=" +
          expected[key],
      );
    }
  }
  return { ...descriptor };
}

export class LocalSelfHostedSemanticClassifier
  implements PrivacyModeLocalClassifier
{
  readonly executionLocation =
    "local_self_hosted" as const;

  constructor(
    private readonly classifier: Pick<
      SemanticClassifier,
      "classify"
    >,
  ) {}

  async classify(input: SemanticClassifyInput) {
    return this.classifier.classify(input);
  }
}

export class PrivacyModeLocalRuntime {
  private readonly deployment: PrivacyModeDeploymentDescriptor;

  constructor(
    deployment: PrivacyModeDeploymentDescriptor,
    private readonly classifier: PrivacyModeLocalClassifier,
    private readonly cloud: PrivacyModeCloudSink,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.deployment =
      assertPrivacyModeDeployment(deployment);
    if (
      classifier.executionLocation !==
      "local_self_hosted"
    ) {
      throw new TypeError(
        "Privacy Mode classifier must execute locally/self-hosted",
      );
    }
  }

  deploymentDescriptor(): PrivacyModeDeploymentDescriptor {
    return { ...this.deployment };
  }

  async classifyAndPublish(
    input: SemanticClassifyInput,
  ): Promise<PrivacyModeRunResult> {
    const localClassification =
      await this.classifier.classify(input);

    const cloudEnvelope =
      projectPrivacyCloudEnvelope(
        input.message,
        localClassification,
        this.now,
      );

    await this.cloud.put(cloudEnvelope);

    return {
      cloudEnvelope,
      localClassification,
    };
  }
}
