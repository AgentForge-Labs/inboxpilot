import type {
  MailboxActionPlan,
  MessageStateSnapshot,
} from "./action-types.js";

export type MutationRecordStatus = "in_progress" | "succeeded" | "failed";

export interface MutationFailure {
  category: "retryable" | "permanent" | "uncertain";
  code: string;
  message: string;
}

export interface MutationRecord {
  idempotencyKey: string;
  planHash: string;
  planId: string;
  status: MutationRecordStatus;
  attemptCount: number;
  startedAt: string;
  completedAt?: string;
  beforeState: MessageStateSnapshot;
  afterState?: MessageStateSnapshot | null;
  afterStateStatus?: "captured" | "unavailable" | "deleted";
  failure?: MutationFailure;
}

export interface ActionAuditEvent {
  idempotencyKey: string;
  planId: string;
  tenantId: string;
  accountId: string;
  providerMessageId: string;
  action: MailboxActionPlan["action"]["type"];
  actorType: string;
  actorId?: string;
  outcome: "succeeded" | "failed" | "retrying" | "deduplicated";
  attempt: number;
  timestamp: string;
  errorCode?: string;
  errorCategory?: MutationFailure["category"];
}

export interface ActionExecutionStore {
  get(idempotencyKey: string): Promise<MutationRecord | undefined>;
  claim(record: MutationRecord): Promise<boolean>;
  noteAttempt(idempotencyKey: string, attemptCount: number): Promise<void>;
  complete(
    idempotencyKey: string,
    update: {
      completedAt: string;
      afterState: MessageStateSnapshot | null;
      afterStateStatus: "captured" | "unavailable" | "deleted";
    },
  ): Promise<void>;
  fail(
    idempotencyKey: string,
    update: {
      completedAt: string;
      failure: MutationFailure;
    },
  ): Promise<void>;
  appendAudit(event: ActionAuditEvent): Promise<void>;
}

export class InMemoryActionExecutionStore implements ActionExecutionStore {
  readonly records = new Map<string, MutationRecord>();
  readonly audit: ActionAuditEvent[] = [];

  async get(idempotencyKey: string): Promise<MutationRecord | undefined> {
    return this.records.get(idempotencyKey);
  }

  async claim(record: MutationRecord): Promise<boolean> {
    if (this.records.has(record.idempotencyKey)) return false;
    this.records.set(record.idempotencyKey, structuredClone(record));
    return true;
  }

  async noteAttempt(
    idempotencyKey: string,
    attemptCount: number,
  ): Promise<void> {
    const record = this.records.get(idempotencyKey);
    if (!record) throw new Error("Mutation record not found");
    record.attemptCount = attemptCount;
  }

  async complete(
    idempotencyKey: string,
    update: {
      completedAt: string;
      afterState: MessageStateSnapshot | null;
      afterStateStatus: "captured" | "unavailable" | "deleted";
    },
  ): Promise<void> {
    const record = this.records.get(idempotencyKey);
    if (!record) throw new Error("Mutation record not found");
    record.status = "succeeded";
    record.completedAt = update.completedAt;
    record.afterState = update.afterState;
    record.afterStateStatus = update.afterStateStatus;
    delete record.failure;
  }

  async fail(
    idempotencyKey: string,
    update: {
      completedAt: string;
      failure: MutationFailure;
    },
  ): Promise<void> {
    const record = this.records.get(idempotencyKey);
    if (!record) throw new Error("Mutation record not found");
    record.status = "failed";
    record.completedAt = update.completedAt;
    record.failure = update.failure;
  }

  async appendAudit(event: ActionAuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }
}
