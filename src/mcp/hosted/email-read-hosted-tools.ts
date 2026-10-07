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

function optionalStringArray(
  args: Readonly<Record<string, unknown>>,
  name: string,
): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        typeof entry === "string" &&
        Boolean(entry.trim()),
    )
  ) {
    return invalid(name + " must be an array of non-empty strings");
  }
  const normalized = [
    ...new Set(
      value.map((entry) =>
        (entry as string).trim().toLowerCase(),
      ),
    ),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

function optionalIsoBoundary(
  args: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = optionalString(args, name);
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    return invalid(name + " must be an ISO-compatible timestamp");
  }
  return value;
}

function attentionLimitFrom(
  args: Readonly<Record<string, unknown>>,
): number {
  const value = args.attentionLimit;
  if (value === undefined) return 10;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 50
  ) {
    return invalid(
      "attentionLimit must be an integer between 1 and 50",
    );
  }
  return value;
}

function summaryMessageView(message: CanonicalMessage) {
  return {
    id: message.id,
    providerMessageId: message.provider.messageId,
    threadId: message.threadId,
    provider: message.provider.kind,
    subject: message.subject,
    ...(message.from ? { from: message.from } : {}),
    receivedAt: message.receivedAt,
    ...(message.classification.importanceScore !== undefined
      ? {
          importanceScore:
            message.classification.importanceScore,
        }
      : {}),
    ...(message.classification.priority
      ? { priority: message.classification.priority }
      : {}),
    categories: [...message.classification.categories],
    actionRequired:
      message.classification.actionRequired === true,
    replyRequired:
      message.classification.replyRequired === true,
    classificationStatus:
      message.classification.status,
    retentionStage: message.retention.stage,
  };
}

function summaryMatchesFilters(
  message: CanonicalMessage,
  providers: readonly string[] | undefined,
  categories: readonly string[] | undefined,
  receivedFrom: string | undefined,
  receivedTo: string | undefined,
): boolean {
  if (
    providers &&
    !providers.includes(message.provider.kind.toLowerCase())
  ) {
    return false;
  }

  if (categories) {
    const messageCategories = new Set(
      message.classification.categories.map((category) =>
        category.trim().toLowerCase(),
      ),
    );
    if (
      !categories.some((category) =>
        messageCategories.has(category),
      )
    ) {
      return false;
    }
  }

  const receivedAt = Date.parse(message.receivedAt);
  if (
    receivedFrom !== undefined &&
    receivedAt < Date.parse(receivedFrom)
  ) {
    return false;
  }
  if (
    receivedTo !== undefined &&
    receivedAt > Date.parse(receivedTo)
  ) {
    return false;
  }
  return true;
}

function hasSummaryCategory(
  message: CanonicalMessage,
  ...categories: string[]
): boolean {
  const values = new Set(
    message.classification.categories.map((category) =>
      category.trim().toLowerCase(),
    ),
  );
  return categories.some((category) =>
    values.has(category),
  );
}

function needsAttention(message: CanonicalMessage): boolean {
  return (
    message.classification.status === "needs_review" ||
    message.classification.actionRequired === true ||
    message.classification.replyRequired === true ||
    message.classification.priority === "critical" ||
    message.classification.priority === "important"
  );
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

  const inboxSummary: HostedMcpTool = {
    descriptor: {
      name: "email_inbox_summary",
      description:
        "Summarize one authorized mailbox over an optional received-time window and optional provider/category filters. Returns priority/retention counts and metadata-only messages needing attention.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          accountId: { type: "string" },
          receivedFrom: { type: "string" },
          receivedTo: { type: "string" },
          providers: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "gmail",
                "microsoft_graph",
                "imap",
                "jmap",
                "maildir",
                "mbox",
                "other",
              ],
            },
          },
          categories: {
            type: "array",
            items: { type: "string" },
          },
          attentionLimit: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 10,
          },
        },
        required: ["accountId"],
      },
      annotations: {
        title: "Summarize Inbox",
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

      const providers = optionalStringArray(
        args,
        "providers",
      );
      const categories = optionalStringArray(
        args,
        "categories",
      );
      const receivedFrom = optionalIsoBoundary(
        args,
        "receivedFrom",
      );
      const receivedTo = optionalIsoBoundary(
        args,
        "receivedTo",
      );
      if (
        receivedFrom !== undefined &&
        receivedTo !== undefined &&
        Date.parse(receivedFrom) > Date.parse(receivedTo)
      ) {
        return invalid(
          "receivedFrom must be before or equal to receivedTo",
        );
      }

      const filtered = (
        await accountMessages(
          source,
          context.tenantId,
          context.accountId!,
        )
      ).filter((message) =>
        summaryMatchesFilters(
          message,
          providers,
          categories,
          receivedFrom,
          receivedTo,
        ),
      );

      const counts = {
        critical: 0,
        important: 0,
        normal: 0,
        lowPriority: 0,
        promotions: 0,
        autoArchived: 0,
        pendingDelete: 0,
      };

      for (const message of filtered) {
        switch (message.classification.priority) {
          case "critical":
            counts.critical += 1;
            break;
          case "important":
            counts.important += 1;
            break;
          case "normal":
            counts.normal += 1;
            break;
          case "low":
          case "very_low":
          case "disposable":
            counts.lowPriority += 1;
            break;
        }

        if (
          hasSummaryCategory(
            message,
            "promotion",
            "promotions",
          )
        ) {
          counts.promotions += 1;
        }
        if (
          message.retention.stage === "archived" &&
          Boolean(message.retention.policyId)
        ) {
          counts.autoArchived += 1;
        }
        if (
          message.retention.stage === "pending_trash" ||
          message.retention.stage === "trashed" ||
          message.retention.stage === "pending_delete"
        ) {
          counts.pendingDelete += 1;
        }
      }

      const attentionMessages = filtered
        .filter(needsAttention)
        .sort((left, right) => {
          const scoreDiff =
            (right.classification.importanceScore ?? -1) -
            (left.classification.importanceScore ?? -1);
          if (scoreDiff !== 0) return scoreDiff;
          return (
            Date.parse(right.receivedAt) -
            Date.parse(left.receivedAt)
          );
        })
        .slice(0, attentionLimitFrom(args))
        .map(summaryMessageView);

      return {
        accountId: context.accountId!,
        window: {
          receivedFrom: receivedFrom ?? null,
          receivedTo: receivedTo ?? null,
        },
        filters: {
          providers: providers ?? [],
          categories: categories ?? [],
        },
        total: filtered.length,
        counts: {
          Critical: counts.critical,
          Important: counts.important,
          Normal: counts.normal,
          "Low Priority": counts.lowPriority,
          Promotions: counts.promotions,
          "Auto Archived": counts.autoArchived,
          "Pending Delete": counts.pendingDelete,
        },
        attentionCount: filtered.filter(needsAttention).length,
        attentionMessages,
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
    inboxSummary,
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
