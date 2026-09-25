/**
 * Handles and connection rules, as pure functions over plain nodes and edges.
 *
 * `getHandleType` and `isValidConnectionPort` are ports of the canvas rules
 * (`WorkflowCanvas.tsx` getHandleType / isValidConnection), which live inside
 * the component and cannot be imported. TODO: move the canvas onto these so
 * the two cannot drift. `wouldCreateCycle` is the store's own.
 *
 * On top of those, this module knows which handle ids each node actually
 * *renders* right now: the sockets each node passes to NodeShell (static
 * lists, router types, switch outputs, conditional rules, numbered
 * stitch/GIF slots), the schema-driven `${type}-${i}` sockets (built with the
 * node's own `schemaSockets`) and ComfyUI app contracts (`appInputHandles`).
 * The agent must only ever emit those ids: an edge to a handle the node does
 * not render is committed but never drawn.
 */

import type { HandleType, ModelInputDef, NodeType } from "@/types";
import type { WorkflowEdge } from "@/types/workflow";
import { wouldCreateCycle as storeWouldCreateCycle } from "@/store/utils/executionUtils";
import { schemaSockets } from "@/components/nodes/ui/schemaSockets";
import { appInputHandles } from "@/lib/comfy/nodeSchema";
import type { ComfyAppDefinition } from "@/lib/comfy/types";
import { normalizeKey, type AgentHandleType } from "./catalog";

export interface GraphNodeLike {
  id: string;
  type: NodeType;
  data: Record<string, unknown>;
}

export interface GraphEdgeLike {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  data?: { isLoop?: boolean; hasPause?: boolean; arrayItemIndex?: number; [key: string]: unknown };
}

export interface NodeHandle {
  id: string;
  type: AgentHandleType;
  label: string;
  /** Inputs: several edges may end here (images are collected, not replaced). */
  multi: boolean;
  /** Rendered for old edges only; not connectable (schema nodes' legacy ids). */
  hidden?: boolean;
  /** Rendered, but dimmed: the node's current model ignores it (schema placeholder), or a switched-off Switch output. */
  unused?: boolean;
  /** Split Grid's reference link: never for the agent. */
  internal?: boolean;
  /** Numbered slot (video-N on Video Stitch, image-N on GIF Encoder). */
  numbered?: boolean;
  /** Schema input name, when the handle comes from a model or ComfyUI schema. */
  schemaName?: string;
}

export const DATA_TYPES: readonly HandleType[] = ["image", "text", "video", "audio", "3d", "easeCurve"];

/** The lane names RouterNode shows per routed type. */
const ROUTER_LABELS: Record<HandleType, string> = {
  image: "Image",
  text: "Text",
  video: "Video",
  audio: "Audio",
  "3d": "3D",
  easeCurve: "Ease curve",
};

/** Preference when a node pair could connect on several types. */
const TYPE_PREFERENCE: readonly AgentHandleType[] = ["image", "video", "text", "audio", "3d", "easeCurve"];

/** Viewers at the end of a chain: they take inputs and have no outputs at all. */
const SINK_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["output", "outputGallery", "imageCompare"]);
const SINK_NAMES: Partial<Record<NodeType, string>> = { output: "Output", outputGallery: "Output Gallery", imageCompare: "Image Compare" };

// ---------------------------------------------------------------------------
// Ports of the canvas rules
// ---------------------------------------------------------------------------

/** Port of `getHandleType` (WorkflowCanvas.tsx): the type a handle id encodes, if any. */
export function getHandleType(handleId: string | null | undefined): HandleType | null {
  if (!handleId) return null;
  if (handleId === "generic-input" || handleId === "generic-output") return null;
  if (handleId === "easeCurve") return "easeCurve";
  if (handleId === "3d") return "3d";
  if (handleId === "video") return "video";
  if (handleId === "audio" || handleId.startsWith("audio")) return "audio";
  if (handleId === "image" || handleId === "text") return handleId;
  if (handleId.includes("video")) return "video";
  if (handleId.startsWith("image-") || handleId.includes("image") || handleId.includes("frame")) return "image";
  if (handleId.startsWith("text-") || handleId === "prompt" || handleId === "negative_prompt" || handleId.includes("prompt")) return "text";
  return null;
}

function comfyOutputType(node: GraphNodeLike | undefined, handleId: string | null | undefined): HandleType | null {
  if (node?.type !== "comfyApp" || !handleId) return null;
  const output = comfyOutputs(node).find((o) => o.id === handleId);
  return (output?.type as HandleType | undefined) ?? null;
}

/** Port of the canvas's `comfyDeclaresInput`: `${type}-${i}` ids counted over `inputSchema`. */
function comfyDeclaresInput(node: GraphNodeLike, handleId: string | null | undefined): boolean {
  if (!handleId) return false;
  const counters: Record<string, number> = {};
  return schemaOf(node).some((input) => {
    const index = counters[input.type] ?? 0;
    counters[input.type] = index + 1;
    return `${input.type}-${index}` === handleId;
  });
}

const VIDEO_TARGET_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  "generateVideo", "videoStitch", "easeCurve", "videoTrim", "videoFrameGrab", "videoInput", "output", "outputGallery", "router", "comfyApp",
]);

/**
 * Port of the canvas's `isValidConnection`. Deliberately permissive where the
 * canvas is (unknown types pass); the agent's resolver is stricter on top.
 */
export function isValidConnectionPort(
  connection: { source: string; sourceHandle: string | null; target: string; targetHandle: string | null },
  nodes: ReadonlyMap<string, GraphNodeLike> | readonly GraphNodeLike[],
): boolean {
  const find = (id: string) =>
    nodes instanceof Map ? (nodes as ReadonlyMap<string, GraphNodeLike>).get(id) : (nodes as readonly GraphNodeLike[]).find((n) => n.id === id);
  const targetNode = find(connection.target);
  const sourceNode = find(connection.source);
  const sourceType = comfyOutputType(sourceNode, connection.sourceHandle) ?? getHandleType(connection.sourceHandle);
  const targetType = getHandleType(connection.targetHandle);

  if (targetNode?.type === "comfyApp" && !comfyDeclaresInput(targetNode, connection.targetHandle)) return false;
  if (sourceNode?.type === "comfyApp" && !sourceType) return false;
  if (targetNode?.type === "switch" && connection.targetHandle === "generic-input") return true;

  if (sourceNode?.type === "switch") {
    const inputType = sourceNode.data.inputType as string | null | undefined;
    if (inputType && targetType) return inputType === targetType;
    return true;
  }
  if (targetNode?.type === "conditionalSwitch") return sourceType === "text";
  if (sourceNode?.type === "conditionalSwitch") return targetType === "text";

  if (!sourceType || !targetType) return true;

  if (sourceType === "easeCurve" || targetType === "easeCurve") {
    if (targetNode?.type === "router" || sourceNode?.type === "router") return true;
    if (sourceType !== "easeCurve" || targetType !== "easeCurve") return false;
    return targetNode?.type === "easeCurve";
  }
  if (sourceType === "video") {
    if (!targetNode) return false;
    return VIDEO_TARGET_NODE_TYPES.has(targetNode.type);
  }
  if (sourceType === "3d" || targetType === "3d") {
    if (sourceNode?.type === "router" || targetNode?.type === "router") return true;
    return sourceType === "3d" && targetType === "3d";
  }
  if (sourceType === "audio" || targetType === "audio") {
    if (sourceType === "audio" && (targetNode?.type === "output" || targetNode?.type === "router")) return true;
    return sourceType === "audio" && targetType === "audio";
  }
  return sourceType === targetType;
}

/** Would source → target close a loop? The store's own check (`executionUtils.ts`), which reads only endpoints. */
export function wouldCreateCycle(sourceId: string, targetId: string, edges: readonly GraphEdgeLike[]): boolean {
  return storeWouldCreateCycle(sourceId, targetId, edges as unknown as WorkflowEdge[]);
}

// ---------------------------------------------------------------------------
// Rendered handles per node
// ---------------------------------------------------------------------------

interface SchemaInput {
  name: string;
  type: string;
  label?: string;
  /** The model takes a list here (e.g. several reference images): every connection is collected. */
  isArray?: boolean;
}

function isSchemaInput(input: unknown): input is SchemaInput {
  return !!input && typeof input === "object" && typeof (input as SchemaInput).name === "string" && typeof (input as SchemaInput).type === "string";
}

function schemaOf(node: GraphNodeLike): SchemaInput[] {
  const schema = node.data.inputSchema;
  return Array.isArray(schema) ? schema.filter(isSchemaInput) : [];
}

function comfyOutputs(node: GraphNodeLike): Array<{ id: string; type: string; label?: string }> {
  const app = node.data.app as { outputs?: unknown } | null | undefined;
  if (!app || !Array.isArray(app.outputs)) return [];
  return app.outputs.filter(
    (o): o is { id: string; type: string; label?: string } =>
      !!o && typeof o === "object" && typeof (o as { id?: unknown }).id === "string" && typeof (o as { type?: unknown }).type === "string",
  );
}

/**
 * A ComfyUI app's input handles, as ComfyAppNode renders them: one per input
 * of the attached workflow, ids counted per type by `appInputHandles`. No
 * workflow, no handles.
 */
function comfyInputHandles(node: GraphNodeLike): NodeHandle[] {
  const app = node.data.app as { inputs?: unknown } | null | undefined;
  if (!app) return [];
  const inputs = Array.isArray(app.inputs) ? (app.inputs as unknown[]).filter(isSchemaInput) : schemaOf(node);
  return appInputHandles({ inputs } as unknown as ComfyAppDefinition).map((input) => ({
    id: input.handleId,
    type: input.type as AgentHandleType,
    label: input.label || input.name,
    multi: false,
    schemaName: input.name,
  }));
}

function incoming(nodeId: string, edges: readonly GraphEdgeLike[]): GraphEdgeLike[] {
  return edges.filter((e) => e.target === nodeId);
}

/** Data types currently flowing into a router (its typed input handles). */
export function routerActiveTypes(nodeId: string, edges: readonly GraphEdgeLike[]): HandleType[] {
  const types = new Set<HandleType>();
  for (const edge of incoming(nodeId, edges)) {
    if (edge.targetHandle && (DATA_TYPES as readonly string[]).includes(edge.targetHandle)) {
      types.add(edge.targetHandle as HandleType);
    }
  }
  return [...types].sort();
}

/** The type a Switch routes: from its input edge (as the node derives it), else its data. */
export function switchInputType(node: GraphNodeLike, edges: readonly GraphEdgeLike[]): HandleType | null {
  const edge = incoming(node.id, edges)[0];
  if (edge?.targetHandle && edge.targetHandle !== "generic-input") return edge.targetHandle as HandleType;
  const stored = node.data.inputType;
  return typeof stored === "string" && stored ? (stored as HandleType) : null;
}

export function switchEntries(node: GraphNodeLike): Array<{ id: string; name: string; enabled: boolean }> {
  const switches = node.data.switches;
  if (!Array.isArray(switches)) return [];
  return switches.filter((s): s is { id: string; name: string; enabled: boolean } => !!s && typeof s === "object" && typeof s.id === "string");
}

export function conditionalRules(node: GraphNodeLike): Array<{ id: string; label: string; value: string; mode: string }> {
  const rules = node.data.rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((r): r is { id: string; label: string; value: string; mode: string } => !!r && typeof r === "object" && typeof r.id === "string");
}

function numberedSlots(prefix: "video" | "image", count: number, labelPrefix: string, type: AgentHandleType): NodeHandle[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    type,
    label: `${labelPrefix} ${i + 1}`,
    multi: false,
    numbered: true,
  }));
}

/**
 * Schema-driven inputs of generateVideo / generate3d, from the node's own
 * `schemaSockets`: indexed `${type}-${i}` sockets, dimmed placeholders for
 * types the model ignores, hidden un-indexed ids kept for old edges. Without
 * a schema the node shows its plain sockets (`collectImages`: its image
 * socket takes several images).
 */
function schemaIndexedInputs(
  node: GraphNodeLike,
  options: Parameters<typeof schemaSockets>[1] & { collectImages?: boolean },
): NodeHandle[] {
  const schema = schemaOf(node);
  return schemaSockets(schema as ModelInputDef[], options).map((socket) => {
    const input = socket.schemaName !== undefined ? schema.find((i) => i.name === socket.schemaName) : undefined;
    return {
      id: socket.id,
      type: socket.type,
      label: socket.label || (input ? input.label || input.name : `${socket.type} (legacy)`),
      multi: schema.length === 0 ? socket.type === "image" && options?.collectImages === true : input?.isArray === true,
      ...(socket.hidden ? { hidden: true } : {}),
      ...(socket.placeholder ? { unused: true } : {}),
      ...(socket.schemaName !== undefined ? { schemaName: socket.schemaName } : {}),
    };
  });
}

/** Input handles the node renders right now. */
export function getInputHandles(node: GraphNodeLike, edges: readonly GraphEdgeLike[]): NodeHandle[] {
  const h = (id: string, type: AgentHandleType, label: string, multi = false): NodeHandle => ({ id, type, label, multi });
  switch (node.type) {
    case "imageInput":
      return [{ id: "reference", type: "reference", label: "Ref", multi: false, internal: true }];
    case "audioInput":
      return [h("audio", "audio", "Audio")];
    case "videoInput":
      return [h("video", "video", "Video")];
    case "annotation":
      return [h("image", "image", "Image")];
    case "prompt":
    case "array":
      return [h("text", "text", "Text")];
    case "promptConstructor":
      return [h("text", "text", "Text", true)];
    case "nanoBanana":
      // Static sockets whatever the model: every connected image is collected.
      return [h("image", "image", "Image", true), h("text", "text", "Prompt")];
    case "generateVideo":
      return schemaIndexedInputs(node, { videoPlaceholder: true, collectImages: true });
    case "generate3d":
      return schemaIndexedInputs(node, { types: ["image", "text"] });
    case "generateAudio": {
      const schema = schemaOf(node);
      if (schema.length > 0) {
        return schema.map((input) => ({
          id: input.name,
          type: (input.type === "image" ? "image" : input.type === "audio" ? "audio" : "text") as AgentHandleType,
          label: input.label || input.name,
          multi: false,
          schemaName: input.name,
        }));
      }
      return [h("text", "text", "Prompt")];
    }
    case "llmGenerate":
      return [h("image", "image", "Image", true), h("text", "text", "Prompt")];
    case "splitGrid":
      return [h("image", "image", "Image")];
    case "output":
      return [h("image", "image", "Image"), h("video", "video", "Video"), h("audio", "audio", "Audio")];
    case "outputGallery":
      return [h("image", "image", "Image", true), h("video", "video", "Video", true)];
    case "imageCompare":
      return [h("image", "image", "A"), h("image-1", "image", "B")];
    case "videoStitch": {
      const videoEdges = incoming(node.id, edges).filter((e) => e.targetHandle?.startsWith("video-"));
      const count = Math.max(videoEdges.length + 1, 2);
      return [...numberedSlots("video", count, "Video", "video"), h("audio", "audio", "Audio")];
    }
    case "easeCurve":
      return [h("video", "video", "Video In"), h("easeCurve", "easeCurve", "Settings")];
    case "videoTrim":
    case "videoFrameGrab":
      return [h("video", "video", "Video In")];
    case "removeBackground":
    case "imageResize":
      return [h("image", "image", "Image In")];
    case "gifEncoder": {
      let maxIndex = -1;
      for (const edge of incoming(node.id, edges)) {
        const match = edge.targetHandle?.match(/^image-(\d+)$/);
        if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
      }
      return numberedSlots("image", Math.max(maxIndex + 2, 2), "Frame", "image");
    }
    case "router":
      return routerActiveTypes(node.id, edges).map((type) => h(type, type, ROUTER_LABELS[type], type !== "text"));
    case "switch": {
      const type = switchInputType(node, edges);
      return type ? [h(type, type, "In")] : [];
    }
    case "conditionalSwitch":
      return [h("text", "text", "Text")];
    case "glbViewer":
      return [h("3d", "3d", "3D")];
    case "comfyApp":
      return comfyInputHandles(node);
    default:
      return [];
  }
}

/** Output handles the node renders right now. */
export function getOutputHandles(node: GraphNodeLike, edges: readonly GraphEdgeLike[]): NodeHandle[] {
  const h = (id: string, type: AgentHandleType, label: string): NodeHandle => ({ id, type, label, multi: true });
  switch (node.type) {
    case "imageInput":
    case "annotation":
    case "nanoBanana":
    case "glbViewer":
      return [h("image", "image", "Image")];
    case "videoFrameGrab":
    case "removeBackground":
    case "imageResize":
      return [h("image", "image", "Image Out")];
    case "gifEncoder":
      return [h("image", "image", "GIF Out")];
    case "audioInput":
    case "generateAudio":
      return [h("audio", "audio", "Audio")];
    case "videoInput":
    case "generateVideo":
      return [h("video", "video", "Video")];
    case "videoStitch":
      return [h("video", "video", "Output")];
    case "videoTrim":
      return [h("video", "video", "Video Out")];
    case "array":
      return [h("text", "text", "Items")];
    case "prompt":
    case "promptConstructor":
    case "llmGenerate":
      return [h("text", "text", "Text")];
    case "generate3d":
      return [h("3d", "3d", "3D")];
    case "splitGrid":
      return [{ ...h("reference", "reference", "Ref"), internal: true }];
    case "easeCurve":
      return [h("video", "video", "Video Out"), h("easeCurve", "easeCurve", "Settings")];
    case "router":
      return routerActiveTypes(node.id, edges).map((type) => h(type, type, ROUTER_LABELS[type]));
    case "switch": {
      const type = switchInputType(node, edges);
      if (!type) return [];
      return switchEntries(node).map((entry) => ({ ...h(entry.id, type, entry.name), ...(entry.enabled ? {} : { unused: true }) }));
    }
    case "conditionalSwitch":
      return [...conditionalRules(node).map((rule) => h(rule.id, "text", rule.label || rule.id)), h("default", "text", "Fallback")];
    case "comfyApp":
      return comfyOutputs(node).map((o) => h(o.id, o.type as AgentHandleType, o.label || o.id));
    case "output":
    case "outputGallery":
    case "imageCompare":
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Resolving what the model asked for into concrete handles
// ---------------------------------------------------------------------------

const TYPE_ALIASES: Record<string, AgentHandleType> = {
  image: "image",
  images: "image",
  img: "image",
  picture: "image",
  text: "text",
  string: "text",
  video: "video",
  videos: "video",
  audio: "audio",
  sound: "audio",
  "3d": "3d",
  model3d: "3d",
  glb: "3d",
  easecurve: "easeCurve",
  curve: "easeCurve",
};

/** "image", "Images", "3D" → a handle type; anything else → null. */
export function parseTypeName(value: string): AgentHandleType | null {
  return TYPE_ALIASES[normalizeKey(value)] ?? null;
}

function matchByName(handles: readonly NodeHandle[], requested: string): NodeHandle | undefined {
  const exact = handles.find((handle) => handle.id === requested);
  if (exact) return exact;
  const key = normalizeKey(requested);
  return (
    handles.find((handle) => normalizeKey(handle.id) === key) ??
    handles.find((handle) => handle.schemaName !== undefined && normalizeKey(handle.schemaName) === key) ??
    handles.find((handle) => normalizeKey(handle.label) === key)
  );
}

export function describeHandle(handle: NodeHandle, direction: "in" | "out"): string {
  const bits: string[] = [handle.type];
  if (handle.label && normalizeKey(handle.label) !== normalizeKey(handle.id)) bits.push(`"${handle.label}"`);
  if (direction === "in" && handle.multi) bits.push("accepts many");
  if (handle.unused) bits.push(direction === "in" ? "not used by this model" : "switched off");
  return `${handle.id} (${bits.join(", ")})`;
}

export function describeHandles(handles: readonly NodeHandle[], direction: "in" | "out"): string {
  const visible = handles.filter((h) => !h.hidden && !h.internal);
  return visible.length > 0 ? visible.map((h) => describeHandle(h, direction)).join(", ") : "none";
}

/** Whether data of `sourceType` may enter a handle of `targetType` on `targetNodeType`. */
function typesCompatible(sourceType: AgentHandleType, targetType: AgentHandleType): boolean {
  if (sourceType === "reference" || targetType === "reference") return false;
  return sourceType === targetType;
}

export interface ConnectionPlanInput {
  source: GraphNodeLike;
  target: GraphNodeLike;
  /** Handle id, type name, label or schema name, as the model wrote it. */
  fromHandle?: string;
  toHandle?: string;
  nodes: ReadonlyMap<string, GraphNodeLike>;
  edges: readonly GraphEdgeLike[];
}

export type ConnectionPlan =
  | {
      ok: true;
      sourceHandle: NodeHandle;
      targetHandle: NodeHandle;
      /** Edges this connection replaces (the target handle takes one connection). */
      replaces: GraphEdgeLike[];
      /** The identical edge already exists. */
      duplicate?: GraphEdgeLike;
      /** Set on a Switch target: the node's inputType must follow the new input. */
      switchInputType?: HandleType;
    }
  | {
      ok: false;
      error: string;
      /**
       * The source is a router/switch whose output does not exist yet because
       * its input is not connected. Worth retrying after the rest of the batch.
       */
      awaitingInput?: boolean;
    };

/**
 * Picks the concrete source and target handles for "connect A to B", from
 * whatever the model supplied (ids, types, labels, schema names or nothing),
 * and checks the connection is one the canvas would accept.
 */
export function planConnection(input: ConnectionPlanInput): ConnectionPlan {
  const { source, target, nodes, edges } = input;
  const fromHandle = input.fromHandle?.trim() || undefined;
  const toHandle = input.toHandle?.trim() || undefined;
  if (source.id === target.id) {
    return { ok: false, error: `cannot connect ${source.id} to itself.` };
  }

  // --- Source side -------------------------------------------------------
  const outputs = getOutputHandles(source, edges).filter((handle) => !handle.internal);
  if (outputs.length === 0) {
    if (source.type === "router") {
      return { ok: false, awaitingInput: true, error: `${source.id} (Router) has no outputs yet: a router output of type X exists only once an input of type X is connected to it. Connect the router's input first.` };
    }
    if (source.type === "switch") {
      return { ok: false, awaitingInput: true, error: `${source.id} (Switch) has no outputs yet: connect its input first; its outputs take the input's type.` };
    }
    if (source.type === "comfyApp" && !source.data.app) {
      return { ok: false, error: `${source.id} (ComfyUI App) has no workflow attached, so it has no outputs. The user must import a workflow into it first.` };
    }
    if (SINK_TYPES.has(source.type)) {
      const name = SINK_NAMES[source.type];
      return {
        ok: false,
        error: `${source.id} (${name}) is an end node with no outputs; nothing can be connected from it. Connect the node that feeds it (e.g. the generator) straight to ${target.id} instead. One output can feed several nodes, so keep ${source.id} connected and add ${target.id} next to it. Do not remove or disconnect nodes the user did not ask you to.`,
      };
    }
    return { ok: false, error: `${source.id} (${source.type}) has no outputs to connect from. Check describe_node_types for what it outputs.` };
  }

  let sourceCandidates: NodeHandle[] = outputs;
  if (!fromHandle && (source.type === "switch" || source.type === "conditionalSwitch")) {
    // Several outputs of one type: fill the ones nothing is connected to yet.
    const used = (handle: NodeHandle) => edges.some((e) => e.source === source.id && e.sourceHandle === handle.id);
    sourceCandidates = [...outputs].sort((a, b) => Number(used(a) || !!a.unused) - Number(used(b) || !!b.unused));
  }
  if (fromHandle) {
    const named = matchByName(outputs, fromHandle);
    if (named) {
      sourceCandidates = [named];
    } else {
      const type = parseTypeName(fromHandle);
      const ofType = type ? outputs.filter((o) => o.type === type) : [];
      if (ofType.length === 0) {
        if (source.type === "router" && type) {
          return { ok: false, awaitingInput: true, error: `${source.id} (Router) has no ${type} output: connect a ${type} input to it first. Current outputs: ${describeHandles(outputs, "out")}.` };
        }
        return { ok: false, error: `${source.id} (${source.type}) has no output "${fromHandle}". Its outputs: ${describeHandles(outputs, "out")}.` };
      }
      sourceCandidates = ofType;
    }
  }

  // --- Target side -------------------------------------------------------
  if (target.type === "imageInput") {
    return { ok: false, error: `${target.id} (Image Input) takes no connections; its image comes from the user's upload. Connect FROM it instead.` };
  }
  const allInputs = getInputHandles(target, edges).filter((handle) => !handle.internal);
  const isRouter = target.type === "router";
  const isSwitch = target.type === "switch";

  let targetTypeRequest: AgentHandleType | null = null;
  let explicitTarget: NodeHandle | undefined;
  if (toHandle && !((isRouter || isSwitch) && toHandle === "generic-input")) {
    const visible = allInputs.filter((handle) => !handle.hidden);
    explicitTarget = matchByName(visible, toHandle);
    if (!explicitTarget) {
      // A legacy id the node keeps only for old edges ("text" on a Veo node)
      // or a bare type name: pick the right slot of that type below.
      const hidden = allInputs.find((handle) => handle.hidden && handle.id === toHandle);
      targetTypeRequest = hidden ? hidden.type : parseTypeName(toHandle);
      if (!targetTypeRequest) {
        const inputsText = isRouter || isSwitch
          ? `${target.type === "router" ? "Router" : "Switch"} inputs are named by data type: ${DATA_TYPES.join(", ")} (or leave toHandle out)`
          : `Its inputs: ${describeTargetInputs(allInputs)}`;
        return { ok: false, error: `${target.id} (${target.type}) has no input "${toHandle}". ${inputsText}.` };
      }
    }
  }

  // Router and Switch inputs take whatever type arrives.
  if (isRouter || isSwitch) {
    const wanted = explicitTarget?.type ?? targetTypeRequest;
    const candidates = wanted ? sourceCandidates.filter((o) => o.type === wanted) : sourceCandidates;
    const chosen = pickPreferred(candidates.filter((o) => o.type !== "reference"));
    if (!chosen) {
      return { ok: false, error: `${source.id} has no ${wanted} output to connect to ${target.id}. Its outputs: ${describeHandles(outputs, "out")}.` };
    }
    const type = chosen.type as HandleType;
    if (isSwitch) {
      // A loop edge sits next to the forward input (the canvas never replaces it).
      const existing = incoming(target.id, edges).filter((e) => !e.data?.isLoop);
      const currentType = switchInputType(target, edges);
      if (existing.length > 0 && currentType && currentType !== type) {
        return { ok: false, error: `${target.id} (Switch) already routes ${currentType} from ${existing[0].source}. A switch has one input; disconnect it first (its ${currentType} outputs go with it).` };
      }
      const duplicate = incoming(target.id, edges).find((e) => e.source === source.id && e.sourceHandle === chosen.id && e.targetHandle === type);
      return {
        ok: true,
        sourceHandle: chosen,
        targetHandle: { id: type, type, label: "Input", multi: false },
        replaces: duplicate ? [] : existing,
        ...(duplicate ? { duplicate } : {}),
        switchInputType: type,
      };
    }
    const targetHandle: NodeHandle = { id: type, type, label: type, multi: type !== "text" };
    return finishPlan(source, target, chosen, targetHandle, nodes, edges);
  }

  if (allInputs.length === 0) {
    if (target.type === "comfyApp" && !target.data.app) {
      return { ok: false, error: `${target.id} (ComfyUI App) has no workflow attached, so it has no inputs. The user must import a workflow into it first.` };
    }
    return { ok: false, error: `${target.id} (${target.type}) has no inputs; it can only be a source.` };
  }

  if (explicitTarget) {
    const compatible = sourceCandidates.filter((o) => typesCompatible(o.type, explicitTarget!.type));
    const chosen = pickPreferred(compatible);
    if (!chosen) {
      return { ok: false, error: typeMismatchError(source, target, sourceCandidates, explicitTarget) };
    }
    if (explicitTarget.unused) {
      return { ok: false, error: `${target.id} input "${explicitTarget.id}" is not used by the node's current model. ${describeTargetInputs(allInputs)} are the inputs it uses.` };
    }
    if (explicitTarget.numbered) {
      const occupant = occupantsOf(target.id, explicitTarget.id, edges);
      if (occupant.length > 0 && !occupant.some((e) => e.source === source.id && e.sourceHandle === chosen.id)) {
        const free = firstFree(target.id, allInputs.filter((h) => h.numbered), edges);
        return { ok: false, error: `${target.id} input ${explicitTarget.id} already has a connection from ${occupant[0].source}.${free ? ` Use ${free.id} (the next free slot) or leave toHandle out.` : ""}` };
      }
    }
    return finishPlan(source, target, chosen, explicitTarget, nodes, edges);
  }

  // Type-driven choice: the first output type the target can take.
  const usable = allInputs.filter((handle) => !handle.hidden);
  const byPreference = [...sourceCandidates].sort((a, b) => TYPE_PREFERENCE.indexOf(a.type) - TYPE_PREFERENCE.indexOf(b.type));
  if (!fromHandle && !targetTypeRequest && (source.type === "router" || source.type === "comfyApp")) {
    // Several outputs of different types that the target could all take:
    // guessing would silently wire the wrong data.
    const acceptable = new Set(
      byPreference.filter((o) => usable.some((h) => !h.unused && typesCompatible(o.type, h.type))).map((o) => o.type),
    );
    if (acceptable.size > 1) {
      return {
        ok: false,
        error: `${source.id} has several outputs ${target.id} could take (${[...acceptable].join(", ")}); say which with fromHandle. ${source.id} outputs: ${describeHandles(outputs, "out")}.`,
      };
    }
  }
  for (const output of byPreference) {
    if (targetTypeRequest && output.type !== targetTypeRequest) continue;
    const ofType = usable.filter((handle) => typesCompatible(output.type, handle.type));
    if (ofType.length === 0) continue;
    const live = ofType.filter((handle) => !handle.unused);
    if (live.length === 0) {
      return { ok: false, error: `${target.id}'s ${output.type} input is not used by its current model. Inputs it uses: ${describeTargetInputs(allInputs)}.` };
    }
    const chosenTarget = chooseTargetSlot(target, output, live, edges);
    if ("error" in chosenTarget) return { ok: false, error: chosenTarget.error };
    return finishPlan(source, target, output, chosenTarget.handle, nodes, edges);
  }

  const wanted = [...new Set(targetTypeRequest ? [targetTypeRequest] : sourceCandidates.map((o) => o.type))];
  const accepted = [...new Set(usable.filter((h) => !h.unused).map((h) => h.type))];
  const hint = wanted.map((from) => accepted.map((to) => conversionHint(from, to)).find(Boolean)).find(Boolean);
  return {
    ok: false,
    error: `${target.id} (${target.type}) has no input that takes ${wanted.join(" or ")} from ${source.id}. ${target.id} inputs: ${describeTargetInputs(allInputs)}. ${source.id} outputs: ${describeHandles(outputs, "out")}. Types never convert on a connection${hint ? `; ${hint}` : ""}.`,
  };
}

/** The node that turns one data type into another, when there is one. */
export function conversionHint(from: AgentHandleType, to: AgentHandleType): string | undefined {
  const hints: Record<string, string> = {
    "text>image": "to make an image from text, put a Generate Image (nanoBanana) node in between",
    "image>text": "to get text about an image, put an LLM Generate (llmGenerate) node in between (image + instruction prompt)",
    "video>image": "to get an image from a video, put a Frame Grab (videoFrameGrab) node in between",
    "text>video": "to make a video from text, put a Generate Video node in between",
    "image>video": "to animate an image, put a Generate Video node with an image-to-video model in between",
    "text>audio": "to make audio from text, put a Generate Audio node in between",
    "image>3d": "to make a 3D model, put a Generate 3D node in between",
    "text>3d": "to make a 3D model, put a Generate 3D node in between",
    "3d>image": "to get an image of a 3D model, use a 3D Viewer (glbViewer) capture",
  };
  return hints[`${from}>${to}`];
}

function describeTargetInputs(inputs: readonly NodeHandle[]): string {
  const live = inputs.filter((h) => !h.unused);
  return describeHandles(live.length > 0 ? live : inputs, "in");
}

function pickPreferred(handles: readonly NodeHandle[]): NodeHandle | undefined {
  return [...handles].sort((a, b) => TYPE_PREFERENCE.indexOf(a.type) - TYPE_PREFERENCE.indexOf(b.type))[0];
}

function typeMismatchError(source: GraphNodeLike, target: GraphNodeLike, outputs: readonly NodeHandle[], input: NodeHandle): string {
  const have = [...new Set(outputs.map((o) => o.type))].join("/");
  return `type mismatch: ${source.id} outputs ${have} but ${target.id} input "${input.id}" takes ${input.type}. Connections must join the same type; there is no automatic conversion.`;
}

/** Every edge ending on this handle, loop edges included. */
function edgesInto(nodeId: string, handleId: string, edges: readonly GraphEdgeLike[]): GraphEdgeLike[] {
  return edges.filter((e) => e.target === nodeId && e.targetHandle === handleId);
}

/**
 * The forward connections that fill a handle. A loop edge does not occupy its
 * input: the canvas keeps it next to the forward edge, the executor ignores it
 * for inputs, and a new forward connection never replaces it.
 */
function occupantsOf(nodeId: string, handleId: string, edges: readonly GraphEdgeLike[]): GraphEdgeLike[] {
  return edgesInto(nodeId, handleId, edges).filter((e) => !e.data?.isLoop);
}

function firstFree(nodeId: string, handles: readonly NodeHandle[], edges: readonly GraphEdgeLike[]): NodeHandle | undefined {
  return handles.find((handle) => occupantsOf(nodeId, handle.id, edges).length === 0);
}

/** Among target inputs of the right type, the one a new connection should use. */
function chooseTargetSlot(
  target: GraphNodeLike,
  output: NodeHandle,
  candidates: readonly NodeHandle[],
  edges: readonly GraphEdgeLike[],
): { handle: NodeHandle } | { error: string } {
  // A handle that collects many connections is always fine.
  const multi = candidates.find((handle) => handle.multi);
  if (multi) return { handle: multi };
  if (candidates.length === 1) return { handle: candidates[0] };
  // Several single slots of this type: text goes to the first (the main
  // prompt), replacing what is there; media fills the next free slot.
  if (output.type === "text") return { handle: candidates[0] };
  const free = firstFree(target.id, candidates, edges);
  if (free) return { handle: free };
  const taken = candidates.map((handle) => `${handle.id} ← ${occupantsOf(target.id, handle.id, edges)[0]?.source}`).join(", ");
  return { error: `every ${output.type} input of ${target.id} is taken (${taken}). Disconnect one first, or name the input to replace with toHandle.` };
}

function finishPlan(
  source: GraphNodeLike,
  target: GraphNodeLike,
  sourceHandle: NodeHandle,
  targetHandle: NodeHandle,
  nodes: ReadonlyMap<string, GraphNodeLike>,
  edges: readonly GraphEdgeLike[],
): ConnectionPlan {
  const connection = { source: source.id, sourceHandle: sourceHandle.id, target: target.id, targetHandle: targetHandle.id };
  if (!isValidConnectionPort(connection, nodes)) {
    return {
      ok: false,
      error: `the canvas does not allow ${sourceHandle.type} from ${source.id} (${source.type}) into ${target.id} (${target.type}) input "${targetHandle.id}".`,
    };
  }
  // Edge ids ignore loop status, so a loop edge with the same handles is a duplicate too.
  const duplicate = edgesInto(target.id, targetHandle.id, edges).find((e) => e.source === source.id && e.sourceHandle === sourceHandle.id);
  if (duplicate) return { ok: true, sourceHandle, targetHandle, replaces: [], duplicate };
  return { ok: true, sourceHandle, targetHandle, replaces: targetHandle.multi ? [] : occupantsOf(target.id, targetHandle.id, edges) };
}

/**
 * How an existing edge stands against the handles its endpoints render now:
 * - "live": both handles exist (and a Switch output carries the input's type);
 * - "dormant": the source is a Router or Switch whose output only exists while
 *   an input of that type is connected, and none is right now. The canvas
 *   keeps such edges and they carry data again once the input comes back;
 * - "mistyped": a Switch output whose type changed under it (it now routes a
 *   type the target handle does not take);
 * - "missing": a handle is gone (a deleted switch output or rule, a model
 *   change that removed an input, …).
 */
export type EdgeState = "live" | "dormant" | "mistyped" | "missing";

export function edgeState(edge: GraphEdgeLike, nodes: ReadonlyMap<string, GraphNodeLike>, edges: readonly GraphEdgeLike[]): EdgeState {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return "missing";
  const numberedTarget = target.type === "videoStitch" || target.type === "gifEncoder";
  const genericTarget = target.type === "switch" && edge.targetHandle === "generic-input";
  const input = numberedTarget || genericTarget ? undefined : getInputHandles(target, edges).find((h) => h.id === edge.targetHandle);
  if (!numberedTarget && !genericTarget && !input) return "missing";

  if (source.type === "switch") {
    if (!switchEntries(source).some((entry) => entry.id === edge.sourceHandle)) return "missing";
    const type = switchInputType(source, edges);
    if (!type) return "dormant";
    const targetType = input?.type ?? getHandleType(edge.targetHandle);
    return targetType && targetType !== type ? "mistyped" : "live";
  }
  if (source.type === "router") {
    if (!edge.sourceHandle || !(DATA_TYPES as readonly string[]).includes(edge.sourceHandle)) return "missing";
    return routerActiveTypes(source.id, edges).includes(edge.sourceHandle as HandleType) ? "live" : "dormant";
  }
  // Numbered stitch/GIF slots are not checked: their count follows the edges themselves.
  if (numberedTarget) return "live";
  return getOutputHandles(source, edges).some((handle) => handle.id === edge.sourceHandle) ? "live" : "missing";
}

/**
 * Whether an existing edge still lands on handles its endpoints render. Numbered
 * stitch/GIF slots are not checked: their count follows the edges themselves.
 */
export function edgeHandlesExist(edge: GraphEdgeLike, nodes: ReadonlyMap<string, GraphNodeLike>, edges: readonly GraphEdgeLike[]): boolean {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return false;
  if (target.type === "videoStitch" || target.type === "gifEncoder") return true;
  const outputs = getOutputHandles(source, edges);
  if (!outputs.some((handle) => handle.id === edge.sourceHandle)) return false;
  if (target.type === "switch" && edge.targetHandle === "generic-input") return true;
  const inputs = getInputHandles(target, edges);
  return inputs.some((handle) => handle.id === edge.targetHandle);
}

/** The data type an edge carries, from its source handle. */
export function edgeDataType(edge: GraphEdgeLike, nodes: ReadonlyMap<string, GraphNodeLike>, edges: readonly GraphEdgeLike[]): AgentHandleType | null {
  const source = nodes.get(edge.source);
  if (!source) return getHandleType(edge.sourceHandle);
  const handle = getOutputHandles(source, edges).find((h) => h.id === edge.sourceHandle);
  return handle?.type ?? getHandleType(edge.sourceHandle);
}

/** Edge id in the store's format (`onConnect`). */
export function edgeIdFor(source: string, sourceHandle: string | null, target: string, targetHandle: string | null): string {
  return `edge-${source}-${target}-${sourceHandle || "default"}-${targetHandle || "default"}`;
}
