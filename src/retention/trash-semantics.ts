import type {
  ProviderCapabilities,
} from "../providers/provider-adapter.js";
import type {
  ProviderKind,
} from "../domain/email-model.js";
import type {
  ProviderTrashSemantics,
} from "./retention-types.js";

export function resolveProviderTrashSemantics(
  provider: ProviderKind,
  capabilities: ProviderCapabilities,
): ProviderTrashSemantics {
  if (provider === "gmail") {
    return {
      provider,
      behavior: "provider_managed_expiry",
      permanentDeleteSupported: capabilities.deletePermanent,
      providerAutoDeleteAfterDays: 30,
      note:
        "Gmail Trash is provider-managed and may expire automatically; explicit permanent delete is only used when policy permits it.",
    };
  }

  if (capabilities.deletePermanent) {
    return {
      provider,
      behavior: "explicit_permanent_delete",
      permanentDeleteSupported: true,
      note:
        "Provider exposes an explicit permanent-delete capability; retention scheduler still waits for the configured trash delay and revalidates policy.",
    };
  }

  return {
    provider,
    behavior: "unknown",
    permanentDeleteSupported: false,
    note:
      "No explicit permanent-delete capability is available; deletion beyond provider Trash is not assumed.",
  };
}
