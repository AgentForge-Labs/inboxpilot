import type { ImapAuthMode } from "../providers/imap/imap-types.js";
import type {
  GenericWizardResolution,
  OnboardingEntryOption,
  ProviderDiscoveryResult,
} from "./onboarding-types.js";

export const ONBOARDING_ENTRY_OPTIONS: readonly OnboardingEntryOption[] =
  Object.freeze([
    {
      kind: "google",
      title: "Connect Google",
      description: "Connect Gmail or Google Workspace with OAuth.",
      recommended: true,
    },
    {
      kind: "microsoft",
      title: "Connect Microsoft",
      description: "Connect Outlook or Microsoft 365 with Microsoft OAuth.",
      recommended: true,
    },
    {
      kind: "generic_email",
      title: "Connect another email",
      description:
        "Detect your provider automatically before showing advanced mail-server fields.",
    },
    {
      kind: "local_mailbox",
      title: "Connect local mailbox",
      description: "Import a mounted Maildir or mbox mailbox.",
    },
  ]);

export interface GenericWizardOptions {
  preferredAuthMode?: ImapAuthMode;
}

export function resolveGenericWizard(
  discovery: ProviderDiscoveryResult,
  options: GenericWizardOptions = {},
): GenericWizardResolution {
  if (discovery.provider === "google") {
    return {
      mode: "redirect_oauth",
      provider: "google",
      email: discovery.email,
      advancedSetupRequired: false,
    };
  }

  if (discovery.provider === "microsoft") {
    return {
      mode: "redirect_oauth",
      provider: "microsoft",
      email: discovery.email,
      advancedSetupRequired: false,
    };
  }

  if (discovery.provider === "jmap" && discovery.jmapSessionUrl) {
    return {
      mode: "jmap",
      email: discovery.email,
      sessionUrl: discovery.jmapSessionUrl,
      advancedSetupRequired: false,
    };
  }

  if (discovery.provider === "imap" && discovery.incoming) {
    return {
      mode: "imap",
      email: discovery.email,
      profile: {
        host: discovery.incoming.host,
        port: discovery.incoming.port,
        tlsMode: discovery.incoming.tlsMode,
        username: discovery.email,
        authMode: options.preferredAuthMode ?? "app_password",
      },
      ...(discovery.outgoing ? { outgoing: discovery.outgoing } : {}),
      advancedSetupRequired: discovery.advancedSetupRequired,
    };
  }

  return {
    mode: "advanced",
    email: discovery.email,
    suggestedDomain: discovery.domain,
    advancedSetupRequired: true,
  };
}
