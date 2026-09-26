/**
 * Plain-text views of the canvas and the catalog for the model: compact
 * enough for every turn, precise enough to act on (ids, handle ids, types).
 */

import type { NodeType } from "@/types";
import {
  getImageModel,
  IMAGE_MODELS,
  LLM_PROVIDERS,
  NODE_CATALOG,
  NODE_TYPES,
  VIDEO_MODELS,
  getSettings,
  type CatalogPort,
  type CatalogSetting,
} from "./catalog";
import { describeHandle, edgeState, getInputHandles, getOutputHandles, type GraphEdgeLike } from "./handles";
import type { DraftGroup, DraftNode } from "./draft";
import { capText, fullTextLength, isTruncatedText } from "./scrub";

export interface DescribableGraph {
  nodes: ReadonlyMap<string, DraftNode>;
  edges: readonly GraphEdgeLike[];
  groups: ReadonlyArray<DraftGroup>;
  selectedNodeIds: readonly string[];
  workflowName?: string;
}

export interface DescribeOptions {
  /** Only these nodes (plus the connections touching them). */
  nodeIds?: string[];
  detail?: "summary" | "full";
  /** Truncate after this many nodes (summary only). */
  maxNodes?: number;
  /** Characters of prompt text shown per node in summary mode. */
  textPreview?: number;
}

const DEFAULT_TEXT_PREVIEW = 400;
/** Prompt and template text in get_workflow detail "full"; longer text is cut with a marker. */
export const FULL_VIEW_TEXT_LIMIT = 20_000;
/** ComfyUI combo options listed in detail "full" (the draft validates against all of them). */
const ENUM_PREVIEW = 30;

/** The canvas as text: nodes with key settings, connections, groups, selection. */
export function describeWorkflow(graph: DescribableGraph, options: DescribeOptions = {}): string {
  const detail = options.detail ?? "summary";
  const all = [...graph.nodes.values()];
  if (all.length === 0) return "The canvas is empty.";

  const wanted = options.nodeIds?.length ? new Set(options.nodeIds) : null;
  const missing = wanted ? [...wanted].filter((id) => !graph.nodes.has(id)) : [];
  let nodes = wanted ? all.filter((n) => wanted.has(n.id)) : all;
  const total = nodes.length;
  const limit = options.maxNodes ?? Infinity;
  const truncated = nodes.length > limit;
  if (truncated) nodes = prioritize(nodes, graph).slice(0, limit);
  const shown = new Set(nodes.map((n) => n.id));

  const lines: string[] = [];
  const heading = `${graph.workflowName ? `Workflow "${graph.workflowName}": ` : ""}${all.length} node${all.length === 1 ? "" : "s"}, ${graph.edges.length} connection${graph.edges.length === 1 ? "" : "s"}.`;
  lines.push(heading);
  if (graph.selectedNodeIds.length > 0) lines.push(`Selected by the user: ${graph.selectedNodeIds.join(", ")}.`);
  if (missing.length > 0) lines.push(`Not on the canvas: ${missing.join(", ")}.`);

  lines.push("Nodes:");
  for (const node of nodes) {
    lines.push(`- ${nodeLine(node, options.textPreview ?? DEFAULT_TEXT_PREVIEW)}`);
    if (detail === "full") lines.push(...fullNodeDetail(node, graph));
  }
  if (truncated) {
    lines.push(`… ${total - nodes.length} more nodes not shown. Call get_workflow with nodeIds for details.`);
  }

  const edges = graph.edges.filter((e) => shown.has(e.source) || shown.has(e.target));
  if (edges.length > 0 && detail === "summary") {
    lines.push("Connections:");
    for (const edge of edges) {
      const dormant = edgeState(edge, graph.nodes, graph.edges) === "dormant";
      lines.push(`- ${edgeLine(edge)}${dormant ? " (inactive: its source has no input of that type right now)" : ""}`);
    }
  } else if (edges.length === 0) {
    lines.push("Connections: none.");
  }

  if (graph.groups.length > 0) {
    lines.push("Groups (a node belongs to the group whose box holds its centre; a locked group's nodes do not run):");
    for (const group of graph.groups) {
      const members = all.filter((n) => n.groupId === group.id).map((n) => n.id);
      const box = group.position && group.size
        ? ` box (${Math.round(group.position.x)}, ${Math.round(group.position.y)}) ${Math.round(group.size.width)}×${Math.round(group.size.height)}`
        : "";
      lines.push(`- ${group.name} [${group.id}]${group.color ? ` ${group.color}` : ""}${group.locked ? " locked" : ""}${box}${members.length ? `: ${members.join(", ")}` : ": no nodes"}`);
    }
  }
  return lines.join("\n");
}

function prioritize(nodes: DraftNode[], graph: DescribableGraph): DraftNode[] {
  const selected = new Set(graph.selectedNodeIds);
  return [...nodes].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));
}

export function edgeLine(edge: GraphEdgeLike): string {
  const extras: string[] = [];
  if (typeof edge.data?.arrayItemIndex === "number") extras.push(`item ${edge.data.arrayItemIndex}`);
  if (edge.data?.isLoop) extras.push(typeof edge.data.loopCount === "number" ? `loop ×${edge.data.loopCount}` : "loop");
  if (edge.data?.hasPause) extras.push("paused");
  return `${edge.source}.${edge.sourceHandle ?? "default"} → ${edge.target}.${edge.targetHandle ?? "default"}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}

/** One line: id, type, title, key settings, content and status. */
export function nodeLine(node: DraftNode, textPreview = DEFAULT_TEXT_PREVIEW): string {
  const entry = NODE_CATALOG[node.type];
  const title = typeof node.data.customTitle === "string" && node.data.customTitle ? ` "${node.data.customTitle}"` : "";
  const parts = [`${node.id} ${node.type} (${entry.displayName})${title}`];
  const settings = keySettings(node, textPreview);
  if (settings) parts.push(settings);
  const content = contentText(node);
  if (content) parts.push(content);
  // "complete" adds nothing the content flags do not say; errors and runs in flight do.
  if (node.status && node.status !== "idle" && node.status !== "complete") {
    parts.push(`status ${node.status}${node.error ? `: ${oneLine(node.error, 200)}` : ""}`);
  }
  return parts.join(" — ");
}

function fullNodeDetail(node: DraftNode, graph: DescribableGraph): string[] {
  const lines: string[] = [];
  lines.push(`  at (${Math.round(node.position.x)}, ${Math.round(node.position.y)}), ${node.width}×${node.height}${node.groupId ? `, group ${node.groupId}` : ""}`);
  const data = displayData(node);
  if (Object.keys(data).length > 0) lines.push(`  data: ${JSON.stringify(data)}`);
  const inputs = getInputHandles(node, graph.edges).filter((h) => !h.hidden && !h.internal);
  const outputs = getOutputHandles(node, graph.edges).filter((h) => !h.internal);
  if (inputs.length > 0) {
    lines.push(`  inputs: ${inputs.map((h) => {
      const from = graph.edges.filter((e) => e.target === node.id && e.targetHandle === h.id).map((e) => `${e.source}.${e.sourceHandle}`);
      return `${describeHandle(h, "in")}${from.length ? ` ← ${from.join(", ")}` : ""}`;
    }).join("; ")}`);
  } else if (node.type === "router" || node.type === "switch") {
    lines.push("  inputs: any type (connect to it without toHandle)");
  }
  if (outputs.length > 0) {
    lines.push(`  outputs: ${outputs.map((h) => {
      const to = graph.edges.filter((e) => e.source === node.id && e.sourceHandle === h.id).map((e) => `${e.target}.${e.targetHandle}`);
      return `${describeHandle(h, "out")}${to.length ? ` → ${to.join(", ")}` : ""}`;
    }).join("; ")}`);
  }
  return lines;
}

/**
 * Node data for detail "full": everything, except that very long prompt text
 * is cut (with a marker; the draft still holds all of it) and ComfyUI option
 * lists show their start and their size.
 */
function displayData(node: DraftNode): Record<string, unknown> {
  const data: Record<string, unknown> = { ...node.data };
  delete data.customTitle;
  for (const field of ["prompt", "template"]) {
    const value = data[field];
    if (typeof value === "string" && !isTruncatedText(value) && value.length > FULL_VIEW_TEXT_LIMIT) data[field] = capText(value, FULL_VIEW_TEXT_LIMIT);
  }
  const app = data.app as { params?: unknown } | null | undefined;
  if (app && Array.isArray(app.params) && app.params.some((p) => Array.isArray((p as { enum?: unknown })?.enum) && (p as { enum: unknown[] }).enum.length > ENUM_PREVIEW)) {
    data.app = {
      ...app,
      params: app.params.map((p) => {
        const options = (p as { enum?: unknown })?.enum;
        if (!Array.isArray(options) || options.length <= ENUM_PREVIEW) return p;
        return { ...(p as Record<string, unknown>), enum: [...options.slice(0, ENUM_PREVIEW), `… ${options.length - ENUM_PREVIEW} more (${options.length} options; any of them can be set)`] };
      }),
    };
  }
  return data;
}

/** `prompt: "…"`, saying how long the text is when only its start is shown. */
function textSetting(label: string, text: string, max: number): string {
  const total = fullTextLength(text);
  if (total <= max && !isTruncatedText(text)) return `${label}: ${JSON.stringify(text)}`;
  return `${label} (${total} characters; only the first ${max} shown): ${JSON.stringify(`${text.slice(0, max)}…`)}`;
}

function keySettings(node: DraftNode, textPreview: number): string {
  const d = node.data;
  const bits: string[] = [];
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const model = d.selectedModel as { provider?: string; modelId?: string; displayName?: string } | undefined;
  switch (node.type) {
    case "prompt":
      bits.push(textSetting("prompt", str(d.prompt) ?? "", textPreview));
      if (str(d.variableName)) bits.push(`variableName @${d.variableName}`);
      if (d.isOptional) bits.push("optional");
      break;
    case "array": {
      const mode = str(d.splitMode) ?? "delimiter";
      bits.push(mode === "delimiter" ? `split by ${JSON.stringify(str(d.delimiter) ?? "*")}` : mode === "regex" ? `split by /${str(d.regexPattern) ?? ""}/` : "split by newline");
      if (d.batchMode) bits.push("batchMode");
      if (Array.isArray(d.outputItems) && d.outputItems.length > 0) {
        const count = typeof d.outputItemCount === "number" ? d.outputItemCount : d.outputItems.length;
        bits.push(`${count} items: ${d.outputItems.slice(0, 8).map((i) => quote(String(i), 40)).join(", ")}${count > 8 ? ", …" : ""}`);
      }
      break;
    }
    case "promptConstructor":
      bits.push(textSetting("template", str(d.template) ?? "", textPreview));
      break;
    case "nanoBanana": {
      if (model && model.provider && model.provider !== "gemini") {
        bits.push(`model ${model.displayName || model.modelId || "not chosen"} (${model.provider})`);
      } else {
        const id = model?.modelId || str(d.model);
        const spec = getImageModel(id);
        bits.push(`model ${id ?? "default"}`);
        if (str(d.aspectRatio)) bits.push(`aspectRatio ${d.aspectRatio}`);
        if (spec && spec.resolutions.length > 0 && str(d.resolution)) bits.push(`resolution ${d.resolution}`);
        if (d.useGoogleSearch) bits.push("Google Search");
        if (d.useImageSearch) bits.push("image search");
      }
      break;
    }
    case "generateVideo":
    case "generate3d":
    case "generateAudio": {
      bits.push(model?.modelId ? `model ${model.modelId}${model.provider ? ` (${model.provider})` : ""}` : "no model chosen");
      const params = d.parameters as Record<string, unknown> | undefined;
      if (params && typeof params === "object") {
        const shown = Object.entries(params).filter(([, v]) => typeof v !== "object").slice(0, 6);
        if (shown.length > 0) bits.push(shown.map(([k, v]) => `${k} ${String(v)}`).join(", "));
      }
      break;
    }
    case "llmGenerate":
      bits.push(`${str(d.provider) ?? "google"} ${str(d.model) ?? ""}`.trim());
      if (typeof d.temperature === "number") bits.push(`temperature ${d.temperature}`);
      break;
    case "splitGrid":
      bits.push(`${d.gridRows ?? 2}×${d.gridCols ?? 3} grid`);
      break;
    case "output":
      if (str(d.outputFilename)) bits.push(`filename ${JSON.stringify(d.outputFilename)}`);
      break;
    case "videoStitch":
      if (typeof d.loopCount === "number" && d.loopCount > 1) bits.push(`loops ×${d.loopCount}`);
      break;
    case "easeCurve":
      bits.push(`${str(d.easingPreset) ?? "custom curve"}, ${d.outputDuration ?? 1.5}s`);
      break;
    case "videoTrim":
      bits.push(`${d.startTime ?? 0}s → ${d.endTime ? `${d.endTime}s` : "end"}`);
      break;
    case "videoFrameGrab":
      bits.push(`${str(d.framePosition) ?? "first"} frame`);
      break;
    case "removeBackground":
      bits.push(`model ${str(d.model) ?? "isnet_fp16"}`);
      break;
    case "imageResize": {
      const mode = str(d.mode) ?? "exact";
      bits.push(mode === "exact" ? `exact ${d.width}×${d.height} ${str(d.fit) ?? "contain"}` : mode === "maxEdge" ? `max edge ${d.maxEdge}` : `scale ${d.scalePct}%`);
      if (str(d.format) && d.format !== "keep") bits.push(String(d.format));
      break;
    }
    case "gifEncoder":
      bits.push(`${d.fps ?? 8} fps`);
      break;
    case "switch": {
      const switches = Array.isArray(d.switches) ? (d.switches as Array<{ id: string; name: string; enabled: boolean }>) : [];
      const type = str(d.inputType);
      bits.push(`${type ? `routes ${type}` : "no input"}; outputs ${switches.map((s) => `"${s.name}" [${s.id}]${s.enabled ? "" : " off"}`).join(", ")}`);
      break;
    }
    case "conditionalSwitch": {
      const rules = Array.isArray(d.rules) ? (d.rules as Array<{ id: string; label: string; value: string; mode: string }>) : [];
      bits.push(`rules ${rules.map((r) => `"${r.label}" [${r.id}] ${r.mode} ${JSON.stringify(r.value)}`).join("; ") || "none"}; default`);
      if (d.evaluationPaused) bits.push("paused");
      break;
    }
    case "comfyApp": {
      const app = d.app as { name?: string; params?: Array<{ id: string; label?: string }>; outputs?: Array<{ id: string; label?: string; type: string }> } | null | undefined;
      if (!app) bits.push("no workflow attached");
      else {
        bits.push(`app ${JSON.stringify(app.name ?? "ComfyUI workflow")}`);
        if (app.params?.length) bits.push(`params ${app.params.map((p) => p.label || p.id).slice(0, 8).join(", ")}`);
      }
      break;
    }
    default:
      break;
  }
  if (node.type === "imageInput" || node.type === "audioInput") {
    if (d.isOptional) bits.push("optional");
  }
  if (str(d.comment)) bits.push(`comment ${quote(String(d.comment), 120)}`);
  return bits.join(", ");
}

function contentText(node: DraftNode): string {
  const c = node.content;
  if (!c) {
    if (node.type === "imageInput") return "empty (no image uploaded)";
    return "";
  }
  const bits: string[] = [];
  if (c.image) bits.push("has image");
  if (c.video) bits.push("has video");
  if (c.audio) bits.push("has audio");
  if (c.model3d) bits.push("has 3D model");
  if (c.text) bits.push(`output text: ${quote(c.text, 300)}`);
  if (bits.length === 0 && node.type === "imageInput") return "empty (no image uploaded)";
  return bits.join(", ");
}

function quote(text: string, max: number): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}…` : text);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------------------
// Catalog views
// ---------------------------------------------------------------------------

function portText(port: CatalogPort): string {
  const bits: string[] = [port.type];
  if (port.multi) bits.push("accepts many");
  if (port.note) bits.push(port.note);
  return `${port.id} (${bits.join("; ")})`;
}

function settingText(setting: CatalogSetting): string {
  let range = "";
  if (setting.values) range = ` one of ${setting.values.length > 16 ? `${setting.values.slice(0, 16).join(" | ")} | … (${setting.values.length} total)` : setting.values.join(" | ")}`;
  else if (setting.min !== undefined || setting.max !== undefined) range = ` ${setting.kind} ${setting.min ?? "…"}-${setting.max ?? "…"}`;
  else range = ` ${setting.kind}`;
  return `${setting.field}:${range}. ${setting.description}${setting.default ? ` Default: ${setting.default}.` : ""}`;
}

/** Handles, settings and notes for the given node types (all when empty). */
export function describeNodeTypes(types?: NodeType[]): string {
  const list = types && types.length > 0 ? types : NODE_TYPES;
  const blocks = list.map((type) => {
    const entry = NODE_CATALOG[type];
    const lines = [`## ${type} — ${entry.displayName}${entry.agentCreatable ? "" : " (cannot be added by the agent)"}`, entry.purpose];
    lines.push(`Inputs: ${entry.inputs.length ? entry.inputs.filter((p) => p.type !== "reference").map(portText).join(", ") || "none" : "none"}`);
    lines.push(`Outputs: ${entry.outputs.length ? entry.outputs.filter((p) => p.type !== "reference").map(portText).join(", ") || "none" : "none"}`);
    const settings = getSettings(type);
    lines.push(`Settings:${settings.map((s) => `\n  - ${settingText(s)}`).join("")}`);
    if (entry.notes.length > 0) lines.push(`Notes: ${entry.notes.join(" ")}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}

/**
 * One line per type, for the system prompt: purpose, handles and the names of
 * the settings (with a hint where the name alone would mislead), so simple
 * edits need no lookup. Allowed values stay in describe_node_types.
 */
export function compactCatalog(): string {
  return NODE_TYPES.map((type) => {
    const entry = NODE_CATALOG[type];
    const ports = (list: CatalogPort[]) => list.filter((p) => p.type !== "reference").map((p) => `${p.id}:${p.type}${p.multi ? "*" : ""}`).join(" ") || "-";
    const settings = getSettings(type).filter((s) => s.field !== "comment").map((s) => (s.hint ? `${s.field}(${s.hint})` : s.field));
    const set = settings.length > 0 ? ` set{${settings.join(", ")}}` : "";
    return `- ${type} (${entry.displayName}): ${entry.purpose} in[${ports(entry.inputs)}] out[${ports(entry.outputs)}]${set}${entry.agentCreatable ? "" : " [not creatable]"}`;
  }).join("\n");
}

/** Models the agent can set, per kind. */
export function describeModels(kind?: "image" | "video" | "llm"): string {
  const sections: string[] = [];
  if (!kind || kind === "image") {
    sections.push(
      [
        "Image models (Generate Image `model`; Gemini API key):",
        ...IMAGE_MODELS.map((m) => `- ${m.id} (${m.label}): ${m.note} Aspect ratios: ${m.aspectRatios.join(", ")}.${m.resolutions.length ? ` Resolutions: ${m.resolutions.join(", ")}.` : ""}`),
        "Models from fal, Replicate, Kie, OpenAI or ComfyUI cannot be set by you: add the node and tell the user to pick one in it.",
      ].join("\n"),
    );
  }
  if (!kind || kind === "video") {
    sections.push(
      [
        "Video models (Generate Video `model`; Gemini API key):",
        ...VIDEO_MODELS.map((m) => `- ${m.id} (${m.label}, ${m.mode === "any" ? "text, images, video and audio" : m.mode}): ${m.note} Settings: ${Object.entries(m.parameters).map(([field, values]) => `${field} ${values.join("|")}`).join(", ")}.`),
        "Other providers' video models (Kling, Sora, Seedance…) must be picked by the user in the node.",
      ].join("\n"),
    );
  }
  if (!kind || kind === "llm") {
    sections.push(
      [
        "LLM models (LLM Generate `provider` + `model`):",
        ...LLM_PROVIDERS.map((p) => `- ${p.id} (needs ${p.requires}): ${p.models.map((m) => `${m.id} (${m.label})`).join(", ")}`),
      ].join("\n"),
    );
  }
  if (!kind) {
    sections.push("3D and audio generation have no model you can set: the user picks one in the node (needs a fal, Replicate, Kie or ComfyUI key).");
  }
  return sections.join("\n\n");
}
