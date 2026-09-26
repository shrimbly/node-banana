/**
 * The tool runtime for one agent turn.
 *
 * Tools read and edit a private draft seeded from the browser's snapshot, so
 * results are immediate and later calls in the same turn see earlier edits.
 * Mutating tools return the resolved graph ops the browser replays. Nothing
 * here throws: bad arguments, invalid edits and internal failures all come
 * back as `ok: false` with text the model can act on.
 */

import { z } from "zod";
import type { NodeType } from "@/types";
import type { ProviderKeys } from "@/lib/providers/keys";
import type { AgentToolDefinition, AgentToolResult, AgentToolRuntime, AgentWorkflowSnapshot } from "../types";
import { findNodeType, NODE_CATALOG, NODE_TYPES, normalizeKey } from "../graph/catalog";
import { describeNodeTypes, describeWorkflow, edgeLine, nodeLine } from "../graph/describe";
import { GraphDraft, groupLabel, titleOf, type DraftNode, type DraftTransaction, type GraphDraftOptions, type RemovedNode } from "../graph/draft";
import { isModelNodeType } from "../graph/settings";
import {
  AGENT_TOOL_DEFINITIONS,
  TOOL_NAMES,
  arrangeWorkflowShape,
  createWorkflowShape,
  describeNodeTypesShape,
  editWorkflowShape,
  getWorkflowShape,
  searchModelsShape,
  updateNodeShape,
} from "./definitions";
import { AgentModels, type ModelRequest, type ModelSource } from "./modelSearch";

const SUMMARY_MAX = 80;
const GET_WORKFLOW_MAX_NODES = 150;
const GENERATOR_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["nanoBanana", "generateVideo", "generate3d", "generateAudio", "llmGenerate", "comfyApp"]);
/** Nodes whose content is the user's own upload rather than a result. */
const UPLOAD_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["imageInput", "audioInput", "videoInput"]);

type Args<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

export interface AgentToolRuntimeOptions extends Omit<GraphDraftOptions, "models"> {
  /**
   * The user's provider keys for this turn (from the chat request's headers,
   * else the server's .env). Used only to list models and read their
   * schemas; never written into any tool text.
   */
  providerKeys?: ProviderKeys;
  /** The turn's signal: model lookups stop when the turn is stopped. */
  signal?: AbortSignal;
  /** Where models come from; the provider registry by default. */
  modelSource?: ModelSource;
}

/** Tools that change the canvas, and so may set models. */
const MUTATING_TOOLS: ReadonlySet<string> = new Set([TOOL_NAMES.createWorkflow, TOOL_NAMES.editWorkflow, TOOL_NAMES.updateNode]);
/** The tool search_models replaced; old sessions may still call it. */
const LIST_MODELS_ALIAS = "list_models";

/**
 * One runtime per turn. Tools read and edit a private draft seeded from the
 * snapshot, so later calls in the same turn see earlier edits.
 */
export function createAgentToolRuntime(snapshot: AgentWorkflowSnapshot, options: AgentToolRuntimeOptions = {}): AgentToolRuntime {
  const { providerKeys, signal, modelSource, ...draftOptions } = options;
  const models = new AgentModels(providerKeys ?? {}, { source: modelSource, signal });
  const draft = new GraphDraft(snapshot ?? { nodes: [], edges: [], groups: [], selectedNodeIds: [] }, { ...draftOptions, models });

  const handlers: Record<string, (args: unknown) => AgentToolResult | Promise<AgentToolResult>> = {
    [TOOL_NAMES.getWorkflow]: (args) => getWorkflow(draft, args as Args<typeof getWorkflowShape>),
    [TOOL_NAMES.describeNodeTypes]: (args) => describeTypes(args as Args<typeof describeNodeTypesShape>),
    [TOOL_NAMES.searchModels]: (args) => searchModels(models, args as Args<typeof searchModelsShape>),
    [TOOL_NAMES.createWorkflow]: (args) => createWorkflow(draft, args as Args<typeof createWorkflowShape>),
    [TOOL_NAMES.editWorkflow]: (args) => editWorkflow(draft, args as Args<typeof editWorkflowShape>),
    [TOOL_NAMES.updateNode]: (args) => updateNode(draft, args as Args<typeof updateNodeShape>),
    [TOOL_NAMES.arrangeWorkflow]: (args) => arrangeWorkflow(draft, args as Args<typeof arrangeWorkflowShape>),
    // The label itself reaches the chat history through the stream (chatStream); the model only needs an ack.
    [TOOL_NAMES.nameConversation]: () => ({ ok: true, text: "Saved.", summary: "Named the conversation", ops: [] }),
  };
  const schemas = new Map(AGENT_TOOL_DEFINITIONS.map((d) => [d.name, z.object(d.inputShape)]));

  return {
    definitions: AGENT_TOOL_DEFINITIONS,
    async execute(name: string, args: unknown): Promise<AgentToolResult> {
      if (bareToolName(name) === LIST_MODELS_ALIAS) {
        name = TOOL_NAMES.searchModels;
        args = listModelsArgs(normalizeArgs(args));
      }
      const definition = findDefinition(name);
      if (!definition) {
        return failure(
          `Unknown tool "${name}". Available tools: ${AGENT_TOOL_DEFINITIONS.map((d) => d.name).join(", ")}.`,
          `Unknown tool ${name}`,
        );
      }
      try {
        const parsed = schemas.get(definition.name)!.safeParse(normalizeArgs(args));
        if (!parsed.success) {
          return failure(formatZodError(definition, parsed.error), `Invalid arguments for ${definition.name}`);
        }
        // Settings resolve synchronously inside the batch: look up every model it names first.
        if (MUTATING_TOOLS.has(definition.name)) await models.prepare(modelRequests(definition.name, parsed.data, draft));
        return await handlers[definition.name](parsed.data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(`${definition.name} failed unexpectedly (${message}). No changes were made; try again, or with fewer operations.`, `${definition.title} failed`);
      }
    },
  };
}

/** Tool names may arrive prefixed by the harness (`mcp__node_banana__x`, `node_banana.x`). */
function findDefinition(name: string): AgentToolDefinition | undefined {
  const exact = AGENT_TOOL_DEFINITIONS.find((d) => d.name === name);
  if (exact) return exact;
  return AGENT_TOOL_DEFINITIONS.find((d) => d.name === bareToolName(name));
}

function bareToolName(name: string): string | undefined {
  return typeof name === "string" ? name.split(/__|[./]/).pop() : undefined;
}

/** list_models {kind} → search_models {nodeType}. */
function listModelsArgs(args: unknown): Record<string, unknown> {
  const kind = args && typeof args === "object" ? (args as { kind?: unknown }).kind : undefined;
  const nodeType = kind === "image" ? "nanoBanana" : kind === "video" ? "generateVideo" : kind === "llm" ? "llmGenerate" : undefined;
  return nodeType ? { nodeType } : {};
}

/**
 * The models a mutating call names (settings.model on generation nodes), and
 * the schemas of models a node already uses when only modelParameters
 * change. A node's type comes from the draft, or from the add_node of the
 * same call for a ref.
 */
function modelRequests(tool: string, args: unknown, draft: GraphDraft): ModelRequest[] {
  const requests: ModelRequest[] = [];
  const visit = (type: NodeType | undefined, settings: unknown, node?: DraftNode) => {
    if (!type || !isModelNodeType(type) || !settings || typeof settings !== "object" || Array.isArray(settings)) return;
    const model = settingValue(settings as Record<string, unknown>, "model");
    if (model.present) {
      requests.push({ kind: "model", nodeType: type, value: model.value });
      return;
    }
    if (!settingValue(settings as Record<string, unknown>, "modelParameters").present) return;
    const data = node?.data ?? draft.options.createDefaultNodeData(type);
    const selected = data.selectedModel as { provider?: unknown; modelId?: unknown } | undefined;
    if (typeof selected?.provider === "string" && typeof selected.modelId === "string" && selected.modelId) {
      requests.push({ kind: "schema", provider: selected.provider, modelId: selected.modelId });
    }
  };
  const existing = (key: unknown): DraftNode | undefined => {
    if (typeof key !== "string") return undefined;
    const name = key.trim();
    return draft.nodes.get(name) ?? draft.nodes.get(draft.refs.get(name) ?? "");
  };
  const typeOf = (value: unknown) => (typeof value === "string" ? findNodeType(value) : undefined);

  if (tool === TOOL_NAMES.updateNode) {
    const { node, settings } = args as Args<typeof updateNodeShape>;
    const target = existing(node);
    visit(target?.type, settings, target);
  } else if (tool === TOOL_NAMES.createWorkflow) {
    for (const spec of (args as Args<typeof createWorkflowShape>).nodes ?? []) visit(typeOf(spec.type), spec.settings);
  } else if (tool === TOOL_NAMES.editWorkflow) {
    const operations = (args as Args<typeof editWorkflowShape>).operations ?? [];
    const refTypes = new Map<string, NodeType>();
    for (const op of operations) {
      if (op.op !== "add_node") continue;
      const type = typeOf(op.type);
      if (type && op.ref) refTypes.set(op.ref.trim(), type);
      visit(type, op.settings);
    }
    for (const op of operations) {
      if (op.op !== "update_node") continue;
      const target = existing(op.node);
      visit(target?.type ?? (typeof op.node === "string" ? refTypes.get(op.node.trim()) : undefined), op.settings, target);
    }
  }
  return requests;
}

/** A setting as the settings resolver finds it: exact name, else case- and separator-insensitive. */
function settingValue(settings: Record<string, unknown>, field: string): { present: boolean; value: unknown } {
  if (field in settings && settings[field] !== undefined) return { present: true, value: settings[field] };
  const key = Object.keys(settings).find((k) => normalizeKey(k) === normalizeKey(field) && settings[k] !== undefined);
  return key ? { present: true, value: settings[key] } : { present: false, value: undefined };
}

/**
 * Models occasionally send JSON-encoded strings where objects belong
 * (the whole argument object, `settings`, or a list). Decode those.
 */
export function normalizeArgs(args: unknown): unknown {
  const decode = (value: unknown): unknown => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  };
  const root = decode(args);
  if (root === undefined || root === null) return {};
  if (typeof root !== "object" || Array.isArray(root)) return root;
  const out: Record<string, unknown> = { ...(root as Record<string, unknown>) };
  for (const key of ["nodes", "connections", "operations", "groups", "nodeIds", "types", "settings"]) {
    if (key in out) out[key] = decode(out[key]);
  }
  for (const key of ["nodes", "operations"]) {
    if (Array.isArray(out[key])) {
      out[key] = (out[key] as unknown[]).map((item) =>
        item && typeof item === "object" && "settings" in item
          ? { ...(item as Record<string, unknown>), settings: decode((item as Record<string, unknown>).settings) }
          : item,
      );
    }
  }
  return dropNulls(out) as Record<string, unknown>;
}

/**
 * Some models send `null` for every optional field they leave out (strict
 * function calling). Treat those as absent, except inside `settings`, where
 * null is a real value ("no size limit", "clear the variable name").
 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null) continue;
    out[key] = key === "settings" ? entry : dropNulls(entry);
  }
  return out;
}

function formatZodError(definition: AgentToolDefinition, error: z.ZodError): string {
  const issues = error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(arguments)";
    return `- ${path}: ${issue.message}`;
  });
  return [`Invalid arguments for ${definition.name}; nothing was changed:`, ...issues, `Expected fields: ${Object.keys(definition.inputShape).join(", ")}.`].join("\n");
}

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

function getWorkflow(draft: GraphDraft, args: Args<typeof getWorkflowShape>): AgentToolResult {
  const text = describeWorkflow(draft, {
    nodeIds: args.nodeIds,
    detail: args.detail ?? "summary",
    // A whole huge canvas would flood the context; nodeIds reaches the rest.
    maxNodes: args.nodeIds?.length ? undefined : GET_WORKFLOW_MAX_NODES,
  });
  const count = args.nodeIds?.length ? `${args.nodeIds.filter((id) => draft.nodes.has(id)).length} of ${draft.nodes.size} nodes` : `${draft.nodes.size} nodes`;
  return { ok: true, text, summary: `Read the workflow (${count})`, ops: [] };
}

function describeTypes(args: Args<typeof describeNodeTypesShape>): AgentToolResult {
  const requested = args.types ?? [];
  const types: NodeType[] = [];
  const unknown: string[] = [];
  for (const name of requested) {
    const type = findNodeType(name);
    if (type) {
      if (!types.includes(type)) types.push(type);
    } else unknown.push(name);
  }
  if (requested.length > 0 && types.length === 0) {
    return failure(`Unknown node type${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Types: ${NODE_TYPES.join(", ")}.`, "Unknown node types");
  }
  const lines = [describeNodeTypes(types)];
  if (unknown.length > 0) lines.push(`Unknown types skipped: ${unknown.join(", ")}. Types: ${NODE_TYPES.join(", ")}.`);
  const names = types.length > 0 ? types.join(", ") : "all node types";
  return { ok: true, text: lines.join("\n\n"), summary: clip(`Looked up ${names}`), ops: [] };
}

async function searchModels(models: AgentModels, args: Args<typeof searchModelsShape>): Promise<AgentToolResult> {
  const result = await models.search(args);
  return { ok: result.ok, text: result.text, summary: clip(result.summary), ops: [] };
}

// ---------------------------------------------------------------------------
// Mutating tools
// ---------------------------------------------------------------------------

function createWorkflow(draft: GraphDraft, args: Args<typeof createWorkflowShape>): AgentToolResult {
  const nodes = args.nodes ?? [];
  const connections = args.connections ?? [];
  if (nodes.length === 0 && connections.length === 0 && !args.replaceCanvas) {
    return failure("create_workflow needs at least one node (or connection). Nothing was changed.", "Nothing to create");
  }
  // An empty canvas has nothing to replace: no removals, no "replaced canvas".
  const replace = !!args.replaceCanvas && draft.nodes.size > 0;
  const replacedCount = replace ? draft.nodes.size : 0;
  return runBatch(draft, TOOL_NAMES.createWorkflow, (tx) => {
    if (replace) tx.clearCanvas();
    nodes.forEach((spec, index) => {
      tx.addNode(spec, `nodes[${index}]${spec.ref ? ` (ref "${spec.ref}")` : ""}`);
    });
    connections.forEach((connection, index) => {
      tx.connect(connection, `connections[${index}] (${connection.from} → ${connection.to})`);
    });
    (args.groups ?? []).forEach((group, index) => {
      tx.createGroup(group, `groups[${index}]${group.name ? ` ("${group.name}")` : ""}`);
    });
  }, { replacedCount });
}

type EditOperation = Args<typeof editWorkflowShape>["operations"][number];

function editWorkflow(draft: GraphDraft, args: Args<typeof editWorkflowShape>): AgentToolResult {
  const operations = args.operations ?? [];
  if (operations.length === 0) {
    return failure("edit_workflow needs at least one operation. Nothing was changed.", "No operations");
  }
  return runBatch(draft, TOOL_NAMES.editWorkflow, (tx) => {
    const where = (op: EditOperation, index: number) => `operations[${index}] (${op.op})`;
    // add_node first, so refs can be used by any other operation in the list.
    operations.forEach((op, index) => {
      if (op.op !== "add_node") return;
      if (!op.type) {
        tx.errors.push(`${where(op, index)}: type is required (e.g. "prompt", "nanoBanana").`);
        return;
      }
      tx.addNode({ ref: op.ref, type: op.type, title: op.title, settings: op.settings, position: op.position }, where(op, index));
    });
    operations.forEach((op, index) => {
      const at = where(op, index);
      switch (op.op) {
        case "add_node":
          return;
        case "update_node":
          tx.updateNode(op.node, op.title, op.settings, at);
          return;
        case "remove_node":
          tx.removeNode(op.node, at);
          return;
        case "connect":
          if (!op.from || !op.to) {
            tx.errors.push(`${at}: connect needs from and to (node ids or refs).`);
            return;
          }
          tx.connect(
            { from: op.from, to: op.to, fromHandle: op.fromHandle, toHandle: op.toHandle, arrayItemIndex: op.arrayItemIndex, loop: op.loop, loopCount: op.loopCount },
            at,
          );
          return;
        case "disconnect":
          tx.disconnect({ edgeId: op.edgeId, from: op.from, to: op.to, fromHandle: op.fromHandle, toHandle: op.toHandle }, at);
          return;
        case "move_node":
          if (!op.position) {
            tx.errors.push(`${at}: move_node needs position {x, y}.`);
            return;
          }
          tx.moveNode(op.node, op.position, at);
          return;
        case "group":
          tx.createGroup({ nodes: nodeList(op), name: op.name ?? op.title ?? op.group, color: op.color }, at);
          return;
        case "ungroup":
          tx.removeGroup(op.group, at);
          return;
        case "update_group":
          tx.updateGroup(op.group, { name: op.name ?? op.title, color: op.color }, at);
          return;
        case "add_to_group":
          tx.addToGroup(nodeList(op), op.group, at);
          return;
        case "remove_from_group":
          tx.removeFromGroup(nodeList(op), at);
          return;
      }
    });
  });
}

/** The nodes a group operation names: `nodes`, or a single `node`. */
function nodeList(op: EditOperation): string[] | undefined {
  if (op.nodes && op.nodes.length > 0) return op.nodes;
  return op.node ? [op.node] : op.nodes;
}

function updateNode(draft: GraphDraft, args: Args<typeof updateNodeShape>): AgentToolResult {
  return runBatch(draft, TOOL_NAMES.updateNode, (tx) => {
    tx.updateNode(args.node, args.title, args.settings, "update_node");
  });
}

function arrangeWorkflow(draft: GraphDraft, args: Args<typeof arrangeWorkflowShape>): AgentToolResult {
  const requested = args.nodeIds ?? [];
  const missing = requested.filter((id) => !draft.nodes.has(id));
  if (missing.length > 0) {
    return failure(`Not on the canvas: ${missing.join(", ")}. Nothing was moved.`, "Unknown nodes");
  }
  if (draft.nodes.size === 0) {
    return { ok: true, text: "The canvas is empty; nothing to arrange.", summary: "Nothing to arrange", ops: [] };
  }
  // Groups move as units, their nodes tidied inside a refit box.
  return runBatch(draft, TOOL_NAMES.arrangeWorkflow, (tx) => tx.arrange(requested));
}

// ---------------------------------------------------------------------------
// Batches and results
// ---------------------------------------------------------------------------

function runBatch(
  draft: GraphDraft,
  tool: string,
  build: (tx: DraftTransaction) => void,
  extra: { replacedCount?: number } = {},
): AgentToolResult {
  const tx = draft.begin();
  build(tx);
  if (tx.errors.length === 0) tx.finish();
  if (tx.errors.length > 0) {
    const text = [
      `No changes were made: ${tool} is all-or-nothing and ${tx.errors.length === 1 ? "this problem" : `these ${tx.errors.length} problems`} must be fixed first. Call ${tool} again with the fix (the canvas is unchanged).`,
      ...tx.errors.map((error, index) => `${index + 1}. ${error}`),
    ].join("\n");
    // "operations[2] (connect): X" → "X": the location is noise in a one-line summary.
    const first = tx.errors[0].replace(/^(?:[a-z_]+\[\d+\](?: \([^)]*\))?|update_node): /, "");
    return { ok: false, text, summary: clip(`Rejected: ${first}`), ops: [] };
  }
  draft.commit(tx);
  return successResult(draft, tx, extra.replacedCount ?? 0);
}

function successResult(draft: GraphDraft, tx: DraftTransaction, replacedCount: number): AgentToolResult {
  const log = tx.log;
  const created = log.created.filter((c) => draft.nodes.has(c.id));
  const updatedIds = [...log.changes.keys()].filter((id) => draft.nodes.has(id) && !created.some((c) => c.id === id));
  const lines: string[] = [];

  if (tx.cleared) lines.push(`Cleared the canvas (${replacedCount} node${replacedCount === 1 ? "" : "s"} removed; the user can undo it with Ctrl+Z, one step per change, or "Revert AI Changes" for everything from this reply).`);
  if (created.length > 0) {
    lines.push("Added nodes:");
    for (const c of created) lines.push(`- ${c.ref ? `ref "${c.ref}" = ` : ""}${nodeLine(draft.nodes.get(c.id)!)}`);
  }
  if (updatedIds.length > 0) {
    lines.push("Updated:");
    for (const id of updatedIds) lines.push(`- ${id}: ${log.changes.get(id)!.join(", ")}`);
  }
  const removedNodes = tx.cleared ? [] : log.removedNodes;
  if (removedNodes.length > 0) {
    lines.push(`Removed nodes: ${removedNodes.map((n) => `${n.id}${n.title ? ` ("${n.title}")` : ""}`).join(", ")} (with their connections).`);
  }
  if (log.addedEdges.length > 0) {
    lines.push("Connected:");
    for (const edge of log.addedEdges) lines.push(`- ${edgeLine(edge)}`);
  }
  const removedNodeIds = new Set(log.removedNodes.map((n) => n.id));
  const disconnected = tx.cleared ? [] : log.removedEdges.filter((r) => !removedNodeIds.has(r.edge.source) && !removedNodeIds.has(r.edge.target));
  if (disconnected.length > 0) {
    lines.push("Disconnected:");
    for (const r of disconnected) lines.push(`- ${edgeLine(r.edge)}${r.reason ? ` (${r.reason})` : ""}`);
  }
  if (log.moved.length > 0) lines.push(`Moved: ${[...new Set(log.moved)].join(", ")}.`);
  const groupLines = describeGroupChanges(draft, tx);
  if (groupLines.length > 0) {
    lines.push("Groups:");
    for (const line of groupLines) lines.push(`- ${line}`);
  }
  if (log.notes.length > 0) lines.push(...log.notes.map((note) => `Note: ${note}`));
  if (tx.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of [...new Set(tx.warnings)]) lines.push(`- ${warning}`);
  }
  const hints = nextSteps(draft, created.map((c) => c.id), log.removedNodes);
  if (hints.length > 0) lines.push(`Next: ${hints.join(" ")}`);
  if (tx.ops.length === 0) lines.unshift("No changes were needed.");

  const focus = new Set<string>([
    ...created.map((c) => c.id),
    ...updatedIds,
    ...log.moved.filter((id) => draft.nodes.has(id)),
    ...log.groupedNodes.filter((id) => draft.nodes.has(id)),
  ]);
  if (focus.size === 0) {
    for (const edge of log.addedEdges) {
      focus.add(edge.source);
      focus.add(edge.target);
    }
  }
  return {
    ok: true,
    text: lines.join("\n"),
    summary: summarize(draft, tx, created.length, updatedIds, disconnected.length, replacedCount),
    ops: tx.ops,
    ...(focus.size > 0 || tx.cleared ? { focusNodeIds: tx.cleared ? [...draft.nodes.keys()] : [...focus] } : {}),
    ...(tx.cleared ? { replacedCanvas: true } : {}),
  };
}

function summarize(draft: GraphDraft, tx: DraftTransaction, created: number, updatedIds: string[], disconnected: number, replacedCount: number): string {
  if (tx.ops.length === 0) return "No changes needed";
  const log = tx.log;
  const parts: string[] = [];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (created > 0) parts.push(`added ${plural(created, "node")}`);
  if (updatedIds.length === 1 && created === 0) {
    const node = draft.nodes.get(updatedIds[0])!;
    const fields = [...new Set(log.changes.get(updatedIds[0])!.map((c) => c.split(/[=\s]/)[0]))];
    parts.push(`updated ${titleOf(node) ?? NODE_CATALOG[node.type].displayName} (${fields.join(", ")})`);
  } else if (updatedIds.length > 0) {
    parts.push(`updated ${plural(updatedIds.length, "node")}`);
  }
  if (!tx.cleared && log.removedNodes.length > 0) parts.push(`removed ${plural(log.removedNodes.length, "node")}`);
  if (log.addedEdges.length > 0) parts.push(`${plural(log.addedEdges.length, "connection")}`);
  if (disconnected > 0) parts.push(`${disconnected} disconnected`);
  const newGroups = log.createdGroups.filter((id) => draft.getGroup(id));
  const removedGroups = log.removedGroups.filter((id) => !log.createdGroups.includes(id));
  if (newGroups.length > 0) parts.push(`${newGroups.length === 1 ? `grouped "${draft.getGroup(newGroups[0])!.name}"` : `${newGroups.length} groups`}`);
  if (removedGroups.length > 0 && !tx.cleared) parts.push(`removed ${plural(removedGroups.length, "group")}`);
  if (newGroups.length === 0 && removedGroups.length === 0 && log.groups.length > 0) parts.push("updated groups");
  if (log.moved.length > 0 && created === 0) parts.push(`moved ${plural(new Set(log.moved).size, "node")}`);
  let text = parts.join(", ") || "Updated the canvas";
  if (tx.cleared) text = `Replaced canvas (${replacedCount} removed): ${text}`;
  return clip(text.charAt(0).toUpperCase() + text.slice(1));
}

/** New groups with their nodes (as they ended up), then every other group change, in order. */
function describeGroupChanges(draft: GraphDraft, tx: DraftTransaction): string[] {
  const lines: string[] = [];
  for (const id of tx.log.createdGroups) {
    const group = draft.getGroup(id);
    if (!group) continue;
    const members = [...draft.nodes.values()].filter((n) => n.groupId === id).map((n) => n.id);
    const box = group.position && group.size ? `, box (${group.position.x}, ${group.position.y}) ${group.size.width}×${group.size.height}` : "";
    lines.push(`Created group ${groupLabel(group)} (${group.color ?? "neutral"}${box}): ${members.join(", ")}.`);
  }
  lines.push(...tx.log.groups);
  return lines;
}

/**
 * What to tell the user: first what was removed from their canvas (above all
 * uploads and results) and how to get it back, then what they have to do for
 * the nodes just created.
 */
function nextSteps(draft: GraphDraft, createdIds: string[], removed: RemovedNode[]): string[] {
  const types = new Set(createdIds.map((id) => draft.nodes.get(id)?.type).filter((t): t is NodeType => !!t));
  const hints: string[] = [];
  const theirs = removed.filter((n) => draft.initialNodeIds.has(n.id));
  if (theirs.length > 0) {
    const media = theirs.filter((n) => n.content && (n.content.image || n.content.video || n.content.audio || n.content.model3d));
    const named = media.slice(0, 6).map((n) => `${n.id}${n.title ? ` ("${n.title}")` : ""} (${heldContent(n)})`);
    const including = named.length > 0 ? `, including ${named.join(", ")}${media.length > named.length ? ` and ${media.length - named.length} more with media` : ""}` : "";
    hints.push(`Tell the user you removed ${theirs.length} of their nodes${including}, and that Ctrl+Z (one step per change) or the header's "Revert AI Changes" button (everything from this reply) brings ${theirs.length === 1 ? "it" : "them"} back.`);
  }
  const uploads = createdIds.filter((id) => {
    const node = draft.nodes.get(id);
    if (!node || !["imageInput", "audioInput", "videoInput"].includes(node.type)) return false;
    return !draft.edges.some((e) => e.target === id);
  });
  if (uploads.length > 0) hints.push(`Tell the user to upload media into ${uploads.join(", ")}.`);
  const modelless = createdIds.filter((id) => {
    const node = draft.nodes.get(id);
    return (node?.type === "generate3d" || node?.type === "generateAudio") && !(node.data.selectedModel as { modelId?: string } | undefined)?.modelId;
  });
  if (modelless.length > 0) {
    hints.push(`${modelless.join(", ")} ha${modelless.length === 1 ? "s" : "ve"} no model: set one from search_models, or tell the user to pick one in the node (it needs a fal, Replicate, Kie, WaveSpeed or ComfyUI key).`);
  }
  if ([...types].some((t) => GENERATOR_TYPES.has(t))) {
    hints.push("Nothing has run yet: the user presses Run (Ctrl/Cmd+Enter) when ready.");
  }
  return hints;
}

/** What a removed node held, in the user's words. */
function heldContent(node: RemovedNode): string {
  const c = node.content ?? {};
  const made = UPLOAD_TYPES.has(node.type) ? "uploaded" : "generated";
  const kinds = [c.image && "image", c.video && "video", c.audio && "audio", c.model3d && "3D model"].filter(Boolean).join(" and ");
  return `${made} ${kinds}`;
}

function failure(text: string, summary: string): AgentToolResult {
  return { ok: false, text, summary: clip(summary), ops: [] };
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}
