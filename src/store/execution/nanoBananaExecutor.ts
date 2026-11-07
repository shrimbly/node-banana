/**
 * NanoBanana Executor
 *
 * Unified executor for nanoBanana (image generation) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type {
  NanoBananaNodeData,
  GenerateResponse,
  ImageGenerationMetadata,
  ModelType,
  Resolution,
  SelectedModel,
} from "@/types";
import { isOpenAIImage25 } from "@/lib/providers/openaiImages";
import { calculateGenerationCost } from "@/utils/costCalculator";
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
  sizeFromString,
} from "./assetRecording";
import { inlineMediaReferences } from "@/lib/media/references";

export interface NanoBananaOptions {
  /** When true, falls back to stored inputImages/inputPrompt if no connections provide them. */
  useStoredFallback?: boolean;
}

export async function executeNanoBanana(
  ctx: NodeExecutionContext,
  options: NanoBananaOptions = {}
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

  const { images: connectedImages, text: connectedText, dynamicInputs } = getConnectedInputs(node.id);

  // Get fresh node data from store
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as NanoBananaNodeData;

  // Determine images and text (with optional fallback to stored values)
  let images: string[];
  let promptText: string | null;

  if (useStoredFallback) {
    images = connectedImages.length > 0 ? connectedImages : nodeData.inputImages;
    promptText = connectedText ?? nodeData.inputPrompt;
  } else {
    images = connectedImages;
    // For dynamic inputs, check if we have at least a prompt
    const promptFromDynamic = Array.isArray(dynamicInputs.prompt)
      ? dynamicInputs.prompt[0]
      : dynamicInputs.prompt;
    promptText = connectedText || promptFromDynamic || null;
  }

  // Defensive: ensure promptText is actually a string at runtime
  // (Guards against corrupted node data or race conditions in parallel execution)
  if (promptText !== null && typeof promptText !== 'string') {
    const raw: unknown = promptText;
    console.warn('[nanoBanana] promptText was not a string, coercing:', typeof raw, Array.isArray(raw) ? `<redacted array length=${raw.length}>` : '<redacted>');
    promptText = Array.isArray(raw) ? (raw as string[])[0] ?? null : null;
  }

  if (!promptText) {
    updateNodeData(node.id, {
      status: "skipped",
      error: "Missing text input",
    });
    throw new MissingInputError("Missing text input");
  }

  // Capture promptText as a definitely-non-null string for use inside the closure.
  const finalPrompt: string = promptText;

  updateNodeData(node.id, {
    inputImages: images,
    inputPrompt: finalPrompt,
    status: "loading",
    error: null,
    // A new run lets go of any request an earlier one left to pick up
    pendingTask: undefined,
  });

  // Inner runOnce: performs the actual fetch/process/history work for a given model.
  // Extracted so runWithFallback can invoke it twice (primary, then fallback) if needed.
  const runOnce = async (modelToUse: SelectedModel, parametersOverride?: Record<string, unknown>): Promise<void> => {
    const provider = modelToUse.provider;
    const headers = buildGenerateHeaders(provider, providerSettings);

    // Sanitize dynamicInputs: remove prompt since it's already sent as the top-level
    // `prompt` field in requestPayload. Keeping both can cause providers like Replicate
    // to prefer dynamicInputs.prompt over the authoritative top-level value.
    const sanitizedDynamicInputs = { ...dynamicInputs };
    delete sanitizedDynamicInputs.prompt;

    const requestPayload = {
      images,
      prompt: finalPrompt,
      aspectRatio: (parametersOverride?.aspectRatio as string) ?? nodeData.aspectRatio,
      resolution: (parametersOverride?.resolution as string) ?? nodeData.resolution,
      model: nodeData.model,
      useGoogleSearch: (parametersOverride?.useGoogleSearch as boolean) ?? nodeData.useGoogleSearch,
      useImageSearch: (parametersOverride?.useImageSearch as boolean) ?? nodeData.useImageSearch,
      selectedModel: modelToUse,
      parameters: parametersOverride ?? nodeData.parameters,
      dynamicInputs: sanitizedDynamicInputs,
    };

    // Final guard: assert that prompt is a string before sending to API
    if (typeof requestPayload.prompt !== 'string') {
      const errorMsg = `Internal error: prompt is ${typeof requestPayload.prompt}, expected string`;
      console.error('[nanoBanana]', errorMsg);
      updateNodeData(node.id, { status: 'error', error: errorMsg });
      throw new Error(errorMsg);
    }

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
            error: result.error || "Generation failed",
          });
          throw new Error(result.error || "Generation failed");
        }
      }

      finishNanoBanana(ctx, result, requestPayload);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      // Convert network errors to user-friendly messages
      let errorMessage = "Generation failed";
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

  // Synthesize a SelectedModel for the primary from legacy fields if selectedModel is missing.
  const primaryModel: SelectedModel = nodeData.selectedModel ?? {
    provider: "gemini",
    modelId: nodeData.model,
    displayName: nodeData.model,
  };

  await runWithFallback({
    nodeId: node.id,
    primary: primaryModel,
    fallback: nodeData.fallbackModel,
    fallbackParameters: nodeData.fallbackParameters,
    updateNodeData,
    runOnce,
    clearOutput: { outputImage: null },
  });
}

/** What an image run asked for: Gemini's framing and search fields as well. */
export interface NanoBananaRequest extends GenerationRequest {
  prompt: string;
  aspectRatio: string;
  resolution: string;
  useGoogleSearch: boolean;
  useImageSearch: boolean;
}

/**
 * Put a finished run's image on the node: the recent generations, the asset
 * library, the carousel, downstream galleries, the cost and the generations
 * folder. Throws when the answer holds none. A run ends here, and so does a
 * request picked up again (resumeGeneration).
 */
export function finishNanoBanana(ctx: NodeExecutionContext, result: GenerateResponse, request: NanoBananaRequest): void {
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
    appendOutputGalleryImage,
  } = ctx;
  const { selectedModel: modelToUse, prompt: finalPrompt } = request;
  const provider = modelToUse.provider;
  const nodeData = (getFreshNode(node.id)?.data || node.data) as NanoBananaNodeData;

  const image = result.image;
  if (!result.success || !image) {
    updateNodeData(node.id, {
      status: "error",
      error: result.error || "Generation failed",
    });
    throw new Error(result.error || "Generation failed");
  }

  const timestamp = Date.now();
  const imageId = `${timestamp}`;

  const generation: ImageGenerationMetadata | undefined = provider === "openai" ? result.generation : undefined;
  // The model that ran. The legacy `model` field only ever names a Gemini
  // model, so it is wrong for any other pick and after a fallback.
  const historyModel = provider === "gemini" ? modelToUse.modelId : modelToUse.displayName || modelToUse.modelId;

  // What the run cost: the provider's own figure when it reports one
  let runCost: number | null = null;
  let costEstimated = true;
  if (provider === "openai" && generation?.cost && Number.isFinite(generation.cost.amount) && generation.cost.amount >= 0) {
    runCost = generation.cost.amount;
    costEstimated = generation.cost.estimated;
  } else if ((provider === "fal" || (provider === "openai" && !isOpenAIImage25(modelToUse.modelId))) && modelToUse.pricing) {
    runCost = modelToUse.pricing.amount;
  } else if (modelToUse.provider === "gemini") {
    runCost = calculateGenerationCost(modelToUse.modelId as ModelType, request.resolution as Resolution);
  }

  // Save to global history
  addToGlobalHistory({
    image,
    timestamp,
    prompt: finalPrompt,
    aspectRatio: nodeData.aspectRatio,
    model: historyModel,
    ...(generation ? { generation } : {}),
  });

  // Aspect ratio, resolution and search grounding are Gemini request
  // fields; other providers carry their framing in their parameters.
  const sentParameters = provider === "gemini"
    ? {
        ...request.parameters,
        ...(request.useGoogleSearch ? { useGoogleSearch: true } : {}),
        ...(request.useImageSearch ? { useImageSearch: true } : {}),
      }
    : request.parameters;
  const framing = provider === "gemini"
    ? { aspectRatio: request.aspectRatio, resolution: request.resolution }
    : parameterFraming(request.parameters);
  const recorded = recordOutput(ctx, {
    kind: "image",
    origin: "generated",
    media: image,
    prompt: finalPrompt,
    model: assetModel(modelToUse),
    parameters: assetParameters(sentParameters),
    ...framing,
    cost: assetCost(runCost, costEstimated),
    producer: assetProducer(ctx),
    ...sizeFromString(generation?.size),
  });

  // The carousel reloads its entries from the asset library, or from the
  // generations folder, so only a generation saved to one gets an entry.
  const newHistoryItem = {
    id: imageId,
    ...(recorded ? { assetId: recorded.assetId } : {}),
    timestamp,
    prompt: finalPrompt,
    aspectRatio: nodeData.aspectRatio,
    model: historyModel,
    ...(generation ? { generation } : {}),
    ...(ctx.batch ? { batch: ctx.batch } : {}),
  };
  const updatedHistory = [newHistoryItem, ...(nodeData.imageHistory || [])].slice(0, 50);

  updateNodeData(node.id, {
    outputImage: image,
    status: "complete",
    error: null,
    ...(generationsPath || recorded ? { imageHistory: updatedHistory, selectedHistoryIndex: 0 } : {}),
  });

  // Push new image to connected downstream outputGallery nodes (atomic append)
  const edges = getEdges();
  const nodes = getNodes();
  edges
    .filter((e) => e.source === node.id)
    .forEach((e) => {
      const target = nodes.find((n) => n.id === e.target);
      if (target?.type === "outputGallery") {
        appendOutputGalleryImage(target.id, image);
      }
    });

  // Track cost
  if (runCost !== null) {
    addIncurredCost(runCost);
  }

  // The save to the generations folder: a project's only save without
  // the asset library, and its fallback when a recording fails
  const saveToFolder = generationsPath
    ? () =>
        fetch("/api/save-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath: generationsPath,
            image,
            prompt: finalPrompt,
            imageId,
          }),
        })
          .then((res) => res.json())
          .then((saveResult) => {
            if (saveResult.success && saveResult.imageId && saveResult.imageId !== imageId) {
              const currentNode = getNodes().find((n) => n.id === node.id);
              if (currentNode) {
                const currentData = currentNode.data as NanoBananaNodeData;
                const histCopy = [...(currentData.imageHistory || [])];
                const entryIndex = histCopy.findIndex((h) => h.id === imageId);
                if (entryIndex !== -1) {
                  histCopy[entryIndex] = { ...histCopy[entryIndex], id: saveResult.imageId };
                  updateNodeData(node.id, { imageHistory: histCopy });
                }
              }
            }
          })
          .catch((err) => {
            console.error("Failed to save generation:", err);
          })
    : null;

  if (recorded) {
    // The recorder writes a project's generations into its folder; the
    // carousel entry then takes the file's name, as a save there always did.
    followRecording(ctx, "imageHistory", imageId, recorded, saveToFolder);
  } else if (saveToFolder) {
    // No asset library: auto-save to the generations folder
    trackSaveGeneration(imageId, saveToFolder());
  }
}
