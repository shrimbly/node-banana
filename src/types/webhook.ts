/**
 * Webhook Types
 *
 * Types for webhook trigger/response system including
 * API request/response formats and job tracking.
 */

/**
 * Request body for the webhook endpoint
 */
export interface WebhookRequest {
  images?: (string | null)[]; // URLs or base64 data URLs, max 10
  text?: string; // Prompt text
  callbackUrl?: string; // For async mode
  recordId?: string; // Pass-through ID (e.g. Airtable record ID)
  apiKeys?: {
    gemini?: string;
    replicate?: string;
    fal?: string;
    kie?: string;
    wavespeed?: string;
    openai?: string;
  };
}

/**
 * Single output from a webhook response node
 */
export interface WebhookOutput {
  nodeId: string;
  type: "image" | "video" | "text";
  base64?: string;
  url?: string;
  text?: string;
}

/**
 * Response from the webhook endpoint (sync mode)
 */
export interface WebhookSyncResponse {
  success: boolean;
  outputs?: WebhookOutput[];
  error?: string;
  executionTime?: number; // ms
}

/**
 * Response from the webhook endpoint (async mode)
 */
export interface WebhookAsyncResponse {
  success: boolean;
  jobId: string;
  status: "processing";
}

/**
 * Job status for async webhook execution
 */
export type WebhookJobStatus = "processing" | "completed" | "failed";

/**
 * Stored job data for async tracking
 */
export interface WebhookJob {
  status: WebhookJobStatus;
  result?: WebhookOutput[];
  error?: string;
  createdAt: number;
  completedAt?: number;
  callbackUrl?: string;
}
