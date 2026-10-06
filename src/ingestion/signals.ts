import { createHash } from "node:crypto";
import type { GmailPushNotification } from "../providers/gmail/gmail-types.js";
import type { GraphSubscriptionNotification } from "../providers/microsoft-graph/graph-types.js";
import type { ProviderConnectionContext } from "../providers/provider-adapter.js";
import type { ProviderKind } from "../domain/email-model.js";
import type {
  IngestionSignal,
  IngestionSignalSource,
} from "./ingestion-types.js";

function signalId(
  source: IngestionSignalSource,
  context: ProviderConnectionContext,
  provider: ProviderKind,
  identity: string,
): string {
  return `sig_${createHash("sha256")
    .update(
      [source, context.tenantId, context.accountId, provider, identity].join(
        "\u0000",
      ),
    )
    .digest("hex")
    .slice(0, 40)}`;
}

function createSignal(
  source: IngestionSignalSource,
  context: ProviderConnectionContext,
  provider: ProviderKind,
  identity: string,
  receivedAt: string,
  providerHint?: string,
): IngestionSignal {
  if (Number.isNaN(Date.parse(receivedAt))) {
    throw new TypeError("Ingestion signal receivedAt must be a valid timestamp");
  }
  return {
    id: signalId(source, context, provider, identity),
    source,
    tenantId: context.tenantId,
    accountId: context.accountId,
    provider,
    receivedAt,
    ...(providerHint ? { providerHint } : {}),
  };
}

export function initialSyncSignal(
  context: ProviderConnectionContext,
  provider: ProviderKind,
  receivedAt = new Date().toISOString(),
): IngestionSignal {
  return createSignal(
    "initial_sync",
    context,
    provider,
    "initial",
    receivedAt,
  );
}

export function gmailPushSignal(
  context: ProviderConnectionContext,
  notification: GmailPushNotification,
  receivedAt = new Date().toISOString(),
): IngestionSignal {
  return createSignal(
    "gmail_push",
    context,
    "gmail",
    `${notification.emailAddress}:${notification.historyId}`,
    receivedAt,
    notification.historyId,
  );
}

export function microsoftGraphWebhookSignal(
  context: ProviderConnectionContext,
  notification: GraphSubscriptionNotification,
  eventId?: string,
  receivedAt = new Date().toISOString(),
): IngestionSignal {
  const identity =
    eventId ??
    [
      notification.subscriptionId ?? "",
      notification.changeType ?? "",
      notification.resource ?? "",
      notification.resourceData?.id ?? "",
    ].join(":");
  if (!identity.replace(/:/g, "").trim()) {
    throw new TypeError(
      "Microsoft Graph notification requires event identity",
    );
  }
  return createSignal(
    "microsoft_graph_webhook",
    context,
    "microsoft_graph",
    identity,
    receivedAt,
    notification.resourceData?.id ?? notification.resource,
  );
}

export function imapIdleSignal(
  context: ProviderConnectionContext,
  sequence: string,
  receivedAt = new Date().toISOString(),
): IngestionSignal {
  return createSignal(
    "imap_idle",
    context,
    "imap",
    sequence,
    receivedAt,
    sequence,
  );
}

export function jmapChangeSignal(
  context: ProviderConnectionContext,
  state: string,
  receivedAt = new Date().toISOString(),
): IngestionSignal {
  if (!state.trim()) throw new TypeError("JMAP change state is required");
  return createSignal(
    "jmap_change",
    context,
    "jmap",
    state,
    receivedAt,
    state,
  );
}

export function localFilesystemSignal(
  context: ProviderConnectionContext,
  provider: Extract<ProviderKind, "maildir" | "mbox">,
  sequence: string,
  receivedAt = new Date().toISOString(),
): IngestionSignal {
  return createSignal(
    "local_filesystem",
    context,
    provider,
    sequence,
    receivedAt,
    sequence,
  );
}

export function scheduledReconciliationSignal(
  context: ProviderConnectionContext,
  provider: ProviderKind,
  scheduledFor: string,
): IngestionSignal {
  return createSignal(
    "scheduled_reconciliation",
    context,
    provider,
    scheduledFor,
    scheduledFor,
    scheduledFor,
  );
}
