import { stat, readFile } from "node:fs/promises";
import type {
  CanonicalMessage,
  CanonicalThread,
  ClassificationState,
} from "../../domain/email-model.js";
import { BaseProviderAdapter } from "../base-provider-adapter.js";
import type {
  ProviderConnectResult,
  ProviderConnectionContext,
  ProviderFolder,
  SyncChangesRequest,
  SyncChangesResult,
} from "../provider-adapter.js";
import {
  LocalStateStore,
  validateLocalMailboxConfig,
} from "./local-fs.js";
import {
  contentFingerprint,
  normalizeLocalMessage,
} from "./local-normalizer.js";
import type {
  LocalMailboxConfig,
  LocalSourceEntry,
} from "./local-types.js";

export function splitMbox(raw: Buffer): Buffer[] {
  const text = raw.toString("utf8");
  const starts: number[] = [];
  const re = /(^|\n)From [^\n]*\n/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    starts.push(match.index + (match[1] ? 1 : 0));
  }
  if (!starts.length) return text.trim() ? [raw] : [];

  const messages: Buffer[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = starts[index + 1] ?? text.length;
    const block = text.slice(start, end);
    const firstNewline = block.indexOf("\n");
    const rfc822 = firstNewline >= 0 ? block.slice(firstNewline + 1) : "";
    if (rfc822.trim()) messages.push(Buffer.from(rfc822, "utf8"));
  }
  return messages;
}

export class MboxAdapter extends BaseProviderAdapter {
  private context: ProviderConnectionContext | undefined;
  private source = "";
  private readonly state: LocalStateStore;
  private readonly index = new Map<string, LocalSourceEntry>();

  constructor(private readonly config: LocalMailboxConfig) {
    super("mbox", ["listFolders", "syncChanges", "getMessage"]);
    this.state = new LocalStateStore(config.statePath);
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    if (this.config.writable || this.config.allowDestructive) {
      throw new Error("mbox adapter is import/read-only");
    }
    const validated = await validateLocalMailboxConfig(this.config);
    const info = await stat(validated.source);
    if (!info.isFile()) throw new TypeError("mbox sourcePath must be a file");
    await this.state.load();
    this.context = context;
    this.source = validated.source;
    return {
      connected: true,
      provider: "mbox",
      accountExternalId: validated.source,
    };
  }

  private requireContext(): ProviderConnectionContext {
    this.assertConnected();
    if (!this.context) throw new Error("mbox context is unavailable");
    return this.context;
  }

  private async scan(): Promise<LocalSourceEntry[]> {
    const raw = await readFile(this.source);
    const blocks = splitMbox(raw);
    const occurrences = new Map<string, number>();
    const entries: LocalSourceEntry[] = [];
    this.index.clear();

    for (const block of blocks) {
      const fingerprint = contentFingerprint(block);
      const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
      occurrences.set(fingerprint, occurrence);
      const providerId = `mbox:${fingerprint}:${occurrence}`;
      const entry: LocalSourceEntry = {
        providerId,
        fingerprint,
        sourcePath: this.source,
        raw: block,
      };
      entries.push(entry);
      this.index.set(providerId, entry);
    }
    return entries;
  }

  override async listFolders(): Promise<ProviderFolder[]> {
    this.assertConnected();
    return [{
      id: "mbox:inbox",
      displayName: "Imported mailbox",
      role: "inbox",
      providerFolderId: this.source,
    }];
  }

  override async syncChanges(
    request: SyncChangesRequest = {},
  ): Promise<SyncChangesResult> {
    this.assertCapability("syncChanges");
    const limit = Math.max(1, Math.min(request.limit ?? 100, 500));
    const unseen: LocalSourceEntry[] = [];
    for (const entry of await this.scan()) {
      if (!(await this.state.hasSeen(entry.providerId, entry.fingerprint))) {
        unseen.push(entry);
      }
    }

    const selected = unseen.slice(0, limit);
    const messages: CanonicalMessage[] = [];
    for (const entry of selected) {
      const message = await normalizeLocalMessage(
        entry,
        "mbox",
        this.requireContext(),
        "inbox",
      );
      const classification = await this.state.classification(entry.providerId);
      if (classification) message.classification = classification;
      messages.push(message);
      await this.state.markSeen(entry.providerId, entry.fingerprint);
    }

    return {
      messages,
      deletedProviderMessageIds: [],
      nextCursor: `local-state-v1:${Date.now()}`,
      hasMore: unseen.length > selected.length,
    };
  }

  private async entry(providerMessageId: string): Promise<LocalSourceEntry> {
    let entry = this.index.get(providerMessageId);
    if (!entry) {
      await this.scan();
      entry = this.index.get(providerMessageId);
    }
    if (!entry) throw new Error("mbox message not found");
    return entry;
  }

  override async getMessage(providerMessageId: string): Promise<CanonicalMessage> {
    this.assertCapability("getMessage");
    const entry = await this.entry(providerMessageId);
    const message = await normalizeLocalMessage(
      entry,
      "mbox",
      this.requireContext(),
      "inbox",
    );
    const classification = await this.state.classification(providerMessageId);
    if (classification) message.classification = classification;
    return message;
  }

  override async getThread(_providerThreadId: string): Promise<CanonicalThread> {
    return this.unsupported("getThread");
  }

  async setClassification(
    providerMessageId: string,
    classification: ClassificationState,
  ): Promise<void> {
    await this.entry(providerMessageId);
    await this.state.setClassification(providerMessageId, classification);
  }

  async getStoredClassification(
    providerMessageId: string,
  ): Promise<ClassificationState | undefined> {
    return this.state.classification(providerMessageId);
  }
}
