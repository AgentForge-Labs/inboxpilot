import { constants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ClassificationState } from "../../domain/email-model.js";
import {
  defaultLocalSourceState,
  type LocalMailboxConfig,
  type LocalSourceState,
} from "./local-types.js";

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

export async function validateLocalMailboxConfig(
  config: LocalMailboxConfig,
): Promise<{ root: string; source: string; state: string }> {
  const root = await realpath(config.allowedRoot);
  const source = await realpath(config.sourcePath);
  if (!contained(root, source)) {
    throw new Error("Local mailbox source escapes allowedRoot");
  }
  await access(source, constants.R_OK);

  if (config.writable || config.allowDestructive) {
    await access(source, constants.W_OK);
  }
  if (config.allowDestructive && !config.writable) {
    throw new Error("allowDestructive requires writable=true");
  }

  const stateParent = await realpath(dirname(config.statePath));
  const state = resolve(config.statePath);
  if (!contained(root, stateParent) || !contained(root, state)) {
    throw new Error("Local mailbox state path escapes allowedRoot");
  }
  await access(stateParent, constants.W_OK);

  for (const target of [config.archivePath, config.trashPath]) {
    if (!target) continue;
    const targetReal = await realpath(target);
    if (!contained(root, targetReal)) {
      throw new Error("Local mailbox mutation target escapes allowedRoot");
    }
  }

  return { root, source, state };
}

export async function assertSafeExistingPath(
  root: string,
  candidate: string,
): Promise<string> {
  const actual = await realpath(candidate);
  if (!contained(root, actual)) {
    throw new Error("Local mailbox path escapes allowedRoot");
  }
  return actual;
}

export class LocalStateStore {
  private state: LocalSourceState = defaultLocalSourceState();
  private loaded = false;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as LocalSourceState;
      if (parsed.version !== 1) throw new Error("Unsupported local state version");
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dirname(this.path), { recursive: true });
    }
    this.loaded = true;
  }

  async hasSeen(providerId: string, fingerprint: string): Promise<boolean> {
    await this.load();
    return this.state.seen[providerId]?.fingerprint === fingerprint;
  }

  async markSeen(providerId: string, fingerprint: string): Promise<void> {
    await this.load();
    this.state.seen[providerId] = {
      fingerprint,
      lastSeenAt: new Date().toISOString(),
    };
    await this.flush();
  }

  async classification(providerId: string): Promise<ClassificationState | undefined> {
    await this.load();
    return this.state.classifications[providerId];
  }

  async setClassification(
    providerId: string,
    classification: ClassificationState,
  ): Promise<void> {
    await this.load();
    this.state.classifications[providerId] = classification;
    await this.flush();
  }

  private async flush(): Promise<void> {
    const temp = `${this.path}.tmp-${process.pid}`;
    await writeFile(temp, JSON.stringify(this.state, null, 2), {
      mode: 0o600,
    });
    await rename(temp, this.path);
  }
}
