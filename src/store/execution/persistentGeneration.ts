import type {
  GenerateResponse,
  LocalGenerationRunResponse,
  PersistedGenerationRun,
  SelectedModel,
} from "@/types";
import {
  createGenerationRunId,
  updateGenerationRun,
  upsertGenerationRun,
} from "@/store/utils/generationRuns";

const INITIAL_INTERVAL = 1_000;
const MAX_INTERVAL = 5_000;
const INTERVAL_STEP = 500;
const MAX_CONSECUTIVE_ERRORS = 10;

interface SubmitPersistentGenerationOptions {
  workflowId: string | null;
  nodeId: string;
  model: SelectedModel;
  prompt: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
  onCreated?: (run: PersistedGenerationRun) => void;
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollLocalGenerationRun(
  runId: string,
  signal?: AbortSignal
): Promise<GenerateResponse> {
  let interval = INITIAL_INTERVAL;
  let consecutiveErrors = 0;

  for (;;) {
    if (signal?.aborted) throw abortError();

    let response: Response;
    let state: LocalGenerationRunResponse;
    try {
      response = await fetch(
        `/api/generate/run?runId=${encodeURIComponent(runId)}`,
        { signal }
      );
      state = (await response.json()) as LocalGenerationRunResponse;
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        throw abortError();
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        const message = "Generation recovery lost contact with the local server";
        updateGenerationRun(runId, { status: "failed", error: message });
        return { success: false, error: message };
      }
      await delay(interval, signal);
      interval = Math.min(MAX_INTERVAL, interval + INTERVAL_STEP);
      continue;
    }

    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      consecutiveErrors += 1;
      if (consecutiveErrors < MAX_CONSECUTIVE_ERRORS) {
        await delay(interval, signal);
        interval = Math.min(MAX_INTERVAL, interval + INTERVAL_STEP);
        continue;
      }
    } else {
      consecutiveErrors = 0;
    }

    if (state.state === "running") {
      updateGenerationRun(runId, { status: "running" });
      await delay(interval, signal);
      interval = Math.min(MAX_INTERVAL, interval + INTERVAL_STEP);
      continue;
    }

    if (!response.ok || state.state === "failed") {
      const message = state.error || `Generation run failed (HTTP ${response.status})`;
      updateGenerationRun(runId, { status: "failed", error: message });
      return { success: false, error: message };
    }

    const result = state.result as GenerateResponse | undefined;
    if (!result) {
      const message = "Generation run completed without a result";
      updateGenerationRun(runId, { status: "failed", error: message });
      return { success: false, error: message };
    }

    if (state.responseStatus && state.responseStatus >= 400 && result.success !== false) {
      return { success: false, error: `Generation failed (HTTP ${state.responseStatus})` };
    }

    return result;
  }
}

export async function submitPersistentGeneration(
  options: SubmitPersistentGenerationOptions
): Promise<{ run: PersistedGenerationRun; result: GenerateResponse }> {
  const runId = createGenerationRunId();
  const now = Date.now();
  const run: PersistedGenerationRun = {
    version: 1,
    runId,
    workflowId: options.workflowId,
    nodeId: options.nodeId,
    nodeType: "generateVideo",
    provider: options.model.provider,
    modelId: options.model.modelId,
    modelName: options.model.displayName,
    mediaType: "video",
    prompt: options.prompt,
    status: "submitting",
    createdAt: now,
    updatedAt: now,
  };
  upsertGenerationRun(run);
  options.onCreated?.(run);

  const response = await fetch("/api/generate/submit", {
    method: "POST",
    headers: options.headers,
    body: JSON.stringify({ ...options.payload, clientRunId: runId }),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    const message = body?.error || `Generation submission failed (HTTP ${response.status})`;
    updateGenerationRun(runId, { status: "failed", error: message });
    throw new Error(message);
  }

  updateGenerationRun(runId, { status: "running" });
  const result = await pollLocalGenerationRun(runId, options.signal);
  return { run, result };
}
