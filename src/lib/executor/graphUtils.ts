/**
 * Graph Utilities
 *
 * Pure functions for workflow graph operations extracted from workflowStore.
 * Used by both the client-side Zustand store and the server-side headless executor.
 */

import type {
  WorkflowNode,
  WorkflowNodeData,
  ImageInputNodeData,
  AudioInputNodeData,
  AnnotationNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  VideoStitchNodeData,
  EaseCurveNodeData,
  PromptNodeData,
  PromptConstructorNodeData,
  LLMGenerateNodeData,
  WebhookTriggerNodeData,
  ModelInputDef,
} from "@/types";
import type { WorkflowEdge } from "@/types/workflow";

/**
 * Level group for parallel execution
 */
export interface LevelGroup {
  level: number;
  nodeIds: string[];
}

/**
 * Return type for getConnectedInputsPure
 */
export interface ConnectedInputs {
  images: string[];
  videos: string[];
  audio: string[];
  text: string | null;
  dynamicInputs: Record<string, string | string[]>;
  easeCurve: { bezierHandles: [number, number, number, number]; easingPreset: string | null } | null;
}

/**
 * Groups nodes by dependency level using Kahn's algorithm variant.
 * Nodes at the same level can be executed in parallel.
 * Level 0 = nodes with no incoming edges (roots)
 * Level N = nodes whose dependencies are all at levels < N
 */
export function groupNodesByLevel(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): LevelGroup[] {
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  nodes.forEach((n) => {
    inDegree.set(n.id, 0);
    adjList.set(n.id, []);
  });

  edges.forEach((e) => {
    inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1);
    adjList.get(e.source)?.push(e.target);
  });

  const levels: LevelGroup[] = [];
  let currentLevel = nodes
    .filter((n) => inDegree.get(n.id) === 0)
    .map((n) => n.id);

  let levelNum = 0;
  while (currentLevel.length > 0) {
    levels.push({ level: levelNum, nodeIds: [...currentLevel] });

    const nextLevel: string[] = [];
    for (const nodeId of currentLevel) {
      for (const child of adjList.get(nodeId) || []) {
        const newDegree = (inDegree.get(child) || 1) - 1;
        inDegree.set(child, newDegree);
        if (newDegree === 0) {
          nextLevel.push(child);
        }
      }
    }

    currentLevel = nextLevel;
    levelNum++;
  }

  return levels;
}

/**
 * Chunk an array into smaller arrays of specified size
 */
export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

/**
 * Helper to determine if a handle ID is an image type
 */
function isImageHandle(handleId: string | null | undefined): boolean {
  if (!handleId) return false;
  return handleId === "image" || handleId.startsWith("image-") || handleId.includes("frame");
}

/**
 * Helper to determine if a handle ID is a text type
 */
function isTextHandle(handleId: string | null | undefined): boolean {
  if (!handleId) return false;
  return handleId === "text" || handleId.startsWith("text-") || handleId.includes("prompt");
}

/**
 * Extract output value from a source node based on its type.
 */
function getSourceOutput(sourceNode: WorkflowNode): { type: "image" | "text" | "video" | "audio"; value: string | null } {
  if (sourceNode.type === "imageInput") {
    return { type: "image", value: (sourceNode.data as ImageInputNodeData).image };
  } else if (sourceNode.type === "audioInput") {
    return { type: "audio", value: (sourceNode.data as AudioInputNodeData).audioFile };
  } else if (sourceNode.type === "annotation") {
    return { type: "image", value: (sourceNode.data as AnnotationNodeData).outputImage };
  } else if (sourceNode.type === "nanoBanana") {
    return { type: "image", value: (sourceNode.data as NanoBananaNodeData).outputImage };
  } else if (sourceNode.type === "generateVideo") {
    return { type: "video", value: (sourceNode.data as GenerateVideoNodeData).outputVideo };
  } else if (sourceNode.type === "videoStitch") {
    return { type: "video", value: (sourceNode.data as VideoStitchNodeData).outputVideo };
  } else if (sourceNode.type === "easeCurve") {
    return { type: "video", value: (sourceNode.data as EaseCurveNodeData).outputVideo };
  } else if (sourceNode.type === "prompt") {
    return { type: "text", value: (sourceNode.data as PromptNodeData).prompt };
  } else if (sourceNode.type === "promptConstructor") {
    const pcData = sourceNode.data as PromptConstructorNodeData;
    return { type: "text", value: pcData.outputText || pcData.template || null };
  } else if (sourceNode.type === "llmGenerate") {
    return { type: "text", value: (sourceNode.data as LLMGenerateNodeData).outputText };
  } else if (sourceNode.type === "webhookTrigger") {
    // WebhookTrigger outputs are determined by the edge's sourceHandle
    // We return null here; the actual routing is done in getConnectedInputsPure
    // based on the sourceHandle ID
    return { type: "image", value: null };
  }
  return { type: "image", value: null };
}

/**
 * Get the output value from a webhookTrigger node for a specific source handle.
 */
function getWebhookTriggerOutput(
  sourceNode: WorkflowNode,
  sourceHandle: string | null | undefined
): { type: "image" | "text"; value: string | null } {
  const data = sourceNode.data as WebhookTriggerNodeData;
  if (!sourceHandle) return { type: "image", value: null };

  if (sourceHandle === "text") {
    return { type: "text", value: data.text };
  }

  // image-0, image-1, etc.
  const match = sourceHandle.match(/^image-(\d+)$/);
  if (match) {
    const index = parseInt(match[1], 10);
    return { type: "image", value: data.images[index] ?? null };
  }

  return { type: "image", value: null };
}

/**
 * Pure version of getConnectedInputs that works with explicit node/edge arrays.
 * Used by both the Zustand store and the headless executor.
 */
export function getConnectedInputsPure(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): ConnectedInputs {
  const images: string[] = [];
  const videos: string[] = [];
  const audio: string[] = [];
  let text: string | null = null;
  const dynamicInputs: Record<string, string | string[]> = {};

  // Get the target node to check for inputSchema
  const targetNode = nodes.find((n) => n.id === nodeId);
  const inputSchema = (targetNode?.data as { inputSchema?: ModelInputDef[] })?.inputSchema;

  // Build mapping from normalized handle IDs to schema names
  const handleToSchemaName: Record<string, string> = {};
  if (inputSchema && inputSchema.length > 0) {
    const imageInputs = inputSchema.filter((i) => i.type === "image");
    const textInputs = inputSchema.filter((i) => i.type === "text");

    imageInputs.forEach((input, index) => {
      handleToSchemaName[`image-${index}`] = input.name;
      if (index === 0) {
        handleToSchemaName["image"] = input.name;
      }
    });

    textInputs.forEach((input, index) => {
      handleToSchemaName[`text-${index}`] = input.name;
      if (index === 0) {
        handleToSchemaName["text"] = input.name;
      }
    });
  }

  edges
    .filter((edge) => edge.target === nodeId)
    .forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;

      const handleId = edge.targetHandle;

      // Special handling for webhookTrigger source nodes
      let type: "image" | "text" | "video" | "audio";
      let value: string | null;

      if (sourceNode.type === "webhookTrigger") {
        const result = getWebhookTriggerOutput(sourceNode, edge.sourceHandle);
        type = result.type;
        value = result.value;
      } else {
        const result = getSourceOutput(sourceNode);
        type = result.type;
        value = result.value;
      }

      if (!value) return;

      // Map normalized handle ID to schema name for dynamicInputs
      if (handleId && handleToSchemaName[handleId]) {
        const schemaName = handleToSchemaName[handleId];
        const existing = dynamicInputs[schemaName];
        if (existing !== undefined) {
          dynamicInputs[schemaName] = Array.isArray(existing)
            ? [...existing, value]
            : [existing, value];
        } else {
          dynamicInputs[schemaName] = value;
        }
      }

      // Route to typed arrays based on source output type
      if (type === "video") {
        videos.push(value);
      } else if (type === "audio") {
        audio.push(value);
      } else if (type === "text" || isTextHandle(handleId)) {
        text = value;
      } else if (isImageHandle(handleId) || !handleId) {
        images.push(value);
      }
    });

  // Extract easeCurve data
  let easeCurve: ConnectedInputs["easeCurve"] = null;
  const easeCurveEdge = edges.find(
    (e) => e.target === nodeId && e.targetHandle === "easeCurve"
  );
  if (easeCurveEdge) {
    const sourceNode = nodes.find((n) => n.id === easeCurveEdge.source);
    if (sourceNode?.type === "easeCurve") {
      const sourceData = sourceNode.data as EaseCurveNodeData;
      easeCurve = {
        bezierHandles: sourceData.bezierHandles,
        easingPreset: sourceData.easingPreset,
      };
    }
  }

  return { images, videos, audio, text, dynamicInputs, easeCurve };
}
