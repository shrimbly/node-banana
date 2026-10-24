/**
 * GenerateAudio Executor
 *
 * Unified executor for generateAudio (TTS) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { GenerateAudioNodeData, GenerateResponse, SelectedModel } from "@/types";
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
  recordOutput,
  resolvedPrompt,
} from "./assetRecording";
import { inlineMediaReferences } from "@/lib/media/references";

export interface GenerateAudioOptions {
  /** When true, falls back to stored inputPrompt if no connections provide it. */
  useStoredFallback?: boolean;
}

export async function executeGenerateAudio(
  ctx: NodeExecutionContext,
  options: GenerateAudioOptions = {}
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

  const { text: connectedText, dynamicInputs } = getConnectedInputs(node.id);

  // Get fresh node data from store
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as GenerateAudioNodeData;

  // Determine text input
  let text: string | null;

  if (useStoredFallback) {
    text = connectedText ?? nodeData.inputPrompt;
    const hasPrompt = text || dynamicInputs.prompt;
    if (!hasPrompt) {
      updateNodeData(node.id, {
        status: "skipped",
        error: "Missing text input for audio generation",
      });
      throw new MissingInputError("Missing text input for audio generation");
    }
  } else {
    text = connectedText;
    const hasPrompt = text || dynamicInputs.prompt;
    if (!hasPrompt) {
      updateNodeData(node.id, {
        status: "skipped",
        error: "Missing text input for audio generation",
      });
      throw new MissingInputError("Missing text input for audio generation");
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
    inputPrompt: text ?? nodeData.inputPrompt,
    status: "loading",
    error: null,
    // A new run lets go of any request an earlier one left to pick up
    pendingTask: undefined,
  });

  const runOnce = async (modelToUse: SelectedModel, parametersOverride?: Record<string, unknown>): Promise<void> => {
    const provider = modelToUse.provider;
    const headers = buildGenerateHeaders(provider, providerSettings);

    const requestPayload = {
      images: [],
      prompt: text,
      selectedModel: modelToUse,
      parameters: parametersOverride ?? nodeData.parameters,
      dynamicInputs,
      mediaType: "audio" as const,
    };

    let errorHandled = false;

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
        errorHandled = true;
        throw new Error(errorMessage);
      }

      let result = await response.json();

      // A long-running request (Kie, Comfy Router): poll it, kept on the node meanwhile
      if (result.polling) {
        result = await waitForPendingTask(ctx, pendingTaskFrom(result), headers);

        if (!result.success) {
          updateNodeData(node.id, {
            status: "error",
            error: result.error || "Audio generation failed",
          });
          errorHandled = true;
          throw new Error(result.error || "Audio generation failed");
        }
      }

      finishGenerateAudio(ctx, result, requestPayload);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      let errorMessage = "Audio generation failed";
      if (error instanceof TypeError && error.message.includes("NetworkError")) {
        errorMessage = "Network error. Check your connection and try again.";
      } else if (error instanceof TypeError) {
        errorMessage = `Network error: ${error.message}`;
      } else if (error instanceof Error) {
        errorMessage = error.message;
      }

      if (!errorHandled) {
        updateNodeData(node.id, {
          status: "error",
          error: errorMessage,
        });
      }
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
    clearOutput: { outputAudio: null },
  });
}

/**
 * Put a finished run's audio on the node: the asset library, the carousel,
 * the cost and the generations folder. Throws when the answer holds none. A
 * run ends here, and so does a request picked up again (resumeGeneration).
 */
export function finishGenerateAudio(ctx: NodeExecutionContext, result: GenerateResponse, request: GenerationRequest): void {
  const { node, updateNodeData, getFreshNode, getNodes, addIncurredCost, generationsPath, trackSaveGeneration } = ctx;
  const { selectedModel: modelToUse, prompt: text, parameters, dynamicInputs } = request;
  const nodeData = (getFreshNode(node.id)?.data || node.data) as GenerateAudioNodeData;

  const audioData = result.audio || result.audioUrl;
  if (!result.success || !audioData) {
    updateNodeData(node.id, {
      status: "error",
      error: result.error || "Audio generation failed",
    });
    throw new Error(result.error || "Audio generation failed");
  }

  const timestamp = Date.now();
  const audioId = `${timestamp}`;

  // fal bills a flat amount per run
  const runCost = modelToUse.provider === "fal" && modelToUse.pricing ? modelToUse.pricing.amount : null;
  const recorded = recordOutput(ctx, {
    kind: "audio",
    origin: "generated",
    media: audioData,
    prompt: resolvedPrompt(text, dynamicInputs),
    model: assetModel(modelToUse),
    parameters: assetParameters(parameters),
    cost: assetCost(runCost),
    producer: assetProducer(ctx),
  });

  // The carousel reloads its entries from the asset library, or from the
  // generations folder, so only a generation saved to one gets an entry.
  const newHistoryItem = {
    id: audioId,
    ...(recorded ? { assetId: recorded.assetId } : {}),
    timestamp,
    prompt: text || "",
    model: modelToUse.modelId || "",
    ...(ctx.batch ? { batch: ctx.batch } : {}),
  };
  const updatedHistory = [newHistoryItem, ...(nodeData.audioHistory || [])].slice(0, 50);

  updateNodeData(node.id, {
    outputAudio: audioData,
    status: "complete",
    error: null,
    ...(generationsPath || recorded ? { audioHistory: updatedHistory, selectedAudioHistoryIndex: 0 } : {}),
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
            audio: audioData,
            prompt: text,
            imageId: audioId,
          }),
        })
          .then((res) => res.json())
          .then((saveResult) => {
            if (saveResult.success && saveResult.imageId && saveResult.imageId !== audioId) {
              const currentNode = getNodes().find((n) => n.id === node.id);
              if (currentNode) {
                const currentData = currentNode.data as GenerateAudioNodeData;
                const histCopy = [...(currentData.audioHistory || [])];
                const entryIndex = histCopy.findIndex((h) => h.id === audioId);
                if (entryIndex !== -1) {
                  histCopy[entryIndex] = { ...histCopy[entryIndex], id: saveResult.imageId };
                  updateNodeData(node.id, { audioHistory: histCopy });
                }
              }
            }
          })
          .catch((err) => {
            console.error("Failed to save audio generation:", err);
          })
    : null;

  if (recorded) {
    // The recorder writes a project's generations into its folder; the
    // carousel entry then takes the file's name, as a save there always did.
    followRecording(ctx, "audioHistory", audioId, recorded, saveToFolder);
  } else if (saveToFolder) {
    // No asset library: auto-save to the generations folder
    trackSaveGeneration(audioId, saveToFolder());
  }
}
