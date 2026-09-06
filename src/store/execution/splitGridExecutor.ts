/**
 * SplitGrid Executor
 *
 * Unified executor for splitGrid nodes.
 * Ensures the node's cell template is materialized (one node set + group per
 * grid cell), splits the input image, and populates each cell's base image
 * input node with its slice.
 */

import type { SplitGridNodeData } from "@/types";
import { clampGridDimension, getSplitGridCells } from "@/store/utils/splitGridTemplate";
import type { NodeExecutionContext } from "./types";
import { MissingInputError } from "./missingInput";

export async function executeSplitGrid(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, getFreshNode, materializeSplitGridCells } = ctx;

  const connectedInputs = getConnectedInputs(node.id);
  const sourceImage = connectedInputs.images[0] || null;

  if (!sourceImage) {
    updateNodeData(node.id, {
      status: "skipped",
      error: "No input image connected",
    });
    throw new MissingInputError("No input image connected");
  }

  const nodeData = (getFreshNode(node.id)?.data ?? node.data) as SplitGridNodeData;
  const rows = clampGridDimension(nodeData.gridRows);
  const cols = clampGridDimension(nodeData.gridCols);

  updateNodeData(node.id, {
    sourceImage,
    status: "loading",
    error: null,
  });

  try {
    // Rebuild cells if rows/cols/template changed since last materialization
    // (no-op when they still match, preserving per-cell user edits)
    materializeSplitGridCells(node.id);

    const freshData = (getFreshNode(node.id)?.data ?? nodeData) as SplitGridNodeData;
    const cells = getSplitGridCells(freshData);

    const { splitWithDimensions } = await import("@/utils/gridSplitter");
    const { images: splitImages } = await splitWithDimensions(sourceImage, rows, cols, {
      colOffsets: freshData.colOffsets,
      rowOffsets: freshData.rowOffsets,
    });

    // Populate each cell's base image node with its slice
    for (let index = 0; index < cells.length; index++) {
      const baseImageNodeId = cells[index].baseImageNodeId;
      if (baseImageNodeId && splitImages[index]) {
        await new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            updateNodeData(baseImageNodeId, {
              image: splitImages[index],
              imageRef: undefined,
              filename: `split-${Math.floor(index / cols) + 1}-${(index % cols) + 1}.png`,
              dimensions: { width: img.width, height: img.height },
            });
            resolve();
          };
          img.onerror = () => {
            console.warn(`[splitGrid] Failed to load split image ${index} for node ${baseImageNodeId}`);
            updateNodeData(baseImageNodeId, {
              image: null,
              imageRef: undefined,
              filename: null,
              dimensions: { width: 0, height: 0 },
            });
            resolve();
          };
          img.src = splitImages[index];
        });
      }
    }

    updateNodeData(node.id, { status: "complete", error: null });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      updateNodeData(node.id, { status: "idle", error: null });
      throw error;
    }
    updateNodeData(node.id, {
      status: "error",
      error: error instanceof Error ? error.message : "Failed to split image",
    });
    throw error instanceof Error ? error : new Error("Failed to split image");
  }
}
