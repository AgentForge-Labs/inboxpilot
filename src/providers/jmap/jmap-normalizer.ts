import {
  EMAIL_SCHEMA_VERSION,
  createDefaultRetentionState,
  createUnclassifiedState,
  type AuthenticationSignals,
  type CanonicalAddress,
  type CanonicalMessage,
  type CanonicalThread,
  type MailboxRole,
} from "../../domain/email-model.js";
import { stableCanonicalId } from "../../domain/provider-id.js";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import type { JmapAddress, JmapEmail } from "./jmap-types.js";

export interface JmapMailboxInfo {
  name: string;
  role: MailboxRole;
}

const STANDARD_KEYWORDS = new Set([
  "$seen",
  "$flagged",
  "$draft",
  "$answered",
  "$important",
]);

function addressOf(value: JmapAddress | undefined): CanonicalAddress | undefined {
  const address = value?.email?.trim().toLowerCase();
  if (!address) return undefined;
  const name = value?.name?.trim();
  return { address, ...(name ? { name } : {}) };
}

function addressesOf(values: JmapAddress[] = []): CanonicalAddress[] {
  return values
    .map(addressOf)
    .filter((value): value is CanonicalAddress => Boolean(value));
}

function headerValue(
  resource: JmapEmail,
  property: string,
): string[] {
  const value = resource[property];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function normalizedHeaders(resource: JmapEmail): Record<string, string[]> {
  const headers: Record<string, string[]> = {};
  const authenticationResults = headerValue(
    resource,
    "header:Authentication-Results:asText",
  );
  const received = headerValue(resource, "header:Received:asText");

  if (authenticationResults.length) {
    headers["authentication-results"] = authenticationResults;
  }
  if (received.length) headers["received"] = received;
  if (resource.messageId?.length) {
    headers["message-id"] = resource.messageId;
  }
  if (resource.inReplyTo?.length) {
    headers["in-reply-to"] = resource.inReplyTo;
  }
  if (resource.references?.length) {
    headers["references"] = resource.references;
  }
  return headers;
}

function authenticationSignals(
  headers: Record<string, string[]>,
): AuthenticationSignals {
  const auth = (headers["authentication-results"] ?? [])
    .join(" ")
    .toLowerCase();
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
  ) {
    result.transportEncrypted = true;
  }
  return result;
}

function bodyFromParts(
  resource: JmapEmail,
  kind: "textBody" | "htmlBody",
): string | undefined {
  const parts = resource[kind] ?? [];
  const values = resource.bodyValues ?? {};
  const chunks = parts
    .map((part) => (part.partId ? values[part.partId]?.value : undefined))
    .filter((value): value is string => typeof value === "string");
  return chunks.length ? chunks.join("\n") : undefined;
}

export function normalizeJmapEmail(
  resource: JmapEmail,
  context: ProviderConnectionContext,
  mailboxes: ReadonlyMap<string, JmapMailboxInfo>,
  now = new Date(),
): CanonicalMessage {
  if (!resource.id || !resource.threadId) {
    throw new TypeError("JMAP Email requires id and threadId");
  }

  const headers = normalizedHeaders(resource);
  const from = addressOf(resource.from?.[0]);
  const receivedAt =
    resource.receivedAt && !Number.isNaN(Date.parse(resource.receivedAt))
      ? new Date(resource.receivedAt).toISOString()
      : now.toISOString();

  const mailboxRefs = Object.entries(resource.mailboxIds ?? {})
    .filter(([, enabled]) => enabled)
    .map(([mailboxId]) => {
      const mailbox = mailboxes.get(mailboxId);
      return {
        id: `jmap:${mailboxId}`,
        role: mailbox?.role ?? "custom",
        ...(mailbox?.name ? { displayName: mailbox.name } : {}),
        providerMailboxId: mailboxId,
      };
    });

  const keywordNames = Object.entries(resource.keywords ?? {})
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "jmap",
      kind: "message",
      providerId: resource.id,
    }),
    tenantId: context.tenantId,
    accountId: context.accountId,
    threadId: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "jmap",
      kind: "thread",
      providerId: resource.threadId,
    }),
    provider: {
      kind: "jmap",
      messageId: resource.id,
      threadId: resource.threadId,
    },
    ...(resource.messageId?.[0]
      ? { internetMessageId: resource.messageId[0] }
      : {}),
    subject: resource.subject ?? "",
    ...(resource.preview ? { snippet: resource.preview } : {}),
    body: {
      ...(() => {
        const text = bodyFromParts(resource, "textBody");
        return text ? { text } : {};
      })(),
      ...(() => {
        const html = bodyFromParts(resource, "htmlBody");
        return html ? { html } : {};
      })(),
      truncated: Object.values(resource.bodyValues ?? {}).some(
        (value) => Boolean(value.isTruncated),
      ),
    },
    ...(from ? { from } : {}),
    to: addressesOf(resource.to),
    cc: addressesOf(resource.cc),
    bcc: addressesOf(resource.bcc),
    replyTo: addressesOf(resource.replyTo),
    headers,
    labels: keywordNames.filter(
      (keyword) => !STANDARD_KEYWORDS.has(keyword.toLowerCase()),
    ),
    mailboxes: mailboxRefs,
    flags: {
      read: Boolean(resource.keywords?.["$seen"]),
      starred: Boolean(resource.keywords?.["$flagged"]),
      important: Boolean(resource.keywords?.["$important"]),
      draft: Boolean(resource.keywords?.["$draft"]),
      answered: Boolean(resource.keywords?.["$answered"]),
      forwarded: /^(fw|fwd):/i.test(resource.subject ?? ""),
    },
    attachments: (resource.attachments ?? []).map((attachment, index) => ({
      id: stableCanonicalId({
        tenantId: context.tenantId,
        accountId: context.accountId,
        provider: "jmap",
        kind: "attachment",
        providerId: `${resource.id}:${attachment.blobId ?? attachment.partId ?? index}`,
      }),
      ...(attachment.blobId
        ? { providerAttachmentId: attachment.blobId }
        : attachment.partId
          ? { providerAttachmentId: attachment.partId }
          : {}),
      ...(attachment.name ? { filename: attachment.name } : {}),
      ...(attachment.type ? { contentType: attachment.type } : {}),
      ...(attachment.size !== undefined
        ? { sizeBytes: attachment.size }
        : {}),
      inline:
        attachment.disposition?.toLowerCase() === "inline" ||
        Boolean(attachment.cid),
      ...(attachment.cid ? { contentId: attachment.cid } : {}),
    })),
    ...(resource.sentAt && !Number.isNaN(Date.parse(resource.sentAt))
      ? { sentAt: new Date(resource.sentAt).toISOString() }
      : {}),
    receivedAt,
    authentication: authenticationSignals(headers),
    classification: createUnclassifiedState(),
    retention: createDefaultRetentionState(),
    providerMetadata: {
      ...(resource.blobId ? { blobId: resource.blobId } : {}),
      ...(resource.size !== undefined ? { size: resource.size } : {}),
      mailboxIds: resource.mailboxIds,
      keywords: resource.keywords,
    },
    ingestedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function normalizeJmapThread(
  threadId: string,
  resources: JmapEmail[],
  context: ProviderConnectionContext,
  mailboxes: ReadonlyMap<string, JmapMailboxInfo>,
  now = new Date(),
): CanonicalThread {
  const messages = resources.map((resource) =>
    normalizeJmapEmail(resource, context, mailboxes, now),
  );
  const participants = new Set<string>();

  for (const message of messages) {
    for (const address of [
      ...(message.from ? [message.from] : []),
      ...message.to,
      ...message.cc,
    ]) {
      participants.add(address.address);
    }
  }

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "jmap",
      kind: "thread",
      providerId: threadId,
    }),
    tenantId: context.tenantId,
    accountId: context.accountId,
    subject: messages[0]?.subject ?? "",
    messageIds: messages.map((message) => message.id),
    participantAddresses: [...participants].sort(),
    latestMessageAt:
      messages.map((message) => message.receivedAt).sort().at(-1) ??
      now.toISOString(),
    categories: [],
    actionRequired: false,
    updatedAt: now.toISOString(),
  };
}
