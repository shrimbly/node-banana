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
  SwitchNodeData,
  ConditionalSwitchNodeData,
  InpaintNodeData,
  MatchMode,
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
  namedImages: Record<string, string>; // variableName → base64 image data URL
  dynamicInputs: Record<string, string | string[]>;
  easeCurve: { bezierHandles: [number, number, number, number]; easingPreset: string | null; outputDuration: number } | null;
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
function getSourceOutput(
  sourceNode: WorkflowNode,
  sourceHandle: string | null | undefined,
  edgeData?: Record<string, unknown>
): { type: "image" | "text" | "video" | "audio" | "3d"; value: string | null } {
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
      const items = arrayData.outputItems;
      if (items.length === 0) return { type: "text", value: null };
      const clampedIndex = dataIndex % items.length;
      return { type: "text", value: items[clampedIndex] ?? null };
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
  } else if (sourceNode.type === "inpaint") {
    return { type: "image", value: (sourceNode.data as InpaintNodeData).outputImage };
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
  edges: WorkflowEdge[],
  visited?: Set<string>,
  dimmedNodeIds?: Set<string>
): ConnectedInputs {
  const _visited = visited || new Set<string>();
  if (_visited.has(nodeId)) return { images: [], videos: [], audio: [], model3d: null, text: null, namedImages: {}, dynamicInputs: {}, easeCurve: null };
  _visited.add(nodeId);
  const images: string[] = [];
  const videos: string[] = [];
  const audio: string[] = [];
  let model3d: string | null = null;
  let text: string | null = null;
  const namedImages: Record<string, string> = {};
  const dynamicInputs: Record<string, string | string[]> = {};
  let easeCurve: ConnectedInputs["easeCurve"] = null;

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

  // Cache passthrough node results so multiple edges from the same router/switch
  // all receive correct data (the _visited set prevents re-traversal, so we cache
  // the result from the first traversal and reuse it for subsequent edges).
  const passthroughCache = new Map<string, ConnectedInputs>();

  edges
    .filter((edge) => edge.target === nodeId)
    .forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;

      // Skip dimmed source nodes — their data should not flow downstream
      if (dimmedNodeIds && dimmedNodeIds.has(sourceNode.id)) return;

      // Router passthrough — traverse upstream to find actual data source
      if (sourceNode.type === "router") {
        const routerInputs = passthroughCache.get(sourceNode.id)
          ?? getConnectedInputsPure(sourceNode.id, nodes, edges, _visited, dimmedNodeIds);
        passthroughCache.set(sourceNode.id, routerInputs);
        // Determine which type this edge carries based on the source handle
        const edgeType = edge.sourceHandle; // Will be "image", "text", "video", "audio", "3d", or "easeCurve"

        if (edgeType === "image" || (!edgeType && isImageHandle(edge.sourceHandle))) {
          images.push(...routerInputs.images);
          Object.assign(namedImages, routerInputs.namedImages);
        } else if (edgeType === "text" || (!edgeType && isTextHandle(edge.sourceHandle))) {
          if (routerInputs.text) text = routerInputs.text;
        } else if (edgeType === "video") {
          videos.push(...routerInputs.videos);
        } else if (edgeType === "audio") {
          audio.push(...routerInputs.audio);
        } else if (edgeType === "3d") {
          if (routerInputs.model3d) model3d = routerInputs.model3d;
        } else if (edgeType === "easeCurve") {
          // EaseCurve passthrough
          if (routerInputs.easeCurve) easeCurve = routerInputs.easeCurve;
        }
        return; // Skip normal getSourceOutput processing for this edge
      }

      // Switch passthrough — traverse upstream if output is enabled
      if (sourceNode.type === "switch") {
        const switchData = sourceNode.data as SwitchNodeData;
        const switchId = edge.sourceHandle; // Handle ID matches switch entry id
        const switchEntry = switchData.switches?.find(s => s.id === switchId);

        // Skip disabled outputs — data does not flow through disabled switches
        if (!switchEntry || !switchEntry.enabled) {
          return; // Block this path
        }

        // Enabled switch: recursively get upstream data (same pattern as router)
        const switchInputs = passthroughCache.get(sourceNode.id)
          ?? getConnectedInputsPure(sourceNode.id, nodes, edges, _visited, dimmedNodeIds);
        passthroughCache.set(sourceNode.id, switchInputs);
        const edgeType = switchData.inputType;

        if (edgeType === "image") {
          images.push(...switchInputs.images);
          Object.assign(namedImages, switchInputs.namedImages);
        } else if (edgeType === "text") {
          if (switchInputs.text) text = switchInputs.text;
        } else if (edgeType === "video") {
          videos.push(...switchInputs.videos);
        } else if (edgeType === "audio") {
          audio.push(...switchInputs.audio);
        } else if (edgeType === "3d") {
          if (switchInputs.model3d) model3d = switchInputs.model3d;
        } else if (edgeType === "easeCurve") {
          if (switchInputs.easeCurve) easeCurve = switchInputs.easeCurve;
        }
        return; // Skip normal getSourceOutput processing
      }

      // Conditional Switch passthrough — traverse upstream if output is active (matched or default)
      if (sourceNode.type === "conditionalSwitch") {
        const condData = sourceNode.data as ConditionalSwitchNodeData;

        // When evaluation is paused, all outputs are active (gate is open)
        if (!condData.evaluationPaused) {
          const sourceHandle = edge.sourceHandle;

          // Find matching rule or check if default
          const rule = condData.rules.find(r => r.id === sourceHandle);
          const isDefaultHandle = sourceHandle === "default";

          // Determine if this output is active
          let isActive = false;
          if (rule) {
            isActive = rule.isMatched;
          } else if (isDefaultHandle) {
            // Default is active when NO rules match
            isActive = !condData.rules.some(r => r.isMatched);
          }

          // Block non-active outputs (data does not flow through non-matching rules)
          if (!isActive) return;
        }

        // Active output (or paused): ConditionalSwitch is a gate — trigger downstream but don't pass data through
        return;
      }

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

      // Track named image variables from imageInput nodes
      if (type === "image" && sourceNode.type === "imageInput") {
        const imgData = sourceNode.data as ImageInputNodeData;
        if (imgData.variableName && value) {
          namedImages[imgData.variableName] = value;
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

  // Extract easeCurve data from parent EaseCurve node (if not already set by router passthrough)
  if (!easeCurve) {
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
          outputDuration: sourceData.outputDuration,
        };
      }
    }
  }

  return { images, videos, audio, model3d, text, namedImages, dynamicInputs, easeCurve };
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
