/**
 * WorldLabs Panorama Executor
 *
 * Executes Panorama Generator nodes via the Marble API.
 * Supports text, single-image, and multi-image (with azimuth) prompts.
 * Defaults to Marble 0.1-mini for fast/cheap preview.
 * Stores panorama URL, thumbnail, and caption on completion.
 */

import type { WorldLabsPanoNodeData } from "@/types";
import { buildGenerateHeaders } from "@/store/utils/buildApiHeaders";
import { uploadImage, pollUntilDone, fetchWorldAssets } from "./worldLabsUtils";
import type { NodeExecutionContext } from "./types";

/** Default azimuths for multi-image (front, right, back, left) */
const DEFAULT_AZIMUTHS = [0, 90, 180, 270];

interface MultiImagePrompt {
  azimuth: number;
  content: {
    source: "media_asset";
    media_asset_id: string;
  };
}

export async function executeWorldLabsPano(
  ctx: NodeExecutionContext
): Promise<void> {
  const {
    node,
    getConnectedInputs,
    updateNodeData,
    getFreshNode,
    signal,
    providerSettings,
  } = ctx;

  const { images: connectedImages, text: connectedText } = getConnectedInputs(node.id);

  const freshNode = getFreshNode(node.id);
  const nodeData = (freshNode?.data || node.data) as WorldLabsPanoNodeData;

  // Need at least text or image input
  if (!connectedText && connectedImages.length === 0) {
    updateNodeData(node.id, {
      status: "error",
      error: "Connect a text prompt or image to generate a panorama",
    });
    throw new Error("Missing text or image input");
  }

  // Determine prompt type
  const hasText = !!connectedText;
  const hasImage = connectedImages.length > 0;
  const isMultiImage = connectedImages.length >= 2;
  const promptType: "text" | "image" | "multi-image" = isMultiImage
    ? "multi-image"
    : hasImage
      ? "image"
      : "text";

  const apiModel = nodeData.model;

  updateNodeData(node.id, {
    inputImages: connectedImages,
    inputPrompt: connectedText,
    status: "loading",
    error: null,
    progress: "Preparing...",
    operationId: null,
    worldId: null,
    panoUrl: null,
    thumbnailUrl: null,
    caption: null,
  });

  const headers = buildGenerateHeaders("worldlabs", providerSettings);

  try {
    // ─── Step 1: Upload image(s) ──────────────────────────────
    let mediaAssetId: string | undefined;
    const multiImagePrompts: MultiImagePrompt[] = [];

    if (hasImage) {
      if (isMultiImage) {
        updateNodeData(node.id, { progress: `Uploading ${connectedImages.length} images...` });

        for (let i = 0; i < connectedImages.length; i++) {
          if (signal?.aborted) {
            throw new DOMException("Operation cancelled", "AbortError");
          }

          updateNodeData(node.id, {
            progress: `Uploading image ${i + 1} of ${connectedImages.length}...`,
          });

          const uploadResult = await uploadImage(headers, connectedImages[i], signal);
          const azimuth = nodeData.imageAzimuths[i] ?? DEFAULT_AZIMUTHS[i % DEFAULT_AZIMUTHS.length];

          multiImagePrompts.push({
            azimuth,
            content: {
              source: "media_asset",
              media_asset_id: uploadResult.mediaAssetId,
            },
          });
        }
      } else {
        updateNodeData(node.id, { progress: "Uploading image..." });
        const uploadResult = await uploadImage(headers, connectedImages[0], signal);
        mediaAssetId = uploadResult.mediaAssetId;
      }
    }

    // ─── Step 2: Submit generation ────────────────────────────
    updateNodeData(node.id, { progress: "Submitting to WorldLabs..." });

    const generateBody: Record<string, unknown> = {
      action: "generate",
      promptType,
      model: apiModel,
      worldName: nodeData.worldName || "",
    };

    if (connectedText) {
      generateBody.textPrompt = connectedText;
    }
    if (mediaAssetId) {
      generateBody.mediaAssetId = mediaAssetId;
    }
    if (multiImagePrompts.length > 0) {
      generateBody.multiImagePrompts = multiImagePrompts;
    }
    if (nodeData.seed != null) {
      generateBody.seed = nodeData.seed;
    }

    const generateResponse = await fetch("/api/worldlabs", {
      method: "POST",
      headers,
      body: JSON.stringify(generateBody),
      ...(signal ? { signal } : {}),
    });

    if (!generateResponse.ok) {
      const errText = await generateResponse.text();
      let errMsg = `Generation failed (${generateResponse.status})`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error || errMsg;
      } catch { /* use default */ }
      throw new Error(errMsg);
    }

    const generateResult = await generateResponse.json();
    if (!generateResult.success || !generateResult.operationId) {
      throw new Error(generateResult.error || "No operation ID returned");
    }

    const operationId = generateResult.operationId;
    updateNodeData(node.id, {
      operationId,
      progress: "Generating panorama...",
    });

    // ─── Step 3: Poll until done ──────────────────────────────
    const worldId = await pollUntilDone(
      headers,
      operationId,
      (msg) => updateNodeData(node.id, { progress: msg }),
      signal
    );

    // ─── Step 4: Fetch world assets ───────────────────────────
    updateNodeData(node.id, {
      worldId,
      progress: "Fetching panorama...",
    });

    const assets = await fetchWorldAssets(headers, worldId, signal);

    // ─── Step 5: Update node with panorama results ────────────
    updateNodeData(node.id, {
      worldId: assets.worldId,
      panoUrl: assets.panoUrl,
      thumbnailUrl: assets.thumbnailUrl,
      caption: assets.caption,
      status: "complete",
      error: null,
      progress: null,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      updateNodeData(node.id, {
        status: "idle",
        progress: null,
      });
      throw error;
    }

    const errorMessage =
      error instanceof Error ? error.message : "Panorama generation failed";

    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
      progress: null,
    });
    throw new Error(errorMessage);
  }
}
