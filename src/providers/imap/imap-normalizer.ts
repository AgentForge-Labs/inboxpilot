import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { FetchMessageObject } from "imapflow";
import {
  EMAIL_SCHEMA_VERSION,
  createDefaultRetentionState,
  createUnclassifiedState,
  type AuthenticationSignals,
  type CanonicalAddress,
  type CanonicalMessage,
  type MailboxRole,
} from "../../domain/email-model.js";
import {
  deriveProviderThreadKey,
  stableCanonicalId,
} from "../../domain/provider-id.js";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import { encodeImapMessageRef } from "./imap-types.js";

function canonicalAddresses(
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

function headersToMap(parsed: ParsedMail): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, value] of parsed.headers.entries()) {
    const name = key.toLowerCase();
    const values = Array.isArray(value) ? value : [value];
    result[name] = values.map((item) =>
      typeof item === "string" ? item : JSON.stringify(item),
    );
  }
  return result;
}

function authenticationSignals(
  headers: Record<string, string[]>,
): AuthenticationSignals {
  const auth = (headers["authentication-results"] ?? []).join(" ").toLowerCase();
  const result: AuthenticationSignals = {};

  const spf = auth.match(/\bspf=([a-z]+)/)?.[1];
  if (
    spf === "pass" ||
    spf === "fail" ||
    spf === "softfail" ||
    spf === "neutral" ||
    spf === "none" ||
    spf === "temperror" ||
    spf === "permerror"
  ) result.spf = spf;

  const dkim = auth.match(/\bdkim=([a-z]+)/)?.[1];
  if (
    dkim === "pass" ||
    dkim === "fail" ||
    dkim === "neutral" ||
    dkim === "none" ||
    dkim === "temperror" ||
    dkim === "permerror"
  ) result.dkim = dkim;

  const dmarc = auth.match(/\bdmarc=([a-z]+)/)?.[1];
  if (
    dmarc === "pass" ||
    dmarc === "fail" ||
    dmarc === "none" ||
    dmarc === "temperror" ||
    dmarc === "permerror"
  ) result.dmarc = dmarc;

  if (
    headers["received"]?.some((value) =>
      /\bwith\s+(?:esmtps|smtps)\b/i.test(value),
    )
  ) result.transportEncrypted = true;

  return result;
}

function referencesOf(parsed: ParsedMail): string[] | undefined {
  const refs = parsed.references;
  if (!refs) return undefined;
  return Array.isArray(refs) ? refs : [refs];
}

export interface NormalizeImapMessageInput {
  fetched: FetchMessageObject;
  source: Buffer;
  mailbox: string;
  uidValidity: bigint;
  mailboxRole: MailboxRole;
  context: ProviderConnectionContext;
  now?: Date;
}

export async function normalizeImapMessage(
  input: NormalizeImapMessageInput,
): Promise<CanonicalMessage> {
  const parsed = await simpleParser(input.source);
  const now = input.now ?? new Date();
  const providerMessageId = encodeImapMessageRef({
    mailbox: input.mailbox,
    uidValidity: input.uidValidity.toString(),
    uid: input.fetched.uid,
  });
  const participants = [
    ...canonicalAddresses(parsed.from),
    ...canonicalAddresses(parsed.to),
    ...canonicalAddresses(parsed.cc),
  ];
  const threadKey =
    input.fetched.threadId?.trim() ||
    deriveProviderThreadKey({
      ...(parsed.messageId ? { internetMessageId: parsed.messageId } : {}),
      ...(referencesOf(parsed) ? { references: referencesOf(parsed)! } : {}),
      ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
      ...(parsed.subject ? { subject: parsed.subject } : {}),
      participants,
    });
  const receivedDate =
    input.fetched.internalDate instanceof Date
      ? input.fetched.internalDate
      : input.fetched.internalDate
        ? new Date(input.fetched.internalDate)
        : parsed.date ?? now;
  const flags = input.fetched.flags ?? new Set<string>();
  const headers = headersToMap(parsed);

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: input.context.tenantId,
      accountId: input.context.accountId,
      provider: "imap",
      kind: "message",
      providerId: providerMessageId,
    }),
    tenantId: input.context.tenantId,
    accountId: input.context.accountId,
    threadId: stableCanonicalId({
      tenantId: input.context.tenantId,
      accountId: input.context.accountId,
      provider: "imap",
      kind: "thread",
      providerId: threadKey,
    }),
    provider: {
      kind: "imap",
      messageId: providerMessageId,
      threadId: threadKey,
    },
    ...(parsed.messageId ? { internetMessageId: parsed.messageId } : {}),
    subject: parsed.subject ?? "",
    body: {
      ...(parsed.text ? { text: parsed.text } : {}),
      ...(typeof parsed.html === "string" ? { html: parsed.html } : {}),
      truncated: false,
    },
    ...(() => {
      const from = canonicalAddresses(parsed.from)[0];
      return from ? { from } : {};
    })(),
    to: canonicalAddresses(parsed.to),
    cc: canonicalAddresses(parsed.cc),
    bcc: canonicalAddresses(parsed.bcc),
    replyTo: canonicalAddresses(parsed.replyTo),
    headers,
    labels: [...(input.fetched.labels ?? [])],
    mailboxes: [
      {
        id: `imap:${input.mailbox}`,
        role: input.mailboxRole,
        displayName: input.mailbox,
        providerMailboxId: input.mailbox,
      },
    ],
    flags: {
      read: flags.has("\\Seen"),
      starred: flags.has("\\Flagged"),
      important: flags.has("$Important") || flags.has("\\Important"),
      draft: flags.has("\\Draft"),
      answered: flags.has("\\Answered"),
      forwarded: /^(fw|fwd):/i.test(parsed.subject ?? ""),
    },
    attachments: parsed.attachments.map((attachment, index) => ({
      id: stableCanonicalId({
        tenantId: input.context.tenantId,
        accountId: input.context.accountId,
        provider: "imap",
        kind: "attachment",
        providerId: `${providerMessageId}:${index}`,
      }),
      providerAttachmentId: String(index),
      ...(attachment.filename ? { filename: attachment.filename } : {}),
      ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
      ...(attachment.size !== undefined ? { sizeBytes: attachment.size } : {}),
      inline: Boolean(attachment.cid) || attachment.contentDisposition === "inline",
      ...(attachment.cid ? { contentId: attachment.cid } : {}),
    })),
    ...(parsed.date ? { sentAt: parsed.date.toISOString() } : {}),
    receivedAt:
      !Number.isNaN(receivedDate.valueOf())
        ? receivedDate.toISOString()
        : now.toISOString(),
    authentication: authenticationSignals(headers),
    classification: createUnclassifiedState(),
    retention: createDefaultRetentionState(),
    providerMetadata: {
      mailbox: input.mailbox,
      uidValidity: input.uidValidity.toString(),
      uid: input.fetched.uid,
      ...(input.fetched.modseq
        ? { modseq: input.fetched.modseq.toString() }
        : {}),
      ...(input.fetched.size !== undefined ? { size: input.fetched.size } : {}),
    },
    ingestedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}
