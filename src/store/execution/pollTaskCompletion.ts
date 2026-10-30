/**
 * Client-Side Task Polling
 *
 * Shared utility for polling /api/generate/poll until a long-running
 * task completes. Each poll is a short-lived HTTP request (~1s),
 * making the system resilient to connection idle timeouts.
 *
 * It waits for as long as the provider says the run is going: a video can
 * take well over ten minutes, and the provider keeps working whether or not
 * anyone is asking. The safety net only stops a poller that would otherwise
 * never end. When the poller stops without the provider's answer, it throws
 * GenerationStillRunningError carrying the request id, so the node can keep
 * the request and pick it up again.
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
// Longer than any real run (Comfy Cloud's own job cap is about 35 minutes).
// Reaching it is not a failure: the run may still finish on the provider.
export const POLL_SAFETY_NET_MS = 90 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 10;

/** The provider a polled request runs on, as the messages name it. */
export function pollProviderName(provider: string): string {
  if (provider === "comfy") return "Comfy Router";
  if (provider === "kie") return "Kie.ai";
  return provider;
}

/**
 * The poller stopped waiting while the provider may still be running the
 * request: the safety net was reached, or the app could not ask. The request
 * is not lost; the node keeps it to pick up again.
 */
export class GenerationStillRunningError extends Error {
  readonly taskId: string;
  readonly provider: string;

  constructor(message: string, taskId: string, provider: string) {
    super(message);
    this.name = "GenerationStillRunningError";
    this.taskId = taskId;
    this.provider = provider;
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** The `error` of a JSON error body, or the body itself, shortened. */
function errorDetail(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown } | null;
    return typeof parsed?.error === "string" && parsed.error ? parsed.error : `HTTP ${status}`;
  } catch {
    return text ? `HTTP ${status} - ${text.substring(0, 200)}` : `HTTP ${status}`;
  }
}

/**
 * Poll /api/generate/poll until the provider answers: the media, or its
 * reason for failing the run. Throws an AbortError when `signal` aborts, and
 * GenerationStillRunningError when it stops waiting without an answer.
 */
export async function pollGenerateTask(
  options: PollGenerateTaskOptions
): Promise<GenerateResponse> {
  const { taskId, provider, modelId, modelName, mediaType, headers, signal } = options;
  const providerName = pollProviderName(provider);

  const deadline = Date.now() + POLL_SAFETY_NET_MS;
  let interval = INITIAL_INTERVAL;
  let consecutiveErrors = 0;

  const stoppedWaiting = (what: string) =>
    new GenerationStillRunningError(
      `${modelName}: ${what} (request ${taskId}). The node keeps the request; pick it up again from the node.`,
      taskId,
      provider
    );
  const atTheNet = () =>
    stoppedWaiting(`still running on ${providerName} after ${POLL_SAFETY_NET_MS / 60_000} minutes`);

  // A poll that went wrong in a way a later one may not: count it, and stop
  // waiting after too many in a row, or once this was the last look.
  const transientError = (lastLook: boolean, detail: string) => {
    consecutiveErrors++;
    console.warn(`[poll] ${detail} (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS})`);
    if (lastLook) throw atTheNet();
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      throw stoppedWaiting(
        `stopped checking after ${MAX_CONSECUTIVE_ERRORS} failed tries (${detail}), and the run may still be going on ${providerName}`
      );
    }
    interval = Math.min(interval + INTERVAL_STEP, MAX_INTERVAL);
  };

  while (true) {
    if (signal?.aborted) throw abortError();

    // Never wait past the net: the poll made there is the last look, so a run
    // that finished or failed meanwhile still reports its real outcome.
    await wait(Math.min(interval, Math.max(0, deadline - Date.now())), signal);
    const lastLook = Date.now() >= deadline;

    let response: Response;
    try {
      response = await fetch("/api/generate/poll", {
        method: "POST",
        headers,
        body: JSON.stringify({ taskId, provider, modelId, modelName, mediaType }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      transientError(lastLook, error instanceof Error ? error.message : "network error");
      continue;
    }

    if (!response.ok) {
      // Server errors and transient HTTP statuses may be retried
      if (response.status >= 500 || response.status === 429 || response.status === 408) {
        const errorText = await response.text().catch(() => "");
        transientError(lastLook, errorDetail(response.status, errorText));
        continue;
      }

      const errorText = await response.text().catch(() => "");
      const detail = errorDetail(response.status, errorText);
      // The provider refused the check (no key, or a rejected one), which says
      // nothing about the run itself
      if (response.status === 401 || response.status === 402 || response.status === 403) {
        throw stoppedWaiting(`could not check on the run (${detail}), and it may still be going on ${providerName}`);
      }
      // Any other 4xx is final: the provider's reason for failing the run
      return { success: false, error: detail };
    }

    let result: GenerateResponse;
    try {
      result = await response.json();
    } catch {
      transientError(lastLook, "invalid response");
      continue;
    }

    // Reset on successful response
    consecutiveErrors = 0;

    // Still running. A server-suggested wait (Retry-After) wins over the local
    // ramp, capped at MAX_SERVER_INTERVAL (and by the net, above).
    if (result.polling) {
      if (lastLook) throw atTheNet();
      const suggested = result.retryAfterMs;
      if (typeof suggested === "number" && suggested > 0) {
        interval = Math.min(suggested, MAX_SERVER_INTERVAL);
      } else {
        interval = Math.min(interval + INTERVAL_STEP, MAX_INTERVAL);
      }
      continue;
    }

    // Task completed (success or failure) — return final result
    return result;
  }
}
