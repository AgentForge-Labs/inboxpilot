import type {
  CanonicalMessage,
  ProviderKind,
} from "../../domain/email-model.js";
import type {
  ConnectionHealthState,
} from "../../onboarding/onboarding-types.js";
import {
  HostedMcpToolError,
  type HostedMcpTool,
  type HostedMcpToolRegistry,
} from "./hosted-mcp-tools.js";

export interface HostedEmailAccount {
  tenantId: string;
  userId: string;
  accountId: string;
  provider: ProviderKind;
  state: ConnectionHealthState;
  displayName?: string;
  emailAddress?: string;
  lastSyncAt?: string;
  lastSuccessfulSyncAt?: string;
  lastError?: string;
}

export interface HostedEmailReadDataSource {
  listAccounts(
    tenantId: string,
    userId: string,
  ): Promise<HostedEmailAccount[]>;
  listMessages(
    tenantId: string,
    accountId: string,
  ): Promise<CanonicalMessage[]>;
}

function invalid(message: string): never {
  throw new HostedMcpToolError(
    "TOOL_INVALID_ARGUMENTS",
    message,
  );
}

function optionalBoolean(
  args: Readonly<Record<string, unknown>>,
  name: string,
): boolean {
  const value = args[name];
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    return invalid(name + " must be a boolean");
  }
  return value;
}

function optionalString(
  args: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return invalid(name + " must be a string");
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function limitFrom(
  args: Readonly<Record<string, unknown>>,
): number {
  const value = args.limit;
  if (value === undefined) return 20;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 100
  ) {
    return invalid("limit must be an integer between 1 and 100");
  }
  return value;
}

function accountView(account: HostedEmailAccount) {
  return {
    accountId: account.accountId,
    provider: account.provider,
    state: account.state,
    ...(account.displayName
      ? { displayName: account.displayName }
      : {}),
    ...(account.emailAddress
      ? { emailAddress: account.emailAddress }
      : {}),
    ...(account.lastSyncAt
      ? { lastSyncAt: account.lastSyncAt }
      : {}),
    ...(account.lastSuccessfulSyncAt
      ? { lastSuccessfulSyncAt: account.lastSuccessfulSyncAt }
      : {}),
    ...(account.lastError
      ? { lastError: account.lastError }
      : {}),
  };
}

function messageView(
  message: CanonicalMessage,
  includeContent: boolean,
) {
  return {
    id: message.id,
    accountId: message.accountId,
    threadId: message.threadId,
    provider: message.provider.kind,
    providerMessageId: message.provider.messageId,
    ...(message.provider.threadId
      ? { providerThreadId: message.provider.threadId }
      : {}),
    ...(message.internetMessageId
      ? { internetMessageId: message.internetMessageId }
      : {}),
    subject: message.subject,
    ...(message.from ? { from: message.from } : {}),
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    replyTo: message.replyTo,
    labels: message.labels,
    mailboxes: message.mailboxes,
    flags: message.flags,
    attachments: message.attachments,
    ...(message.sentAt ? { sentAt: message.sentAt } : {}),
    receivedAt: message.receivedAt,
    classification: message.classification,
    retention: message.retention,
    ...(includeContent
      ? {
          ...(message.snippet
            ? { snippet: message.snippet }
            : {}),
          body: message.body,
          headers: message.headers,
        }
      : {}),
  };
}

function messageSearchText(message: CanonicalMessage): string {
  return [
    message.subject,
    message.snippet ?? "",
    message.body.text ?? "",
    message.body.html ?? "",
    message.from?.name ?? "",
    message.from?.address ?? "",
    ...message.to.flatMap((entry) => [
      entry.name ?? "",
      entry.address,
    ]),
    ...message.cc.flatMap((entry) => [
      entry.name ?? "",
      entry.address,
    ]),
    ...message.replyTo.flatMap((entry) => [
      entry.name ?? "",
      entry.address,
    ]),
    message.internetMessageId ?? "",
    ...message.labels,
    ...message.classification.categories,
  ]
    .join("\n")
    .toLocaleLowerCase();
}

function matchesQuery(
  message: CanonicalMessage,
  query: string | undefined,
): boolean {
  if (!query) return true;
  return messageSearchText(message).includes(
    query.toLocaleLowerCase(),
  );
}

function newestFirst(
  left: CanonicalMessage,
  right: CanonicalMessage,
): number {
  return (
    Date.parse(right.receivedAt) -
    Date.parse(left.receivedAt)
  );
}

async function findAccount(
  source: HostedEmailReadDataSource,
  tenantId: string,
  userId: string,
  accountId: string,
): Promise<HostedEmailAccount> {
  const account = (
    await source.listAccounts(tenantId, userId)
  ).find((candidate) => candidate.accountId === accountId);
  if (!account) {
    return invalid("Mailbox account was not found");
  }
  return account;
}

async function accountMessages(
  source: HostedEmailReadDataSource,
  tenantId: string,
  accountId: string,
): Promise<CanonicalMessage[]> {
  const messages = await source.listMessages(
    tenantId,
    accountId,
  );
  return messages
    .filter(
      (message) =>
        message.tenantId === tenantId &&
        message.accountId === accountId,
    )
    .sort(newestFirst);
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createHostedEmailReadTools(
  source: HostedEmailReadDataSource,
): HostedMcpTool[] {
  const accountList: HostedMcpTool = {
    descriptor: {
      name: "email_account_list",
      description:
        "List email accounts authorized for this MCP grant using provider-normalized account metadata.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
      annotations: {
        title: "List Email Accounts",
        ...READ_ONLY_ANNOTATIONS,
      },
    },
    requiredScopes: ["mailbox:read"],
    async execute(_args, context) {
      const allowed = new Set(context.accountIds);
      const accounts = (
        await source.listAccounts(
          context.tenantId,
          context.userId,
        )
      )
        .filter((account) => allowed.has(account.accountId))
        .map(accountView)
        .sort((a, b) =>
          a.accountId.localeCompare(b.accountId),
        );
      return { accounts };
    },
  };

  const accountStatus: HostedMcpTool = {
    descriptor: {
      name: "email_account_status",
      description:
        "Read normalized connection and sync status for one authorized email account.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "Email Account Status",
        ...READ_ONLY_ANNOTATIONS,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(_args, context) {
      const account = await findAccount(
        source,
        context.tenantId,
        context.userId,
        context.accountId!,
      );
      return accountView(account);
    },
  };

  const search: HostedMcpTool = {
    descriptor: {
      name: "email_search",
      description:
        "Search normalized email metadata and content for one account. Message body, snippet and headers are omitted unless includeContent is explicitly true.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          query: { type: "string" },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          includeContent: {
            type: "boolean",
            default: false,
          },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "Search Email",
        ...READ_ONLY_ANNOTATIONS,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(args, context) {
      await findAccount(
        source,
        context.tenantId,
        context.userId,
        context.accountId!,
      );
      const query = optionalString(args, "query");
      const includeContent = optionalBoolean(
        args,
        "includeContent",
      );
      const limit = limitFrom(args);
      const matches = (
        await accountMessages(
          source,
          context.tenantId,
          context.accountId!,
        )
      )
        .filter((message) => matchesQuery(message, query))
        .slice(0, limit)
        .map((message) =>
          messageView(message, includeContent),
        );
      return {
        query: query ?? null,
        count: matches.length,
        messages: matches,
      };
    },
  };

  const read: HostedMcpTool = {
    descriptor: {
      name: "email_read",
      description:
        "Read one normalized email by canonical or provider message ID. Message body, snippet and headers are omitted unless includeContent is explicitly true.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          messageId: { type: "string" },
          includeContent: {
            type: "boolean",
            default: false,
          },
        },
        required: ["accountId", "messageId"],
      },
      annotations: {
        title: "Read Email",
        ...READ_ONLY_ANNOTATIONS,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(args, context) {
      await findAccount(
        source,
        context.tenantId,
        context.userId,
        context.accountId!,
      );
      const messageId = optionalString(args, "messageId");
      if (!messageId) {
        return invalid("messageId is required");
      }
      const includeContent = optionalBoolean(
        args,
        "includeContent",
      );
      const message = (
        await accountMessages(
          source,
          context.tenantId,
          context.accountId!,
        )
      ).find(
        (candidate) =>
          candidate.id === messageId ||
          candidate.provider.messageId === messageId,
      );
      if (!message) {
        return invalid("Email message was not found");
      }
      return {
        message: messageView(message, includeContent),
      };
    },
  };

  const threadRead: HostedMcpTool = {
    descriptor: {
      name: "email_thread_read",
      description:
        "Read a normalized email thread by canonical or provider thread ID. Message body, snippet and headers are omitted unless includeContent is explicitly true.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          threadId: { type: "string" },
          includeContent: {
            type: "boolean",
            default: false,
          },
        },
        required: ["accountId", "threadId"],
      },
      annotations: {
        title: "Read Email Thread",
        ...READ_ONLY_ANNOTATIONS,
      },
    },
    requiredScopes: ["mailbox:read"],
    requiresAccount: true,
    async execute(args, context) {
      await findAccount(
        source,
        context.tenantId,
        context.userId,
        context.accountId!,
      );
      const threadId = optionalString(args, "threadId");
      if (!threadId) {
        return invalid("threadId is required");
      }
      const includeContent = optionalBoolean(
        args,
        "includeContent",
      );
      const messages = (
        await accountMessages(
          source,
          context.tenantId,
          context.accountId!,
        )
      )
        .filter(
          (message) =>
            message.threadId === threadId ||
            message.provider.threadId === threadId,
        )
        .sort(
          (left, right) =>
            Date.parse(left.receivedAt) -
            Date.parse(right.receivedAt),
        );
      if (messages.length === 0) {
        return invalid("Email thread was not found");
      }
      return {
        threadId: messages[0]!.threadId,
        count: messages.length,
        messages: messages.map((message) =>
          messageView(message, includeContent),
        ),
      };
    },
  };

  return [
    accountList,
    accountStatus,
    search,
    read,
    threadRead,
  ];
}

export function registerHostedEmailReadTools(
  registry: HostedMcpToolRegistry,
  source: HostedEmailReadDataSource,
): void {
  for (const tool of createHostedEmailReadTools(source)) {
    registry.register(tool);
  }
}

export class InMemoryHostedEmailReadDataSource
  implements HostedEmailReadDataSource
{
  private readonly accounts = new Map<
    string,
    HostedEmailAccount
  >();
  private readonly messages = new Map<
    string,
    CanonicalMessage
  >();

  seedAccount(account: HostedEmailAccount): void {
    this.accounts.set(
      [
        account.tenantId,
        account.userId,
        account.accountId,
      ].join("\u0000"),
      structuredClone(account),
    );
  }

  seedMessage(message: CanonicalMessage): void {
    this.messages.set(
      [
        message.tenantId,
        message.accountId,
        message.id,
      ].join("\u0000"),
      structuredClone(message),
    );
  }

  async listAccounts(
    tenantId: string,
    userId: string,
  ): Promise<HostedEmailAccount[]> {
    return [...this.accounts.values()]
      .filter(
        (account) =>
          account.tenantId === tenantId &&
          account.userId === userId,
      )
      .map((account) => structuredClone(account));
  }

  async listMessages(
    tenantId: string,
    accountId: string,
  ): Promise<CanonicalMessage[]> {
    return [...this.messages.values()]
      .filter(
        (message) =>
          message.tenantId === tenantId &&
          message.accountId === accountId,
      )
      .map((message) => structuredClone(message));
  }
}
