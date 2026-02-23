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
  Generate3DNodeData,
  GenerateAudioNodeData,
  VideoStitchNodeData,
  EaseCurveNodeData,
  VideoTrimNodeData,
  VideoFrameGrabNodeData,
  PromptNodeData,
  ArrayNodeData,
  PromptConstructorNodeData,
  LLMGenerateNodeData,
  GLBViewerNodeData,
  SpzViewerNodeData,
  WorldLabsPanoNodeData,
  WorldLabsWorldNodeData,
  PanoCropNodeData,
  PanoEditorNodeData,
  MaskPainterNodeData,
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
  // "image", "image-mask_url", "image-depth_image_url", "image-0", etc.
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
 * Extract output data and type from a source node.
 * sourceHandleId is used for multi-output nodes (e.g. WorldLabs outputs both "image" and "3d").
 */
function getSourceOutput(
  sourceNode: WorkflowNode,
  sourceHandle: string | null | undefined,
  edgeData?: Record<string, unknown>
): { type: "image" | "text" | "video" | "audio" | "3d"; value: string | null } {
  const sourceHandleId = sourceHandle;
  if (sourceNode.type === "imageInput") {
    return { type: "image", value: (sourceNode.data as ImageInputNodeData).image };
  } else if (sourceNode.type === "audioInput") {
    return { type: "audio", value: (sourceNode.data as AudioInputNodeData).audioFile };
  } else if (sourceNode.type === "annotation") {
    return { type: "image", value: (sourceNode.data as AnnotationNodeData).outputImage };
  } else if (sourceNode.type === "nanoBanana") {
    const nbData = sourceNode.data as NanoBananaNodeData;
    return { type: "image", value: nbData.outputImage };
  } else if (sourceNode.type === "generate3d") {
    const g3dData = sourceNode.data as Generate3DNodeData;
    return { type: "3d", value: g3dData.output3dUrl };
  } else if (sourceNode.type === "generateVideo") {
    return { type: "video", value: (sourceNode.data as GenerateVideoNodeData).outputVideo };
  } else if (sourceNode.type === "generateAudio") {
    return { type: "audio", value: (sourceNode.data as GenerateAudioNodeData).outputAudio };
  } else if (sourceNode.type === "videoStitch") {
    return { type: "video", value: (sourceNode.data as VideoStitchNodeData).outputVideo };
  } else if (sourceNode.type === "easeCurve") {
    return { type: "video", value: (sourceNode.data as EaseCurveNodeData).outputVideo };
  } else if (sourceNode.type === "videoTrim") {
    return { type: "video", value: (sourceNode.data as VideoTrimNodeData).outputVideo };
  } else if (sourceNode.type === "prompt") {
    return { type: "text", value: (sourceNode.data as PromptNodeData).prompt };
  } else if (sourceNode.type === "array") {
    const arrayData = sourceNode.data as ArrayNodeData;
    const dataIndex = edgeData?.arrayItemIndex;
    if (typeof dataIndex === "number" && Number.isInteger(dataIndex) && dataIndex >= 0) {
      return { type: "text", value: arrayData.outputItems[dataIndex] ?? null };
    }
    if (sourceHandle?.startsWith("text-")) {
      const index = Number(sourceHandle.replace("text-", ""));
      if (Number.isInteger(index) && index >= 0) {
        return { type: "text", value: arrayData.outputItems[index] ?? null };
      }
    }
    return { type: "text", value: arrayData.outputText };
  } else if (sourceNode.type === "promptConstructor") {
    const pcData = sourceNode.data as PromptConstructorNodeData;
    return { type: "text", value: pcData.outputText ?? pcData.template ?? null };
  } else if (sourceNode.type === "llmGenerate") {
    return { type: "text", value: (sourceNode.data as LLMGenerateNodeData).outputText };
  } else if (sourceNode.type === "videoFrameGrab") {
    return { type: "image", value: (sourceNode.data as VideoFrameGrabNodeData).outputImage };
  } else if (sourceNode.type === "glbViewer") {
    return { type: "image", value: (sourceNode.data as GLBViewerNodeData).capturedImage };
  } else if (sourceNode.type === "spzViewer") {
    return { type: "image", value: (sourceNode.data as SpzViewerNodeData).capturedImage };
  } else if (sourceNode.type === "worldLabsPano") {
    const pData = sourceNode.data as WorldLabsPanoNodeData;
    if (sourceHandleId === "text") {
      return { type: "text", value: pData.caption || null };
    }
    return { type: "image", value: pData.panoUrl || pData.thumbnailUrl || null };
  } else if (sourceNode.type === "worldLabsWorld") {
    const wData = sourceNode.data as WorldLabsWorldNodeData;
    if (sourceHandleId === "3d") {
      const bestSpz = wData.spzUrls?.["500k"] || wData.spzUrls?.full_res || wData.spzUrls?.["100k"] || null;
      return { type: "3d", value: bestSpz };
    }
    return { type: "image", value: wData.panoUrl || wData.thumbnailUrl || null };
  } else if (sourceNode.type === "panoCrop") {
    const pcData = sourceNode.data as PanoCropNodeData;
    if (sourceHandleId === "text") {
      return { type: "text", value: pcData.metadata || null };
    }
    return { type: "image", value: pcData.image || null };
  } else if (sourceNode.type === "panoEditor") {
    return { type: "image", value: (sourceNode.data as PanoEditorNodeData).outputImage || null };
  } else if (sourceNode.type === "maskPainter") {
    return { type: "image", value: (sourceNode.data as MaskPainterNodeData).outputMask || null };
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

    // Map primary image handle to first image input (usually "image_url")
    if (imageInputs.length > 0) {
      handleToSchemaName["image"] = imageInputs[0].name;
    }

    // Map each dynamic image input handle: "image-{schemaName}" → schemaName
    // These are generated by GenerateImageNode/GenerateVideoNode/Generate3DNode
    imageInputs.forEach((input) => {
      handleToSchemaName[`image-${input.name}`] = input.name;
    });

    // Also keep index-based mapping for backwards compatibility
    imageInputs.forEach((input, index) => {
      handleToSchemaName[`image-${index}`] = input.name;
    });

    textInputs.forEach((input, index) => {
      handleToSchemaName[`text-${index}`] = input.name;
      if (index === 0) {
        handleToSchemaName["text"] = input.name;
      }
    });

    // Legacy: map "image-mask" to mask schema name for backwards compatibility
    const maskInput = inputSchema.find(i => i.name.includes("mask") && i.type === "image");
    if (maskInput) {
      handleToSchemaName["image-mask"] = maskInput.name;
    }
  }

  edges
    .filter((edge) => edge.target === nodeId)
    .forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;

      const handleId = edge.targetHandle;
      const { type, value } = getSourceOutput(
        sourceNode,
        edge.sourceHandle,
        (edge.data as Record<string, unknown> | undefined)
      );

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
        // Defensive: ensure text values are always strings
        // (Guards against corrupted node data during parallel execution)
        text = typeof value === 'string' ? value : String(value);
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
