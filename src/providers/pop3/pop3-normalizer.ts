import {
  simpleParser,
  type AddressObject,
  type ParsedMail,
} from "mailparser";

import {
  EMAIL_SCHEMA_VERSION,
  createDefaultRetentionState,
  createUnclassifiedState,
  type AuthenticationSignals,
  type CanonicalAddress,
  type CanonicalMessage,
} from "../../domain/email-model.js";
import {
  deriveProviderThreadKey,
  stableCanonicalId,
} from "../../domain/provider-id.js";
import type { ProviderConnectionContext } from "../provider-adapter.js";
import type { Pop3SyncItem } from "./pop3-sync.js";

function addresses(
  value?: AddressObject | AddressObject[],
): CanonicalAddress[] {
  const objects = Array.isArray(value)
    ? value
    : value
      ? [value]
      : [];
  return objects
    .flatMap((item) => item.value ?? [])
    .filter((item) =>
      Boolean(item.address?.trim()),
    )
    .map((item) => ({
      address: item.address!
        .trim()
        .toLowerCase(),
      ...(item.name?.trim()
        ? { name: item.name.trim() }
        : {}),
    }));
}

function headersToMap(
  parsed: ParsedMail,
): Record<string, string[]> {
  const result: Record<string, string[]> =
    {};
  for (const [key, value] of
    parsed.headers.entries()) {
    const name = key.toLowerCase();
    const values = Array.isArray(value)
      ? value
      : [value];
    result[name] = values.map((item) =>
      typeof item === "string"
        ? item
        : item instanceof Date
          ? item.toISOString()
          : JSON.stringify(item),
    );
  }
  return result;
}

function authenticationSignals(
  headers: Record<string, string[]>,
): AuthenticationSignals {
  const auth = (
    headers["authentication-results"] ?? []
  )
    .join(" ")
    .toLowerCase();
  const result: AuthenticationSignals = {};

  const spf =
    auth.match(/\bspf=([a-z]+)/)?.[1];
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

  const dkim =
    auth.match(/\bdkim=([a-z]+)/)?.[1];
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

  const dmarc =
    auth.match(/\bdmarc=([a-z]+)/)?.[1];
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
      /\bwith\s+(?:esmtps|smtps)\b/i.test(
        value,
      ),
    )
  ) {
    result.transportEncrypted = true;
  }
  return result;
}

function referencesOf(
  parsed: ParsedMail,
): string[] | undefined {
  if (!parsed.references) return undefined;
  return Array.isArray(parsed.references)
    ? parsed.references
    : [parsed.references];
}

function receivedAt(
  headers: Record<string, string[]>,
  parsed: ParsedMail,
  now: Date,
): Date {
  for (const received of
    headers["received"] ?? []) {
    const delimiter =
      received.lastIndexOf(";");
    const candidate =
      delimiter >= 0
        ? received.slice(delimiter + 1)
        : received;
    const timestamp = Date.parse(
      candidate.trim(),
    );
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp);
    }
  }
  return parsed.date ?? now;
}

export interface NormalizePop3MessageInput {
  item: Pop3SyncItem;
  context: ProviderConnectionContext;
  now?: Date;
}

export async function normalizePop3Message(
  input: NormalizePop3MessageInput,
): Promise<CanonicalMessage> {
  const parsed = await simpleParser(
    Buffer.from(input.item.fetched.raw),
  );
  const now = input.now ?? new Date();
  const headers = headersToMap(parsed);
  const from = addresses(parsed.from)[0];
  const to = addresses(parsed.to);
  const cc = addresses(parsed.cc);
  const references =
    referencesOf(parsed);
  const participants = [
    ...(from ? [from] : []),
    ...to,
    ...cc,
  ];
  const threadKey =
    deriveProviderThreadKey({
      ...(parsed.messageId
        ? {
            internetMessageId:
              parsed.messageId,
          }
        : {}),
      ...(references
        ? { references }
        : {}),
      ...(parsed.inReplyTo
        ? {
            inReplyTo:
              parsed.inReplyTo,
          }
        : {}),
      ...(parsed.subject
        ? { subject: parsed.subject }
        : {}),
      participants,
    });
  const providerMessageId =
    input.item.stableMessageId;
  const received = receivedAt(
    headers,
    parsed,
    now,
  );

  return {
    schemaVersion: EMAIL_SCHEMA_VERSION,
    id: stableCanonicalId({
      tenantId: input.context.tenantId,
      accountId: input.context.accountId,
      provider: "pop3",
      kind: "message",
      providerId: providerMessageId,
    }),
    tenantId: input.context.tenantId,
    accountId: input.context.accountId,
    threadId: stableCanonicalId({
      tenantId: input.context.tenantId,
      accountId: input.context.accountId,
      provider: "pop3",
      kind: "thread",
      providerId: threadKey,
    }),
    provider: {
      kind: "pop3",
      messageId: providerMessageId,
      threadId: threadKey,
    },
    ...(parsed.messageId
      ? {
          internetMessageId:
            parsed.messageId,
        }
      : {}),
    subject: parsed.subject ?? "",
    body: {
      ...(parsed.text
        ? { text: parsed.text }
        : {}),
      ...(typeof parsed.html === "string"
        ? { html: parsed.html }
        : {}),
      truncated: false,
    },
    ...(from ? { from } : {}),
    to,
    cc,
    bcc: addresses(parsed.bcc),
    replyTo: addresses(parsed.replyTo),
    headers,
    labels: [],
    mailboxes: [
      {
        id: "pop3:inbox",
        role: "inbox",
        displayName: "Inbox",
        providerMailboxId: "INBOX",
      },
    ],
    flags: {
      read: false,
      starred: false,
      important: false,
      draft: false,
      answered: Boolean(
        parsed.inReplyTo,
      ),
      forwarded:
        /^(fw|fwd):/i.test(
          parsed.subject ?? "",
        ),
    },
    attachments:
      parsed.attachments.map(
        (attachment, index) => ({
          id: stableCanonicalId({
            tenantId:
              input.context.tenantId,
            accountId:
              input.context.accountId,
            provider: "pop3",
            kind: "attachment",
            providerId:
              providerMessageId +
              ":" +
              index,
          }),
          providerAttachmentId:
            String(index),
          ...(attachment.filename
            ? {
                filename:
                  attachment.filename,
              }
            : {}),
          ...(attachment.contentType
            ? {
                contentType:
                  attachment.contentType,
              }
            : {}),
          ...(attachment.size !==
          undefined
            ? {
                sizeBytes:
                  attachment.size,
              }
            : {}),
          inline:
            Boolean(attachment.cid) ||
            attachment.contentDisposition ===
              "inline",
          ...(attachment.cid
            ? {
                contentId:
                  attachment.cid,
              }
            : {}),
        }),
      ),
    ...(parsed.date
      ? {
          sentAt:
            parsed.date.toISOString(),
        }
      : {}),
    receivedAt:
      !Number.isNaN(
        received.valueOf(),
      )
        ? received.toISOString()
        : now.toISOString(),
    authentication:
      authenticationSignals(headers),
    classification:
      createUnclassifiedState(),
    retention:
      createDefaultRetentionState(),
    providerMetadata: {
      identityMode: input.item.mode,
      identityKey:
        input.item.identityKey,
      sequenceNumber:
        input.item.fetched.ref
          .sequenceNumber,
      ...(input.item.fetched.ref.uidl
        ? {
            uidl:
              input.item.fetched.ref
                .uidl,
          }
        : {}),
      ...(input.item.fetched.ref
        .sizeBytes !== undefined
        ? {
            sizeBytes:
              input.item.fetched.ref
                .sizeBytes,
          }
        : {}),
      ...(references
        ? { references }
        : {}),
      ...(parsed.inReplyTo
        ? {
            inReplyTo:
              parsed.inReplyTo,
          }
        : {}),
    },
    ingestedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}
