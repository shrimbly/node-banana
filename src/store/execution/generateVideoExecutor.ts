/**
 * GenerateVideo Executor
 *
 * Unified executor for generateVideo nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { GenerateResponse, GenerateVideoNodeData, SelectedModel } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { updateGenerationRun } from "@/store/utils/generationRuns";
import { pollGenerateTask } from "./pollTaskCompletion";
import { submitPersistentGeneration } from "./persistentGeneration";
import { runWithFallback } from "./runWithFallback";
import { resolveGenerationCost } from "./generationCost";
import type { NodeExecutionContext } from "./types";

export interface GenerateVideoOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}

export async function applyVideoGenerationResult(
  ctx: NodeExecutionContext,
  options: {
    result: GenerateResponse;
    model: SelectedModel;
    prompt: string;
    runId: string;
  }
): Promise<void> {
  const {
    node,
    updateNodeData,
    getFreshNode,
    generationsPath,
    getEdges,
    getNodes,
    trackSaveGeneration,
    appendOutputGalleryVideo,
    appendOutputGalleryImage,
  } = ctx;
  const { result, model, prompt, runId } = options;
  const videoData = result.video || result.videoUrl;
  const outputContent = videoData || result.image;

  if (!result.success || !outputContent) {
    throw new Error(result.error || "Video generation failed");
  }

  const currentData = (getFreshNode(node.id)?.data || node.data) as GenerateVideoNodeData;
  const generationCost = resolveGenerationCost(model, result.generationCost);
  const timestamp = Date.now();
  const videoId = `${timestamp}`;
  const existingHistory = currentData.videoHistory || [];
  const alreadyApplied = existingHistory.some((item) => item.runId === runId);
  const updatedHistory = alreadyApplied
    ? existingHistory
    : [
        {
          id: videoId,
          runId,
          timestamp,
          prompt,
          model: model.modelId,
          generationCost,
        },
        ...existingHistory,
      ].slice(0, 50);

  if (alreadyApplied) {
    updateNodeData(node.id, {
      status: "complete",
      error: null,
      activeRunId: null,
      runStatus: null,
    });
    updateGenerationRun(runId, { status: "completed", error: undefined });
    return;
  }

  updateNodeData(node.id, {
    outputVideo: outputContent,
    status: "complete",
    error: null,
    videoHistory: updatedHistory,
    selectedVideoHistoryIndex: 0,
    activeRunId: null,
    runStatus: null,
  });

  const currentEdges = getEdges();
  const currentNodes = getNodes();
  currentEdges
    .filter((edge) => edge.source === node.id)
    .forEach((edge) => {
      const target = currentNodes.find((candidate) => candidate.id === edge.target);
      if (target?.type !== "outputGallery") return;
      if (videoData) appendOutputGalleryVideo(target.id, outputContent);
      else appendOutputGalleryImage(target.id, outputContent);
    });

  if (generationsPath) {
    const saveContent = videoData ? { video: videoData } : { image: result.image };
    const savePromise = fetch("/api/save-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        directoryPath: generationsPath,
        ...saveContent,
        prompt,
        imageId: videoId,
      }),
    })
      .then((response) => response.json())
      .then((saveResult) => {
        if (!saveResult.success || !saveResult.imageId || saveResult.imageId === videoId) return;
        const fresh = getFreshNode(node.id);
        if (!fresh) return;
        const data = fresh.data as GenerateVideoNodeData;
        const history = [...(data.videoHistory || [])];
        const index = history.findIndex((item) => item.runId === runId);
        if (index !== -1) {
          history[index] = { ...history[index], id: saveResult.imageId };
          updateNodeData(node.id, { videoHistory: history });
        }
      })
      .catch((error) => {
        console.error("Failed to save video generation:", error);
      });
    trackSaveGeneration(videoId, savePromise);
  }

  updateGenerationRun(runId, { status: "completed", error: undefined });
}

export async function executeGenerateVideo(
  ctx: NodeExecutionContext,
  options: GenerateVideoOptions = {}
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    signal,
    providerSettings,
  } = ctx;

  const { useStoredFallback = false } = options;

  const { images: connectedImages, text: connectedText, audio: connectedAudio, videos: connectedVideos, dynamicInputs } = getConnectedInputs(node.id);

  // Get fresh node data from store
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as GenerateVideoNodeData;

  // Determine images and text
  let images: string[];
  let text: string | null;

  if (useStoredFallback) {
    images = connectedImages.length > 0 ? connectedImages : nodeData.inputImages;
    text = connectedText ?? nodeData.inputPrompt;
    const hasPrompt = text || dynamicInputs.prompt || dynamicInputs.negative_prompt;
    const hasAudio = connectedAudio.length > 0;
    const hasVideo = connectedVideos.length > 0;
    if (!hasPrompt && images.length === 0 && !hasAudio && !hasVideo) {
      updateNodeData(node.id, {
        status: "error",
        error: "Missing required inputs",
      });
      throw new Error("Missing required inputs");
    }
  } else {
    images = connectedImages;
    text = connectedText;
    const hasPrompt = text || dynamicInputs.prompt || dynamicInputs.negative_prompt;
    const hasAudio = connectedAudio.length > 0;
    const hasVideo = connectedVideos.length > 0;
    if (!hasPrompt && images.length === 0 && !hasAudio && !hasVideo) {
      updateNodeData(node.id, {
        status: "error",
        error: "Missing required inputs",
      });
      throw new Error("Missing required inputs");
    }
  }

  if (!nodeData.selectedModel?.modelId) {
    updateNodeData(node.id, {
      status: "error",
      error: "No model selected",
    });
    throw new Error("No model selected");
  }

  updateNodeData(node.id, {
    inputImages: images,
    inputPrompt: text,
    status: "loading",
    error: null,
  });

  const runOnce = async (modelToUse: SelectedModel, parametersOverride?: Record<string, unknown>): Promise<void> => {
    const provider = modelToUse.provider;
    const headers = buildGenerateHeaders(provider, providerSettings);

    const requestPayload = {
      images,
      prompt: text,
      selectedModel: modelToUse,
      parameters: parametersOverride ?? nodeData.parameters,
      dynamicInputs,
      mediaType: "video" as const,
    };

    try {
      let runId = "";
      const submitted = await submitPersistentGeneration({
        workflowId: ctx.workflowId ?? null,
        nodeId: node.id,
        model: modelToUse,
        prompt: text || "",
        headers,
        payload: requestPayload,
        signal,
        onCreated: (run) => {
          runId = run.runId;
          updateNodeData(node.id, {
            activeRunId: run.runId,
            runStatus: "submitting",
          });
        },
      });
      let result = submitted.result;
      runId = submitted.run.runId;

      // Some providers return their durable task id before the final result.
      if (result.polling) {
        if (!result.taskId) {
          throw new Error("Provider returned a polling response without a task id");
        }
        const pollProvider = result.pollProvider || provider;
        updateGenerationRun(runId, {
          status: "provider-polling",
          providerTaskId: result.taskId,
          pollProvider,
        });
        updateNodeData(node.id, { runStatus: pollProvider });
        result = await pollGenerateTask({
          taskId: result.taskId,
          provider: pollProvider,
          modelId: result.pollModelId || modelToUse.modelId,
          modelName: result.pollModelName || modelToUse.displayName,
          mediaType: result.pollMediaType || "video",
          headers,
          signal,
        });

        if (!result.success) {
          updateNodeData(node.id, {
            status: "error",
            error: result.error || "Video generation failed",
          });
          throw new Error(result.error || "Video generation failed");
        }
      }

      if (!result.success || !(result.video || result.videoUrl || result.image)) {
        updateNodeData(node.id, {
          status: "error",
          error: result.error || "Video generation failed",
          activeRunId: null,
          runStatus: null,
        });
        updateGenerationRun(runId, {
          status: "failed",
          error: result.error || "Video generation failed",
        });
        throw new Error(result.error || "Video generation failed");
      }

      await applyVideoGenerationResult(ctx, {
        result,
        model: modelToUse,
        prompt: text || "",
        runId,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      let errorMessage = "Video generation failed";
      if (error instanceof TypeError && error.message.includes("NetworkError")) {
        errorMessage = "Network error. Check your connection and try again.";
      } else if (error instanceof TypeError) {
        errorMessage = `Network error: ${error.message}`;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      updateNodeData(node.id, {
        status: "error",
        error: errorMessage,
      });
      throw new Error(errorMessage);
    }
  };

  await runWithFallback({
    nodeId: node.id,
    primary: nodeData.selectedModel,
    fallback: nodeData.fallbackModel,
    fallbackParameters: nodeData.fallbackParameters,
    updateNodeData,
    runOnce,
    clearOutput: { outputVideo: null },
  });
}
