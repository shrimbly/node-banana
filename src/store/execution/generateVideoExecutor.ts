/**
 * GenerateVideo Executor
 *
 * Unified executor for generateVideo nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { AspectRatio, GenerateResponse, GenerateVideoNodeData, SelectedModel } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { GenerationStillRunningError } from "./pollTaskCompletion";
import { pendingTaskFrom, waitForPendingTask } from "./pendingTask";
import { runWithFallback } from "./runWithFallback";
import type { GenerationRequest, NodeExecutionContext } from "./types";
import { MissingInputError } from "./missingInput";
import {
  assetCost,
  assetModel,
  assetParameters,
  assetProducer,
  followRecording,
  parameterFraming,
  recordOutput,
  resolvedPrompt,
} from "./assetRecording";
import { inlineMediaReferences } from "@/lib/media/references";

export interface GenerateVideoOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
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
        status: "skipped",
        error: "Missing required inputs",
      });
      throw new MissingInputError("Missing required inputs");
    }
  } else {
    images = connectedImages;
    text = connectedText;
    const hasPrompt = text || dynamicInputs.prompt || dynamicInputs.negative_prompt;
    const hasAudio = connectedAudio.length > 0;
    const hasVideo = connectedVideos.length > 0;
    if (!hasPrompt && images.length === 0 && !hasAudio && !hasVideo) {
      updateNodeData(node.id, {
        status: "skipped",
        error: "Missing required inputs",
      });
      throw new MissingInputError("Missing required inputs");
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
    // A new run lets go of any request an earlier one left to pick up
    pendingTask: undefined,
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
      const response = await fetch("/api/generate", {
        method: "POST",
        headers,
        // Providers take media inline; node data may hold it by reference
        body: JSON.stringify(await inlineMediaReferences(requestPayload)),
        ...(signal ? { signal } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `HTTP ${response.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorMessage;
        } catch {
          if (errorText) errorMessage += ` - ${errorText.substring(0, 200)}`;
        }

        updateNodeData(node.id, {
          status: "error",
          error: errorMessage,
        });
        throw new Error(errorMessage);
      }

      let result = await response.json();

      // A long-running request (Kie, Comfy Router): poll it, kept on the node meanwhile
      if (result.polling) {
        result = await waitForPendingTask(ctx, pendingTaskFrom(result), headers);

        if (!result.success) {
          updateNodeData(node.id, {
            status: "error",
            error: result.error || "Video generation failed",
          });
          throw new Error(result.error || "Video generation failed");
        }
      }

      finishGenerateVideo(ctx, result, requestPayload);
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
      // Still running on the provider: no fallback, and the node keeps the request
      throw error instanceof GenerationStillRunningError ? error : new Error(errorMessage);
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

/**
 * Put a finished run's video on the node, or the still some video models
 * answer with: the asset library, the carousel, downstream galleries, the
 * cost and the generations folder. Throws when the answer holds neither. A
 * run ends here, and so does a request picked up again (resumeGeneration).
 */
export function finishGenerateVideo(ctx: NodeExecutionContext, result: GenerateResponse, request: GenerationRequest): void {
  const {
    node,
    updateNodeData,
    getFreshNode,
    getEdges,
    getNodes,
    addIncurredCost,
    addToGlobalHistory,
    generationsPath,
    trackSaveGeneration,
    appendOutputGalleryVideo,
    appendOutputGalleryImage,
  } = ctx;
  const { selectedModel: modelToUse, prompt: text, parameters, dynamicInputs } = request;
  const nodeData = (getFreshNode(node.id)?.data || node.data) as GenerateVideoNodeData;

  const videoData = result.video || result.videoUrl;
  const outputContent = videoData || result.image;
  if (!result.success || !outputContent) {
    updateNodeData(node.id, {
      status: "error",
      error: result.error || "Video generation failed",
    });
    throw new Error(result.error || "Video generation failed");
  }

  const timestamp = Date.now();
  const videoId = `${timestamp}`;

  // fal bills a flat amount per run
  const runCost = modelToUse.provider === "fal" && modelToUse.pricing ? modelToUse.pricing.amount : null;
  const recorded = recordOutput(ctx, {
    // Some video models answer with a still
    kind: videoData ? "video" : "image",
    origin: "generated",
    media: outputContent,
    prompt: resolvedPrompt(text, dynamicInputs),
    model: assetModel(modelToUse),
    parameters: assetParameters(parameters),
    ...parameterFraming(parameters),
    cost: assetCost(runCost),
    producer: assetProducer(ctx),
  });

  // The carousel reloads its entries from the asset library, or from the
  // generations folder, so only a generation saved to one gets an entry.
  const newHistoryItem = {
    id: videoId,
    ...(recorded ? { assetId: recorded.assetId } : {}),
    timestamp,
    prompt: text || "",
    model: modelToUse.modelId || "",
    ...(ctx.batch ? { batch: ctx.batch } : {}),
  };
  const updatedHistory = [newHistoryItem, ...(nodeData.videoHistory || [])].slice(0, 50);

  updateNodeData(node.id, {
    outputVideo: outputContent,
    status: "complete",
    error: null,
    ...(generationsPath || recorded ? { videoHistory: updatedHistory, selectedVideoHistoryIndex: 0 } : {}),
  });

  // The recent-generations list, beside the images (a still is listed as one)
  addToGlobalHistory(
    {
      kind: videoData ? "video" : "image",
      image: outputContent,
      timestamp,
      prompt: resolvedPrompt(text, dynamicInputs) ?? "",
      aspectRatio: (parameterFraming(parameters).aspectRatio ?? "16:9") as AspectRatio,
      model: modelToUse.displayName || modelToUse.modelId,
    },
    recorded
  );

  // Push this result to downstream outputGallery nodes so a batch run
  // collects every item, not just the final one (mirrors the image path).
  // executeOutputGallery de-dupes, so the final item is not double-added.
  const currentEdges = getEdges();
  const currentNodes = getNodes();
  currentEdges
    .filter((e) => e.source === node.id)
    .forEach((e) => {
      const target = currentNodes.find((n) => n.id === e.target);
      if (target?.type === "outputGallery") {
        if (videoData) {
          appendOutputGalleryVideo(target.id, outputContent);
        } else {
          appendOutputGalleryImage(target.id, outputContent);
        }
      }
    });

  // Track cost
  if (runCost !== null) {
    addIncurredCost(runCost);
  }

  // The save to the generations folder: a project's only save without
  // the asset library, and its fallback when a recording fails
  const saveToFolder = generationsPath
    ? () => {
        const saveContent = videoData
          ? { video: videoData }
          : { image: result.image };

        return fetch("/api/save-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath: generationsPath,
            ...saveContent,
            prompt: text,
            imageId: videoId,
          }),
        })
          .then((res) => res.json())
          .then((saveResult) => {
            if (saveResult.success && saveResult.imageId && saveResult.imageId !== videoId) {
              const currentNode = getNodes().find((n) => n.id === node.id);
              if (currentNode) {
                const currentData = currentNode.data as GenerateVideoNodeData;
                const histCopy = [...(currentData.videoHistory || [])];
                const entryIndex = histCopy.findIndex((h) => h.id === videoId);
                if (entryIndex !== -1) {
                  histCopy[entryIndex] = { ...histCopy[entryIndex], id: saveResult.imageId };
                  updateNodeData(node.id, { videoHistory: histCopy });
                }
              }
            }
          })
          .catch((err) => {
            console.error("Failed to save video generation:", err);
          });
      }
    : null;

  if (recorded) {
    // The recorder writes a project's generations into its folder; the
    // carousel entry then takes the file's name, as a save there always did.
    followRecording(ctx, "videoHistory", videoId, recorded, saveToFolder);
  } else if (saveToFolder) {
    // No asset library: auto-save to the generations folder
    trackSaveGeneration(videoId, saveToFolder());
  }
}
