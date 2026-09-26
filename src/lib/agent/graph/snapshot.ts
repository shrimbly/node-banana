/**
 * Browser side: the compact, media-free picture of the canvas sent with every
 * agent turn.
 *
 * Settings and the structure handles depend on are whitelisted per node type
 * (catalog `dataFields`); what a node holds is reduced to `content` flags;
 * long text is capped with a visible marker. A final pass replaces any
 * data:/blob:/base64 string that slipped through, anywhere in the result.
 */

import type { NodeType, WorkflowNode } from "@/types";
import type { WorkflowEdge, NodeGroup } from "@/types/workflow";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { estimatedNodeHeight } from "./sizes";
import { getNodeSize } from "@/utils/nodeDimensions";
import type { AgentSnapshotEdge, AgentSnapshotGroup, AgentSnapshotNode, AgentWorkflowSnapshot } from "../types";
import { isNodeType } from "./catalog";
import { pickAgentData } from "./nodeData";
import { capText, stripMedia } from "./scrub";

export interface BuildAgentSnapshotInput {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
  /** Visible area in flow coordinates. */
  viewport?: AgentWorkflowSnapshot["viewport"];
  workflowName?: string;
  /**
   * The store's createDefaultNodeData, which applies the user's saved model
   * and settings. When given, the snapshot carries those defaults for the
   * node types that have them, so the server's draft starts new nodes the
   * way this browser will.
   */
  createDefaultNodeData?: (type: NodeType) => unknown;
}

/** Node types whose new-node data follows the user's saved defaults (see nodeDefaults.ts). */
export const STICKY_DEFAULT_NODE_TYPES: readonly NodeType[] = [
  "nanoBanana",
  "generateVideo",
  "generate3d",
  "generateAudio",
  "llmGenerate",
];

const OUTPUT_TEXT_LIMIT = 2000;
const ERROR_LIMIT = 300;

/** Browser-side: turns live store state into the compact, media-free snapshot sent each turn. */
export function buildAgentSnapshot(input: BuildAgentSnapshotInput): AgentWorkflowSnapshot {
  const nodes: AgentSnapshotNode[] = [];
  for (const node of input.nodes ?? []) {
    if (!node || typeof node.id !== "string" || !isNodeType(node.type)) continue;
    nodes.push(snapshotNode(node));
  }
  const ids = new Set(nodes.map((n) => n.id));
  const edges: AgentSnapshotEdge[] = (input.edges ?? [])
    .filter((e) => e && ids.has(e.source) && ids.has(e.target))
    .map((e) => {
      const data: NonNullable<AgentSnapshotEdge["data"]> = {};
      if (e.data?.isLoop) data.isLoop = true;
      if (e.data?.hasPause) data.hasPause = true;
      const index = (e.data as { arrayItemIndex?: unknown } | undefined)?.arrayItemIndex;
      if (typeof index === "number" && Number.isInteger(index)) data.arrayItemIndex = index;
      const loopCount = (e.data as { loopCount?: unknown } | undefined)?.loopCount;
      if (data.isLoop && typeof loopCount === "number" && Number.isFinite(loopCount)) data.loopCount = loopCount;
      return {
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? null,
        target: e.target,
        targetHandle: e.targetHandle ?? null,
        ...(Object.keys(data).length > 0 ? { data } : {}),
      };
    });
  // The box and lock state too: arranging and placing nodes must respect them.
  const groups: AgentSnapshotGroup[] = Object.values(input.groups ?? {})
    .filter((g) => g && typeof g.id === "string")
    .map((g) => ({
      id: g.id,
      name: g.name,
      ...(g.color ? { color: g.color } : {}),
      ...(g.position && g.size
        ? {
            position: { x: round(g.position.x), y: round(g.position.y) },
            size: { width: round(g.size.width), height: round(g.size.height) },
          }
        : {}),
      ...(g.locked ? { locked: true } : {}),
    }));
  const selectedNodeIds = (input.nodes ?? []).filter((n) => n?.selected && ids.has(n.id)).map((n) => n.id);

  const snapshot: AgentWorkflowSnapshot = {
    nodes,
    edges,
    groups,
    selectedNodeIds,
    ...(validViewport(input.viewport) ? { viewport: roundViewport(input.viewport!) } : {}),
    ...(input.workflowName ? { workflowName: input.workflowName } : {}),
  };
  const nodeDefaults = stickyDefaults(input.createDefaultNodeData);
  if (nodeDefaults) snapshot.nodeDefaults = nodeDefaults;
  return stripMedia(snapshot);
}

/** New-node defaults per sticky type, whitelisted like node data. Never throws: a broken default is left out. */
function stickyDefaults(create: BuildAgentSnapshotInput["createDefaultNodeData"]): AgentWorkflowSnapshot["nodeDefaults"] {
  if (!create) return undefined;
  const out: NonNullable<AgentWorkflowSnapshot["nodeDefaults"]> = {};
  for (const type of STICKY_DEFAULT_NODE_TYPES) {
    try {
      const data = create(type);
      if (!data || typeof data !== "object") continue;
      const picked = pickAgentData(type, data as Record<string, unknown>);
      if (Object.keys(picked).length > 0) out[type] = picked;
    } catch {
      // Unreadable saved defaults: the server falls back to the built-in ones.
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function snapshotNode(node: WorkflowNode): AgentSnapshotNode {
  const type = node.type as NodeType;
  const data = (node.data ?? {}) as Record<string, unknown>;
  const size = nodeSize(node);
  const content = contentOf(type, data);
  const status = typeof data.status === "string" && data.status !== "idle" ? data.status : undefined;
  const error = typeof data.error === "string" && data.error ? capText(data.error, ERROR_LIMIT) : undefined;
  return {
    id: node.id,
    type,
    position: { x: round(node.position?.x), y: round(node.position?.y) },
    width: size.width,
    height: size.height,
    ...(typeof data.customTitle === "string" && data.customTitle ? { title: data.customTitle } : {}),
    ...(node.groupId ? { groupId: node.groupId } : {}),
    data: pickAgentData(type, data),
    ...(content ? { content } : {}),
    ...(status ? { status } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * The size the node occupies on the canvas: the width it was given (as the
 * canvas's own `getNodeSize` reads it) and the height React Flow measured
 * from its content. Nodes are width-driven and their height is never stored,
 * so a node not yet measured gets its type's rendered-height estimate.
 */
function nodeSize(node: WorkflowNode): { width: number; height: number } {
  const type = node.type as NodeType;
  const fallbackWidth = defaultNodeDimensions[type]?.width ?? 300;
  const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined);
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : undefined;
  return {
    width: positive(getNodeSize(node).width) ?? fallbackWidth,
    height: positive(node.measured?.height ?? node.height ?? styleHeight) ?? estimatedNodeHeight(type),
  };
}

function present(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return false;
}

/** What the node holds right now, without the bytes. */
export function contentOf(type: NodeType, data: Record<string, unknown>): AgentSnapshotNode["content"] | undefined {
  const any = (...keys: string[]) => keys.some((key) => present(data[key]));
  const content: NonNullable<AgentSnapshotNode["content"]> = {};
  const text = (value: unknown) => {
    if (typeof value === "string" && value.trim()) content.text = capText(value, OUTPUT_TEXT_LIMIT);
  };
  switch (type) {
    case "imageInput":
      if (any("image", "imageRef")) content.image = true;
      break;
    case "audioInput":
      if (any("audioFile", "audioFileRef")) content.audio = true;
      break;
    case "videoInput":
      if (any("video", "videoRef")) content.video = true;
      break;
    case "annotation":
      if (any("outputImage", "outputImageRef", "sourceImage", "sourceImageRef")) content.image = true;
      break;
    case "nanoBanana":
    case "videoFrameGrab":
    case "removeBackground":
    case "imageResize":
      if (any("outputImage", "outputImageRef")) content.image = true;
      break;
    case "generateVideo":
      if (any("outputVideo", "outputVideoRef")) content.video = true;
      break;
    case "videoStitch":
    case "easeCurve":
    case "videoTrim":
      if (any("outputVideo")) content.video = true;
      break;
    case "generate3d":
      if (any("output3dUrl")) content.model3d = true;
      break;
    case "generateAudio":
      if (any("outputAudio", "outputAudioRef")) content.audio = true;
      break;
    case "llmGenerate":
      text(data.outputText);
      break;
    case "promptConstructor":
      if (data.outputText !== data.template) text(data.outputText);
      break;
    case "splitGrid":
      if (any("sourceImage", "sourceImageRef")) content.image = true;
      break;
    case "output":
      if (any("image", "imageRef")) content.image = true;
      if (any("video")) content.video = true;
      if (any("audio")) content.audio = true;
      break;
    case "outputGallery":
      if (any("images", "imageRefs")) content.image = true;
      if (any("videos", "videoRefs")) content.video = true;
      break;
    case "imageCompare":
      if (any("imageA", "imageB", "imageARef", "imageBRef")) content.image = true;
      break;
    case "gifEncoder":
      if (any("outputGif")) content.image = true;
      break;
    case "glbViewer":
      if (any("glbUrl")) content.model3d = true;
      if (any("capturedImage", "capturedImageRef")) content.image = true;
      break;
    case "comfyApp": {
      if (any("outputImage")) content.image = true;
      if (any("outputVideo")) content.video = true;
      if (any("outputAudio")) content.audio = true;
      if (any("output3dUrl")) content.model3d = true;
      text(data.outputText);
      break;
    }
    default:
      break;
  }
  return Object.keys(content).length > 0 ? content : undefined;
}

function validViewport(viewport: AgentWorkflowSnapshot["viewport"] | undefined): boolean {
  return (
    !!viewport &&
    [viewport.x, viewport.y, viewport.width, viewport.height, viewport.zoom].every((v) => typeof v === "number" && Number.isFinite(v)) &&
    viewport.width > 0 &&
    viewport.height > 0
  );
}

function roundViewport(viewport: NonNullable<AgentWorkflowSnapshot["viewport"]>): NonNullable<AgentWorkflowSnapshot["viewport"]> {
  return {
    x: round(viewport.x),
    y: round(viewport.y),
    width: round(viewport.width),
    height: round(viewport.height),
    zoom: Math.round(viewport.zoom * 1000) / 1000,
  };
}

function round(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}
