import type {
  CanonicalMessage,
  ClassificationState,
  ProviderKind,
} from "../domain/email-model.js";
import type { ProviderAdapter } from "../providers/provider-adapter.js";

export type BackfillMode = "classify_only" | "ingest_and_classify";

export type BackfillJobStatus =
  | "queued"
  | "running"
  | "paused"
  | "throttled"
  | "cancelled"
  | "completed"
  | "failed";

export interface BackfillJobConfig {
  tenantId: string;
  accountId: string;
  provider: ProviderKind;
  mode: BackfillMode;
  since: string;
  until: string;
  pageSize: number;
  maxPagesPerRun: number;
}

export interface BackfillJob {
  id: string;
  version: number;
  status: BackfillJobStatus;
  config: BackfillJobConfig;
  cursor?: string;
  pagesProcessed: number;
  messagesSeen: number;
  messagesClassified: number;
  uniqueUsageCharged: number;
  duplicateUsageSkipped: number;
  totalEstimate?: number;
  nextRunAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface HistoricalBackfillPage {
  messages: CanonicalMessage[];
  nextCursor?: string;
  hasMore: boolean;
  totalEstimate?: number;
}

export interface HistoricalBackfillSource {
  fetchPage(input: {
    cursor?: string;
    limit: number;
    since: string;
    until: string;
  }): Promise<HistoricalBackfillPage>;
}

export interface BackfillSourceResolver {
  resolve(job: BackfillJob): Promise<HistoricalBackfillSource>;
}

export interface BackfillClassifier {
  classify(
    message: CanonicalMessage,
    context: {
      jobId: string;
      mode: BackfillMode;
      reclassification: boolean;
    },
  ): Promise<ClassificationState>;
}

export interface BackfillMessageRepository {
  getByProviderMessageId(input: {
    tenantId: string;
    accountId: string;
    provider: ProviderKind;
    providerMessageId: string;
  }): Promise<CanonicalMessage | undefined>;

  saveClassified(input: {
    job: BackfillJob;
    message: CanonicalMessage;
    classification: ClassificationState;
  }): Promise<"inserted" | "updated" | "classification_only">;
}

export interface BackfillUsageLedger {
  chargeUnique(input: {
    tenantId: string;
    accountId: string;
    provider: ProviderKind;
    providerMessageId: string;
  }): Promise<boolean>;
}

export interface BackfillJobStore {
  create(job: BackfillJob): Promise<void>;
  get(jobId: string): Promise<BackfillJob | undefined>;
  update(
    jobId: string,
    expectedVersion: number,
    mutate: (job: BackfillJob) => BackfillJob,
  ): Promise<BackfillJob>;
}

export interface BackfillRunResult {
  job: BackfillJob;
  pagesThisRun: number;
  status:
    | "completed"
    | "paused"
    | "cancelled"
    | "throttled"
    | "yielded"
    | "failed";
}

export interface BackfillProgressView {
  jobId: string;
  status: BackfillJobStatus;
  mode: BackfillMode;
  pagesProcessed: number;
  messagesSeen: number;
  messagesClassified: number;
  uniqueUsageCharged: number;
  duplicateUsageSkipped: number;
  totalEstimate?: number;
  percent?: number;
  nextRunAt?: string;
  lastError?: string;
}
