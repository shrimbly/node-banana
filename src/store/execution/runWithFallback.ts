/**
 * runWithFallback
 *
 * Shared helper that wraps a primary model attempt with an optional fallback.
 * On primary failure (non-abort), the helper runs the fallback once and stamps
 * metadata onto the node so the UI can render a "Fallback used" badge.
 *
 * If the primary and fallback resolve to the same provider + modelId, the
 * fallback is skipped to avoid double-billing.
 *
 * JSON-compatible with Node Banana Pro: the fallbackModel field and the three
 * __-prefixed metadata fields match NBP's shape exactly so config round-trips
 * cleanly between the two apps.
 */

import type { SelectedModel, WorkflowNodeData } from "@/types";
import { GenerationStillRunningError } from "./pollTaskCompletion";

export interface RunWithFallbackOptions {
  nodeId: string;
  primary: SelectedModel;
  fallback?: SelectedModel;
  fallbackParameters?: Record<string, unknown>;
  updateNodeData: (id: string, data: Partial<WorkflowNodeData>) => void;
  runOnce: (model: SelectedModel, parametersOverride?: Record<string, unknown>) => Promise<void>;
  /** Data to merge when transitioning to fallback (e.g. { outputImage: null }) */
  clearOutput?: Partial<WorkflowNodeData>;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Not a failure to fall back from: stopped, or still running on the provider,
 * where a fallback would start a second paid run beside the first.
 */
function endsTheRun(err: unknown): boolean {
  return isAbortError(err) || err instanceof GenerationStillRunningError;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

function isSameModel(a: SelectedModel, b: SelectedModel): boolean {
  return a.provider === b.provider && a.modelId === b.modelId;
}

export async function runWithFallback(
  options: RunWithFallbackOptions
): Promise<void> {
  const { nodeId, primary, fallback, fallbackParameters, updateNodeData, runOnce, clearOutput } = options;

  // Clear any prior fallback metadata before we start.
  updateNodeData(nodeId, {
    __usedFallback: undefined,
    __fallbackModelUsed: undefined,
    __primaryError: undefined,
  });

  let primaryError: unknown;
  try {
    await runOnce(primary, undefined);
    return;
  } catch (err) {
    if (endsTheRun(err)) throw err;
    primaryError = err;
  }

  // No fallback, or same model as primary — rethrow the primary error.
  if (!fallback || isSameModel(primary, fallback)) {
    throw primaryError;
  }

  const primaryErrMsg = errorMessage(primaryError);

  // Clear error state and stale output, show the fallback is now running.
  updateNodeData(nodeId, {
    ...clearOutput,
    status: "loading",
    error: null,
    __usedFallback: true,
    __fallbackModelUsed: fallback.displayName,
    __primaryError: primaryErrMsg,
  });

  try {
    await runOnce(fallback, fallbackParameters);
    // Success on fallback: stamp metadata and ensure status reflects completion.
    updateNodeData(nodeId, {
      status: "complete",
      error: null,
      __usedFallback: true,
      __fallbackModelUsed: fallback.displayName,
      __primaryError: primaryErrMsg,
    });
  } catch (err) {
    if (endsTheRun(err)) throw err;
    const fallbackErrMsg = errorMessage(err);
    const combined = `Primary failed: ${primaryErrMsg}. Fallback failed: ${fallbackErrMsg}`;
    updateNodeData(nodeId, {
      status: "error",
      error: combined,
    });
    throw new Error(combined);
  }
}
