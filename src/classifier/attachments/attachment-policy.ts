import type {
  CanonicalAttachment,
  CanonicalMessage,
} from "../../domain/email-model.js";
import type {
  DeterministicImportanceResult,
} from "../importance-engine.js";
import type {
  AttachmentExtractionPolicyConfig,
  AttachmentExtractionPolicyDecision,
} from "./attachment-types.js";

const VALUE_CATEGORIES = new Set([
  "finance",
  "invoice",
  "receipt",
  "legal",
  "government",
  "travel",
]);

const DOCUMENT_SIGNAL =
  /\b(?:invoice|rechnung|receipt|quittung|booking|reservation|ticket|boarding|itinerary|reise|buchung|contract|vertrag|legal|notice|statement|tax|steuer|visa|permit|bescheid|faktura)\b/i;

const SAFE_TEXT_TYPES = new Set([
  "text/plain",
  "text/csv",
]);

const SANDBOX_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

const DANGEROUS_EXTENSIONS = new Set([
  ".exe",
  ".com",
  ".scr",
  ".msi",
  ".dll",
  ".bat",
  ".cmd",
  ".ps1",
  ".sh",
  ".js",
  ".mjs",
  ".cjs",
  ".jar",
  ".html",
  ".htm",
  ".svg",
  ".zip",
  ".rar",
  ".7z",
  ".dmg",
  ".iso",
  ".docm",
  ".xlsm",
  ".pptm",
  ".xlam",
  ".dotm",
]);

const DANGEROUS_CONTENT_TYPES = new Set([
  "application/javascript",
  "text/javascript",
  "text/html",
  "image/svg+xml",
  "application/zip",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/vnd.ms-word.document.macroenabled.12",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
]);

function normalizedContentType(
  attachment: CanonicalAttachment,
): string | undefined {
  const value = attachment.contentType
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  return value || undefined;
}

function extension(filename: string | undefined): string {
  const value = filename?.trim().toLowerCase() ?? "";
  const dot = value.lastIndexOf(".");
  return dot >= 0 ? value.slice(dot) : "";
}

export function isDangerousAttachment(
  attachment: CanonicalAttachment,
): boolean {
  const ext = extension(attachment.filename);
  const type = normalizedContentType(attachment);
  return (
    DANGEROUS_EXTENSIONS.has(ext) ||
    (type !== undefined &&
      DANGEROUS_CONTENT_TYPES.has(type))
  );
}

export function isSafeInlineTextType(
  contentType: string,
): boolean {
  return SAFE_TEXT_TYPES.has(contentType);
}

export function isSandboxDocumentType(
  contentType: string,
): boolean {
  return SANDBOX_TYPES.has(contentType);
}

export function isAllowedAttachmentType(
  contentType: string,
): boolean {
  return (
    isSafeInlineTextType(contentType) ||
    isSandboxDocumentType(contentType)
  );
}

export function attachmentContentType(
  attachment: CanonicalAttachment,
): string | undefined {
  return normalizedContentType(attachment);
}

function classificationValueSignal(
  message: CanonicalMessage,
  deterministic: DeterministicImportanceResult,
): boolean {
  if (
    deterministic.categoryHints.some((category) =>
      VALUE_CATEGORIES.has(category),
    )
  ) {
    return true;
  }

  const attachmentText = message.attachments
    .map((attachment) => attachment.filename ?? "")
    .join("\n");
  const messageText = [
    message.subject,
    message.snippet ?? "",
    message.body.text?.slice(0, 4000) ?? "",
    attachmentText,
  ].join("\n");

  return DOCUMENT_SIGNAL.test(messageText);
}

export class AttachmentExtractionPolicy {
  readonly maxAttachmentBytes: number;
  readonly maxAttachmentsPerMessage: number;
  readonly maxExtractedCharsPerAttachment: number;
  readonly maxTotalExtractedChars: number;
  readonly extractorTimeoutMs: number;
  readonly allowUnknownSize: boolean;

  constructor(
    config: AttachmentExtractionPolicyConfig = {},
  ) {
    this.maxAttachmentBytes = Math.max(
      1024,
      Math.min(
        config.maxAttachmentBytes ?? 5 * 1024 * 1024,
        25 * 1024 * 1024,
      ),
    );
    this.maxAttachmentsPerMessage = Math.max(
      1,
      Math.min(config.maxAttachmentsPerMessage ?? 3, 10),
    );
    this.maxExtractedCharsPerAttachment = Math.max(
      500,
      Math.min(
        config.maxExtractedCharsPerAttachment ?? 12_000,
        50_000,
      ),
    );
    this.maxTotalExtractedChars = Math.max(
      this.maxExtractedCharsPerAttachment,
      Math.min(
        config.maxTotalExtractedChars ?? 24_000,
        100_000,
      ),
    );
    this.extractorTimeoutMs = Math.max(
      250,
      Math.min(config.extractorTimeoutMs ?? 3000, 15_000),
    );
    this.allowUnknownSize =
      config.allowUnknownSize === true;
  }

  classificationValueJustified(
    message: CanonicalMessage,
    deterministic: DeterministicImportanceResult,
  ): boolean {
    return (
      deterministic.needsLlm &&
      classificationValueSignal(message, deterministic)
    );
  }

  assessAttachment(
    attachment: CanonicalAttachment,
  ):
    | { eligible: true; contentType: string }
    | {
        eligible: false;
        reason:
          | "inline_attachment"
          | "dangerous_extension"
          | "missing_content_type"
          | "content_type_not_allowed"
          | "size_unknown"
          | "size_limit_exceeded";
      } {
    if (attachment.inline) {
      return {
        eligible: false,
        reason: "inline_attachment",
      };
    }
    if (isDangerousAttachment(attachment)) {
      return {
        eligible: false,
        reason: "dangerous_extension",
      };
    }

    const contentType = normalizedContentType(attachment);
    if (!contentType) {
      return {
        eligible: false,
        reason: "missing_content_type",
      };
    }
    if (!isAllowedAttachmentType(contentType)) {
      return {
        eligible: false,
        reason: "content_type_not_allowed",
      };
    }
    if (attachment.sizeBytes === undefined) {
      if (!this.allowUnknownSize) {
        return {
          eligible: false,
          reason: "size_unknown",
        };
      }
    } else if (
      attachment.sizeBytes > this.maxAttachmentBytes
    ) {
      return {
        eligible: false,
        reason: "size_limit_exceeded",
      };
    }

    return {
      eligible: true,
      contentType,
    };
  }

  select(
    message: CanonicalMessage,
    deterministic: DeterministicImportanceResult,
  ): AttachmentExtractionPolicyDecision {
    if (
      !this.classificationValueJustified(
        message,
        deterministic,
      )
    ) {
      return {
        justified: false,
        reason: "classification_value_not_justified",
        candidateAttachmentIds: [],
      };
    }

    const candidates = message.attachments
      .filter(
        (attachment) =>
          this.assessAttachment(attachment).eligible,
      )
      .slice(0, this.maxAttachmentsPerMessage)
      .map((attachment) => attachment.id);

    return {
      justified: candidates.length > 0,
      ...(candidates.length === 0
        ? { reason: "content_type_not_allowed" as const }
        : {}),
      candidateAttachmentIds: candidates,
    };
  }
}
