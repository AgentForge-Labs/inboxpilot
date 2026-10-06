import type {
  ProviderCapabilityName,
} from "./provider-adapter.js";
import type { ProviderKind } from "../domain/email-model.js";

export class ProviderCapabilityError extends Error {
  readonly code = "PROVIDER_CAPABILITY_UNSUPPORTED";

  constructor(
    readonly provider: ProviderKind,
    readonly capability: ProviderCapabilityName,
  ) {
    super(`Provider "${provider}" does not support capability "${capability}"`);
    this.name = "ProviderCapabilityError";
  }
}

export class ProviderNotConnectedError extends Error {
  readonly code = "PROVIDER_NOT_CONNECTED";

  constructor(readonly provider: ProviderKind) {
    super(`Provider "${provider}" is not connected`);
    this.name = "ProviderNotConnectedError";
  }
}
