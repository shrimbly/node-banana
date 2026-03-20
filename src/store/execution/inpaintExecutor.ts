/**
 * Inpaint Executor
 *
 * Handles masked image regeneration using either Gemini (pseudo-inpaint
 * via multimodal prompt) or WaveSpeed (real mask-based inpainting).
 */

import type { InpaintNodeData } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import type { NodeExecutionContext } from "./types";

export async function executeInpaint(ctx: NodeExecutionContext): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    getEdges,
    signal,
    providerSettings,
    addIncurredCost,
    generationsPath,
    trackSaveGeneration,
    getNodes,
  } = ctx;

  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as InpaintNodeData;

  const { images: connectedImages, text: connectedText } = getConnectedInputs(node.id);

  // Determine source image (connected or stored)
  const hasIncomingEdges = getEdges().some((e) => e.target === node.id);
  const sourceImage = connectedImages[0] ?? (hasIncomingEdges ? nodeData.inputImage : null);
  const promptText = connectedText ?? nodeData.inputPrompt ?? "Regenerate the masked area naturally, matching the surrounding context";
  const maskImage = nodeData.maskImage;

  if (!sourceImage) {
    updateNodeData(node.id, { status: "error", error: "Missing source image" });
    throw new Error("Missing source image");
  }

  if (!maskImage) {
    updateNodeData(node.id, { status: "error", error: "No mask drawn — draw a mask first" });
    throw new Error("No mask drawn");
  }

  updateNodeData(node.id, {
    inputImage: sourceImage,
    inputPrompt: promptText,
    status: "loading",
    error: null,
  });

  const provider = nodeData.inpaintProvider || "gemini";

  try {
    let result: { success: boolean; image?: string; error?: string };

    if (provider === "gemini") {
      result = await inpaintWithGemini(sourceImage, maskImage, promptText, providerSettings, signal);
    } else {
      result = await inpaintWithWaveSpeed(sourceImage, maskImage, promptText, nodeData, providerSettings, signal);
    }

    if (result.success && result.image) {
      const timestamp = Date.now();
      const imageId = `${timestamp}`;
      const newHistoryItem = {
        id: imageId,
        timestamp,
        prompt: promptText,
        aspectRatio: "1:1" as const,
        model: "inpaint" as const,
      };
      const updatedHistory = [newHistoryItem, ...(nodeData.imageHistory || [])].slice(0, 50);

      updateNodeData(node.id, {
        outputImage: result.image,
        status: "complete",
        error: null,
        imageHistory: updatedHistory,
        selectedHistoryIndex: 0,
      });

      // Auto-save if configured
      if (generationsPath) {
        const savePromise = fetch("/api/save-generation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directoryPath: generationsPath,
            image: result.image,
            prompt: promptText,
            imageId,
          }),
        })
          .then((res) => res.json())
          .then((saveResult) => {
            if (saveResult.success && saveResult.imageId && saveResult.imageId !== imageId) {
              const currentNode = getNodes().find((n) => n.id === node.id);
              if (currentNode) {
                const currentData = currentNode.data as InpaintNodeData;
                const histCopy = [...(currentData.imageHistory || [])];
                const entryIndex = histCopy.findIndex((h) => h.id === imageId);
                if (entryIndex !== -1) {
                  histCopy[entryIndex] = { ...histCopy[entryIndex], id: saveResult.imageId };
                  updateNodeData(node.id, { imageHistory: histCopy });
                }
              }
            }
          })
          .catch((err) => console.error("Failed to save inpaint generation:", err));

        trackSaveGeneration(imageId, savePromise);
      }
    } else {
      updateNodeData(node.id, { status: "error", error: result.error || "Inpainting failed" });
      throw new Error(result.error || "Inpainting failed");
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const errorMessage = error instanceof Error ? error.message : "Inpainting failed";
    updateNodeData(node.id, { status: "error", error: errorMessage });
    throw new Error(errorMessage);
  }
}

/**
 * Gemini pseudo-inpaint: sends source image + mask + prompt as multimodal parts.
 * The model interprets the mask as guidance for which area to regenerate.
 */
async function inpaintWithGemini(
  sourceImage: string,
  maskImage: string,
  prompt: string,
  providerSettings: NodeExecutionContext["providerSettings"],
  signal?: AbortSignal
): Promise<{ success: boolean; image?: string; error?: string }> {
  const headers = buildGenerateHeaders("gemini", providerSettings);

  const inpaintPrompt =
    `You are given two images: the first is the original image, the second is a black-and-white mask ` +
    `where white areas indicate the region to edit. Edit ONLY the white masked area of the original image ` +
    `according to this instruction: ${prompt}. Keep all non-masked areas exactly the same.`;

  const response = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      images: [sourceImage, maskImage],
      prompt: inpaintPrompt,
      model: "nano-banana-pro",
      aspectRatio: "1:1",
    }),
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
    return { success: false, error: errorMessage };
  }

  const result = await response.json();
  return { success: result.success, image: result.image, error: result.error };
}

/**
 * WaveSpeed real inpaint: sends source image + mask via the standard generation pipeline.
 * WaveSpeed edit models accept `image` and `mask` parameters.
 */
async function inpaintWithWaveSpeed(
  sourceImage: string,
  maskImage: string,
  prompt: string,
  nodeData: InpaintNodeData,
  providerSettings: NodeExecutionContext["providerSettings"],
  signal?: AbortSignal
): Promise<{ success: boolean; image?: string; error?: string }> {
  const headers = buildGenerateHeaders("wavespeed", providerSettings);

  const selectedModel = nodeData.selectedModel || {
    provider: "wavespeed" as const,
    modelId: "flux/inpaint",
    displayName: "FLUX Inpaint",
  };

  const response = await fetch("/api/generate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      prompt,
      images: [sourceImage],
      selectedModel,
      dynamicInputs: {
        mask: maskImage,
      },
    }),
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
    return { success: false, error: errorMessage };
  }

  const result = await response.json();
  return { success: result.success, image: result.image, error: result.error };
}
