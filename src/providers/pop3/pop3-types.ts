import type { ProviderConnectionContext } from "../provider-adapter.js";

export const POP3_CAPABILITIES = [
  "connect",
  "list",
  "fetch",
  "deleteOnServer",
] as const;

export type Pop3CapabilityName = (typeof POP3_CAPABILITIES)[number];

export type Pop3Capabilities = Readonly<
  Record<Pop3CapabilityName, boolean>
>;

export interface Pop3MessageRef {
  sequenceNumber: number;
  uidl?: string;
  sizeBytes?: number;
}

export interface Pop3FetchedMessage {
  ref: Pop3MessageRef;
  raw: Uint8Array;
}

export interface Pop3TransportConnectResult {
  accountExternalId?: string;
}

export interface Pop3Transport {
  connect(
    context: ProviderConnectionContext,
  ): Promise<Pop3TransportConnectResult>;
  list(): Promise<readonly Pop3MessageRef[]>;
  fetch(ref: Pop3MessageRef): Promise<Pop3FetchedMessage>;
  deleteOnServer(ref: Pop3MessageRef): Promise<void>;
  close(): Promise<void>;
}

export interface Pop3AdapterOptions {
  allowServerDelete?: boolean;
}

export function pop3Capabilities(
  allowServerDelete = false,
): Pop3Capabilities {
  return Object.freeze({
    connect: true,
    list: true,
    fetch: true,
    deleteOnServer: allowServerDelete,
  });
}

export class Pop3CapabilityError extends Error {
  readonly code = "POP3_CAPABILITY_UNSUPPORTED";

  constructor(readonly capability: Pop3CapabilityName) {
    super(`POP3 does not support capability "${capability}" in this configuration`);
    this.name = "Pop3CapabilityError";
  }
}
