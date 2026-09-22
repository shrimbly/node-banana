/**
 * Client-Side Task Polling
 *
 * Shared utility for polling /api/generate/poll until a long-running
 * task completes. Each poll is a short-lived HTTP request (~1s),
 * making the system resilient to connection idle timeouts.
 */

import type { GenerateResponse } from "@/types";

export interface PollGenerateTaskOptions {
  taskId: string;
  provider: string;
  modelId: string;
  modelName: string;
  mediaType: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

const INITIAL_INTERVAL = 3000; // 3s
const MAX_INTERVAL = 8000; // 8s
// Ceiling for a wait the server asks for (Retry-After). Long enough to honour a
// real queue estimate, short enough that a bad header cannot park the poller.
const MAX_SERVER_INTERVAL = 60 * 1000; // 60s
const INTERVAL_STEP = 500; // grow by 500ms each poll
const MAX_POLL_TIME = 10 * 60 * 1000; // 10 minutes
const MAX_CONSECUTIVE_ERRORS = 10;

/**
 * Poll /api/generate/poll until the task completes, fails, or times out.
 * Returns the final GenerateResponse with media data.
 */
export async function pollGenerateTask(
  options: PollGenerateTaskOptions
): Promise<GenerateResponse> {
  const { taskId, provider, modelId, modelName, mediaType, headers, signal } = options;

  const startTime = Date.now();
  let interval = INITIAL_INTERVAL;
  let consecutiveErrors = 0;

  while (true) {
    // Check client-side timeout
    if (Date.now() - startTime > MAX_POLL_TIME) {
      return { success: false, error: `${modelName}: Generation timed out after 10 minutes` };
    }

    // Check abort signal
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    // Wait before polling
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve();
      }, interval);
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });

    // Make poll request
    let response: Response;
    try {
      response = await fetch("/api/generate/poll", {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId, provider, modelId, modelName, mediaType }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // Network errors during individual polls are recoverable
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      consecutiveErrors++;
      console.warn(`[poll] Network error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, error);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return { success: false, error: `${modelName}: Polling failed after ${MAX_CONSECUTIVE_ERRORS} consecutive network errors` };
      }
      interval = Math.min(interval + INTERVAL_STEP, MAX_INTERVAL);
      continue;
    }

    if (!response.ok) {
      // Server errors and transient HTTP statuses may be retried
      if (response.status >= 500 || response.status === 429 || response.status === 408) {
        consecutiveErrors++;
        console.warn(`[poll] Transient error ${response.status} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          const errorText = await response.text().catch(() => "");
          return { success: false, error: `${modelName}: Polling failed - ${errorText || `HTTP ${response.status}`}` };
        }
        interval = Math.min(interval + INTERVAL_STEP, MAX_INTERVAL);
        continue;
      }

      // Other 4xx errors are not recoverable
      const errorText = await response.text().catch(() => "");
      let errorMessage = `HTTP ${response.status}`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error || errorMessage;
      } catch {
        if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
      }
      return { success: false, error: errorMessage };
    }

    let result: GenerateResponse;
    try {
      result = await response.json();
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        return { success: false, error: `${modelName}: Polling failed - invalid response` };
      }
      continue;
    }

    // Reset on successful response
    consecutiveErrors = 0;

    // Still polling — task not done yet. A server-suggested wait (Retry-After)
    // wins over the local ramp, capped at MAX_SERVER_INTERVAL and by the time
    // left before the overall timeout.
    if (result.polling) {
      const suggested = result.retryAfterMs;
      if (typeof suggested === "number" && suggested > 0) {
        const remaining = Math.max(0, MAX_POLL_TIME - (Date.now() - startTime));
        interval = Math.min(suggested, MAX_SERVER_INTERVAL, remaining);
      } else {
        interval = Math.min(interval + INTERVAL_STEP, MAX_INTERVAL);
      }
      continue;
    }

    // Task completed (success or failure) — return final result
    return result;
  }
}
