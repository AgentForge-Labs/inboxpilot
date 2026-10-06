import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCapabilityName,
} from "./provider-adapter.js";
import { ProviderCapabilityError } from "./provider-errors.js";

export interface ProviderCapabilitySummary {
  supported: ProviderCapabilityName[];
  unsupported: ProviderCapabilityName[];
}

export function discoverCapabilities(
  adapter: Pick<ProviderAdapter, "capabilities">,
): ProviderCapabilitySummary {
  const capabilities = adapter.capabilities();
  const supported: ProviderCapabilityName[] = [];
  const unsupported: ProviderCapabilityName[] = [];

  for (const [name, enabled] of Object.entries(capabilities) as [
    ProviderCapabilityName,
    boolean,
  ][]) {
    (enabled ? supported : unsupported).push(name);
  }

  return { supported, unsupported };
}

export function requireCapability(
  adapter: Pick<ProviderAdapter, "kind" | "capabilities">,
  capability: ProviderCapabilityName,
): void {
  if (!adapter.capabilities()[capability]) {
    throw new ProviderCapabilityError(adapter.kind, capability);
  }
}

export function supportsCapability(
  capabilities: ProviderCapabilities,
  capability: ProviderCapabilityName,
): boolean {
  return capabilities[capability];
}
