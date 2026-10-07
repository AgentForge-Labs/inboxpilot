import type {
  PriorityBand,
} from "../domain/email-model.js";
import type {
  SemanticClassificationResult,
  SemanticClassifyInput,
} from "../classifier/semantic-types.js";

export const PRIVACY_MODE_ENVELOPE_VERSION = 1 as const;

export type PrivacyClassificationStatus =
  | "classified"
  | "needs_review"
  | "failed";

export interface PrivacyCloudClassification {
  status: PrivacyClassificationStatus;
  importanceScore: number;
  priority: PriorityBand;
  categories: string[];
  confidence: number;
  actionRequired: boolean;
  replyRequired: boolean;
  riskScore?: number;
  classifiedAt: string;
}

export interface PrivacyCloudClassificationEnvelope {
  envelopeVersion: typeof PRIVACY_MODE_ENVELOPE_VERSION;
  mode: "local_self_hosted";
  tenantId: string;
  accountId: string;
  cloudMessageId: string;
  receivedAt: string;
  classification: PrivacyCloudClassification;
}

export interface PrivacyModeDeploymentDescriptor {
  providerCredentials: "local_only";
  emailContent: "local_only";
  attachmentContent: "local_only";
  classifierExecution: "local_self_hosted";
  classifierTransport: "local_or_self_hosted_only";
  cloudSync: "classification_metadata_only";
}

export const PRIVACY_MODE_DEPLOYMENT: PrivacyModeDeploymentDescriptor = {
  providerCredentials: "local_only",
  emailContent: "local_only",
  attachmentContent: "local_only",
  classifierExecution: "local_self_hosted",
  classifierTransport: "local_or_self_hosted_only",
  cloudSync: "classification_metadata_only",
};

export interface PrivacyModeCapabilities {
  cloudMessageBodyRead: false;
  cloudFullTextSearch: false;
  cloudAttachmentRead: false;
  cloudProviderCredentials: false;
  cloudProviderMutations: false;
  cloudSenderRecipientMetadata: false;
  cloudClassificationMetadata: true;
  localClassification: true;
  localAttachmentExtraction: true;
  localAutomation: true;
}

export const PRIVACY_MODE_CAPABILITIES: PrivacyModeCapabilities = {
  cloudMessageBodyRead: false,
  cloudFullTextSearch: false,
  cloudAttachmentRead: false,
  cloudProviderCredentials: false,
  cloudProviderMutations: false,
  cloudSenderRecipientMetadata: false,
  cloudClassificationMetadata: true,
  localClassification: true,
  localAttachmentExtraction: true,
  localAutomation: true,
};

export interface PrivacyModeCloudSink {
  put(
    envelope: PrivacyCloudClassificationEnvelope,
  ): Promise<void>;
}

export interface PrivacyModeCloudStore
  extends PrivacyModeCloudSink {
  get(
    tenantId: string,
    accountId: string,
    cloudMessageId: string,
  ): Promise<PrivacyCloudClassificationEnvelope | undefined>;
  listForAccount(
    tenantId: string,
    accountId: string,
  ): Promise<PrivacyCloudClassificationEnvelope[]>;
}

export interface PrivacyModeLocalClassifier {
  readonly executionLocation: "local_self_hosted";
  classify(
    input: SemanticClassifyInput,
  ): Promise<SemanticClassificationResult>;
}

export interface PrivacyModeRunResult {
  cloudEnvelope: PrivacyCloudClassificationEnvelope;
  localClassification: SemanticClassificationResult;
}
