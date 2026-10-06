import type {
  ImapAuthMode,
  ImapConnectionConfig,
} from "../providers/imap/imap-types.js";
import {
  discoverEmailProvider,
  type ProviderDiscoveryNetwork,
} from "./provider-autodiscovery.js";
import {
  ONBOARDING_ENTRY_OPTIONS,
  resolveGenericWizard,
} from "./wizard.js";
import type {
  GenericWizardResolution,
  LocalMailboxWizardProfile,
  OnboardingEntryOption,
  ProviderDiscoveryResult,
} from "./onboarding-types.js";

export interface ManualImapProfileInput {
  email: string;
  host: string;
  port: number;
  tlsMode: "implicit" | "starttls";
  authMode: ImapAuthMode;
  inboxPath?: string;
  archivePath?: string;
  trashPath?: string;
}

export interface ManualImapProfile {
  username: string;
  authMode: ImapAuthMode;
  config: ImapConnectionConfig;
}

function requiredHost(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host.length > 253 ||
    host === "localhost" ||
    host.includes("/") ||
    host.includes(":") ||
    /^\d+(?:\.\d+){3}$/.test(host)
  ) {
    throw new TypeError("A valid mail server hostname is required");
  }
  return host;
}

export function createManualImapProfile(
  input: ManualImapProfileInput,
): ManualImapProfile {
  const email = input.email.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || /\s/.test(email)) {
    throw new TypeError("A valid email address is required");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new RangeError("IMAP port must be between 1 and 65535");
  }
  if (input.authMode === "password") {
    throw new Error(
      "Normal password authentication is not enabled during onboarding; use OAuth2 or an app password",
    );
  }

  return {
    username: email,
    authMode: input.authMode,
    config: {
      host: requiredHost(input.host),
      port: input.port,
      tlsMode: input.tlsMode,
      rejectUnauthorized: true,
      ...(input.inboxPath ? { inboxPath: input.inboxPath } : {}),
      ...(input.archivePath ? { archivePath: input.archivePath } : {}),
      ...(input.trashPath ? { trashPath: input.trashPath } : {}),
    },
  };
}

export function createLocalMailboxProfile(
  input: Omit<
    LocalMailboxWizardProfile,
    "writable" | "destructiveActionsEnabled"
  > & {
    writable?: boolean;
    destructiveActionsEnabled?: boolean;
  },
): LocalMailboxWizardProfile {
  if (!input.sourcePath.trim() || !input.allowedRoot.trim() || !input.statePath.trim()) {
    throw new TypeError("Local mailbox paths are required");
  }
  if (input.destructiveActionsEnabled && !input.writable) {
    throw new Error(
      "Destructive local mailbox actions require writable mode",
    );
  }

  return {
    kind: input.kind,
    sourcePath: input.sourcePath,
    allowedRoot: input.allowedRoot,
    statePath: input.statePath,
    writable: Boolean(input.writable),
    destructiveActionsEnabled: Boolean(input.destructiveActionsEnabled),
  };
}

export class MailboxOnboardingService {
  constructor(
    private readonly discoveryNetwork?: ProviderDiscoveryNetwork,
  ) {}

  entryOptions(): readonly OnboardingEntryOption[] {
    return ONBOARDING_ENTRY_OPTIONS;
  }

  async discover(email: string): Promise<ProviderDiscoveryResult> {
    return discoverEmailProvider(email, this.discoveryNetwork);
  }

  async resolveGeneric(
    email: string,
  ): Promise<GenericWizardResolution> {
    return resolveGenericWizard(await this.discover(email));
  }
}
