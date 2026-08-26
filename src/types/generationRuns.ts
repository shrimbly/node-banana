import type { ProviderType } from "./providers";

export type PersistedGenerationRunStatus =
  | "submitting"
  | "running"
  | "provider-polling"
  | "completed"
  | "failed";

/**
 * Small, JSON-safe recovery record for a generation that may outlive the page.
 * Media and API keys deliberately stay out of localStorage.
 */
export interface PersistedGenerationRun {
  version: 1;
  runId: string;
  workflowId: string | null;
  nodeId: string;
  nodeType: "generateVideo";
  provider: ProviderType;
  modelId: string;
  modelName: string;
  mediaType: "video";
  prompt: string;
  status: PersistedGenerationRunStatus;
  providerTaskId?: string;
  pollProvider?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface LocalGenerationRunResponse {
  state: "running" | "completed" | "failed";
  result?: unknown;
  responseStatus?: number;
  error?: string;
}
