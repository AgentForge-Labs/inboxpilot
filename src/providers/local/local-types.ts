import type { ClassificationState } from "../../domain/email-model.js";

export interface LocalMailboxConfig {
  sourcePath: string;
  allowedRoot: string;
  statePath: string;
  writable?: boolean;
  allowDestructive?: boolean;
  archivePath?: string;
  trashPath?: string;
}

export interface LocalSourceState {
  version: 1;
  seen: Record<string, { fingerprint: string; lastSeenAt: string }>;
  classifications: Record<string, ClassificationState>;
}

export interface LocalSourceEntry {
  providerId: string;
  fingerprint: string;
  sourcePath: string;
  raw: Buffer;
  receivedHint?: Date;
  flags?: Set<string>;
}

export function defaultLocalSourceState(): LocalSourceState {
  return { version: 1, seen: {}, classifications: {} };
}
