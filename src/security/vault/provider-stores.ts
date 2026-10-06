import type { ProviderConnectionContext } from "../../providers/provider-adapter.js";
import type {
  GmailCredentialStore,
  GmailStoredCredentials,
} from "../../providers/gmail/gmail-types.js";
import type {
  MicrosoftCredentialStore,
  MicrosoftStoredCredentials,
} from "../../providers/microsoft-graph/graph-types.js";
import type {
  ImapCredentialStore,
  ImapSecretRecord,
} from "../../providers/imap/imap-types.js";
import type {
  JmapCredential,
  JmapCredentialStore,
} from "../../providers/jmap/jmap-types.js";
import { CredentialVault } from "./credential-vault.js";
import type { SecretRef, VaultPrincipal } from "./vault-types.js";

function ref(
  context: ProviderConnectionContext,
  name: string,
): SecretRef {
  return {
    tenantId: context.tenantId,
    accountId: context.accountId,
    name,
  };
}

export class GmailVaultCredentialStore implements GmailCredentialStore {
  constructor(
    private readonly vault: CredentialVault,
    private readonly principal: VaultPrincipal,
  ) {}
  get(context: ProviderConnectionContext) {
    return this.vault.getJson<GmailStoredCredentials>(
      this.principal,
      ref(context, "gmail/oauth"),
    );
  }
  set(context: ProviderConnectionContext, credentials: GmailStoredCredentials) {
    return this.vault.putJson(
      this.principal,
      ref(context, "gmail/oauth"),
      credentials,
    );
  }
  delete(context: ProviderConnectionContext) {
    return this.vault.delete(this.principal, ref(context, "gmail/oauth"));
  }
}

export class MicrosoftVaultCredentialStore
  implements MicrosoftCredentialStore
{
  constructor(
    private readonly vault: CredentialVault,
    private readonly principal: VaultPrincipal,
  ) {}
  get(context: ProviderConnectionContext) {
    return this.vault.getJson<MicrosoftStoredCredentials>(
      this.principal,
      ref(context, "microsoft/oauth"),
    );
  }
  set(
    context: ProviderConnectionContext,
    credentials: MicrosoftStoredCredentials,
  ) {
    return this.vault.putJson(
      this.principal,
      ref(context, "microsoft/oauth"),
      credentials,
    );
  }
  delete(context: ProviderConnectionContext) {
    return this.vault.delete(
      this.principal,
      ref(context, "microsoft/oauth"),
    );
  }
}

export class ImapVaultCredentialStore implements ImapCredentialStore {
  constructor(
    private readonly vault: CredentialVault,
    private readonly principal: VaultPrincipal,
  ) {}
  get(context: ProviderConnectionContext) {
    return this.vault.getJson<ImapSecretRecord>(
      this.principal,
      ref(context, "imap/credentials"),
    );
  }
  set(context: ProviderConnectionContext, credentials: ImapSecretRecord) {
    return this.vault.putJson(
      this.principal,
      ref(context, "imap/credentials"),
      credentials,
    );
  }
  delete(context: ProviderConnectionContext) {
    return this.vault.delete(
      this.principal,
      ref(context, "imap/credentials"),
    );
  }
}

export class JmapVaultCredentialStore implements JmapCredentialStore {
  constructor(
    private readonly vault: CredentialVault,
    private readonly principal: VaultPrincipal,
  ) {}
  get(context: ProviderConnectionContext) {
    return this.vault.getJson<JmapCredential>(
      this.principal,
      ref(context, "jmap/credentials"),
    );
  }
  set(context: ProviderConnectionContext, credentials: JmapCredential) {
    return this.vault.putJson(
      this.principal,
      ref(context, "jmap/credentials"),
      credentials,
    );
  }
  delete(context: ProviderConnectionContext) {
    return this.vault.delete(
      this.principal,
      ref(context, "jmap/credentials"),
    );
  }
}
