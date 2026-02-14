/**
 * Connected Inputs & Validation
 *
 * Pure functions extracted from workflowStore for getting connected inputs
 * and validating workflow structure. These can be tested without the store.
 */

import {
  WorkflowNode,
  WorkflowEdge,
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
  GLBViewerNodeData,
} from "@/types";

/**
 * Return type for getConnectedInputs
 */
export interface ConnectedInputs {
  images: string[];
  videos: string[];
  audio: string[];
  model3d: string | null;
  text: string | null;
  dynamicInputs: Record<string, string | string[]>;
  easeCurve: { bezierHandles: [number, number, number, number]; easingPreset: string | null } | null;
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
 * Extract output data and type from a source node
 */
function getSourceOutput(sourceNode: WorkflowNode): { type: "image" | "text" | "video" | "audio" | "3d"; value: string | null } {
  if (sourceNode.type === "imageInput") {
    return { type: "image", value: (sourceNode.data as ImageInputNodeData).image };
  } else if (sourceNode.type === "audioInput") {
    return { type: "audio", value: (sourceNode.data as AudioInputNodeData).audioFile };
  } else if (sourceNode.type === "annotation") {
    return { type: "image", value: (sourceNode.data as AnnotationNodeData).outputImage };
  } else if (sourceNode.type === "nanoBanana") {
    const nbData = sourceNode.data as NanoBananaNodeData;
    if (nbData.output3dUrl) {
      return { type: "3d", value: nbData.output3dUrl };
    }
    return { type: "image", value: nbData.outputImage };
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
    return { type: "text", value: pcData.outputText ?? pcData.template ?? null };
  } else if (sourceNode.type === "llmGenerate") {
    return { type: "text", value: (sourceNode.data as LLMGenerateNodeData).outputText };
  } else if (sourceNode.type === "glbViewer") {
    return { type: "image", value: (sourceNode.data as GLBViewerNodeData).capturedImage };
  }
  return { type: "image", value: null };
}

/**
 * Get all connected inputs for a node.
 * Pure function version of workflowStore.getConnectedInputs.
 */
export function getConnectedInputsPure(
  nodeId: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): ConnectedInputs {
  const images: string[] = [];
  const videos: string[] = [];
  const audio: string[] = [];
  let model3d: string | null = null;
  let text: string | null = null;
  const dynamicInputs: Record<string, string | string[]> = {};

  // Get the target node to check for inputSchema
  const targetNode = nodes.find((n) => n.id === nodeId);
  const inputSchema = (targetNode?.data as { inputSchema?: Array<{ name: string; type: string }> })?.inputSchema;

  // Build mapping from normalized handle IDs to schema names if schema exists
  const handleToSchemaName: Record<string, string> = {};
  if (inputSchema && inputSchema.length > 0) {
    const imageInputs = inputSchema.filter(i => i.type === "image");
    const textInputs = inputSchema.filter(i => i.type === "text");

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
      const { type, value } = getSourceOutput(sourceNode);

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
      if (type === "3d") {
        model3d = value;
      } else if (type === "video") {
        videos.push(value);
      } else if (type === "audio") {
        audio.push(value);
      } else if (type === "text" || isTextHandle(handleId)) {
        text = value;
      } else if (isImageHandle(handleId) || !handleId) {
        images.push(value);
      }
    });

  // Extract easeCurve data from parent EaseCurve node
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

  return { images, videos, audio, model3d, text, dynamicInputs, easeCurve };
}

/**
 * Validate workflow structure.
 * Pure function version of workflowStore.validateWorkflow.
 */
export function validateWorkflowPure(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (nodes.length === 0) {
    errors.push("Workflow is empty");
    return { valid: false, errors };
  }

  // Check each Nano Banana node has required inputs (text required, image optional)
  nodes
    .filter((n) => n.type === "nanoBanana")
    .forEach((node) => {
      const textConnected = edges.some(
        (e) => e.target === node.id &&
               (e.targetHandle === "text" || e.targetHandle?.startsWith("text-"))
      );
      if (!textConnected) {
        errors.push(`Generate node "${node.id}" missing text input`);
      }
    });

  // Check generateVideo nodes have required text input
  nodes
    .filter((n) => n.type === "generateVideo")
    .forEach((node) => {
      const textConnected = edges.some(
        (e) => e.target === node.id &&
               (e.targetHandle === "text" || e.targetHandle?.startsWith("text-"))
      );
      if (!textConnected) {
        errors.push(`Video node "${node.id}" missing text input`);
      }
    });

  // Check annotation nodes have image input (either connected or manually loaded)
  nodes
    .filter((n) => n.type === "annotation")
    .forEach((node) => {
      const imageConnected = edges.some((e) => e.target === node.id);
      const hasManualImage = (node.data as AnnotationNodeData).sourceImage !== null;
      if (!imageConnected && !hasManualImage) {
        errors.push(`Annotation node "${node.id}" missing image input`);
      }
    });

  // Check output nodes have image input
  nodes
    .filter((n) => n.type === "output")
    .forEach((node) => {
      const imageConnected = edges.some((e) => e.target === node.id);
      if (!imageConnected) {
        errors.push(`Output node "${node.id}" missing image input`);
      }
    });

  return { valid: errors.length === 0, errors };
}
