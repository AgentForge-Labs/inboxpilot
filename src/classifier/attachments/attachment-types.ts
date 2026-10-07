import type {
  CanonicalAttachment,
  CanonicalMessage,
} from "../../domain/email-model.js";
import type {
  DeterministicImportanceResult,
} from "../importance-engine.js";

export const ATTACHMENT_EXTRACTION_POLICY_VERSION = 1 as const;

export type AttachmentExtractionStatus =
  | "extracted"
  | "skipped"
  | "failed";

export type AttachmentExtractionReason =
  | "classification_value_not_justified"
  | "inline_attachment"
  | "missing_content_type"
  | "content_type_not_allowed"
  | "dangerous_extension"
  | "size_unknown"
  | "size_limit_exceeded"
  | "attachment_limit_reached"
  | "total_character_limit_reached"
  | "sandbox_unavailable"
  | "source_error"
  | "extractor_error"
  | "extractor_timeout"
  | "empty_extraction";

export interface AttachmentExtractionText {
  attachmentId: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

export interface AttachmentExtractionDecision {
  attachmentId: string;
  status: AttachmentExtractionStatus;
  reason?: AttachmentExtractionReason;
  contentType?: string;
  sizeBytes?: number;
  extractedChars?: number;
  truncated?: boolean;
}

export interface AttachmentEnrichmentResult {
  policyVersion: typeof ATTACHMENT_EXTRACTION_POLICY_VERSION;
  transient: true;
  extracted: AttachmentExtractionText[];
  decisions: AttachmentExtractionDecision[];
  totalExtractedChars: number;
}

export interface AttachmentEnrichmentSummary {
  attempted: number;
  extracted: number;
  skipped: number;
  failed: number;
  totalExtractedChars: number;
  transient: true;
}

export interface AttachmentContentSource {
  load(
    message: CanonicalMessage,
    attachment: CanonicalAttachment,
    maxBytes: number,
  ): Promise<Buffer>;
}

export interface AttachmentSandboxSecurityProfile {
  isolatedProcess: true;
  networkAccess: false;
  macroExecution: false;
  scriptExecution: false;
  filesystem: "ephemeral";
}

export interface SandboxedAttachmentExtractionInput {
  bytes: Buffer;
  filename?: string;
  contentType: string;
  maxOutputChars: number;
  signal: AbortSignal;
}

export interface SandboxedAttachmentExtractor {
  readonly securityProfile: AttachmentSandboxSecurityProfile;
  supports(contentType: string): boolean;
  extract(
    input: SandboxedAttachmentExtractionInput,
  ): Promise<string>;
}

export interface AttachmentExtractionAuditEvent {
  tenantId: string;
  accountId: string;
  providerMessageId: string;
  attachmentId: string;
  status: AttachmentExtractionStatus;
  reason?: AttachmentExtractionReason;
  contentType?: string;
  sizeBytes?: number;
  extractedChars?: number;
  truncated?: boolean;
  timestamp: string;
  contentPersisted: false;
}

export interface AttachmentExtractionAuditSink {
  append(event: AttachmentExtractionAuditEvent): Promise<void>;
}

export interface AttachmentExtractionPolicyConfig {
  maxAttachmentBytes?: number;
  maxAttachmentsPerMessage?: number;
  maxExtractedCharsPerAttachment?: number;
  maxTotalExtractedChars?: number;
  extractorTimeoutMs?: number;
  allowUnknownSize?: boolean;
}

export interface AttachmentExtractionPolicyDecision {
  justified: boolean;
  reason?: AttachmentExtractionReason;
  candidateAttachmentIds: string[];
}

export interface AttachmentClassificationEnricher {
  enrich(
    message: CanonicalMessage,
    deterministic: DeterministicImportanceResult,
  ): Promise<AttachmentEnrichmentResult>;
}
