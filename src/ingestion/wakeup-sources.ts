import type { ProviderConnectionContext } from "../providers/provider-adapter.js";
import { imapIdleSignal, localFilesystemSignal } from "./signals.js";
import type { IngestionSignal } from "./ingestion-types.js";

export interface ImapIdleCapable {
  waitForIdleChange(mailboxPath?: string): Promise<boolean>;
}

export interface LocalWatchCapable {
  waitForChange(timeoutMs?: number): Promise<boolean>;
}

export class ImapIdleWakeupSource {
  private sequence = 0;

  constructor(
    private readonly adapter: ImapIdleCapable,
    private readonly context: ProviderConnectionContext,
    private readonly mailboxPath?: string,
  ) {}

  async wait(): Promise<IngestionSignal | null> {
    const changed = await this.adapter.waitForIdleChange(this.mailboxPath);
    if (!changed) return null;
    this.sequence += 1;
    return imapIdleSignal(
      this.context,
      `${Date.now()}:${this.sequence}`,
    );
  }
}

export class MaildirWakeupSource {
  private sequence = 0;

  constructor(
    private readonly adapter: LocalWatchCapable,
    private readonly context: ProviderConnectionContext,
    private readonly timeoutMs = 60_000,
  ) {}

  async wait(): Promise<IngestionSignal | null> {
    const changed = await this.adapter.waitForChange(this.timeoutMs);
    if (!changed) return null;
    this.sequence += 1;
    return localFilesystemSignal(
      this.context,
      "maildir",
      `${Date.now()}:${this.sequence}`,
    );
  }
}
