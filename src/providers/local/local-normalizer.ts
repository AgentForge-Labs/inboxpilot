import { createHash } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";
import {
  EMAIL_SCHEMA_VERSION,
  createDefaultRetentionState,
  createUnclassifiedState,
  type CanonicalAddress,
  type CanonicalMessage,
  type MailboxRole,
  type ProviderKind,
} from "../../domain/email-model.js";
import {
  deriveProviderThreadKey,
  stableCanonicalId,
} from "../../domain/provider-id.js";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import type { LocalSourceEntry } from "./local-types.js";

function addresses(
  value?: AddressObject | AddressObject[],
): CanonicalAddress[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects
    .flatMap((item) => item.value ?? [])
    .filter((item) => Boolean(item.address))
    .map((item) => ({
      address: item.address!.trim().toLowerCase(),
      ...(item.name?.trim() ? { name: item.name.trim() } : {}),
    }));
}

export function contentFingerprint(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function normalizeLocalMessage(
  entry: LocalSourceEntry,
  kind: Extract<ProviderKind, "maildir" | "mbox">,
  context: ProviderConnectionContext,
  role: MailboxRole,
  now = new Date(),
): Promise<CanonicalMessage> {
  const parsed = await simpleParser(entry.raw);
  const from = addresses(parsed.from)[0];
  const participants = [
    ...(from ? [from] : []),
    ...addresses(parsed.to),
    ...addresses(parsed.cc),
  ];
  const references = parsed.references
    ? Array.isArray(parsed.references)
      ? parsed.references
      : [parsed.references]
    : undefined;
  const threadKey = deriveProviderThreadKey({
    ...(parsed.messageId ? { internetMessageId: parsed.messageId } : {}),
    ...(references ? { references } : {}),
    ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
    ...(parsed.subject ? { subject: parsed.subject } : {}),
    participants,
  });
  const flags = entry.flags ?? new Set<string>();
  const received = entry.receivedHint ?? parsed.date ?? now;

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: kind,
      kind: "message",
      providerId: entry.providerId,
    }),
    tenantId: context.tenantId,
    accountId: context.accountId,
    threadId: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: kind,
      kind: "thread",
      providerId: threadKey,
    }),
    provider: {
      kind,
      messageId: entry.providerId,
      threadId: threadKey,
    },
    ...(parsed.messageId ? { internetMessageId: parsed.messageId } : {}),
    subject: parsed.subject ?? "",
    body: {
      ...(parsed.text ? { text: parsed.text } : {}),
      ...(typeof parsed.html === "string" ? { html: parsed.html } : {}),
      truncated: false,
    },
    ...(from ? { from } : {}),
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    replyTo: addresses(parsed.replyTo),
    headers: {},
    labels: [],
    mailboxes: [{
      id: `${kind}:${role}`,
      role,
      displayName: role,
      providerMailboxId: role,
    }],
    flags: {
      read: flags.has("S"),
      starred: flags.has("F"),
      important: false,
      draft: flags.has("D"),
      answered: flags.has("R"),
      forwarded: /^(fw|fwd):/i.test(parsed.subject ?? ""),
    },
    attachments: parsed.attachments.map((attachment, index) => ({
      id: stableCanonicalId({
        tenantId: context.tenantId,
        accountId: context.accountId,
        provider: kind,
        kind: "attachment",
        providerId: `${entry.providerId}:${index}`,
      }),
      providerAttachmentId: String(index),
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}),
      inline: Boolean(attachment.cid) || attachment.contentDisposition === "inline",
      ...(attachment.cid ? { contentId: attachment.cid } : {}),
    })),
    ...(parsed.date ? { sentAt: parsed.date.toISOString() } : {}),
    receivedAt: received.toISOString(),
    authentication: {},
    classification: createUnclassifiedState(),
    retention: createDefaultRetentionState(),
    providerMetadata: {
      sourcePath: entry.sourcePath,
      fingerprint: entry.fingerprint,
    },
    ingestedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}
