export type OutboundAuthMethod =
  | "none"
  | "password"
  | "app_password"
  | "oauth2";

export type OutboundTlsMode =
  | "none"
  | "starttls"
  | "implicit_tls";

export interface OutboundTransportCapabilities {
  authMethods: readonly OutboundAuthMethod[];
  tlsModes: readonly OutboundTlsMode[];
  envelopeSender: boolean;
  customFrom: boolean;
  customReplyTo: boolean;
  smtpUtf8: boolean;
  maxMessageBytes?: number;
}

export interface OutboundConnectionValidation {
  ok: true;
  capabilities: OutboundTransportCapabilities;
  accountExternalId?: string;
}

export interface OutboundAddress {
  address: string;
  name?: string;
}

export interface OutboundMessageInput {
  from: OutboundAddress;
  to: readonly OutboundAddress[];
  cc?: readonly OutboundAddress[];
  bcc?: readonly OutboundAddress[];
  replyTo?: readonly OutboundAddress[];
  envelopeFrom?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Readonly<Record<string, string>>;
  raw?: Uint8Array;
}

export interface OutboundReplyInput
  extends Omit<OutboundMessageInput, "subject"> {
  subject?: string;
  inReplyTo: string;
  references?: readonly string[];
  threadId?: string;
}

export interface OutboundSendResult {
  accepted: readonly string[];
  rejected: readonly string[];
  messageId?: string;
  providerResponse?: string;
}

export interface OutboundTransport {
  validateConnection(): Promise<OutboundConnectionValidation>;
  sendMessage(
    input: OutboundMessageInput,
  ): Promise<OutboundSendResult>;
  sendReply(
    input: OutboundReplyInput,
  ): Promise<OutboundSendResult>;
  capabilities(): OutboundTransportCapabilities;
  close(): Promise<void>;
}

function normalizeAddress(
  value: string,
  field: string,
): string {
  const address = value.trim();
  if (!address || !address.includes("@")) {
    throw new TypeError(
      field + " must be a valid email address",
    );
  }
  return address;
}

function validateRecipients(
  values: readonly OutboundAddress[],
  field: string,
): void {
  for (const [index, value] of values.entries()) {
    normalizeAddress(
      value.address,
      field + "[" + index + "].address",
    );
  }
}

export function assertOutboundMessageInput(
  input: OutboundMessageInput,
): void {
  normalizeAddress(
    input.from.address,
    "from.address",
  );
  if (input.to.length === 0) {
    throw new TypeError(
      "At least one To recipient is required",
    );
  }
  validateRecipients(input.to, "to");
  validateRecipients(input.cc ?? [], "cc");
  validateRecipients(input.bcc ?? [], "bcc");
  validateRecipients(
    input.replyTo ?? [],
    "replyTo",
  );
  if (input.envelopeFrom) {
    normalizeAddress(
      input.envelopeFrom,
      "envelopeFrom",
    );
  }
  if (!input.raw && !input.text && !input.html) {
    throw new TypeError(
      "Outbound message requires raw, text or html content",
    );
  }
}

export class ProviderNeutralOutboundSender {
  constructor(
    private readonly transport: OutboundTransport,
  ) {}

  capabilities(): OutboundTransportCapabilities {
    return this.transport.capabilities();
  }

  validateConnection(): Promise<OutboundConnectionValidation> {
    return this.transport.validateConnection();
  }

  async sendMessage(
    input: OutboundMessageInput,
  ): Promise<OutboundSendResult> {
    assertOutboundMessageInput(input);
    return this.transport.sendMessage(input);
  }

  async sendReply(
    input: OutboundReplyInput,
  ): Promise<OutboundSendResult> {
    assertOutboundMessageInput({
      ...input,
      subject: input.subject ?? "",
    });
    if (!input.inReplyTo.trim()) {
      throw new TypeError(
        "inReplyTo is required",
      );
    }
    return this.transport.sendReply(input);
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
