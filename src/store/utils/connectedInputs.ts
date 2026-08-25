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
  VideoInputNodeData,
  AnnotationNodeData,
  NanoBananaNodeData,
  GenerateVideoNodeData,
  Generate3DNodeData,
  GenerateAudioNodeData,
  VideoStitchNodeData,
  EaseCurveNodeData,
  VideoTrimNodeData,
  VideoFrameGrabNodeData,
  RemoveBackgroundNodeData,
  ImageResizeNodeData,
  GifEncoderNodeData,
  PromptNodeData,
  ArrayNodeData,
  PromptConstructorNodeData,
  LLMGenerateNodeData,
  GLBViewerNodeData,
  SwitchNodeData,
  ConditionalSwitchNodeData,
  ComfyAppNodeData,
  MatchMode,
} from "@/types";
import {
  formatMissingRequiredModelParameters,
  getMissingRequiredModelParameters,
} from "@/utils/requiredModelParameters";

/**
 * Return type for getConnectedInputs
 */
export interface ConnectedInputs {
  images: string[];
  videos: string[];
  audio: string[];
  model3d: string | null;
  text: string | null;
  textItems: string[]; // All items from array batch mode (empty when not in batch)
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
export function getSourceOutput(
  sourceNode: WorkflowNode,
  sourceHandle: string | null | undefined,
  edgeData?: Record<string, unknown>
): { type: "image" | "text" | "video" | "audio" | "3d"; value: string | null } {
  if (sourceNode.type === "imageInput") {
    return { type: "image", value: (sourceNode.data as ImageInputNodeData).image };
  } else if (sourceNode.type === "videoInput") {
    return { type: "video", value: (sourceNode.data as VideoInputNodeData).video };
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
  } else if (sourceNode.type === "removeBackground") {
    return { type: "image", value: (sourceNode.data as RemoveBackgroundNodeData).outputImage };
  } else if (sourceNode.type === "imageResize") {
    return { type: "image", value: (sourceNode.data as ImageResizeNodeData).outputImage };
  } else if (sourceNode.type === "gifEncoder") {
    return { type: "image", value: (sourceNode.data as GifEncoderNodeData).outputGif };
  } else if (sourceNode.type === "glbViewer") {
    return { type: "image", value: (sourceNode.data as GLBViewerNodeData).capturedImage };
  } else if (sourceNode.type === "comfyApp") {
    // A Comfy app can expose several outputs of different types, so the handle
    // the edge leaves from decides both the value and its type. `outputs` is
    // keyed by output id, which is also the source handle id.
    const comfyData = sourceNode.data as ComfyAppNodeData;
    const output = comfyData.app?.outputs.find((o) => o.id === sourceHandle);
    if (output) {
      const value = comfyData.outputs?.[output.id] ?? null;
      return { type: output.type === "3d" ? "3d" : output.type, value };
    }
    // No handle match — an edge made before the app was attached, or one left
    // over from a workflow that has since been replaced. Substituting a
    // different output here would silently feed the wrong image downstream, so
    // the edge carries nothing until it is reconnected.
    return { type: "image", value: null };
  }
  return { type: "image", value: null };
}

/**
 * Resolves text source nodes through router (passthrough) nodes.
 * Given a list of directly-connected source nodes, expands any router nodes
 * by recursively following their upstream text connections to find the actual
 * text-producing source nodes.
 */
export function resolveTextSourcesThroughRouters(
  sourceNodes: WorkflowNode[],
  allNodes: WorkflowNode[],
  edges: { source: string; target: string; targetHandle?: string | null }[],
  visited?: Set<string>
): WorkflowNode[] {
  const seen = visited ?? new Set<string>();
  const resolved: WorkflowNode[] = [];

  for (const node of sourceNodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);

    if (node.type === "router" || node.type === "switch") {
      const upstreamNodes = edges
        .filter((e) => e.target === node.id && e.targetHandle === "text")
        .map((e) => allNodes.find((n) => n.id === e.source))
        .filter((n): n is WorkflowNode => n !== undefined);
      resolved.push(
        ...resolveTextSourcesThroughRouters(upstreamNodes, allNodes, edges, seen)
      );
    } else {
      resolved.push(node);
    }
  }

  return resolved;
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
  if (_visited.has(nodeId)) return { images: [], videos: [], audio: [], model3d: null, text: null, textItems: [], dynamicInputs: {}, easeCurve: null };
  _visited.add(nodeId);
  const images: string[] = [];
  const videos: string[] = [];
  const audio: string[] = [];
  let model3d: string | null = null;
  let text: string | null = null;
  const textItems: string[] = [];
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
    const audioInputs = inputSchema.filter(i => i.type === "audio");
    const videoInputs = inputSchema.filter(i => i.type === "video");

    imageInputs.forEach((input, index) => {
      handleToSchemaName[`image-${index}`] = input.name;
      if (index === 0) {
        handleToSchemaName["image"] = input.name;
      }
    });

    videoInputs.forEach((input, index) => {
      handleToSchemaName[`video-${index}`] = input.name;
      if (index === 0) {
        handleToSchemaName["video"] = input.name;
      }
    });

    textInputs.forEach((input, index) => {
      handleToSchemaName[`text-${index}`] = input.name;
      if (index === 0) {
        handleToSchemaName["text"] = input.name;
      }
    });

    audioInputs.forEach((input, index) => {
      handleToSchemaName[`audio-${index}`] = input.name;
      if (index === 0) {
        handleToSchemaName["audio"] = input.name;
      }
    });
  }

  // Populate dynamicInputs for a passthrough (router/switch) edge, mirroring the direct-connection
  // mapping further below. Those branches `return` before that block runs, so without this a routed
  // input never reaches dynamicInputs (the named schema slots) — which breaks generateVideo
  // multi-image slots, video inputs, and negative prompts. (Surfaced as "Failed to fetch result: 422".)
  const addPassthroughDynamicInput = (
    targetHandle: string | null | undefined,
    values: Array<string | null> | string | null,
  ): void => {
    if (!targetHandle) return;
    const schemaName = handleToSchemaName[targetHandle];
    if (!schemaName) return; // node has no schema slot for this handle (e.g. nanoBanana) → no-op
    const list = Array.isArray(values) ? values : [values];
    for (const v of list) {
      if (v == null) continue;
      const existing = dynamicInputs[schemaName];
      dynamicInputs[schemaName] = existing !== undefined
        ? (Array.isArray(existing) ? [...existing, v] : [existing, v])
        : v;
    }
  };

  // Cache passthrough node results so multiple edges from the same router/switch
  // all receive correct data (the _visited set prevents re-traversal, so we cache
  // the result from the first traversal and reuse it for subsequent edges).
  const passthroughCache = new Map<string, ConnectedInputs>();

  edges
    .filter((edge) => edge.target === nodeId && !edge.data?.isLoop)
    .forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;

      // Skip dimmed source nodes — their data should not flow downstream
      if (dimmedNodeIds && dimmedNodeIds.has(sourceNode.id)) return;

      // Array batch mode — send all items as textItems instead of a single item
      // Derive from source node's current batchMode (not edge metadata which can go stale)
      if (sourceNode.type === "array" && (sourceNode.data as ArrayNodeData).batchMode === true) {
        const arrayData = sourceNode.data as ArrayNodeData;
        const items = arrayData.outputItems;
        if (items.length > 0) {
          textItems.push(...items);
          // Set text to first item for backward compatibility
          if (text === null) text = items[0];
        }
        return; // Skip normal getSourceOutput processing
      }

      // Router passthrough — traverse upstream to find actual data source
      if (sourceNode.type === "router") {
        const routerInputs = passthroughCache.get(sourceNode.id)
          ?? getConnectedInputsPure(sourceNode.id, nodes, edges, _visited, dimmedNodeIds);
        passthroughCache.set(sourceNode.id, routerInputs);
        // Determine which type this edge carries based on the source handle
        const edgeType = edge.sourceHandle; // Will be "image", "text", "video", "audio", "3d", or "easeCurve"

        if (edgeType === "image" || (!edgeType && isImageHandle(edge.sourceHandle))) {
          images.push(...routerInputs.images);
          addPassthroughDynamicInput(edge.targetHandle, routerInputs.images);
        } else if (edgeType === "text" || (!edgeType && isTextHandle(edge.sourceHandle))) {
          if (routerInputs.text) text = routerInputs.text;
          addPassthroughDynamicInput(edge.targetHandle, routerInputs.text);
        } else if (edgeType === "video") {
          videos.push(...routerInputs.videos);
          addPassthroughDynamicInput(edge.targetHandle, routerInputs.videos);
        } else if (edgeType === "audio") {
          audio.push(...routerInputs.audio);
          addPassthroughDynamicInput(edge.targetHandle, routerInputs.audio);
        } else if (edgeType === "3d") {
          if (routerInputs.model3d) model3d = routerInputs.model3d;
          addPassthroughDynamicInput(edge.targetHandle, routerInputs.model3d);
        } else if (edgeType === "easeCurve") {
          // EaseCurve passthrough (not a schema-named input → no dynamicInputs mapping)
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
          addPassthroughDynamicInput(edge.targetHandle, switchInputs.images);
        } else if (edgeType === "text") {
          if (switchInputs.text) text = switchInputs.text;
          addPassthroughDynamicInput(edge.targetHandle, switchInputs.text);
        } else if (edgeType === "video") {
          videos.push(...switchInputs.videos);
          addPassthroughDynamicInput(edge.targetHandle, switchInputs.videos);
        } else if (edgeType === "audio") {
          audio.push(...switchInputs.audio);
          addPassthroughDynamicInput(edge.targetHandle, switchInputs.audio);
        } else if (edgeType === "3d") {
          if (switchInputs.model3d) model3d = switchInputs.model3d;
          addPassthroughDynamicInput(edge.targetHandle, switchInputs.model3d);
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

      // Settings edges into an EaseCurve target handle carry only the curve/
      // settings, not a video. The dedicated extraction below (targetHandle ===
      // "easeCurve") handles them. Processing them here would push the source
      // node's outputVideo into videos[] and ease the wrong video.
      if (edge.targetHandle === "easeCurve") return;

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

  // Extract easeCurve data from parent EaseCurve node (if not already set by router passthrough)
  if (!easeCurve) {
    const easeCurveEdge = edges.find(
      (e) => e.target === nodeId && e.targetHandle === "easeCurve" && !e.data?.isLoop
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

  return { images, videos, audio, model3d, text, textItems, dynamicInputs, easeCurve };
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

  nodes
    .filter((node) => ["nanoBanana", "generateVideo", "generate3d", "generateAudio"].includes(node.type))
    .forEach((node) => {
      const data = node.data as NanoBananaNodeData | GenerateVideoNodeData | Generate3DNodeData | GenerateAudioNodeData;
      const missingParameters = getMissingRequiredModelParameters(
        data.requiredModelParameters,
        data.parameters
      );
      if (missingParameters.length > 0) {
        errors.push(`${node.type} node "${node.id}" ${formatMissingRequiredModelParameters(missingParameters).toLowerCase()}`);
      }
    });

  // Check each Nano Banana node has required inputs (text required, image optional)
  // Loop edges are excluded because they carry no data on the first iteration.
  nodes
    .filter((n) => n.type === "nanoBanana")
    .forEach((node) => {
      const textConnected = edges.some(
        (e) => e.target === node.id &&
               !e.data?.isLoop &&
               (e.targetHandle === "text" || e.targetHandle?.startsWith("text-"))
      );
      if (!textConnected) {
        errors.push(`Generate node "${node.id}" missing text input`);
      }
    });

  // Check generateVideo nodes have at least one usable input connected.
  // A prompt is not always required: video-to-video models (e.g. upscalers)
  // need only a video input, image-to-video needs an image, etc. This mirrors
  // the executor, which runs as long as any of text/image/video/audio is present.
  nodes
    .filter((n) => n.type === "generateVideo")
    .forEach((node) => {
      const hasInput = edges.some(
        (e) => e.target === node.id &&
               !e.data?.isLoop &&
               (e.targetHandle === "text" || e.targetHandle?.startsWith("text-") ||
                e.targetHandle === "image" || e.targetHandle?.startsWith("image-") ||
                e.targetHandle === "video" || e.targetHandle?.startsWith("video-") ||
                e.targetHandle === "audio" || e.targetHandle?.startsWith("audio-"))
      );
      if (!hasInput) {
        errors.push(`Video node "${node.id}" missing input`);
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

  // Check split grid nodes have an image to split
  nodes
    .filter((n) => n.type === "splitGrid")
    .forEach((node) => {
      const imageConnected = edges.some(
        (e) => e.target === node.id && !e.data?.isLoop && e.targetHandle === "image"
      );
      if (!imageConnected) {
        errors.push(`Split Grid node "${node.id}" missing image input`);
      }
    });

  return { valid: errors.length === 0, errors };
}
