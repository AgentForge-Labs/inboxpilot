import { createHash } from "node:crypto";
import type { CanonicalAddress, ProviderKind } from "./email-model.js";

export type CanonicalIdKind = "message" | "thread" | "attachment";

export interface StableProviderIdInput {
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  kind: CanonicalIdKind;
  providerId: string;
}

const prefixes: Record<CanonicalIdKind, string> = {
  message: "msg",
  thread: "thr",
  attachment: "att",
};

export function stableCanonicalId(input: StableProviderIdInput): string {
  const fields = [input.tenantId, input.accountId, input.provider, input.kind, input.providerId];
  if (fields.some((value) => value.length === 0)) {
    throw new TypeError("Stable provider IDs require non-empty scope and provider ID fields");
  }

  const digest = createHash("sha256").update(fields.join("\0"), "utf8").digest("hex");
  return `${prefixes[input.kind]}_${digest.slice(0, 32)}`;
}

export interface ThreadKeyInput {
  nativeThreadId?: string;
  internetMessageId?: string;
  references?: string[];
  inReplyTo?: string;
  subject?: string;
  participants?: CanonicalAddress[];
}

export function deriveProviderThreadKey(input: ThreadKeyInput): string {
  if (input.nativeThreadId?.trim()) return `native:${input.nativeThreadId.trim()}`;

  const rootReference = input.references?.map((value) => value.trim()).find(Boolean);
  if (rootReference) return `rfc-root:${rootReference}`;

  if (input.inReplyTo?.trim()) return `rfc-root:${input.inReplyTo.trim()}`;
  if (input.internetMessageId?.trim()) return `rfc-root:${input.internetMessageId.trim()}`;

  const normalizedSubject = (input.subject ?? "")
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/gi, "")
    .trim()
    .toLocaleLowerCase("en-US");
  const participants = (input.participants ?? [])
    .map(({ address }) => address.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean)
    .sort();

  if (!normalizedSubject && participants.length === 0) {
    throw new TypeError("Cannot derive thread key without provider/RFC identity or fallback fields");
  }

  return `fallback:${normalizedSubject}\0${participants.join(",")}`;
}
