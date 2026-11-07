/**
 * Picking up a generate node's kept request (`pendingTask`) again.
 *
 * The run that sent the request is gone (the app stopped waiting, was
 * reloaded or crashed), and its request payload with it. What the output is
 * recorded with comes from the node instead: the model the request names,
 * that model's settings, and the prompt the run started with.
 */

import type {
  Generate3DNodeData,
  GenerateAudioNodeData,
  GenerateResponse,
  GenerateVideoNodeData,
  NanoBananaNodeData,
  PendingGenerationTask,
  ProviderType,
  SelectedModel,
} from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { waitForPendingTask } from "./pendingTask";
import { finishGenerateVideo } from "./generateVideoExecutor";
import { finishGenerateAudio } from "./generateAudioExecutor";
import { finishGenerate3D } from "./generate3dExecutor";
import { finishNanoBanana } from "./nanoBananaExecutor";
import type { GenerationRequest, NodeExecutionContext } from "./types";

type ResumableData = NanoBananaNodeData | GenerateVideoNodeData | GenerateAudioNodeData | Generate3DNodeData;

const RESUMABLE = new Set(["nanoBanana", "generateVideo", "generateAudio", "generate3d"]);

/** Whether a node of this type keeps a request it can pick up again. */
export function canResumePendingTask(type: string | undefined): boolean {
  return RESUMABLE.has(type ?? "");
}

/** The model that sent the request and its settings: the node's model, or its fallback. */
function requestedModel(data: ResumableData, task: PendingGenerationTask): Pick<GenerationRequest, "selectedModel" | "parameters"> {
  const sent = (model: SelectedModel | undefined): model is SelectedModel =>
    model?.provider === task.provider && model.modelId === task.modelId;
  if (sent(data.selectedModel)) return { selectedModel: data.selectedModel, parameters: data.parameters };
  if (sent(data.fallbackModel)) return { selectedModel: data.fallbackModel, parameters: data.fallbackParameters };
  // The node has been given another model since
  return { selectedModel: { provider: task.provider as ProviderType, modelId: task.modelId, displayName: task.modelName } };
}

/** The node's finish path, with the request rebuilt from the node. */
function finisher(ctx: NodeExecutionContext, data: ResumableData, task: PendingGenerationTask): (result: GenerateResponse) => void {
  const request: GenerationRequest = {
    ...requestedModel(data, task),
    prompt: data.inputPrompt,
    dynamicInputs: ctx.getConnectedInputs(ctx.node.id).dynamicInputs,
  };
  switch (ctx.node.type) {
    case "generateVideo":
      return (result) => finishGenerateVideo(ctx, result, request);
    case "generateAudio":
      return (result) => finishGenerateAudio(ctx, result, request);
    case "generate3d":
      return (result) => finishGenerate3D(ctx, result, request);
    default: {
      const image = data as NanoBananaNodeData;
      return (result) =>
        finishNanoBanana(ctx, result, {
          ...request,
          prompt: image.inputPrompt ?? "",
          aspectRatio: image.aspectRatio,
          resolution: image.resolution,
          useGoogleSearch: image.useGoogleSearch,
          useImageSearch: image.useImageSearch,
        });
    }
  }
}

/**
 * Poll the node's kept request to the provider's answer and finish it as the
 * run that sent it would have: the output in the carousel and the asset
 * library. The provider failing the run clears the request and shows its
 * reason; stopping waiting again keeps it. Throws as an executor does.
 */
export async function resumePendingTask(ctx: NodeExecutionContext): Promise<void> {
  const { node, updateNodeData, getFreshNode, providerSettings } = ctx;
  if (!canResumePendingTask(node.type)) return;
  const data = (getFreshNode(node.id)?.data ?? node.data) as ResumableData;
  const task = data.pendingTask;
  if (!task) return;

  const finish = finisher(ctx, data, task);
  updateNodeData(node.id, { status: "loading", error: null });
  try {
    const result = await waitForPendingTask(ctx, task, buildGenerateHeaders(task.provider, providerSettings));
    finish(result);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      // No longer waiting; a user's Stop has let the request go, anything else kept it
      updateNodeData(node.id, { status: "idle" });
      throw error;
    }
    updateNodeData(node.id, {
      status: "error",
      error: error instanceof Error ? error.message : `${task.modelName}: generation failed`,
    });
    throw error;
  }
}
