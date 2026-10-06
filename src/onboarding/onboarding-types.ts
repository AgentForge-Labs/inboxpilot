import type {
  ImapAuthMode,
  ImapConnectionConfig,
} from "../providers/imap/imap-types.js";
import type { ProviderKind } from "../domain/email-model.js";

export type OnboardingEntryKind =
  | "google"
  | "microsoft"
  | "generic_email"
  | "local_mailbox";

export interface OnboardingEntryOption {
  kind: OnboardingEntryKind;
  title: string;
  description: string;
  recommended?: boolean;
}

export interface MailServiceEndpoint {
  protocol: "imap" | "submission";
  host: string;
  port: number;
  tlsMode: "implicit" | "starttls";
  source: "preset" | "srv";
}

export type DiscoveryProvider =
  | "google"
  | "microsoft"
  | "jmap"
  | "imap"
  | "unknown";

export interface ProviderDiscoveryResult {
  email: string;
  domain: string;
  provider: DiscoveryProvider;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  jmapSessionUrl?: string;
  incoming?: MailServiceEndpoint;
  outgoing?: MailServiceEndpoint;
  advancedSetupRequired: boolean;
}

export type GenericWizardResolution =
  | {
      mode: "redirect_oauth";
      provider: "google" | "microsoft";
      email: string;
      advancedSetupRequired: false;
    }
  | {
      mode: "jmap";
      email: string;
      sessionUrl: string;
      advancedSetupRequired: false;
    }
  | {
      mode: "imap";
      email: string;
      profile: Omit<ImapConnectionConfig, "allowPasswordAuth"> & {
        username: string;
        authMode: ImapAuthMode;
      };
      outgoing?: MailServiceEndpoint;
      advancedSetupRequired: boolean;
    }
  | {
      mode: "advanced";
      email: string;
      suggestedDomain: string;
      advancedSetupRequired: true;
    };

export type ConnectionHealthState =
  | "healthy"
  | "syncing"
  | "degraded"
  | "reauth_required"
  | "disconnected";

export type ConnectionHealthAction =
  | "reauthorize"
  | "retry_sync"
  | "disconnect"
  | "reconnect";

export interface ConnectionHealthInput {
  provider: ProviderKind;
  connected: boolean;
  reauthRequired?: boolean;
  syncInProgress?: boolean;
  lastSyncAt?: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
  grantedScopes?: string[];
}

export interface ConnectionHealthView {
  state: ConnectionHealthState;
  provider: ProviderKind;
  grantedScopes: string[];
  lastSyncAt?: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
  actions: ConnectionHealthAction[];
}

export interface LocalMailboxWizardProfile {
  kind: "maildir" | "mbox";
  sourcePath: string;
  allowedRoot: string;
  statePath: string;
  writable: boolean;
  destructiveActionsEnabled: boolean;
}
