/**
 * Job Store
 *
 * In-memory store for tracking async webhook job execution.
 * Jobs expire after 1 hour.
 */

import type { WebhookJob, WebhookOutput } from "@/types/webhook";

const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

const jobs = new Map<string, WebhookJob>();

/**
 * Generate a unique job ID
 */
export function createJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Create a new job entry
 */
export function createJob(jobId: string, callbackUrl?: string): void {
  cleanup();
  jobs.set(jobId, {
    status: "processing",
    createdAt: Date.now(),
    callbackUrl,
  });
}

/**
 * Mark a job as completed with results
 */
export function completeJob(jobId: string, result: WebhookOutput[]): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "completed";
    job.result = result;
    job.completedAt = Date.now();
  }
}

/**
 * Mark a job as failed with error
 */
export function failJob(jobId: string, error: string): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = "failed";
    job.error = error;
    job.completedAt = Date.now();
  }
}

/**
 * Get job status and results
 */
export function getJob(jobId: string): WebhookJob | undefined {
  return jobs.get(jobId);
}

/**
 * Remove expired jobs
 */
function cleanup(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}
