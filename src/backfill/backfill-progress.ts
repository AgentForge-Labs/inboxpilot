import type {
  BackfillJob,
  BackfillProgressView,
} from "./backfill-types.js";

export function buildBackfillProgress(
  job: BackfillJob,
): BackfillProgressView {
  const percent =
    job.totalEstimate && job.totalEstimate > 0
      ? Math.min(
          100,
          Math.round((job.messagesSeen / job.totalEstimate) * 10_000) / 100,
        )
      : job.status === "completed"
        ? 100
        : undefined;

  return {
    jobId: job.id,
    status: job.status,
    mode: job.config.mode,
    pagesProcessed: job.pagesProcessed,
    messagesSeen: job.messagesSeen,
    messagesClassified: job.messagesClassified,
    uniqueUsageCharged: job.uniqueUsageCharged,
    duplicateUsageSkipped: job.duplicateUsageSkipped,
    ...(job.totalEstimate !== undefined
      ? { totalEstimate: job.totalEstimate }
      : {}),
    ...(percent !== undefined ? { percent } : {}),
    ...(job.nextRunAt ? { nextRunAt: job.nextRunAt } : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
  };
}
