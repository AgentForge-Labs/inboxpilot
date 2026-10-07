import type {
  AttachmentExtractionAuditEvent,
  AttachmentExtractionAuditSink,
} from "./attachment-types.js";

export class InMemoryAttachmentExtractionAuditSink
  implements AttachmentExtractionAuditSink
{
  readonly events: AttachmentExtractionAuditEvent[] = [];

  async append(
    event: AttachmentExtractionAuditEvent,
  ): Promise<void> {
    this.events.push(structuredClone(event));
  }
}
