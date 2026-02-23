/**
 * GenerateVideo Executor
 *
 * Unified executor for generateVideo nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { GenerateVideoNodeData } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import type { NodeExecutionContext } from "./types";

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
    addIncurredCost,
    generationsPath,
    getNodes,
    trackSaveGeneration,
  } = ctx;

  const { useStoredFallback = false } = options;

  const { images: connectedImages, text: connectedText, dynamicInputs } = getConnectedInputs(node.id);

  // Get fresh node data from store
  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as GenerateVideoNodeData;

  // Determine images and text
  let images: string[];
  let text: string | null;

  if (useStoredFallback) {
    images = connectedImages.length > 0 ? connectedImages : nodeData.inputImages;
    text = connectedText ?? nodeData.inputPrompt;
    // Validate fallback inputs the same way as the regular path
    const hasPrompt = text || dynamicInputs.prompt || dynamicInputs.negative_prompt;
    if (!hasPrompt && images.length === 0) {
      updateNodeData(node.id, {
        status: "error",
        error: "Missing required inputs",
      });
      throw new Error("Missing required inputs");
    }
  } else {
    images = connectedImages;
    text = connectedText;
    // For dynamic inputs, check if we have at least a prompt
    const hasPrompt = text || dynamicInputs.prompt || dynamicInputs.negative_prompt;
    if (!hasPrompt && images.length === 0) {
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
    lastGenerationCost: null,
  });

  const provider = nodeData.selectedModel.provider;
  const headers = buildGenerateHeaders(provider, providerSettings);

  const requestPayload = {
    images,
    prompt: text,
    selectedModel: nodeData.selectedModel,
    parameters: nodeData.parameters,
    dynamicInputs,
    mediaType: "video" as const,
  };

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
      throw new Error(errorMessage);
    }

    const result = await response.json();

    // Handle video response (video or videoUrl field)
    const videoData = result.video || result.videoUrl;
    if (result.success && (videoData || result.image)) {
      const outputContent = videoData || result.image;
      const timestamp = Date.now();
      const videoId = `${timestamp}`;

      // Add to node's video history
      const newHistoryItem = {
        id: videoId,
        timestamp,
        prompt: text || "",
        model: nodeData.selectedModel?.modelId || "",
      };
      const updatedHistory = [newHistoryItem, ...(nodeData.videoHistory || [])].slice(0, 50);

      updateNodeData(node.id, {
        outputVideo: outputContent,
        status: "complete",
        error: null,
        videoHistory: updatedHistory,
        selectedVideoHistoryIndex: 0,
      });

      // Track cost from server response
      if (result.cost != null) {
        addIncurredCost(result.cost);
        updateNodeData(node.id, { lastGenerationCost: result.cost });
      }

      // Auto-save to generations folder if configured
      if (generationsPath) {
        const saveContent = videoData
          ? { video: videoData }
          : { image: result.image };

        const savePromise = fetch("/api/save-generation", {
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

        trackSaveGeneration(videoId, savePromise);
      }
    } else {
      updateNodeData(node.id, {
        status: "error",
        error: result.error || "Video generation failed",
      });
      throw new Error(result.error || "Video generation failed");
    }
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
}
