import type { BatchJob, BatchJobStore } from './types';

/** A deep copy through JSON: a job is plain JSON by contract, and stays apart from the caller's. */
const copy = (job: BatchJob): BatchJob => JSON.parse(JSON.stringify(job)) as BatchJob;

/**
 * An in-memory `BatchJobStore` (2.3): for tests and single-process apps. A job
 * store that survives a restart keeps the same records in your database;
 * `BatchJob` is plain JSON, so one row per `job.id` with the JSON is enough.
 */
export function createMemoryBatchJobStore(): BatchJobStore {
  const jobs = new Map<string, BatchJob>();
  return Object.freeze({
    async put(job: BatchJob): Promise<void> {
      jobs.set(job.id, copy(job));
    },
    async get(id: string): Promise<BatchJob | undefined> {
      const job = jobs.get(id);
      return job && copy(job);
    },
    async list(): Promise<BatchJob[]> {
      return [...jobs.values()].map(copy).sort((a, b) => a.submittedAt - b.submittedAt);
    },
    async delete(id: string): Promise<void> {
      jobs.delete(id);
    },
  });
}
