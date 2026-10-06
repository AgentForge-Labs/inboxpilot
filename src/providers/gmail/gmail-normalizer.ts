import {
  EMAIL_SCHEMA_VERSION,
  createDefaultRetentionState,
  createUnclassifiedState,
  type AuthenticationSignals,
  type CanonicalAddress,
  type CanonicalAttachment,
  type CanonicalMailboxRef,
  type CanonicalMessage,
  type CanonicalThread,
  type MailboxRole,
} from "../../domain/email-model.js";
import { stableCanonicalId } from "../../domain/provider-id.js";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import type {
  GmailHeader,
  GmailMessagePart,
  GmailMessageResource,
  GmailThreadResource,
} from "./gmail-types.js";

const SYSTEM_ROLES: Readonly<Record<string, MailboxRole>> = Object.freeze({
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  TRASH: "trash",
  SPAM: "spam",
});

function decodeBase64Url(value?: string): string | undefined {
  if (!value) return undefined;
  return Buffer.from(value, "base64url").toString("utf8");
}

function headersToMap(headers: GmailHeader[] = []): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const header of headers) {
    const name = header.name.trim().toLowerCase();
    if (!name) continue;
    (result[name] ??= []).push(header.value);
  }
  return result;
}

function firstHeader(
  headers: Record<string, string[]>,
  name: string,
): string | undefined {
  return headers[name.toLowerCase()]?.[0];
}

function parseAddress(value: string): CanonicalAddress {
  const match = value.trim().match(/^(?:"?([^"]*)"?\s*)?<([^<>]+)>$/);
  if (match?.[2]) {
    const name = match[1]?.trim();
    return {
      address: match[2].trim().toLowerCase(),
      ...(name ? { name } : {}),
    };
  }
  return { address: value.trim().toLowerCase() };
}

function parseAddressList(value?: string): CanonicalAddress[] {
  if (!value) return [];
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseAddress);
}

interface ContentParts {
  textParts: string[];
  htmlParts: string[];
  attachments: CanonicalAttachment[];
}

function walkParts(
  part: GmailMessagePart,
  messageId: string,
  context: ProviderConnectionContext,
  content: ContentParts,
): void {
  const mimeType = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename?.trim();
  const decoded = decodeBase64Url(part.body?.data);

  if (mimeType === "text/plain" && decoded !== undefined && !filename) {
    content.textParts.push(decoded);
  } else if (mimeType === "text/html" && decoded !== undefined && !filename) {
    content.htmlParts.push(decoded);
  }

  if (filename || part.body?.attachmentId) {
    const providerAttachmentId = part.body?.attachmentId ?? part.partId ?? filename ?? "attachment";
    content.attachments.push({
      id: stableCanonicalId({
        tenantId: context.tenantId,
        accountId: context.accountId,
        provider: "gmail",
        kind: "attachment",
        providerId: `${messageId}:${providerAttachmentId}`,
      }),
      ...(part.body?.attachmentId
        ? { providerAttachmentId: part.body.attachmentId }
        : {}),
      ...(filename ? { filename } : {}),
      ...(part.mimeType ? { contentType: part.mimeType } : {}),
      ...(part.body?.size !== undefined ? { sizeBytes: part.body.size } : {}),
      inline:
        (part.headers ?? []).some(
          (header) =>
            header.name.toLowerCase() === "content-disposition" &&
            header.value.toLowerCase().includes("inline"),
        ) || Boolean(
          (part.headers ?? []).find(
            (header) => header.name.toLowerCase() === "content-id",
          ),
        ),
      ...(() => {
        const contentId = (part.headers ?? []).find(
          (header) => header.name.toLowerCase() === "content-id",
        )?.value;
        return contentId ? { contentId } : {};
      })(),
    });
  }

  for (const child of part.parts ?? []) {
    walkParts(child, messageId, context, content);
  }
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
  ) {
    result.spf = spf;
  }

  const dkim = auth.match(/\bdkim=([a-z]+)/)?.[1];
  if (
    dkim === "pass" ||
    dkim === "fail" ||
    dkim === "neutral" ||
    dkim === "none" ||
    dkim === "temperror" ||
    dkim === "permerror"
  ) {
    result.dkim = dkim;
  }

  const dmarc = auth.match(/\bdmarc=([a-z]+)/)?.[1];
  if (
    dmarc === "pass" ||
    dmarc === "fail" ||
    dmarc === "none" ||
    dmarc === "temperror" ||
    dmarc === "permerror"
  ) {
    result.dmarc = dmarc;
  }

  if (
    headers["received"]?.some((value) =>
      /\bwith\s+(?:esmtps|smtps)\b/i.test(value),
    )
  ) {
    result.transportEncrypted = true;
  }

  return result;
}

function mailboxRefs(labelIds: string[]): CanonicalMailboxRef[] {
  const refs: CanonicalMailboxRef[] = [];

  for (const labelId of labelIds) {
    const role = SYSTEM_ROLES[labelId];
    if (!role) continue;
    refs.push({
      id: `gmail:${labelId.toLowerCase()}`,
      role,
      displayName: labelId,
      providerMailboxId: labelId,
    });
  }

  if (
    !labelIds.includes("INBOX") &&
    !labelIds.includes("TRASH") &&
    !labelIds.includes("SPAM")
  ) {
    refs.push({
      id: "gmail:archive",
      role: "archive",
      displayName: "Archive",
    });
  }

  return refs;
}

export function normalizeGmailMessage(
  resource: GmailMessageResource,
  context: ProviderConnectionContext,
  now = new Date(),
): CanonicalMessage {
  if (!resource.id || !resource.threadId) {
    throw new TypeError("Gmail message requires id and threadId");
  }

  const headers = headersToMap(resource.payload?.headers);
  const content: ContentParts = {
    textParts: [],
    htmlParts: [],
    attachments: [],
  };
  if (resource.payload) {
    walkParts(resource.payload, resource.id, context, content);
  }

  const internalDate = resource.internalDate
    ? new Date(Number(resource.internalDate))
    : undefined;
  const dateHeader = firstHeader(headers, "date");
  const receivedAt =
    internalDate && !Number.isNaN(internalDate.valueOf())
      ? internalDate.toISOString()
      : dateHeader && !Number.isNaN(Date.parse(dateHeader))
        ? new Date(dateHeader).toISOString()
        : now.toISOString();

  const threadId = stableCanonicalId({
    tenantId: context.tenantId,
    accountId: context.accountId,
    provider: "gmail",
    kind: "thread",
    providerId: resource.threadId,
  });

  const labelIds = resource.labelIds ?? [];
  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "gmail",
      kind: "message",
      providerId: resource.id,
    }),
    tenantId: context.tenantId,
    accountId: context.accountId,
    threadId,
    provider: {
      kind: "gmail",
      messageId: resource.id,
      threadId: resource.threadId,
    },
    ...(() => {
      const internetMessageId = firstHeader(headers, "message-id");
      return internetMessageId ? { internetMessageId } : {};
    })(),
    subject: firstHeader(headers, "subject") ?? "",
    ...(resource.snippet ? { snippet: resource.snippet } : {}),
    body: {
      ...(content.textParts.length ? { text: content.textParts.join("\n") } : {}),
      ...(content.htmlParts.length ? { html: content.htmlParts.join("\n") } : {}),
      truncated: false,
    },
    ...(() => {
      const from = firstHeader(headers, "from");
      return from ? { from: parseAddress(from) } : {};
    })(),
    to: parseAddressList(firstHeader(headers, "to")),
    cc: parseAddressList(firstHeader(headers, "cc")),
    bcc: parseAddressList(firstHeader(headers, "bcc")),
    replyTo: parseAddressList(firstHeader(headers, "reply-to")),
    headers,
    labels: labelIds,
    mailboxes: mailboxRefs(labelIds),
    flags: {
      read: !labelIds.includes("UNREAD"),
      starred: labelIds.includes("STARRED"),
      important: labelIds.includes("IMPORTANT"),
      draft: labelIds.includes("DRAFT"),
      answered: Boolean(firstHeader(headers, "in-reply-to")),
      forwarded: /^(fw|fwd):/i.test(firstHeader(headers, "subject") ?? ""),
    },
    attachments: content.attachments,
    ...(dateHeader && !Number.isNaN(Date.parse(dateHeader))
      ? { sentAt: new Date(dateHeader).toISOString() }
      : {}),
    receivedAt,
    authentication: authenticationSignals(headers),
    classification: createUnclassifiedState(),
    retention: createDefaultRetentionState(),
    providerMetadata: {
      ...(resource.historyId ? { historyId: resource.historyId } : {}),
      ...(resource.internalDate ? { internalDate: resource.internalDate } : {}),
      ...(resource.sizeEstimate !== undefined
        ? { sizeEstimate: resource.sizeEstimate }
        : {}),
    },
    ingestedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function normalizeGmailThread(
  resource: GmailThreadResource,
  context: ProviderConnectionContext,
  now = new Date(),
): CanonicalThread {
  if (!resource.id) throw new TypeError("Gmail thread requires id");

  const messages = (resource.messages ?? []).map((message) =>
    normalizeGmailMessage(message, context, now),
  );
  const participants = new Set<string>();
  for (const message of messages) {
    for (const address of [
      ...(message.from ? [message.from] : []),
      ...message.to,
      ...message.cc,
    ]) {
      participants.add(address.address.toLowerCase());
    }
  }

  const latestMessageAt =
    messages
      .map((message) => message.receivedAt)
      .sort()
      .at(-1) ?? now.toISOString();

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "gmail",
      kind: "thread",
      providerId: resource.id,
    }),
    tenantId: context.tenantId,
    accountId: context.accountId,
    subject: messages[0]?.subject ?? "",
    messageIds: messages.map((message) => message.id),
    participantAddresses: [...participants].sort(),
    latestMessageAt,
    categories: [],
    actionRequired: false,
    updatedAt: now.toISOString(),
  };
}
