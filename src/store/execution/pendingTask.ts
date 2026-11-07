/**
 * The provider request a generate node is waiting on, kept on the node.
 *
 * Kie and Comfy Router runs are polled from the browser. The provider goes
 * on with the run whatever the app does, so the node keeps the request
 * (`pendingTask`) while it waits and after it stops waiting without an
 * answer. Saved with the workflow and in the desktop crash checkpoint, it
 * lets the run be picked up again later. See docs/generation-polling.md.
 */

import type { GenerateResponse, PendingGenerationTask } from "@/types";
import { GenerationStillRunningError, pollGenerateTask } from "./pollTaskCompletion";
import type { NodeExecutionContext } from "./types";

/** The abort reason of the user's Stop (stopWorkflow). */
export const USER_STOP_REASON = "user-cancelled";

/** The request a polling envelope from /api/generate names. */
export function pendingTaskFrom(envelope: GenerateResponse, submittedAt: number = Date.now()): PendingGenerationTask {
  return {
    provider: envelope.pollProvider ?? "",
    taskId: envelope.taskId ?? "",
    modelId: envelope.pollModelId ?? "",
    modelName: envelope.pollModelName ?? "",
    mediaType: envelope.pollMediaType ?? "",
    submittedAt,
  };
}

/**
 * Poll a request to the provider's answer, with the request on the node
 * meanwhile. It is cleared once the provider answers (the media, or its
 * reason for failing the run) and when the user stops the run. It stays when
 * the poller stops waiting without an answer (GenerationStillRunningError)
 * and when the run is cut off any other way (another node's failure, the
 * local server going away), since the provider carries on regardless.
 */
export async function waitForPendingTask(
  ctx: Pick<NodeExecutionContext, "node" | "updateNodeData" | "signal">,
  task: PendingGenerationTask,
  headers: Record<string, string>
): Promise<GenerateResponse> {
  const { node, updateNodeData, signal } = ctx;
  const clear = () => updateNodeData(node.id, { pendingTask: undefined });
  updateNodeData(node.id, { pendingTask: task });

  let result: GenerateResponse;
  try {
    result = await pollGenerateTask({ ...task, headers, signal });
  } catch (error) {
    if (!(error instanceof GenerationStillRunningError) && signal?.reason === USER_STOP_REASON) clear();
    throw error;
  }
  clear();
  return result;
}
