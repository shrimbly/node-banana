/**
 * Batch Execution Helper
 *
 * Detects batch mode (textItems from array nodes) and loops through items,
 * executing the appropriate node executor for each. Shared by executeWorkflow,
 * regenerateNode, and executeSelectedNodes.
 */

import { logger } from "@/utils/logger";
import type { WorkflowNodeData } from "@/types";
import type { NodeExecutionContext } from "./types";
import { executeNanoBanana } from "./nanoBananaExecutor";
import { executeGenerateVideo } from "./generateVideoExecutor";
import { executeGenerateAudio } from "./generateAudioExecutor";
import { executeLlmGenerate } from "./llmGenerateExecutor";
import { executeGenerate3D } from "./generate3dExecutor";
import { executeComfyApp } from "./comfyAppExecutor";

const BATCH_NODE_TYPES = new Set(["nanoBanana", "generateVideo", "generateAudio", "generate3d", "llmGenerate", "comfyApp"]);

/**
 * Attempts to run batch execution for a node.
 *
 * If the node type supports batching and has textItems from upstream array
 * nodes, iterates through each item and runs the executor individually.
 *
 * @returns `true` if batch execution was performed, `false` if the node
 *          should proceed with normal single-item execution.
 */
export async function runBatchIfApplicable(
  executionCtx: NodeExecutionContext,
  options?: { useStoredFallback?: boolean },
): Promise<boolean> {
  const { node } = executionCtx;

  if (!node.type || !BATCH_NODE_TYPES.has(node.type)) {
    return false;
  }

  const connectedInputs = executionCtx.getConnectedInputs(node.id);
  if (connectedInputs.textItems.length === 0) {
    return false;
  }

  const items = connectedInputs.textItems;
  const totalItems = items.length;

  for (let i = 0; i < totalItems; i++) {
    if (executionCtx.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    executionCtx.updateNodeData(node.id, {
      status: "loading",
      error: null,
    } as Partial<WorkflowNodeData>);

    logger.info("node.execution", `Batch ${i + 1} of ${totalItems}`, {
      nodeId: node.id,
      nodeType: node.type,
      batchIndex: i,
      batchTotal: totalItems,
    });

    // Wrap context so getConnectedInputs returns current batch item as text
    // and in the slot the batch feeds, and so each item's asset says which
    // item of the batch it was
    const { recordAsset } = executionCtx;
    const batchCtx: NodeExecutionContext = {
      ...executionCtx,
      getConnectedInputs: (nodeId: string) => {
        const { textItemsInput, ...inputs } = executionCtx.getConnectedInputs(nodeId);
        return {
          ...inputs,
          text: items[i],
          textItems: [],
          ...(textItemsInput ? { dynamicInputs: { ...inputs.dynamicInputs, [textItemsInput]: items[i] } } : {}),
        };
      },
      ...(recordAsset
        ? { recordAsset: (input) => recordAsset({ ...input, producer: { ...input.producer, batchIndex: i } }) }
        : {}),
    };

    switch (node.type) {
      case "nanoBanana":
        await executeNanoBanana(batchCtx, options);
        break;
      case "generateVideo":
        await executeGenerateVideo(batchCtx, options);
        break;
      case "generateAudio":
        await executeGenerateAudio(batchCtx, options);
        break;
      case "generate3d":
        await executeGenerate3D(batchCtx, options);
        break;
      case "llmGenerate":
        await executeLlmGenerate(batchCtx, options);
        break;
      case "comfyApp":
        await executeComfyApp(batchCtx);
        break;
    }
    // The next item sets "loading" itself, after checking for a Stop, so a
    // Stop between items leaves this item's result showing
  }

  return true;
}
