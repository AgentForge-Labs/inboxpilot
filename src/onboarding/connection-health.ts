import type {
  ConnectionHealthAction,
  ConnectionHealthInput,
  ConnectionHealthView,
} from "./onboarding-types.js";

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export function buildConnectionHealth(
  input: ConnectionHealthInput,
): ConnectionHealthView {
  let state: ConnectionHealthView["state"];
  const actions: ConnectionHealthAction[] = [];

  if (!input.connected) {
    state = "disconnected";
    actions.push("reconnect");
  } else if (input.reauthRequired) {
    state = "reauth_required";
    actions.push("reauthorize", "disconnect");
  } else if (input.syncInProgress) {
    state = "syncing";
    actions.push("disconnect");
  } else if (input.lastError) {
    state = "degraded";
    actions.push("retry_sync", "disconnect");
  } else {
    state = "healthy";
    actions.push("disconnect");
  }

  return {
    state,
    provider: input.provider,
    grantedScopes: unique(input.grantedScopes ?? []),
    ...(input.lastSyncAt ? { lastSyncAt: input.lastSyncAt } : {}),
    ...(input.lastSuccessfulSyncAt
      ? { lastSuccessfulSyncAt: input.lastSuccessfulSyncAt }
      : {}),
    ...(input.lastError ? { lastError: input.lastError } : {}),
    actions: unique(actions),
  };
}
