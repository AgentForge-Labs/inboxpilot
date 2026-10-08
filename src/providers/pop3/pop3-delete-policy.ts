import type { CanonicalMessage } from "../../domain/email-model.js";
import type { ExplainabilityAuditRecorder } from "../../audit/audit-recorder.js";
import type { NeverAutoDeleteProtectionService } from "../../safeguards/safeguard-service.js";
import { tenantScopedKey } from "../../security/tenant-boundary.js";
import type { Pop3MessageRef } from "./pop3-types.js";

export const POP3_MIN_SERVER_DELETE_DELAY_DAYS = 7 as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Pop3ServerDeletePolicy {
  tenantId: string;
  accountId: string;
  deleteFromServerAfterDays?: number;
  updatedAt: string;
  updatedBy: string;
}

export interface Pop3ServerDeletePolicyStore {
  get(
    tenantId: string,
    accountId: string,
  ): Promise<Pop3ServerDeletePolicy | undefined>;
  set(
    policy: Pop3ServerDeletePolicy,
  ): Promise<void>;
}

export class InMemoryPop3ServerDeletePolicyStore
  implements Pop3ServerDeletePolicyStore
{
  readonly policies = new Map<
    string,
    Pop3ServerDeletePolicy
  >();

  async get(
    tenantId: string,
    accountId: string,
  ): Promise<Pop3ServerDeletePolicy | undefined> {
    const value = this.policies.get(
      tenantScopedKey(
        { tenantId, accountId },
        "pop3_server_delete_policy",
      ),
    );
    return value
      ? structuredClone(value)
      : undefined;
  }

  async set(
    policy: Pop3ServerDeletePolicy,
  ): Promise<void> {
    this.policies.set(
      tenantScopedKey(
        {
          tenantId: policy.tenantId,
          accountId: policy.accountId,
        },
        "pop3_server_delete_policy",
      ),
      structuredClone(policy),
    );
  }
}

function required(
  value: string,
  field: string,
): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(field + " is required");
  }
  return normalized;
}

export class Pop3ServerDeletePolicyService {
  constructor(
    private readonly store: Pop3ServerDeletePolicyStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(
    tenantId: string,
    accountId: string,
  ): Promise<Pop3ServerDeletePolicy> {
    const existing = await this.store.get(
      required(tenantId, "tenantId"),
      required(accountId, "accountId"),
    );
    return (
      existing ?? {
        tenantId,
        accountId,
        updatedAt: this.now().toISOString(),
        updatedBy: "system_default",
      }
    );
  }

  async setDeleteFromServerAfterDays(
    tenantId: string,
    accountId: string,
    days: number | undefined,
    actorId: string,
  ): Promise<Pop3ServerDeletePolicy> {
    const normalizedTenant = required(
      tenantId,
      "tenantId",
    );
    const normalizedAccount = required(
      accountId,
      "accountId",
    );
    const actor = required(
      actorId,
      "actorId",
    );

    if (
      days !== undefined &&
      (!Number.isSafeInteger(days) ||
        days < POP3_MIN_SERVER_DELETE_DELAY_DAYS)
    ) {
      throw new RangeError(
        "delete_from_server_after_days must be at least " +
          POP3_MIN_SERVER_DELETE_DELAY_DAYS,
      );
    }

    const policy: Pop3ServerDeletePolicy = {
      tenantId: normalizedTenant,
      accountId: normalizedAccount,
      ...(days !== undefined
        ? {
            deleteFromServerAfterDays:
              days,
          }
        : {}),
      updatedAt: this.now().toISOString(),
      updatedBy: actor,
    };
    await this.store.set(policy);
    return structuredClone(policy);
  }
}

export interface Pop3ServerDeleteResult {
  outcome:
    | "disabled"
    | "not_due"
    | "protected"
    | "deleted";
  dueAt?: string;
  protectionReasons?: string[];
}

export interface Pop3ServerDeleteTarget {
  deleteOnServer(
    ref: Pop3MessageRef,
  ): Promise<void>;
}

function messageRef(
  message: CanonicalMessage,
): Pop3MessageRef {
  const sequenceNumber =
    message.providerMetadata
      .sequenceNumber;
  if (
    typeof sequenceNumber !== "number" ||
    !Number.isSafeInteger(
      sequenceNumber,
    ) ||
    sequenceNumber < 1
  ) {
    throw new TypeError(
      "POP3 message is missing a valid sequenceNumber",
    );
  }

  const uidl =
    typeof message.providerMetadata
      .uidl === "string"
      ? message.providerMetadata.uidl
      : undefined;
  const sizeBytes =
    typeof message.providerMetadata
      .sizeBytes === "number"
      ? message.providerMetadata
          .sizeBytes
      : undefined;

  return {
    sequenceNumber,
    ...(uidl ? { uidl } : {}),
    ...(sizeBytes !== undefined
      ? { sizeBytes }
      : {}),
  };
}

export class Pop3ServerDeleteService {
  constructor(
    private readonly policies: Pop3ServerDeletePolicyStore,
    private readonly target: Pop3ServerDeleteTarget,
    private readonly protection: Pick<
      NeverAutoDeleteProtectionService,
      "evaluate"
    >,
    private readonly now: () => Date = () => new Date(),
    private readonly audit?: Pick<
      ExplainabilityAuditRecorder,
      "recordManualDecision"
    >,
  ) {}

  async deleteIfDue(
    message: CanonicalMessage,
  ): Promise<Pop3ServerDeleteResult> {
    if (message.provider.kind !== "pop3") {
      throw new TypeError(
        "POP3 server deletion only accepts POP3 messages",
      );
    }

    const policy = await this.policies.get(
      message.tenantId,
      message.accountId,
    );
    const days =
      policy?.deleteFromServerAfterDays;
    if (days === undefined) {
      return { outcome: "disabled" };
    }
    if (
      days <
      POP3_MIN_SERVER_DELETE_DELAY_DAYS
    ) {
      throw new RangeError(
        "Stored POP3 deletion policy violates the minimum safety delay",
      );
    }

    const baseTime = Date.parse(
      message.receivedAt,
    );
    if (Number.isNaN(baseTime)) {
      throw new TypeError(
        "POP3 message receivedAt is invalid",
      );
    }
    const dueAt = new Date(
      baseTime + days * DAY_MS,
    ).toISOString();

    if (
      this.now().getTime() <
      Date.parse(dueAt)
    ) {
      return {
        outcome: "not_due",
        dueAt,
      };
    }

    // Re-evaluate immediately before the destructive POP3 DELE command.
    const safeguard =
      await this.protection.evaluate(
        message,
      );
    if (safeguard.protected) {
      return {
        outcome: "protected",
        dueAt,
        protectionReasons:
          safeguard.reasons.map(
            (reason) => reason.code,
          ),
      };
    }

    const ref = messageRef(message);
    await this.target.deleteOnServer(ref);

    await this.audit?.recordManualDecision({
      tenantId: message.tenantId,
      accountId: message.accountId,
      canonicalMessageId: message.id,
      provider: "pop3",
      providerMessageId:
        message.provider.messageId,
      ...(message.internetMessageId
        ? {
            internetMessageId:
              message.internetMessageId,
          }
        : {}),
      actor: {
        type: "system",
        id: "pop3_server_delete_policy",
      },
      requestedAction:
        "pop3_delete_from_server",
      executedAction: "pop3_dele",
      outcome: "succeeded",
      reason:
        "POP3 delete-after-fetch retention policy reached its safety delay",
      metadata: {
        deleteFromServerAfterDays:
          days,
        dueAt,
        sequenceNumber:
          ref.sequenceNumber,
        hasUidl: Boolean(ref.uidl),
      },
    });

    return {
      outcome: "deleted",
      dueAt,
    };
  }
}
