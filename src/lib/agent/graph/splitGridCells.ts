/**
 * A Split Grid's per-cell pipeline, as the agent writes it (`cells`), turned
 * into the node's SplitGridTemplate — the same template the user builds in
 * the node's cell editor. The browser copies it into every cell when the
 * grid is materialized (on applying the agent's change, and on Run).
 *
 * The spec mirrors create_workflow: nodes by ref, connections by ref, and
 * `collect` for the outputs every cell sends to the grid's one shared Router.
 * The cell's image slice is the reserved ref "cell" (the template's base
 * Image Input). Settings and connections go through the same checks as real
 * nodes (resolveSettings, planConnection).
 */

import type { NodeType, SplitGridTemplate, SplitGridTemplateEdge, SplitGridTemplateNode, SplitGridTemplateRouterConnection } from "@/types";
import { defaultNodeDimensions, SPLIT_GRID_BASE_NODE_ID } from "@/store/utils/nodeDefaults";
import { findNodeType, NODE_CATALOG, NODE_TYPES } from "./catalog";
import { DATA_TYPES, getOutputHandles, planConnection, type GraphEdgeLike, type GraphNodeLike } from "./handles";
import { pickAgentData } from "./nodeData";
import type { SettingsContext, SettingsOutcome } from "./settings";

/** The ref that names each cell's own image slice. */
export const CELL_REF = "cell";
const CELL_REF_ALIASES = new Set(["cell", "image", "slice", SPLIT_GRID_BASE_NODE_ID]);
const MAX_CELL_NODES = 12;
/** Types that cannot sit inside a cell. */
const NOT_IN_CELLS: ReadonlySet<NodeType> = new Set<NodeType>(["splitGrid", "comfyApp"]);
const COLUMN_GAP = 60;
const ROW_GAP = 40;

export interface CellsSpec {
  nodes?: Array<{ ref?: unknown; type?: unknown; title?: unknown; settings?: unknown }>;
  connections?: Array<{ from?: unknown; to?: unknown; fromHandle?: unknown; toHandle?: unknown }>;
  collect?: Array<{ from?: unknown; fromHandle?: unknown }>;
  /** Where the shared Router connects (a ref or node id, e.g. an Output Gallery); handled by the draft. */
  into?: unknown;
}

export interface BuiltCellTemplate {
  template: SplitGridTemplate;
  /** One line for the tool result, e.g. `cell → up (Generate Image) → collected`. */
  summary: string;
  warnings: string[];
}

type ResolveSettings = (node: GraphNodeLike, settings: Record<string, unknown> | undefined, context: SettingsContext) => SettingsOutcome;

/**
 * Builds the template, or returns every problem found. `resolveSettings` is
 * passed in (settings.ts calls this module) to keep the import graph acyclic.
 */
export function buildCellTemplate(
  raw: unknown,
  context: SettingsContext,
  resolveSettings: ResolveSettings,
  label: string,
): { ok: true; built: BuiltCellTemplate } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (message: string) => errors.push(`${label}: cells ${message}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [`${label}: cells must be an object {nodes, connections, collect}. ${CELLS_EXAMPLE}`] };
  }
  const spec = raw as CellsSpec;
  const specNodes = Array.isArray(spec.nodes) ? spec.nodes : [];
  if (spec.nodes !== undefined && !Array.isArray(spec.nodes)) fail("nodes must be a list.");
  if (specNodes.length > MAX_CELL_NODES) fail(`can hold at most ${MAX_CELL_NODES} nodes per cell (got ${specNodes.length}).`);

  // --- Nodes -------------------------------------------------------------
  const base: GraphNodeLike = { id: SPLIT_GRID_BASE_NODE_ID, type: "imageInput", data: {} };
  const nodes = new Map<string, GraphNodeLike>([[base.id, base]]);
  const refs = new Map<string, string>();
  const templateNodes: SplitGridTemplateNode[] = [{ id: base.id, type: "imageInput", position: { x: 0, y: 0 } }];

  specNodes.forEach((entry, index) => {
    const where = `nodes[${index}]`;
    if (!entry || typeof entry !== "object") {
      fail(`${where} must be an object {ref, type, settings?}.`);
      return;
    }
    const ref = typeof entry.ref === "string" ? entry.ref.trim() : "";
    const type = typeof entry.type === "string" ? findNodeType(entry.type) : undefined;
    if (!ref) {
      fail(`${where} needs a ref (a short name used in connections and collect).`);
      return;
    }
    if (CELL_REF_ALIASES.has(ref.toLowerCase())) {
      fail(`${where}: ref "${ref}" is reserved for the cell's image slice; pick another.`);
      return;
    }
    if (refs.has(ref)) {
      fail(`${where}: ref "${ref}" is used twice.`);
      return;
    }
    if (!type) {
      fail(`${where}: unknown node type ${JSON.stringify(entry.type)}. Types: ${NODE_TYPES.join(", ")}.`);
      return;
    }
    if (!NODE_CATALOG[type].agentCreatable || NOT_IN_CELLS.has(type)) {
      fail(`${where}: ${NODE_CATALOG[type].displayName} nodes cannot go in a cell.`);
      return;
    }
    const id = `cell-${ref.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    if (nodes.has(id)) {
      fail(`${where}: ref "${ref}" clashes with another ref; pick another.`);
      return;
    }
    // Starts from the data a real node of this type would have, so settings validate the same way.
    const defaults = pickAgentData(type, context.createDefaultNodeData?.(type));
    const node: GraphNodeLike = { id, type, data: defaults };
    const settings = entry.settings;
    if (settings !== undefined && (typeof settings !== "object" || settings === null || Array.isArray(settings))) {
      fail(`${where}: settings must be an object of field → value.`);
      return;
    }
    const combined: Record<string, unknown> = { ...((settings as Record<string, unknown> | undefined) ?? {}) };
    if (entry.title !== undefined) combined.title = entry.title;
    const outcome = resolveSettings(node, combined, context);
    for (const error of outcome.errors) errors.push(`${label}: cells ${where} (${ref}): ${error}`);
    warnings.push(...outcome.warnings.map((warning) => `${label}: cell ${ref}: ${warning}`));
    node.data = { ...defaults, ...outcome.patch };
    nodes.set(id, node);
    refs.set(ref, id);
    templateNodes.push({ id, type, position: { x: 0, y: 0 }, ...(Object.keys(outcome.patch).length ? { data: { ...outcome.patch } } : {}) });
  });

  const resolveRef = (value: unknown, where: string): GraphNodeLike | undefined => {
    const name = typeof value === "string" ? value.trim() : "";
    if (CELL_REF_ALIASES.has(name.toLowerCase())) return base;
    const id = refs.get(name);
    if (id) return nodes.get(id);
    fail(`${where}: ${JSON.stringify(value)} is not "${CELL_REF}" or a ref from cells.nodes (${[...refs.keys()].join(", ") || "none yet"}).`);
    return undefined;
  };

  // --- Connections -------------------------------------------------------
  const edges: GraphEdgeLike[] = [];
  const connections = Array.isArray(spec.connections) ? spec.connections : [];
  if (spec.connections !== undefined && !Array.isArray(spec.connections)) fail("connections must be a list.");
  connections.forEach((entry, index) => {
    const where = `connections[${index}]`;
    const source = resolveRef(entry?.from, `${where}.from`);
    const target = resolveRef(entry?.to, `${where}.to`);
    if (!source || !target) return;
    if (target.id === base.id) {
      fail(`${where}: nothing connects into "${CELL_REF}"; it receives the cell's slice.`);
      return;
    }
    const plan = planConnection({
      source,
      target,
      fromHandle: typeof entry.fromHandle === "string" ? entry.fromHandle : undefined,
      toHandle: typeof entry.toHandle === "string" ? entry.toHandle : undefined,
      nodes,
      edges,
    });
    if (!plan.ok) {
      fail(`${where}: ${plan.error}`);
      return;
    }
    for (const replaced of plan.replaces) edges.splice(edges.indexOf(replaced), 1);
    if (plan.duplicate) return;
    edges.push({
      id: `cell-edge-${index}`,
      source: source.id,
      sourceHandle: plan.sourceHandle.id,
      target: target.id,
      targetHandle: plan.targetHandle.id,
    });
  });

  // --- Collect -----------------------------------------------------------
  const router: SplitGridTemplateRouterConnection[] = [];
  const collect = Array.isArray(spec.collect) ? spec.collect : [];
  if (spec.collect !== undefined && !Array.isArray(spec.collect)) fail("collect must be a list.");
  collect.forEach((entry, index) => {
    const where = `collect[${index}]`;
    const source = resolveRef(entry?.from, `${where}.from`);
    if (!source) return;
    const outputs = getOutputHandles(source, edges).filter(
      (handle) => !handle.internal && (DATA_TYPES as readonly string[]).includes(handle.type),
    );
    const wanted = typeof entry.fromHandle === "string" ? entry.fromHandle.trim().toLowerCase() : "";
    const handle = wanted
      ? outputs.find((h) => h.id.toLowerCase() === wanted || h.type === wanted || h.label.toLowerCase() === wanted)
      : outputs[0];
    if (!handle) {
      fail(`${where}: ${source.id === base.id ? CELL_REF : entry?.from} has no ${wanted ? `output "${wanted}"` : "output to collect"}${outputs.length ? ` (outputs: ${outputs.map((h) => h.id).join(", ")})` : ""}.`);
      return;
    }
    if (router.some((r) => r.source === source.id && r.sourceHandle === handle.id)) return;
    router.push({ source: source.id, sourceHandle: handle.id, targetHandle: handle.type });
  });

  if (errors.length > 0) return { ok: false, errors };

  layoutCell(templateNodes, edges);
  const template: SplitGridTemplate = {
    baseNodeId: base.id,
    nodes: templateNodes,
    edges: edges.map(
      (edge): SplitGridTemplateEdge => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle ?? "",
        target: edge.target,
        targetHandle: edge.targetHandle ?? "",
      }),
    ),
    ...(router.length ? { router } : {}),
  };
  return { ok: true, built: { template, summary: describeCellTemplate(template), warnings } };
}

/** Columns by distance from the slice, stacked within a column; positions are relative to the cell. */
function layoutCell(nodes: SplitGridTemplateNode[], edges: readonly GraphEdgeLike[]): void {
  const depth = new Map<string, number>([[SPLIT_GRID_BASE_NODE_ID, 0]]);
  for (let pass = 0; pass < nodes.length; pass++) {
    for (const edge of edges) {
      const from = depth.get(edge.source);
      if (from === undefined) continue;
      if ((depth.get(edge.target) ?? -1) < from + 1) depth.set(edge.target, from + 1);
    }
  }
  // Nodes nothing feeds (a prompt) sit in the column before the node they feed.
  for (const node of nodes) {
    if (depth.has(node.id)) continue;
    const fed = edges.filter((e) => e.source === node.id).map((e) => depth.get(e.target) ?? 1);
    depth.set(node.id, Math.max(0, Math.min(...(fed.length ? fed : [1])) - 1));
  }
  const columns = new Map<number, SplitGridTemplateNode[]>();
  for (const node of nodes) {
    const column = depth.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }
  let x = 0;
  for (const column of [...columns.keys()].sort((a, b) => a - b)) {
    const members = columns.get(column)!;
    let y = 0;
    let width = 0;
    for (const node of members) {
      const size = defaultNodeDimensions[node.type];
      node.position = { x, y };
      y += size.height + ROW_GAP;
      width = Math.max(width, size.width);
    }
    x += width + COLUMN_GAP;
  }
}

/** `cell → up (Generate Image); collected: up.image`, for the tool result and the canvas description. */
export function describeCellTemplate(template: SplitGridTemplate | undefined): string {
  if (!template || template.nodes.length <= 1) return "each cell: just its image slice";
  const name = (id: string) => (id === template.baseNodeId ? CELL_REF : id.replace(/^cell-/, ""));
  const nodes = template.nodes
    .filter((node) => node.id !== template.baseNodeId)
    .map((node) => `${name(node.id)} (${NODE_CATALOG[node.type]?.displayName ?? node.type})`);
  const wires = template.edges.map((edge) => `${name(edge.source)}.${edge.sourceHandle} → ${name(edge.target)}.${edge.targetHandle}`);
  const collected = (template.router ?? []).map((r) => `${name(r.source)}.${r.sourceHandle}`);
  return [
    `each cell: ${nodes.join(", ")}`,
    wires.length ? `wired ${wires.join(", ")}` : "",
    collected.length ? `collected into the shared Router: ${collected.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export const CELLS_EXAMPLE =
  'Example (upscale every cell and collect the results into a gallery): {"nodes":[{"ref":"ask","type":"prompt","settings":{"prompt":"Upscale this image: keep it identical, sharper and more detailed"}},{"ref":"up","type":"nanoBanana","settings":{"resolution":"4K"}}],"connections":[{"from":"cell","to":"up"},{"from":"ask","to":"up"}],"collect":[{"from":"up"}],"into":"gallery"}. "cell" is each cell\'s image slice.';
