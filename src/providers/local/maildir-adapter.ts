import { watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  access,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import type {
  CanonicalMessage,
  CanonicalThread,
  ClassificationState,
  MailboxRole,
} from "../../domain/email-model.js";
import { BaseProviderAdapter } from "../base-provider-adapter.js";
import type {
  MessageMoveTarget,
  ProviderConnectResult,
  ProviderConnectionContext,
  ProviderFolder,
  SyncChangesRequest,
  SyncChangesResult,
} from "../provider-adapter.js";
import {
  assertSafeExistingPath,
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

function flagsFromName(name: string): Set<string> {
  const marker = name.indexOf(":2,");
  if (marker < 0) return new Set();
  return new Set(name.slice(marker + 3).split("").filter(Boolean));
}

function nameWithFlags(name: string, flags: Set<string>): string {
  const base = name.split(":2,")[0]!;
  return `${base}:2,${[...flags].sort().join("")}`;
}

export class MaildirAdapter extends BaseProviderAdapter {
  private context: ProviderConnectionContext | undefined;
  private root = "";
  private source = "";
  private readonly index = new Map<string, LocalSourceEntry>();
  private readonly state: LocalStateStore;

  constructor(private readonly config: LocalMailboxConfig) {
    super("maildir", [
      "listFolders",
      "syncChanges",
      "getMessage",
      ...(config.writable ? (["markRead", "star"] as const) : []),
      ...(config.allowDestructive
        ? ([
            "move",
            ...(config.archivePath ? ["archive"] as const : []),
            ...(config.trashPath ? ["trash"] as const : []),
            "restore",
            "deletePermanent",
          ] as const)
        : []),
    ]);
    this.state = new LocalStateStore(config.statePath);
  }

  protected async onConnect(
    context: ProviderConnectionContext,
  ): Promise<ProviderConnectResult> {
    const validated = await validateLocalMailboxConfig(this.config);
    const info = await stat(validated.source);
    if (!info.isDirectory()) {
      throw new TypeError("Maildir sourcePath must be a directory");
    }

    for (const child of ["cur", "new"]) {
      const path = join(validated.source, child);
      const childInfo = await stat(path);
      if (!childInfo.isDirectory()) {
        throw new TypeError(`Maildir is missing ${child}/ directory`);
      }
      await access(path, constants.R_OK);
    }

    await this.state.load();
    this.context = context;
    this.root = validated.root;
    this.source = validated.source;
    return {
      connected: true,
      provider: "maildir",
      accountExternalId: validated.source,
    };
  }

  private requireContext(): ProviderConnectionContext {
    this.assertConnected();
    if (!this.context) throw new Error("Maildir context is unavailable");
    return this.context;
  }

  private async scan(): Promise<LocalSourceEntry[]> {
    this.assertConnected();
    const entries: LocalSourceEntry[] = [];
    this.index.clear();

    for (const folder of ["cur", "new"] as const) {
      const directory = join(this.source, folder);
      for (const name of (await readdir(directory)).sort()) {
        const candidate = join(directory, name);
        const safePath = await assertSafeExistingPath(this.root, candidate);
        const info = await stat(safePath);
        if (!info.isFile()) continue;

        const raw = await readFile(safePath);
        const fingerprint = contentFingerprint(raw);
        const providerId = `maildir:${fingerprint}`;
        const entry: LocalSourceEntry = {
          providerId,
          fingerprint,
          sourcePath: safePath,
          raw,
          receivedHint: info.mtime,
          flags: flagsFromName(name),
        };
        entries.push(entry);
        this.index.set(providerId, entry);
      }
    }

    return entries;
  }

  override async listFolders(): Promise<ProviderFolder[]> {
    this.assertConnected();
    const folders: ProviderFolder[] = [{
      id: `maildir:${this.source}`,
      displayName: "Inbox",
      role: "inbox",
      providerFolderId: this.source,
    }];

    if (this.config.archivePath) {
      folders.push({
        id: `maildir:${this.config.archivePath}`,
        displayName: "Archive",
        role: "archive",
        providerFolderId: this.config.archivePath,
      });
    }
    if (this.config.trashPath) {
      folders.push({
        id: `maildir:${this.config.trashPath}`,
        displayName: "Trash",
        role: "trash",
        providerFolderId: this.config.trashPath,
      });
    }
    return folders;
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
        "maildir",
        this.requireContext(),
        "inbox",
      );
      const savedClassification = await this.state.classification(entry.providerId);
      if (savedClassification) message.classification = savedClassification;
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
    if (!entry) throw new Error("Maildir message not found");
    return entry;
  }

  override async getMessage(providerMessageId: string): Promise<CanonicalMessage> {
    this.assertCapability("getMessage");
    const entry = await this.entry(providerMessageId);
    const message = await normalizeLocalMessage(
      entry,
      "maildir",
      this.requireContext(),
      "inbox",
    );
    const savedClassification = await this.state.classification(providerMessageId);
    if (savedClassification) message.classification = savedClassification;
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

  private async renameFlags(
    providerMessageId: string,
    mutate: (flags: Set<string>) => void,
  ): Promise<void> {
    const entry = await this.entry(providerMessageId);
    const oldPath = entry.sourcePath;
    const flags = flagsFromName(basename(oldPath));
    mutate(flags);
    const newPath = join(dirname(oldPath), nameWithFlags(basename(oldPath), flags));
    if (newPath !== oldPath) {
      await rename(oldPath, newPath);
      entry.sourcePath = newPath;
      entry.flags = flags;
      this.index.set(providerMessageId, entry);
    }
  }

  override async markRead(providerMessageId: string, read = true): Promise<void> {
    this.assertCapability("markRead");
    await this.renameFlags(providerMessageId, (flags) => {
      if (read) flags.add("S");
      else flags.delete("S");
    });
  }

  override async star(providerMessageId: string, starred = true): Promise<void> {
    this.assertCapability("star");
    await this.renameFlags(providerMessageId, (flags) => {
      if (starred) flags.add("F");
      else flags.delete("F");
    });
  }

  private async moveTo(providerMessageId: string, destinationRoot: string): Promise<void> {
    const entry = await this.entry(providerMessageId);
    const safeDestination = await assertSafeExistingPath(this.root, destinationRoot);
    const cur = await assertSafeExistingPath(this.root, join(safeDestination, "cur"));
    const destination = join(cur, basename(entry.sourcePath));
    await rename(entry.sourcePath, destination);
    entry.sourcePath = destination;
    this.index.set(providerMessageId, entry);
  }

  override async move(
    providerMessageId: string,
    target: MessageMoveTarget,
  ): Promise<void> {
    this.assertCapability("move");
    const path = target.folderId.replace(/^maildir:/, "");
    if (!path || !path.startsWith("/")) {
      throw new TypeError("Maildir move requires an absolute target inside allowedRoot");
    }
    await this.moveTo(providerMessageId, path);
  }

  override async archive(providerMessageId: string): Promise<void> {
    this.assertCapability("archive");
    if (!this.config.archivePath) throw new Error("Archive path is not configured");
    await this.moveTo(providerMessageId, this.config.archivePath);
  }

  override async trash(providerMessageId: string): Promise<void> {
    this.assertCapability("trash");
    if (!this.config.trashPath) throw new Error("Trash path is not configured");
    await this.moveTo(providerMessageId, this.config.trashPath);
  }

  override async restore(providerMessageId: string): Promise<void> {
    this.assertCapability("restore");
    await this.moveTo(providerMessageId, this.source);
  }

  override async deletePermanent(providerMessageId: string): Promise<void> {
    this.assertCapability("deletePermanent");
    const entry = await this.entry(providerMessageId);
    await unlink(entry.sourcePath);
    this.index.delete(providerMessageId);
  }

  async waitForChange(timeoutMs = 60_000): Promise<boolean> {
    this.assertConnected();
    return new Promise<boolean>((resolve) => {
      const watchers = [
        watch(join(this.source, "cur")),
        watch(join(this.source, "new")),
      ];
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        for (const watcher of watchers) watcher.close();
        clearTimeout(timer);
        resolve(value);
      };
      for (const watcher of watchers) {
        watcher.once("change", () => finish(true));
        watcher.once("error", () => finish(false));
      }
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
    });
  }
}
