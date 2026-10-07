import type {
  CanonicalAttachment,
  CanonicalMessage,
} from "../../domain/email-model.js";
import type {
  DeterministicImportanceResult,
} from "../importance-engine.js";
import {
  AttachmentExtractionPolicy,
  attachmentContentType,
  isSafeInlineTextType,
  isSandboxDocumentType,
} from "./attachment-policy.js";
import type {
  AttachmentClassificationEnricher,
  AttachmentContentSource,
  AttachmentEnrichmentResult,
  AttachmentExtractionAuditSink,
  AttachmentExtractionDecision,
  AttachmentExtractionReason,
  SandboxedAttachmentExtractor,
} from "./attachment-types.js";
import {
  ATTACHMENT_EXTRACTION_POLICY_VERSION,
} from "./attachment-types.js";

class AttachmentExtractorTimeoutError extends Error {
  constructor() {
    super("Attachment extractor timed out");
    this.name = "AttachmentExtractorTimeoutError";
  }
}

function assertSandboxSecurityProfile(
  extractor: SandboxedAttachmentExtractor,
): void {
  const profile = extractor.securityProfile as {
    isolatedProcess?: unknown;
    networkAccess?: unknown;
    macroExecution?: unknown;
    scriptExecution?: unknown;
    filesystem?: unknown;
  };

  if (
    profile.isolatedProcess !== true ||
    profile.networkAccess !== false ||
    profile.macroExecution !== false ||
    profile.scriptExecution !== false ||
    profile.filesystem !== "ephemeral"
  ) {
    throw new TypeError(
      "Sandboxed attachment extractor must enforce isolated process, no network, no macro/script execution, and ephemeral filesystem",
    );
  }
}

function clampText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const normalized = value.replace(/\u0000/g, "").trim();
  if (normalized.length <= maxChars) {
    return {
      text: normalized,
      truncated: false,
    };
  }
  return {
    text: normalized.slice(0, maxChars),
    truncated: true,
  };
}

function safeUtf8Decode(bytes: Buffer): string {
  return new TextDecoder("utf-8", {
    fatal: false,
    ignoreBOM: true,
  }).decode(bytes);
}

export class SafeAttachmentClassificationEnricher
  implements AttachmentClassificationEnricher
{
  constructor(
    private readonly source: AttachmentContentSource,
    readonly policy: AttachmentExtractionPolicy,
    private readonly audit: AttachmentExtractionAuditSink,
    private readonly sandbox?: SandboxedAttachmentExtractor,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (sandbox) {
      assertSandboxSecurityProfile(sandbox);
    }
  }

  async enrich(
    message: CanonicalMessage,
    deterministic: DeterministicImportanceResult,
  ): Promise<AttachmentEnrichmentResult> {
    const decisions: AttachmentExtractionDecision[] = [];
    const extracted: AttachmentEnrichmentResult["extracted"] = [];
    let totalExtractedChars = 0;
    let eligibleCount = 0;

    if (
      !this.policy.classificationValueJustified(
        message,
        deterministic,
      )
    ) {
      for (const attachment of message.attachments) {
        await this.record(
          message,
          attachment,
          {
            attachmentId: attachment.id,
            status: "skipped",
            reason: "classification_value_not_justified",
            ...(attachment.contentType
              ? { contentType: attachment.contentType }
              : {}),
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
          decisions,
        );
      }
      return {
        policyVersion:
          ATTACHMENT_EXTRACTION_POLICY_VERSION,
        transient: true,
        extracted,
        decisions,
        totalExtractedChars,
      };
    }

    for (const attachment of message.attachments) {
      const assessment =
        this.policy.assessAttachment(attachment);
      if (!assessment.eligible) {
        await this.record(
          message,
          attachment,
          {
            attachmentId: attachment.id,
            status: "skipped",
            reason: assessment.reason,
            ...(attachment.contentType
              ? { contentType: attachment.contentType }
              : {}),
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
          decisions,
        );
        continue;
      }

      if (
        eligibleCount >=
        this.policy.maxAttachmentsPerMessage
      ) {
        await this.record(
          message,
          attachment,
          {
            attachmentId: attachment.id,
            status: "skipped",
            reason: "attachment_limit_reached",
            contentType: assessment.contentType,
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
          decisions,
        );
        continue;
      }
      eligibleCount += 1;

      const remaining =
        this.policy.maxTotalExtractedChars -
        totalExtractedChars;
      if (remaining <= 0) {
        await this.record(
          message,
          attachment,
          {
            attachmentId: attachment.id,
            status: "skipped",
            reason: "total_character_limit_reached",
            contentType: assessment.contentType,
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
          decisions,
        );
        continue;
      }

      if (
        isSandboxDocumentType(assessment.contentType) &&
        (!this.sandbox ||
          !this.sandbox.supports(assessment.contentType))
      ) {
        await this.record(
          message,
          attachment,
          {
            attachmentId: attachment.id,
            status: "skipped",
            reason: "sandbox_unavailable",
            contentType: assessment.contentType,
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
          decisions,
        );
        continue;
      }

      let bytes: Buffer | undefined;
      try {
        try {
          bytes = await this.source.load(
            message,
            attachment,
            this.policy.maxAttachmentBytes,
          );
        } catch {
          await this.record(
            message,
            attachment,
            {
              attachmentId: attachment.id,
              status: "failed",
              reason: "source_error",
              contentType: assessment.contentType,
              ...(attachment.sizeBytes !== undefined
                ? { sizeBytes: attachment.sizeBytes }
                : {}),
            },
            decisions,
          );
          continue;
        }

        if (
          !Buffer.isBuffer(bytes) ||
          bytes.length > this.policy.maxAttachmentBytes
        ) {
          throw new RangeError(
            "Attachment source exceeded maximum byte budget",
          );
        }

        const maxChars = Math.min(
          remaining,
          this.policy.maxExtractedCharsPerAttachment,
        );
        const rawText = await this.extractText(
          bytes,
          attachment,
          assessment.contentType,
          maxChars,
        );
        const bounded = clampText(rawText, maxChars);
        if (!bounded.text) {
          await this.record(
            message,
            attachment,
            {
              attachmentId: attachment.id,
              status: "failed",
              reason: "empty_extraction",
              contentType: assessment.contentType,
              ...(attachment.sizeBytes !== undefined
                ? { sizeBytes: attachment.sizeBytes }
                : {}),
            },
            decisions,
          );
          continue;
        }

        extracted.push({
          attachmentId: attachment.id,
          contentType: assessment.contentType,
          text: bounded.text,
          truncated: bounded.truncated,
        });
        totalExtractedChars += bounded.text.length;

        await this.record(
          message,
          attachment,
          {
            attachmentId: attachment.id,
            status: "extracted",
            contentType: assessment.contentType,
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
            extractedChars: bounded.text.length,
            truncated: bounded.truncated,
          },
          decisions,
        );
      } catch (error) {
        const reason = this.reasonForError(error);
        await this.record(
          message,
          attachment,
          {
            attachmentId: attachment.id,
            status: "failed",
            reason,
            contentType: assessment.contentType,
            ...(attachment.sizeBytes !== undefined
              ? { sizeBytes: attachment.sizeBytes }
              : {}),
          },
          decisions,
        );
      } finally {
        if (bytes) {
          bytes.fill(0);
        }
      }
    }

    return {
      policyVersion:
        ATTACHMENT_EXTRACTION_POLICY_VERSION,
      transient: true,
      extracted,
      decisions,
      totalExtractedChars,
    };
  }

  private async extractText(
    bytes: Buffer,
    attachment: CanonicalAttachment,
    contentType: string,
    maxChars: number,
  ): Promise<string> {
    if (isSafeInlineTextType(contentType)) {
      return safeUtf8Decode(bytes);
    }

    if (!isSandboxDocumentType(contentType)) {
      throw new Error(
        "Attachment type is not extractable",
      );
    }
    if (
      !this.sandbox ||
      !this.sandbox.supports(contentType)
    ) {
      const error = new Error(
        "Sandbox extractor unavailable",
      );
      error.name = "SandboxUnavailableError";
      throw error;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new AttachmentExtractorTimeoutError());
      }, this.policy.extractorTimeoutMs);
    });

    try {
      return await Promise.race([
        this.sandbox.extract({
          bytes,
          ...(attachment.filename
            ? { filename: attachment.filename }
            : {}),
          contentType,
          maxOutputChars: maxChars,
          signal: controller.signal,
        }),
        timer,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.abort();
    }
  }

  private reasonForError(
    error: unknown,
  ): AttachmentExtractionReason {
    if (
      error instanceof AttachmentExtractorTimeoutError
    ) {
      return "extractor_timeout";
    }
    if (
      error instanceof Error &&
      error.name === "SandboxUnavailableError"
    ) {
      return "sandbox_unavailable";
    }
    if (
      error instanceof RangeError &&
      /byte budget/i.test(error.message)
    ) {
      return "size_limit_exceeded";
    }
    if (
      error instanceof Error &&
      /source/i.test(error.message)
    ) {
      return "source_error";
    }
    return "extractor_error";
  }

  private async record(
    message: CanonicalMessage,
    attachment: CanonicalAttachment,
    decision: AttachmentExtractionDecision,
    decisions: AttachmentExtractionDecision[],
  ): Promise<void> {
    decisions.push(structuredClone(decision));
    await this.audit.append({
      tenantId: message.tenantId,
      accountId: message.accountId,
      providerMessageId: message.provider.messageId,
      attachmentId: attachment.id,
      status: decision.status,
      ...(decision.reason
        ? { reason: decision.reason }
        : {}),
      ...(decision.contentType
        ? { contentType: decision.contentType }
        : {}),
      ...(decision.sizeBytes !== undefined
        ? { sizeBytes: decision.sizeBytes }
        : {}),
      ...(decision.extractedChars !== undefined
        ? { extractedChars: decision.extractedChars }
        : {}),
      ...(decision.truncated !== undefined
        ? { truncated: decision.truncated }
        : {}),
      timestamp: this.now().toISOString(),
      contentPersisted: false,
    });
  }
}

export function attachmentEnrichmentSummary(
  result: AttachmentEnrichmentResult,
) {
  return {
    attempted: result.decisions.filter(
      (decision) => decision.status !== "skipped",
    ).length,
    extracted: result.decisions.filter(
      (decision) => decision.status === "extracted",
    ).length,
    skipped: result.decisions.filter(
      (decision) => decision.status === "skipped",
    ).length,
    failed: result.decisions.filter(
      (decision) => decision.status === "failed",
    ).length,
    totalExtractedChars: result.totalExtractedChars,
    transient: true as const,
  };
}
