/**
 * GenerateAudio Executor
 *
 * Unified executor for generateAudio (TTS) nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { GenerateAudioNodeData, SelectedModel } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { pollGenerateTask } from "./pollTaskCompletion";
import { runWithFallback } from "./runWithFallback";
import { resolveGenerationCost } from "./generationCost";
import { appendGenerationHistory } from "@/utils/generationCarousel";
import type { NodeExecutionContext } from "./types";
import {
  formatMissingRequiredModelParameters,
  getMissingRequiredModelParameters,
} from "@/utils/requiredModelParameters";

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
    generationsPath,
    getNodes,
    trackSaveGeneration,
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
        status: "error",
        error: "Missing text input for audio generation",
      });
      throw new Error("Missing text input for audio generation");
    }
  } else {
    text = connectedText;
    const hasPrompt = text || dynamicInputs.prompt;
    if (!hasPrompt) {
      updateNodeData(node.id, {
        status: "error",
        error: "Missing text input for audio generation",
      });
      throw new Error("Missing text input for audio generation");
    }
  }

  if (!nodeData.selectedModel?.modelId) {
    updateNodeData(node.id, {
      status: "error",
      error: "No model selected",
    });
    throw new Error("No model selected");
  }

  const missingParameters = getMissingRequiredModelParameters(
    nodeData.requiredModelParameters,
    nodeData.parameters
  );
  if (missingParameters.length > 0) {
    const error = formatMissingRequiredModelParameters(missingParameters);
    updateNodeData(node.id, { status: "error", error });
    throw new Error(error);
  }

  updateNodeData(node.id, {
    inputPrompt: text ?? nodeData.inputPrompt,
    status: "loading",
    error: null,
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
        body: JSON.stringify(requestPayload),
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

      // Handle polling response (long-running Kie and fal queue tasks)
      if (result.polling) {
        result = await pollGenerateTask({
          taskId: result.taskId,
          provider: result.pollProvider,
          modelId: result.pollModelId,
          modelName: result.pollModelName,
          mediaType: result.pollMediaType,
          headers,
          signal,
        });

        if (!result.success) {
          updateNodeData(node.id, {
            status: "error",
            error: result.error || "Audio generation failed",
          });
          errorHandled = true;
          throw new Error(result.error || "Audio generation failed");
        }
      }

      // Handle audio response (audio or audioUrl field)
      const audioData = result.audio || result.audioUrl;
      if (result.success && audioData) {
        const generationCost = resolveGenerationCost(
          modelToUse,
          result.generationCost
        );
        const timestamp = Date.now();
        const audioId = `${timestamp}`;

        // Add to node's audio history
        const newHistoryItem = {
          id: audioId,
          timestamp,
          prompt: text || "",
          model: modelToUse.modelId || "",
          generationCost,
        };
        const updatedHistory = appendGenerationHistory(nodeData.audioHistory, newHistoryItem);

        updateNodeData(node.id, {
          outputAudio: audioData,
          status: "complete",
          error: null,
          audioHistory: updatedHistory,
          selectedAudioHistoryIndex: updatedHistory.length - 1,
        });

        // Auto-save to generations folder if configured
        if (generationsPath) {
          const savePromise = fetch("/api/save-generation", {
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
            });

          trackSaveGeneration(audioId, savePromise);
        }
      } else {
        updateNodeData(node.id, {
          status: "error",
          error: result.error || "Audio generation failed",
        });
        errorHandled = true;
        throw new Error(result.error || "Audio generation failed");
      }
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
    clearOutput: { outputAudio: null },
  });
}
