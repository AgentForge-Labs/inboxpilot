import type {
  OutboundAuthMethod,
  OutboundTransportCapabilities,
  OutboundTlsMode,
} from "../../outbound/outbound-transport.js";

export type SmtpAuthMethod =
  Extract<
    OutboundAuthMethod,
    "password" | "app_password" | "oauth2"
  >;

export type SmtpTlsMode =
  Extract<
    OutboundTlsMode,
    "starttls" | "implicit_tls"
  >;

export interface SmtpAccountCapabilities
  extends OutboundTransportCapabilities {
  authMethods: readonly SmtpAuthMethod[];
  tlsModes: readonly SmtpTlsMode[];
}

export interface SmtpCapabilityOptions {
  authMethods?: readonly SmtpAuthMethod[];
  tlsModes?: readonly SmtpTlsMode[];
  envelopeSender?: boolean;
  customFrom?: boolean;
  customReplyTo?: boolean;
  smtpUtf8?: boolean;
  maxMessageBytes?: number;
}

export function smtpCapabilities(
  options: SmtpCapabilityOptions = {},
): SmtpAccountCapabilities {
  const maxMessageBytes =
    options.maxMessageBytes;
  if (
    maxMessageBytes !== undefined &&
    (!Number.isSafeInteger(maxMessageBytes) ||
      maxMessageBytes < 1)
  ) {
    throw new RangeError(
      "SMTP maxMessageBytes must be a positive safe integer",
    );
  }

  return Object.freeze({
    authMethods: Object.freeze([
      ...(options.authMethods ?? []),
    ]),
    tlsModes: Object.freeze([
      ...(options.tlsModes ?? []),
    ]),
    envelopeSender:
      options.envelopeSender ?? true,
    customFrom: options.customFrom ?? true,
    customReplyTo:
      options.customReplyTo ?? true,
    smtpUtf8: options.smtpUtf8 ?? false,
    ...(maxMessageBytes !== undefined
      ? { maxMessageBytes }
      : {}),
  });
}
