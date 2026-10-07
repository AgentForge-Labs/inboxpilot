import type {
  McpAuthorizationCodeRecord,
  McpControlPlaneUsageEvent,
  McpLinkedAccount,
  McpOAuthClient,
  McpOAuthGrant,
  McpOAuthTokenRecord,
} from "./hosted-mcp-types.js";

export interface McpOAuthStore {
  getClient(clientId: string): Promise<McpOAuthClient | undefined>;
  putAuthorizationCode(record: McpAuthorizationCodeRecord): Promise<void>;
  consumeAuthorizationCode(
    codeHash: string,
  ): Promise<McpAuthorizationCodeRecord | undefined>;
  putGrant(grant: McpOAuthGrant): Promise<void>;
  getGrant(grantId: string): Promise<McpOAuthGrant | undefined>;
  listGrantsForUser(
    tenantId: string,
    userId: string,
  ): Promise<McpOAuthGrant[]>;
  putToken(record: McpOAuthTokenRecord): Promise<void>;
  getToken(
    tokenHash: string,
  ): Promise<McpOAuthTokenRecord | undefined>;
  revokeToken(
    tokenHash: string,
    revokedAt: string,
  ): Promise<void>;
}

export interface McpAccountLinkStore {
  link(
    tenantId: string,
    userId: string,
    accountId: string,
    linkedAt: string,
  ): Promise<McpLinkedAccount>;
  listLinked(
    tenantId: string,
    userId: string,
  ): Promise<McpLinkedAccount[]>;
  disconnect(
    tenantId: string,
    userId: string,
    accountId: string,
    disconnectedAt: string,
  ): Promise<boolean>;
}

export interface McpControlPlaneUsageStore {
  append(event: McpControlPlaneUsageEvent): Promise<void>;
  listForTenant(
    tenantId: string,
  ): Promise<McpControlPlaneUsageEvent[]>;
}

function accountKey(
  tenantId: string,
  userId: string,
  accountId: string,
): string {
  return [tenantId, userId, accountId].join("\u0000");
}

export class InMemoryMcpOAuthStore implements McpOAuthStore {
  private readonly clients = new Map<string, McpOAuthClient>();
  private readonly codes = new Map<
    string,
    McpAuthorizationCodeRecord
  >();
  private readonly grants = new Map<string, McpOAuthGrant>();
  private readonly tokens = new Map<string, McpOAuthTokenRecord>();

  constructor(clients: readonly McpOAuthClient[] = []) {
    for (const client of clients) {
      this.clients.set(
        client.clientId,
        structuredClone(client),
      );
    }
  }

  async getClient(
    clientId: string,
  ): Promise<McpOAuthClient | undefined> {
    const value = this.clients.get(clientId);
    return value ? structuredClone(value) : undefined;
  }

  async putAuthorizationCode(
    record: McpAuthorizationCodeRecord,
  ): Promise<void> {
    this.codes.set(record.codeHash, structuredClone(record));
  }

  async consumeAuthorizationCode(
    codeHash: string,
  ): Promise<McpAuthorizationCodeRecord | undefined> {
    const value = this.codes.get(codeHash);
    if (!value) return undefined;
    this.codes.delete(codeHash);
    return structuredClone(value);
  }

  async putGrant(grant: McpOAuthGrant): Promise<void> {
    this.grants.set(grant.grantId, structuredClone(grant));
  }

  async getGrant(
    grantId: string,
  ): Promise<McpOAuthGrant | undefined> {
    const value = this.grants.get(grantId);
    return value ? structuredClone(value) : undefined;
  }

  async listGrantsForUser(
    tenantId: string,
    userId: string,
  ): Promise<McpOAuthGrant[]> {
    return [...this.grants.values()]
      .filter(
        (grant) =>
          grant.tenantId === tenantId &&
          grant.userId === userId,
      )
      .map((grant) => structuredClone(grant));
  }

  async putToken(record: McpOAuthTokenRecord): Promise<void> {
    this.tokens.set(record.tokenHash, structuredClone(record));
  }

  async getToken(
    tokenHash: string,
  ): Promise<McpOAuthTokenRecord | undefined> {
    const value = this.tokens.get(tokenHash);
    return value ? structuredClone(value) : undefined;
  }

  async revokeToken(
    tokenHash: string,
    revokedAt: string,
  ): Promise<void> {
    const current = this.tokens.get(tokenHash);
    if (!current) return;
    this.tokens.set(tokenHash, {
      ...current,
      revokedAt,
    });
  }

  async exportAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<{
    grants: Array<Omit<McpOAuthGrant, "accountIds"> & { accountIds: string[] }>;
    authorizationCodes: number;
    tokenCount: number;
  }> {
    const grants = [...this.grants.values()]
      .filter(
        (grant) =>
          grant.tenantId === tenantId &&
          grant.accountIds.includes(accountId),
      )
      .map((grant) => structuredClone(grant));
    const grantIds = new Set(grants.map((grant) => grant.grantId));
    const tokenCount = [...this.tokens.values()].filter((token) =>
      grantIds.has(token.grantId),
    ).length;
    const authorizationCodes = [...this.codes.values()].filter(
      (code) =>
        code.tenantId === tenantId &&
        code.accountIds.includes(accountId),
    ).length;
    return {
      grants,
      authorizationCodes,
      tokenCount,
    };
  }

  async deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    const grantIds = new Set<string>();
    let deleted = 0;

    for (const [grantId, grant] of this.grants) {
      if (
        grant.tenantId === tenantId &&
        grant.accountIds.includes(accountId)
      ) {
        grantIds.add(grantId);
        this.grants.delete(grantId);
        deleted += 1;
      }
    }

    for (const [codeHash, code] of this.codes) {
      if (
        code.tenantId === tenantId &&
        code.accountIds.includes(accountId)
      ) {
        this.codes.delete(codeHash);
        deleted += 1;
      }
    }

    for (const [tokenHash, token] of this.tokens) {
      if (grantIds.has(token.grantId)) {
        this.tokens.delete(tokenHash);
        deleted += 1;
      }
    }

    return deleted;
  }
}

export class InMemoryMcpAccountLinkStore
  implements McpAccountLinkStore
{
  private readonly links = new Map<string, McpLinkedAccount>();

  async link(
    tenantId: string,
    userId: string,
    accountId: string,
    linkedAt: string,
  ): Promise<McpLinkedAccount> {
    const key = accountKey(tenantId, userId, accountId);
    const value: McpLinkedAccount = {
      tenantId,
      userId,
      accountId,
      linkedAt,
    };
    this.links.set(key, value);
    return structuredClone(value);
  }

  async listLinked(
    tenantId: string,
    userId: string,
  ): Promise<McpLinkedAccount[]> {
    return [...this.links.values()]
      .filter(
        (link) =>
          link.tenantId === tenantId &&
          link.userId === userId &&
          !link.disconnectedAt,
      )
      .map((link) => structuredClone(link));
  }

  async disconnect(
    tenantId: string,
    userId: string,
    accountId: string,
    disconnectedAt: string,
  ): Promise<boolean> {
    const key = accountKey(tenantId, userId, accountId);
    const current = this.links.get(key);
    if (!current || current.disconnectedAt) return false;
    this.links.set(key, {
      ...current,
      disconnectedAt,
    });
    return true;
  }

  async exportAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<McpLinkedAccount[]> {
    return [...this.links.values()]
      .filter(
        (link) =>
          link.tenantId === tenantId &&
          link.accountId === accountId,
      )
      .map((link) => structuredClone(link));
  }

  async deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    let deleted = 0;
    for (const [key, link] of this.links) {
      if (
        link.tenantId === tenantId &&
        link.accountId === accountId
      ) {
        this.links.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

export class InMemoryMcpControlPlaneUsageStore
  implements McpControlPlaneUsageStore
{
  readonly events: McpControlPlaneUsageEvent[] = [];

  async append(
    event: McpControlPlaneUsageEvent,
  ): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async listForTenant(
    tenantId: string,
  ): Promise<McpControlPlaneUsageEvent[]> {
    return this.events
      .filter((event) => event.tenantId === tenantId)
      .map((event) => structuredClone(event));
  }

  async exportAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<McpControlPlaneUsageEvent[]> {
    return this.events
      .filter(
        (event) =>
          event.tenantId === tenantId &&
          event.accountId === accountId,
      )
      .map((event) => structuredClone(event));
  }

  async deleteAccountData(
    tenantId: string,
    accountId: string,
  ): Promise<number> {
    let deleted = 0;
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index]!;
      if (
        event.tenantId === tenantId &&
        event.accountId === accountId
      ) {
        this.events.splice(index, 1);
        deleted += 1;
      }
    }
    return deleted;
  }
}
