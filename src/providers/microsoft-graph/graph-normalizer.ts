import {
  EMAIL_SCHEMA_VERSION,
  createDefaultRetentionState,
  createUnclassifiedState,
  type AuthenticationSignals,
  type CanonicalAddress,
  type CanonicalMailboxRef,
  type CanonicalMessage,
  type CanonicalThread,
} from "../../domain/email-model.js";
import { stableCanonicalId } from "../../domain/provider-id.js";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import type { GraphMessage } from "./graph-types.js";

function addressOf(
  recipient: { emailAddress?: { name?: string; address?: string } } | undefined,
): CanonicalAddress | undefined {
  const address = recipient?.emailAddress?.address?.trim().toLowerCase();
  if (!address) return undefined;
  const name = recipient?.emailAddress?.name?.trim();
  return { address, ...(name ? { name } : {}) };
}

function addressesOf(
  recipients: Array<{ emailAddress?: { name?: string; address?: string } }> = [],
): CanonicalAddress[] {
  return recipients
    .map(addressOf)
    .filter((value): value is CanonicalAddress => Boolean(value));
}

function headerMap(
  headers: Array<{ name?: string; value?: string }> = [],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const header of headers) {
    const name = header.name?.trim().toLowerCase();
    if (!name || header.value === undefined) continue;
    (result[name] ??= []).push(header.value);
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

export function normalizeGraphMessage(
  resource: GraphMessage,
  context: ProviderConnectionContext,
  now = new Date(),
): CanonicalMessage {
  if (!resource.id) throw new TypeError("Microsoft Graph message requires id");

  const conversationId =
    resource.conversationId?.trim() ||
    resource.internetMessageId?.trim() ||
    resource.id;
  const headers = headerMap(resource.internetMessageHeaders);
  const receivedAt =
    resource.receivedDateTime &&
    !Number.isNaN(Date.parse(resource.receivedDateTime))
      ? new Date(resource.receivedDateTime).toISOString()
      : now.toISOString();

  const mailboxes: CanonicalMailboxRef[] = resource.parentFolderId
    ? [{
        id: `graph:${resource.parentFolderId}`,
        role: "custom",
        providerMailboxId: resource.parentFolderId,
      }]
    : [];

  const from = addressOf(resource.from);
  const bodyContent = resource.body?.content;
  const contentType = resource.body?.contentType?.toLowerCase();

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "microsoft_graph",
      kind: "message",
      providerId: resource.id,
    }),
    tenantId: context.tenantId,
    accountId: context.accountId,
    threadId: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "microsoft_graph",
      kind: "thread",
      providerId: conversationId,
    }),
    provider: {
      kind: "microsoft_graph",
      messageId: resource.id,
      threadId: conversationId,
    },
    ...(resource.internetMessageId
      ? { internetMessageId: resource.internetMessageId }
      : {}),
    subject: resource.subject ?? "",
    ...(resource.bodyPreview ? { snippet: resource.bodyPreview } : {}),
    body: {
      ...(bodyContent && contentType === "text" ? { text: bodyContent } : {}),
      ...(bodyContent && contentType === "html" ? { html: bodyContent } : {}),
      truncated: false,
    },
    ...(from ? { from } : {}),
    to: addressesOf(resource.toRecipients),
    cc: addressesOf(resource.ccRecipients),
    bcc: addressesOf(resource.bccRecipients),
    replyTo: addressesOf(resource.replyTo),
    headers,
    labels: resource.categories ?? [],
    mailboxes,
    flags: {
      read: resource.isRead ?? false,
      starred: resource.flag?.flagStatus === "flagged",
      important: resource.importance === "high",
      draft: resource.isDraft ?? false,
      answered: Boolean(headers["in-reply-to"]?.[0]),
      forwarded: /^(fw|fwd):/i.test(resource.subject ?? ""),
    },
    attachments: [],
    ...(resource.sentDateTime &&
    !Number.isNaN(Date.parse(resource.sentDateTime))
      ? { sentAt: new Date(resource.sentDateTime).toISOString() }
      : {}),
    receivedAt,
    authentication: authenticationSignals(headers),
    classification: createUnclassifiedState(),
    retention: createDefaultRetentionState(),
    providerMetadata: {
      ...(resource.parentFolderId ? { parentFolderId: resource.parentFolderId } : {}),
      ...(resource.hasAttachments !== undefined
        ? { hasAttachments: resource.hasAttachments }
        : {}),
      ...(resource.importance ? { importance: resource.importance } : {}),
      ...(resource.flag?.flagStatus ? { flagStatus: resource.flag.flagStatus } : {}),
    },
    ingestedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function normalizeGraphConversation(
  conversationId: string,
  resources: GraphMessage[],
  context: ProviderConnectionContext,
  now = new Date(),
): CanonicalThread {
  if (!conversationId.trim()) {
    throw new TypeError("Microsoft Graph conversation requires id");
  }

  const messages = resources
    .filter((message) => !message["@removed"])
    .map((message) => normalizeGraphMessage(message, context, now));

  const participants = new Set<string>();
  for (const message of messages) {
    for (const address of [
      ...(message.from ? [message.from] : []),
      ...message.to,
      ...message.cc,
    ]) participants.add(address.address);
  }

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: context.tenantId,
      accountId: context.accountId,
      provider: "microsoft_graph",
      kind: "thread",
      providerId: conversationId,
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
