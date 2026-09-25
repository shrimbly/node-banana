/**
 * The server-side draft of the canvas the agent's tools edit.
 *
 * Seeded from the browser's snapshot at the start of a turn. Each tool call
 * runs as one transaction on a copy: every operation is validated and applied
 * to the copy, recording the fully resolved `AgentGraphOp`s (ids, handles,
 * positions decided here). If anything fails, the copy is discarded and every
 * error is returned; otherwise the copy becomes the draft and the ops are
 * streamed to the browser, which replays them with `applyGraphOps`.
 *
 * Loops: connecting A → B when B already feeds A is refused unless the call
 * asks for a loop (`loop: true`), in which case the edge is marked
 * `{isLoop: true, loopCount}` exactly like the canvas does. A loop edge sits
 * next to the forward edge on the same input; it never replaces it.
 *
 * Groups: a node belongs to the group whose box holds its centre, the rule the
 * canvas applies when a node is dropped. Moving a node carries its new
 * membership on the op; new nodes are placed clear of every group box.
 */

import type { NodeType } from "@/types";
import { createDefaultNodeData, defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { parseTextToArray } from "@/utils/arrayParser";
import { parseVarTags } from "@/utils/parseVarTags";
import type { AgentGraphOp, AgentSnapshotNode, AgentWorkflowSnapshot } from "../types";
import { findNodeType, NODE_CATALOG, NODE_TYPES } from "./catalog";
import { estimatedNodeHeight } from "./sizes";
import {
  edgeIdFor,
  edgeState,
  getHandleType,
  getInputHandles,
  getOutputHandles,
  planConnection,
  switchInputType,
  wouldCreateCycle,
  type GraphEdgeLike,
  type GraphNodeLike,
  type NodeHandle,
} from "./handles";
import { placeNewNodes, type LayoutBox } from "./layout";
import { pickAgentData } from "./nodeData";
import { cloneJson, isTruncatedText } from "./scrub";
import { resolveSettings, type SettingsOutcome } from "./settings";

type AddNodeOp = Extract<AgentGraphOp, { op: "addNode" }>;
type MoveNodeOp = Extract<AgentGraphOp, { op: "moveNode" }>;

export interface DraftNode extends GraphNodeLike {
  position: { x: number; y: number };
  width: number;
  height: number;
  groupId?: string;
  content?: AgentSnapshotNode["content"];
  status?: string;
  error?: string | null;
}

export type DraftEdge = GraphEdgeLike;

/** A group: its box on the canvas (when the snapshot carries it) and whether it is locked. */
export interface DraftGroup {
  id: string;
  name: string;
  color?: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  locked?: boolean;
}

/** A removed node, with what it held (uploads and results are what the user loses). */
export interface RemovedNode {
  id: string;
  type: NodeType;
  title?: string;
  content?: AgentSnapshotNode["content"];
}

export interface GraphDraftOptions {
  /** Defaults for nodes the agent adds (the store's, minus the browser's sticky settings). */
  createDefaultNodeData?: (type: NodeType) => Record<string, unknown>;
  /** Random 7-char ids for switch outputs and rules. */
  randomId?: () => string;
}

export interface ConnectInput {
  from: string;
  fromHandle?: string;
  to: string;
  toHandle?: string;
  /** Array sources: which item this connection carries. */
  arrayItemIndex?: number;
  /** Create a loop edge on purpose (only when the connection closes a cycle). */
  loop?: boolean;
  loopCount?: number;
}

export interface DisconnectInput {
  edgeId?: string;
  from?: string;
  fromHandle?: string;
  to?: string;
  toHandle?: string;
}

export interface AddNodeInput {
  ref?: string;
  type: string;
  title?: string;
  settings?: Record<string, unknown>;
  position?: { x: number; y: number };
}

export interface TransactionLog {
  created: Array<{ id: string; ref?: string; type: NodeType }>;
  /** Setting changes per node id (created nodes included). */
  changes: Map<string, string[]>;
  removedNodes: RemovedNode[];
  addedEdges: DraftEdge[];
  removedEdges: Array<{ edge: DraftEdge; reason?: string }>;
  moved: string[];
  /** Harmless no-ops worth mentioning ("already connected"). */
  notes: string[];
}

const GENERATOR_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["nanoBanana", "generateVideo", "generate3d", "generateAudio", "llmGenerate"]);
/** Nodes that turn text into media: where an LLM-written prompt usually ends up. */
const MEDIA_GENERATOR_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["nanoBanana", "generateVideo", "generate3d", "generateAudio"]);
const LOOP_COUNT_DEFAULT = 3;
const LOOP_COUNT_MAX = 100;

export class GraphDraft {
  nodes: Map<string, DraftNode>;
  edges: DraftEdge[];
  groups: DraftGroup[];
  /** Nodes on the canvas when the turn began (the user's, as opposed to ones the agent added this turn). */
  readonly initialNodeIds: ReadonlySet<string>;
  /** The user's saved defaults for new nodes, from the snapshot. */
  readonly savedDefaults: AgentWorkflowSnapshot["nodeDefaults"];
  selectedNodeIds: string[];
  viewport: AgentWorkflowSnapshot["viewport"];
  workflowName?: string;
  /** Next base36 suffix for `${type}-ag${suffix}` ids. */
  nextSuffix: number;
  /** Refs defined by earlier calls this turn, still resolvable in later ones. */
  refs = new Map<string, string>();
  readonly options: Required<GraphDraftOptions>;

  constructor(snapshot: AgentWorkflowSnapshot, options: GraphDraftOptions = {}) {
    this.options = {
      createDefaultNodeData: options.createDefaultNodeData ?? browserDefaults(snapshot?.nodeDefaults),
      randomId: options.randomId ?? defaultRandomId,
    };
    // The snapshot comes from the browser: tolerate anything malformed.
    this.nodes = new Map();
    for (const node of Array.isArray(snapshot?.nodes) ? snapshot.nodes : []) {
      if (!node || typeof node.id !== "string" || !NODE_TYPES.includes(node.type) || this.nodes.has(node.id)) continue;
      const data: Record<string, unknown> = isRecord(node.data) ? cloneJson(node.data) : {};
      if (node.title) data.customTitle = node.title;
      this.nodes.set(node.id, {
        id: node.id,
        type: node.type,
        position: { x: finite(node.position?.x), y: finite(node.position?.y) },
        width: finite(node.width) || defaultNodeDimensions[node.type].width,
        height: finite(node.height) || estimatedNodeHeight(node.type),
        data,
        ...(node.groupId ? { groupId: node.groupId } : {}),
        ...(node.content ? { content: { ...node.content } } : {}),
        ...(node.status ? { status: node.status } : {}),
        ...(node.error ? { error: node.error } : {}),
      });
    }
    this.edges = (Array.isArray(snapshot?.edges) ? snapshot.edges : [])
      .filter((e) => e && typeof e.id === "string" && this.nodes.has(e.source) && this.nodes.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourceHandle ?? null,
        target: e.target,
        targetHandle: e.targetHandle ?? null,
        ...(isRecord(e.data) ? { data: { ...e.data } } : {}),
      }));
    this.groups = (Array.isArray(snapshot?.groups) ? snapshot.groups : []).map(parseGroup).filter((g): g is DraftGroup => !!g);
    this.selectedNodeIds = (Array.isArray(snapshot?.selectedNodeIds) ? snapshot.selectedNodeIds : []).filter((id) => this.nodes.has(id));
    this.viewport = isRecord(snapshot?.viewport) ? { ...snapshot.viewport } : undefined;
    this.workflowName = typeof snapshot?.workflowName === "string" ? snapshot.workflowName : undefined;
    this.nextSuffix = nextAgentSuffix([...this.nodes.keys()]);
    this.initialNodeIds = new Set(this.nodes.keys());
    this.savedDefaults = isRecord(snapshot?.nodeDefaults) ? snapshot.nodeDefaults : undefined;
  }

  getNode(id: string): DraftNode | undefined {
    return this.nodes.get(id);
  }

  getGroup(id: string | undefined): DraftGroup | undefined {
    return id ? this.groups.find((g) => g.id === id) : undefined;
  }

  /** The group whose box holds this point (the first one, like the canvas's drop rule). */
  groupAt(point: { x: number; y: number }): DraftGroup | undefined {
    return this.groups.find((g) => {
      const box = groupBox(g);
      return !!box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height;
    });
  }

  /** Every group box, as layout obstacles. */
  groupBoxes(): LayoutBox[] {
    return this.groups.map(groupBox).filter((b): b is LayoutBox => !!b);
  }

  begin(): DraftTransaction {
    return new DraftTransaction(this);
  }

  /** Adopts a transaction's state. Call only when it has no errors. */
  commit(tx: DraftTransaction): void {
    if (tx.errors.length > 0) throw new Error("commit: transaction has errors");
    // Clearing removes every node; the canvas drops the groups that emptied and keeps the rest.
    if (tx.cleared) this.groups = this.groups.filter((g) => ![...this.nodes.values()].some((n) => n.groupId === g.id));
    this.nodes = tx.nodes;
    this.edges = tx.edges;
    this.nextSuffix = tx.nextSuffix;
    if (tx.cleared) this.refs.clear();
    for (const [ref, id] of tx.refs) this.refs.set(ref, id);
    this.selectedNodeIds = this.selectedNodeIds.filter((id) => this.nodes.has(id));
  }
}

export class DraftTransaction {
  nodes: Map<string, DraftNode>;
  edges: DraftEdge[];
  nextSuffix: number;
  readonly ops: AgentGraphOp[] = [];
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  readonly refs = new Map<string, string>();
  readonly log: TransactionLog = { created: [], changes: new Map(), removedNodes: [], addedEdges: [], removedEdges: [], moved: [], notes: [] };
  cleared = false;

  private readonly draft: GraphDraft;
  private readonly explicitPosition = new Set<string>();
  private readonly addOps = new Map<string, AddNodeOp>();
  private readonly deferred: Array<() => void> = [];
  private readonly touched = new Set<string>();
  /** Edges already broken (a missing handle, a mistyped Switch output) before this call: left alone. */
  private readonly preexistingBroken: Set<string>;
  /** Router/Switch edges already dormant before this call. */
  private readonly preexistingDormant: Set<string>;

  constructor(draft: GraphDraft) {
    this.draft = draft;
    this.nodes = new Map([...draft.nodes].map(([id, node]) => [id, cloneNode(node)]));
    this.edges = draft.edges.map(cloneEdge);
    this.nextSuffix = draft.nextSuffix;
    const states = new Map(this.edges.map((e) => [e.id, edgeState(e, this.nodes, this.edges)]));
    this.preexistingBroken = new Set([...states].filter(([, state]) => state === "missing" || state === "mistyped").map(([id]) => id));
    this.preexistingDormant = new Set([...states].filter(([, state]) => state === "dormant").map(([id]) => id));
  }

  get createdIds(): string[] {
    return this.log.created.map((c) => c.id).filter((id) => this.nodes.has(id));
  }

  get touchedIds(): string[] {
    return [...this.touched].filter((id) => this.nodes.has(id));
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** A node by ref (new in this call) or id; reports a helpful error when missing. */
  resolveNode(key: unknown, where: string, role = "node"): DraftNode | undefined {
    if (typeof key !== "string" || !key.trim()) {
      this.fail(where, `${role} is required (a node id from the canvas, or the ref of a node added in this call).`);
      return undefined;
    }
    const name = key.trim();
    const byRef = this.refs.get(name);
    if (byRef) return this.nodes.get(byRef);
    const byId = this.nodes.get(name);
    if (byId) return byId;
    // A ref from an earlier call this turn (the model often reuses them).
    const earlier = this.draft.refs.get(name);
    if (earlier && this.nodes.has(earlier)) return this.nodes.get(earlier);
    this.fail(where, `${role} "${name}" does not exist. ${this.suggestNodes(name)}`);
    return undefined;
  }

  private suggestNodes(name: string): string {
    const lower = name.toLowerCase();
    const matches = [...this.nodes.values()]
      .filter((n) => n.id.toLowerCase().includes(lower) || lower.includes(n.type.toLowerCase()) || titleOf(n)?.toLowerCase() === lower)
      .slice(0, 5)
      .map((n) => `${n.id}${titleOf(n) ? ` ("${titleOf(n)}")` : ""}`);
    const refs = [...this.refs.keys()];
    const parts: string[] = [];
    if (matches.length > 0) parts.push(`Did you mean ${matches.join(", ")}?`);
    if (refs.length > 0) parts.push(`Refs defined so far in this call: ${refs.join(", ")}.`);
    if (parts.length === 0) parts.push("Use get_workflow to see node ids; a ref only exists after the node that defines it is added.");
    return parts.join(" ");
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Removes every node the draft knows about, one removeNode op each, so a
   * node the user adds while the turn runs survives. Nothing to do (and no
   * "replaced" canvas) when the canvas is already empty.
   */
  clearCanvas(): void {
    if (this.nodes.size === 0) return;
    for (const node of this.nodes.values()) {
      this.log.removedNodes.push(removedEntry(node));
      this.ops.push({ op: "removeNode", id: node.id });
    }
    this.nodes = new Map();
    this.edges = [];
    this.preexistingBroken.clear();
    this.preexistingDormant.clear();
    this.cleared = true;
  }

  addNode(input: AddNodeInput, where: string): DraftNode | undefined {
    const type = typeof input.type === "string" ? findNodeType(input.type) : undefined;
    if (!type) {
      this.fail(where, `unknown node type ${JSON.stringify(input.type)}. Types: ${NODE_TYPES.join(", ")}.`);
      return undefined;
    }
    const entry = NODE_CATALOG[type];
    if (!entry.agentCreatable) {
      this.fail(where, `${entry.displayName} nodes cannot be added by the agent. ${entry.notes[0] ?? ""}`.trim());
      return undefined;
    }
    const ref = typeof input.ref === "string" ? input.ref.trim() : "";
    if (ref) {
      if (this.refs.has(ref)) {
        this.fail(where, `ref "${ref}" is used twice in this call; give every new node its own ref.`);
        return undefined;
      }
      if (this.nodes.has(ref)) {
        this.fail(where, `ref "${ref}" is already the id of a node on the canvas; pick a different ref.`);
        return undefined;
      }
    }

    const id = this.allocateId(type);
    const size = { ...defaultNodeDimensions[type], height: estimatedNodeHeight(type) };
    const defaults = this.draft.options.createDefaultNodeData(type);
    const node: DraftNode = {
      id,
      type,
      position: { x: 0, y: 0 },
      width: size.width,
      height: size.height,
      data: agentView(type, defaults),
    };
    // Switch outputs and rules are handle ids: the browser must get the same
    // ones, so they are always sent. When the call supplies its own list the
    // default entry is not created at all.
    const opData: Record<string, unknown> = {};
    if (type === "switch") opData.switches = hasSetting(input.settings, "switches") ? [] : this.freshSwitches();
    if (type === "conditionalSwitch") opData.rules = hasSetting(input.settings, "rules") ? [] : this.freshRules();
    node.data = agentView(type, { ...node.data, ...cloneJson(opData) });

    this.nodes.set(id, node);
    const op: AddNodeOp = { op: "addNode", id, nodeType: type, position: { x: 0, y: 0 }, data: opData };
    this.ops.push(op);
    this.addOps.set(id, op);
    this.log.created.push({ id, type, ...(ref ? { ref } : {}) });
    this.touched.add(id);
    if (ref) this.refs.set(ref, id);

    if (input.position) {
      if (this.checkPosition(input.position, where)) {
        node.position = { x: Math.round(input.position.x), y: Math.round(input.position.y) };
        op.position = { ...node.position };
        this.explicitPosition.add(id);
        this.regroup(node);
      }
    }
    if (input.title !== undefined || input.settings) {
      this.applyNodeChanges(node, input.title, input.settings, where);
    }
    return node;
  }

  updateNode(key: unknown, title: unknown, settings: Record<string, unknown> | undefined, where: string): void {
    const node = this.resolveNode(key, where);
    if (!node) return;
    if (title === undefined && (!settings || Object.keys(settings).length === 0)) {
      this.fail(where, `nothing to change on ${node.id}: pass settings and/or title.`);
      return;
    }
    this.applyNodeChanges(node, title, settings, where);
  }

  removeNode(key: unknown, where: string): void {
    const node = this.resolveNode(key, where);
    if (!node) return;
    for (const edge of this.edges.filter((e) => e.source === node.id || e.target === node.id)) {
      // applyGraphOps drops a removed node's edges itself; only the draft needs
      // updating. A Switch this node fed still forgets its type in the browser too.
      this.dropEdge(edge, undefined, false, edge.target !== node.id);
    }
    this.nodes.delete(node.id);
    this.touched.delete(node.id);
    this.log.removedNodes.push(removedEntry(node));
    this.ops.push({ op: "removeNode", id: node.id });
    for (const [ref, id] of this.refs) if (id === node.id) this.refs.delete(ref);
  }

  moveNode(key: unknown, position: unknown, where: string): void {
    const node = this.resolveNode(key, where);
    if (!node) return;
    if (!this.checkPosition(position, where)) return;
    const next = { x: Math.round((position as { x: number }).x), y: Math.round((position as { y: number }).y) };
    node.position = next;
    const membership = this.regroup(node);
    const addOp = this.addOps.get(node.id);
    if (addOp) {
      addOp.position = { ...next };
      this.explicitPosition.add(node.id);
    } else {
      const op: MoveNodeOp = { op: "moveNode", id: node.id, position: { ...next }, ...(membership ? { groupId: membership.groupId } : {}) };
      this.ops.push(op);
    }
    this.log.moved.push(node.id);
  }

  /**
   * After an explicit move, the node belongs to the group whose box holds its
   * centre (the canvas's drop rule). Updates the draft and a new node's
   * addNode op, reports the change, and returns it for a moveNode op.
   */
  private regroup(node: DraftNode): { groupId: string | null } | undefined {
    const current = node.groupId;
    // Without the old group's box nothing says the node left it.
    if (current && this.draft.getGroup(current) && !groupBox(this.draft.getGroup(current)!)) return undefined;
    const next = this.draft.groupAt(centerOf(node));
    if (next?.id === current || (!next && !this.draft.getGroup(current))) return undefined;
    if (current) {
      const left = this.draft.getGroup(current);
      this.log.notes.push(`${node.id} left group "${left?.name ?? current}"${left?.locked ? " (a locked group, so it runs again)" : ""}.`);
    }
    if (next) {
      if (next.locked) this.warnings.push(`${node.id} is now in locked group "${next.name}": it will not run until the user unlocks the group.`);
      else this.log.notes.push(`${node.id} joined group "${next.name}".`);
      node.groupId = next.id;
    } else {
      delete node.groupId;
    }
    const addOp = this.addOps.get(node.id);
    if (addOp) {
      if (next) addOp.groupId = next.id;
      else delete addOp.groupId;
    }
    return { groupId: next?.id ?? null };
  }

  /** Moves an existing node without it counting as the agent's explicit choice (arrange). */
  arrangeNode(id: string, position: { x: number; y: number }): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (node.position.x === position.x && node.position.y === position.y) return;
    node.position = { ...position };
    this.ops.push({ op: "moveNode", id, position: { ...position } });
    this.log.moved.push(id);
  }

  connect(input: ConnectInput, where: string, allowDefer = true): void {
    const source = this.resolveNode(input.from, where, "from");
    const target = this.resolveNode(input.to, where, "to");
    if (!source || !target) return;

    const plan = planConnection({
      source,
      target,
      fromHandle: input.fromHandle,
      toHandle: input.toHandle,
      nodes: this.nodes,
      edges: this.edges,
    });
    if (!plan.ok) {
      if (plan.awaitingInput && allowDefer) {
        // A router/switch output appears once its input is connected, which a
        // later operation in this call may do.
        this.deferred.push(() => this.connect(input, where, false));
        return;
      }
      this.fail(where, plan.error);
      return;
    }
    const label = `${source.id}.${plan.sourceHandle.id} → ${target.id}.${plan.targetHandle.id}`;
    if (plan.duplicate) {
      this.log.notes.push(`${label} was already connected.`);
      return;
    }
    // Edges into the target never lie on a path from it, so they cannot change this.
    const cycle = wouldCreateCycle(source.id, target.id, this.edges);
    // A loop edge sits next to the forward edge on the same input, as on the canvas.
    const replaces = cycle && input.loop ? [] : plan.replaces;
    if (source.type === "conditionalSwitch") {
      // Its outputs gate execution but carry no text (connectedInputs.ts).
      if (replaces.length > 0) {
        this.fail(
          where,
          `${source.id} (Conditional Switch) gates nodes but passes no text, so connecting it to ${target.id}.${plan.targetHandle.id} would replace the text from ${replaces[0].source} with nothing. Connect the rule output to the text input of the Prompt that should only run on a match (rule → Prompt → ${target.id}).`,
        );
        return;
      }
      if (GENERATOR_TYPES.has(target.type)) {
        this.warnings.push(`${label}: a Conditional Switch passes no text, so ${target.id} gets no prompt from it. Usually: rule output → Prompt (text input) → ${target.id}.`);
      }
    }

    const edgeData: Record<string, unknown> = {};
    if (cycle) {
      if (!input.loop) {
        this.fail(
          where,
          `connecting ${source.id} → ${target.id} would create a cycle (${target.id} already feeds ${source.id}). Workflows run left to right; only pass loop: true if the user asked for a loop that re-runs part of the graph.`,
        );
        return;
      }
      const count = input.loopCount ?? LOOP_COUNT_DEFAULT;
      if (!Number.isInteger(count) || count < 1 || count > LOOP_COUNT_MAX) {
        this.fail(where, `loopCount must be a whole number from 1 to ${LOOP_COUNT_MAX}.`);
        return;
      }
      edgeData.isLoop = true;
      edgeData.loopCount = count;
    } else if (input.loop) {
      this.warnings.push(`${label} does not close a cycle, so it was connected as a normal edge (loop ignored).`);
    }

    if (source.type === "array" && plan.sourceHandle.id === "text") {
      const index = input.arrayItemIndex ?? this.nextArrayItemIndex(source);
      if (!Number.isInteger(index) || index < 0) {
        this.fail(where, "arrayItemIndex must be a whole number ≥ 0 (0 is the first item).");
        return;
      }
      edgeData.arrayItemIndex = index;
    } else if (input.arrayItemIndex !== undefined) {
      this.warnings.push(`${label}: arrayItemIndex only applies to connections from an Array node; ignored.`);
    }

    for (const replaced of replaces) {
      this.dropEdge(replaced, `replaced by ${source.id}`);
    }
    if (plan.switchInputType && target.data.inputType !== plan.switchInputType) {
      target.data.inputType = plan.switchInputType;
      this.emitUpdate(target.id, { inputType: plan.switchInputType });
    }

    const edge: DraftEdge = {
      id: edgeIdFor(source.id, plan.sourceHandle.id, target.id, plan.targetHandle.id),
      source: source.id,
      sourceHandle: plan.sourceHandle.id,
      target: target.id,
      targetHandle: plan.targetHandle.id,
      ...(Object.keys(edgeData).length > 0 ? { data: edgeData as DraftEdge["data"] } : {}),
    };
    this.addEdge(edge);
  }

  disconnect(input: DisconnectInput, where: string): void {
    if (input.edgeId) {
      const edge = this.edges.find((e) => e.id === input.edgeId);
      if (!edge) {
        this.fail(where, `no connection with id "${input.edgeId}". Use get_workflow to list connections, or disconnect by from/to.`);
        return;
      }
      this.dropEdge(edge);
      return;
    }
    if (!input.from && !input.to) {
      this.fail(where, "disconnect needs from and/or to (node ids or refs), or an edgeId.");
      return;
    }
    const source = input.from ? this.resolveNode(input.from, where, "from") : undefined;
    const target = input.to ? this.resolveNode(input.to, where, "to") : undefined;
    if ((input.from && !source) || (input.to && !target)) return;

    // A handle may be named by id, data type, label ("Neg. Prompt", a switch
    // output's name, a rule's label) or schema name.
    const matchesHandle = (handleId: string | null, wanted: string | undefined, nodeId: string, side: "in" | "out") => {
      if (!wanted) return true;
      if (handleId === wanted || getHandleType(handleId) === wanted) return true;
      const node = this.nodes.get(nodeId);
      if (!node) return false;
      const handles = side === "in" ? getInputHandles(node, this.edges) : getOutputHandles(node, this.edges);
      const handle = handles.find((h) => h.id === handleId);
      const key = wanted.toLowerCase();
      return !!handle && (handle.label.toLowerCase() === key || handle.schemaName?.toLowerCase() === key || handle.type === wanted);
    };
    const matches = this.edges.filter(
      (e) =>
        (!source || e.source === source.id) &&
        (!target || e.target === target.id) &&
        matchesHandle(e.sourceHandle, input.fromHandle, e.source, "out") &&
        matchesHandle(e.targetHandle, input.toHandle, e.target, "in"),
    );
    if (matches.length === 0) {
      const around = this.edges
        .filter((e) => (source && (e.source === source.id || e.target === source.id)) || (target && (e.source === target.id || e.target === target.id)))
        .slice(0, 12)
        .map(describeEdge);
      this.fail(where, `no matching connection${source ? ` from ${source.id}` : ""}${target ? ` to ${target.id}` : ""}. ${around.length > 0 ? `Connections there: ${around.join("; ")}.` : "Those nodes have no connections."}`);
      return;
    }
    for (const edge of matches) this.dropEdge(edge);
  }

  /**
   * Runs deferred connections, removes connections whose handles no longer
   * exist, lays out new nodes and collects warnings. Call once, last.
   */
  finish(): void {
    const deferred = this.deferred.splice(0);
    for (const run of deferred) run();
    if (this.errors.length > 0) return;
    this.sweepDanglingEdges();
    this.layoutCreatedNodes();
    this.lint();
    this.noteDefaults();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private fail(where: string, message: string): void {
    this.errors.push(where ? `${where}: ${message}` : message);
  }

  private allocateId(type: NodeType): string {
    let id: string;
    do {
      id = `${type}-ag${(this.nextSuffix++).toString(36)}`;
    } while (this.nodes.has(id));
    return id;
  }

  private freshSwitches(): Array<{ id: string; name: string; enabled: boolean }> {
    return [{ id: this.draft.options.randomId(), name: "Output 1", enabled: true }];
  }

  private freshRules(): Array<{ id: string; value: string; mode: string; label: string; isMatched: boolean }> {
    return [{ id: `rule-${this.draft.options.randomId()}`, value: "", mode: "contains", label: "Rule 1", isMatched: false }];
  }

  private checkPosition(position: unknown, where: string): boolean {
    const p = position as { x?: unknown; y?: unknown } | undefined;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      this.fail(where, "position must be {x, y} numbers in canvas coordinates.");
      return false;
    }
    return true;
  }

  private applyNodeChanges(node: DraftNode, title: unknown, settings: Record<string, unknown> | undefined, where: string): void {
    const combined: Record<string, unknown> = { ...(settings ?? {}) };
    if (title !== undefined) combined.title = title;
    const outcome = resolveSettings(node, combined, { newId: this.draft.options.randomId });
    if (outcome.errors.length > 0) {
      for (const error of outcome.errors) this.fail(where, error);
      return;
    }
    if (Object.keys(outcome.patch).length === 0) return;
    const before = cloneNode(node);
    // Keep the draft's view of the node exactly what the next snapshot will show.
    node.data = agentView(node.type, { ...node.data, ...cloneJson(outcome.patch) });
    this.emitUpdate(node.id, outcome.patch);
    this.recordChanges(node.id, outcome);
    this.touched.add(node.id);
    if (outcome.handlesMayChange && (node.type === "generateVideo" || node.type === "generate3d")) {
      this.remapSchemaEdges(node, before);
    }
  }

  private recordChanges(id: string, outcome: SettingsOutcome): void {
    const list = this.log.changes.get(id) ?? [];
    list.push(...outcome.changes);
    this.log.changes.set(id, list);
    this.warnings.push(...outcome.warnings);
  }

  /** Shallow data patch for the browser; folded into the node's addNode op when it is new. */
  private emitUpdate(id: string, patch: Record<string, unknown>): void {
    const data = cloneJson(patch);
    const addOp = this.addOps.get(id);
    if (addOp && this.nodes.has(id)) {
      Object.assign(addOp.data, data);
      return;
    }
    const last = this.ops[this.ops.length - 1];
    if (last && last.op === "updateNode" && last.id === id) {
      Object.assign(last.data, data);
      return;
    }
    this.ops.push({ op: "updateNode", id, data });
  }

  private addEdge(edge: DraftEdge): void {
    this.edges.push(edge);
    this.ops.push({
      op: "addEdge",
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? "",
      target: edge.target,
      targetHandle: edge.targetHandle ?? "",
      ...(edge.data ? { data: cloneJson(edge.data) as Record<string, unknown> } : {}),
    });
    this.log.addedEdges.push(edge);
    this.touched.add(edge.source);
    this.touched.add(edge.target);
  }

  /**
   * Removes an edge from the draft and, unless `emit` is false, from the
   * browser. `emitSideEffects` still sends what follows from the removal
   * (a Switch forgetting its type) when the edge itself goes with its node.
   */
  private dropEdge(edge: DraftEdge, reason?: string, emit = true, emitSideEffects = emit): void {
    const index = this.edges.indexOf(edge);
    if (index === -1) return;
    this.edges.splice(index, 1);
    if (emit) this.ops.push({ op: "removeEdge", id: edge.id });
    const added = this.log.addedEdges.indexOf(edge);
    if (added !== -1) this.log.addedEdges.splice(added, 1);
    else this.log.removedEdges.push({ edge, ...(reason ? { reason } : {}) });
    this.touched.add(edge.target);

    // A Switch forgets its type when its input goes (the node does the same).
    const target = this.nodes.get(edge.target);
    if (target?.type === "switch" && !this.edges.some((e) => e.target === target.id) && target.data.inputType) {
      target.data.inputType = null;
      if (emitSideEffects) this.emitUpdate(target.id, { inputType: null });
    }
  }

  /**
   * After a model change on a schema-driven node, move each incoming edge to
   * the matching new handle (text → text-0, image → image-0, …) or drop it
   * when the model takes no input of that type.
   */
  private remapSchemaEdges(node: DraftNode, before: DraftNode): void {
    const incoming = this.edges.filter((e) => e.target === node.id);
    if (incoming.length === 0) return;
    const inputs = getInputHandles(node, this.edges);
    const live = inputs.filter((h) => !h.hidden && !h.unused);
    const taken = new Set<string>();
    const pending: DraftEdge[] = [];
    // Loop edges do not occupy an input: they follow the forward edges below.
    const loops = incoming.filter((e) => e.data?.isLoop);
    // A slot that collects many connections (Omni's reference images) is never full.
    const free = (h: NodeHandle) => h.multi || !taken.has(h.id);
    for (const edge of incoming.filter((e) => !e.data?.isLoop)) {
      const handle = live.find((h) => h.id === edge.targetHandle);
      if (handle && free(handle)) taken.add(handle.id);
      else pending.push(edge);
    }
    const modelName = (node.data.selectedModel as { displayName?: string } | undefined)?.displayName ?? "the new model";
    for (const edge of pending) {
      const oldHandle = getInputHandles(before, this.edges).find((h) => h.id === edge.targetHandle);
      const type = oldHandle?.type ?? getHandleType(edge.targetHandle);
      const index = Number(edge.targetHandle?.match(/-(\d+)$/)?.[1] ?? 0);
      const candidates = live.filter((h) => h.type === type && free(h));
      const slot: NodeHandle | undefined = candidates.find((h) => h.id === `${type}-${index}`) ?? candidates[0];
      const movedId = slot ? edgeIdFor(edge.source, edge.sourceHandle, node.id, slot.id) : undefined;
      if (slot && movedId && this.edges.some((e) => e.id === movedId)) {
        // The same source already feeds that slot: this edge is a duplicate of it.
        this.dropEdge(edge, undefined);
        continue;
      }
      if (slot && movedId) {
        taken.add(slot.id);
        this.dropEdge(edge, undefined);
        const moved: DraftEdge = { ...cloneEdge(edge), id: movedId, targetHandle: slot.id };
        this.addEdge(moved);
        this.log.notes.push(`Moved ${edge.source} → ${node.id} from input "${edge.targetHandle}" to "${slot.id}" (${slot.label}) to match ${modelName}.`);
        continue;
      }
      const placeholder = inputs.find((h) => h.unused && h.id === edge.targetHandle);
      if (placeholder) {
        this.warnings.push(`${node.id}: ${modelName} does not use its ${placeholder.type} input, so the connection from ${edge.source} is ignored.`);
        continue;
      }
      this.dropEdge(edge, `${modelName} has no ${type ?? edge.targetHandle} input`);
      this.warnings.push(`Removed ${edge.source} → ${node.id} (${type ?? edge.targetHandle}): ${modelName} has no ${type ?? "such"} input.`);
    }
    for (const edge of loops) {
      if (live.some((h) => h.id === edge.targetHandle)) continue;
      const oldHandle = getInputHandles(before, this.edges).find((h) => h.id === edge.targetHandle);
      const type = oldHandle?.type ?? getHandleType(edge.targetHandle);
      const index = Number(edge.targetHandle?.match(/-(\d+)$/)?.[1] ?? 0);
      const candidates = live.filter((h) => h.type === type);
      const slot = candidates.find((h) => h.id === `${type}-${index}`) ?? candidates[0];
      const movedId = slot ? edgeIdFor(edge.source, edge.sourceHandle, node.id, slot.id) : undefined;
      if (slot && movedId && !this.edges.some((e) => e.id === movedId)) {
        this.dropEdge(edge, undefined);
        this.addEdge({ ...cloneEdge(edge), id: movedId, targetHandle: slot.id });
        this.log.notes.push(`Moved the loop ${edge.source} → ${node.id} from input "${edge.targetHandle}" to "${slot.id}" (${slot.label}) to match ${modelName}.`);
        continue;
      }
      if (inputs.some((h) => h.unused && h.id === edge.targetHandle)) continue;
      this.dropEdge(edge, `${modelName} has no ${type ?? edge.targetHandle} input`);
      this.warnings.push(`Removed the loop ${edge.source} → ${node.id} (${type ?? edge.targetHandle}): ${modelName} has no ${type ?? "such"} input.`);
    }
  }

  /**
   * Removes the connections this call broke: a handle that no longer exists,
   * or a Switch output whose type changed under it. A Router or Switch output
   * whose input went is only dormant: the canvas keeps those connections and
   * they carry data again once an input of that type is connected.
   */
  private sweepDanglingEdges(): void {
    const newlyDormant = new Map<string, DraftEdge[]>();
    for (const edge of [...this.edges]) {
      if (this.preexistingBroken.has(edge.id)) continue;
      const state = edgeState(edge, this.nodes, this.edges);
      if (state === "live") continue;
      if (state === "dormant") {
        if (!this.preexistingDormant.has(edge.id)) newlyDormant.set(edge.source, [...(newlyDormant.get(edge.source) ?? []), edge]);
        continue;
      }
      if (state === "mistyped") {
        const source = this.nodes.get(edge.source)!;
        const target = this.nodes.get(edge.target)!;
        const routes = switchInputType(source, this.edges);
        const takes = getInputHandles(target, this.edges).find((h) => h.id === edge.targetHandle)?.type ?? getHandleType(edge.targetHandle);
        this.dropEdge(edge, `${source.id} now routes ${routes}`);
        this.warnings.push(`Removed ${describeEdge(edge)}: ${source.id} now routes ${routes}, and that input takes ${takes}.`);
        continue;
      }
      this.dropEdge(edge, "its handle no longer exists");
      this.warnings.push(`Removed ${describeEdge(edge)}: that handle no longer exists after this change.`);
    }
    for (const [sourceId, edges] of newlyDormant) {
      const source = this.nodes.get(sourceId)!;
      const kind = source.type === "router" ? "Router" : "Switch";
      const type = source.type === "router" ? edges[0].sourceHandle : undefined;
      this.warnings.push(
        `${sourceId} (${kind}) has no ${type ? `${type} ` : ""}input now, so its connections to ${edges.map((e) => e.target).join(", ")} stay on the canvas but carry nothing until ${type ? `a ${type}` : "an"} input is connected to ${sourceId} again.`,
      );
    }
  }

  private layoutCreatedNodes(): void {
    const toPlace = this.createdIds.filter((id) => !this.explicitPosition.has(id));
    if (toPlace.length === 0) return;
    const placing = new Set(toPlace);
    // Group boxes are obstacles: a node placed inside one would look like a
    // member without being one. After a clear, only groups that had no nodes
    // stay on the canvas.
    const emptied = new Set(this.cleared ? [...this.draft.nodes.values()].map((n) => n.groupId).filter(Boolean) : []);
    const fixed: LayoutBox[] = [
      ...[...this.nodes.values()]
        .filter((n) => !placing.has(n.id))
        .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, width: n.width, height: n.height })),
      ...this.draft.groupBoxes().filter((box) => !emptied.has(box.id.slice("group:".length))),
    ];
    const positions = placeNewNodes({
      place: toPlace.map((id) => ({ id, width: this.nodes.get(id)!.width, height: this.nodes.get(id)!.height })),
      fixed,
      edges: this.edges.map((e) => ({ source: e.source, target: e.target, isLoop: !!e.data?.isLoop })),
      viewport: this.draft.viewport,
    });
    for (const [id, position] of positions) {
      this.nodes.get(id)!.position = position;
      const op = this.addOps.get(id);
      if (op) op.position = { ...position };
    }
  }

  /** Array fan-out: the next item index, like the store's `buildConnectionEdgeData`. */
  private nextArrayItemIndex(arrayNode: DraftNode): number {
    const selected = arrayNode.data.selectedOutputIndex;
    const items = this.arrayItems(arrayNode);
    const count = items?.length ?? 0;
    if (typeof selected === "number" && Number.isInteger(selected) && selected >= 0 && (count === 0 || selected < count)) {
      return selected;
    }
    const outgoing = this.edges.filter((e) => e.source === arrayNode.id && (e.sourceHandle || "text") === "text");
    const lastIndex = outgoing[outgoing.length - 1]?.data?.arrayItemIndex;
    // Number the connections 0, 1, 2… even past a known item count (the
    // runtime wraps indices anyway): once the split is fixed, every connection
    // still gets its own item. lint() reports a count that does not match.
    return typeof lastIndex === "number" && Number.isInteger(lastIndex) && lastIndex >= 0 ? lastIndex + 1 : outgoing.length;
  }

  /** The items an Array node will produce, when they can be known from here. */
  arrayItems(arrayNode: DraftNode): string[] | null {
    const edge = this.edges.find((e) => e.target === arrayNode.id && (e.targetHandle || "text") === "text");
    const source = edge ? this.nodes.get(edge.source) : undefined;
    if (source?.type === "prompt" && typeof source.data.prompt === "string" && !isTruncatedText(source.data.prompt)) {
      const parsed = parseTextToArray(source.data.prompt, {
        splitMode: (arrayNode.data.splitMode as "delimiter" | "newline" | "regex") ?? "delimiter",
        delimiter: typeof arrayNode.data.delimiter === "string" ? arrayNode.data.delimiter : "*",
        regexPattern: typeof arrayNode.data.regexPattern === "string" ? arrayNode.data.regexPattern : "",
        trimItems: arrayNode.data.trimItems !== false,
        removeEmpty: arrayNode.data.removeEmpty !== false,
      });
      return parsed.error ? null : parsed.items;
    }
    const items = arrayNode.data.outputItems;
    return Array.isArray(items) && items.length > 0 && typeof arrayNode.data.outputItemCount !== "number"
      ? (items as string[])
      : null;
  }

  /** Non-blocking checks on the nodes this call touched (and the ones their changes reach). */
  private lint(): void {
    const ids = new Set(this.touchedIds);
    for (const id of [...ids]) {
      if (this.nodes.get(id)?.type !== "prompt") continue;
      // A Prompt's text is what the Array it feeds splits, and an LLM's whole instruction.
      for (const edge of this.edges) {
        if (edge.source !== id || edge.data?.isLoop) continue;
        const type = this.nodes.get(edge.target)?.type;
        if (type === "array" || type === "llmGenerate") ids.add(edge.target);
      }
    }
    for (const id of ids) {
      const node = this.nodes.get(id)!;
      // Loop edges and Router/Switch outputs with no input deliver nothing.
      const inputs = this.edges.filter((e) => e.target === id && !e.data?.isLoop && edgeState(e, this.nodes, this.edges) !== "dormant");
      const has = (predicate: (handle: string) => boolean) => inputs.some((e) => predicate(e.targetHandle ?? ""));
      const isText = (h: string) => h === "text" || h.startsWith("text-");
      const selected = node.data.selectedModel as { modelId?: string; displayName?: string } | undefined;
      switch (node.type) {
        case "nanoBanana":
          if (!has(isText)) this.warnings.push(`${id} (Generate Image) has no text input yet; it will not run until a prompt is connected.`);
          break;
        case "llmGenerate":
          if (!has(isText)) this.warnings.push(`${id} (LLM Generate) has no text input yet; it will not run until a prompt is connected.`);
          this.lintLLMInstruction(node, inputs);
          break;
        case "generateVideo":
          if (!selected?.modelId) this.warnings.push(`${id} (Generate Video) has no model: set model to a Gemini video model (Veo or Gemini Omni), or tell the user to pick one in the node (their saved default may apply).`);
          if (inputs.length === 0) this.warnings.push(`${id} (Generate Video) has no inputs yet; connect a prompt (and an image for image-to-video).`);
          else if (selected?.modelId?.includes("image-to-video") && !has((h) => h.startsWith("image"))) {
            this.warnings.push(`${id} uses an image-to-video model but has no image connected.`);
          }
          break;
        case "generate3d":
        case "generateAudio":
          if (!selected?.modelId) this.warnings.push(`${id} (${NODE_CATALOG[node.type].displayName}) needs a model: tell the user to pick one in the node (needs a fal, Replicate, Kie or ComfyUI key).`);
          break;
        case "array":
          this.lintArray(node, inputs);
          break;
        case "output":
        case "outputGallery":
        case "imageCompare":
        case "annotation":
        case "splitGrid":
        case "videoTrim":
        case "videoFrameGrab":
        case "removeBackground":
        case "imageResize":
        case "videoStitch":
        case "gifEncoder":
        case "easeCurve":
        case "glbViewer":
        case "router":
        case "switch":
        case "conditionalSwitch":
          if (inputs.length === 0) this.warnings.push(`${id} (${NODE_CATALOG[node.type].displayName}) has nothing connected to its input yet.`);
          break;
        case "imageInput":
          if (this.log.created.some((c) => c.id === id)) this.warnings.push(`${id} (Image Input) is empty: the user must upload an image into it.`);
          break;
        case "audioInput":
        case "videoInput":
          if (this.log.created.some((c) => c.id === id) && inputs.length === 0) {
            this.warnings.push(`${id} (${NODE_CATALOG[node.type].displayName}) is empty: the user must upload a file into it.`);
          }
          break;
        case "promptConstructor":
          this.lintTemplate(node);
          break;
        case "prompt": {
          const upstream = inputs.find((e) => (e.targetHandle || "text") === "text");
          if (upstream && this.deliversText(upstream.source) && this.log.changes.get(id)?.some((change) => /^prompt[= ]/.test(change))) {
            this.warnings.push(`${id} receives text from ${upstream.source}, which overwrites its prompt whenever that node produces new text.`);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Whether text from `nodeId` reaches what it is connected to at run time
   * (getConnectedInputsPure): a Conditional Switch passes none, it only gates;
   * a Router or Switch passes on whatever reaches it.
   */
  private deliversText(nodeId: string, seen = new Set<string>()): boolean {
    if (seen.has(nodeId)) return false;
    seen.add(nodeId);
    const node = this.nodes.get(nodeId);
    if (!node || node.type === "conditionalSwitch") return false;
    if (node.type !== "router" && node.type !== "switch") return true;
    return this.edges.some((e) => e.target === nodeId && e.targetHandle === "text" && !e.data?.isLoop && this.deliversText(e.source, seen));
  }

  /**
   * Port of resolveTextSourcesThroughRouters (connectedInputs.ts), which the
   * Prompt Constructor's executor uses: Routers and Switches are replaced by
   * the text sources that feed them.
   */
  private resolveTextSources(sources: DraftNode[], seen = new Set<string>()): DraftNode[] {
    const resolved: DraftNode[] = [];
    for (const source of sources) {
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      if (source.type === "router" || source.type === "switch") {
        const upstream = this.edges
          .filter((e) => e.target === source.id && e.targetHandle === "text")
          .map((e) => this.nodes.get(e.source))
          .filter((n): n is DraftNode => !!n);
        resolved.push(...this.resolveTextSources(upstream, seen));
      } else {
        resolved.push(source);
      }
    }
    return resolved;
  }

  /** Mirrors executePromptConstructor: which @names its template can fill. */
  private lintTemplate(node: DraftNode): void {
    const template = typeof node.data.template === "string" ? node.data.template : "";
    const used = [...new Set([...template.matchAll(/@(\w+)/g)].map((m) => m[1]))];
    if (used.length === 0) return;
    const direct = this.edges
      .filter((e) => e.target === node.id && e.targetHandle === "text")
      .map((e) => this.nodes.get(e.source))
      .filter((n): n is DraftNode => !!n);
    const sources = this.resolveTextSources(direct);
    const available = new Set<string>();
    for (const source of sources) {
      if (source.type === "prompt" && typeof source.data.variableName === "string" && source.data.variableName) available.add(source.data.variableName);
      // Inline <var="x">value</var> tags in connected text fill @x too.
      const text = source.type === "prompt" ? source.data.prompt : source.type === "promptConstructor" ? source.data.template : undefined;
      if (typeof text === "string") for (const tag of parseVarTags(text)) available.add(tag.name);
    }
    const missing = used.filter((name) => !available.has(name));
    if (missing.length === 0) return;
    const names = missing.map((m) => `@${m}`).join(", ");
    // An LLM's output is only known at run time; it may carry <var> tags.
    const llms = sources.filter((s) => s.type === "llmGenerate").map((s) => s.id);
    if (llms.length > 0) {
      this.warnings.push(`${node.id} (Prompt Constructor) uses ${names}, which no connected Prompt (directly or through a Router/Switch) names; it stays unresolved unless ${llms.join(", ")} writes <var="${missing[0]}">…</var> in its output.`);
      return;
    }
    this.warnings.push(`${node.id} (Prompt Constructor) uses ${names} but no connected Prompt (directly or through a Router/Switch) has that variableName; set variableName on the Prompt that should fill it.`);
  }

  /**
   * An Array whose split does not match its fan-out: connection i reads item
   * i, and indices past the end wrap, so several nodes get the same text (all
   * of it, when the delimiter does not occur).
   */
  private lintArray(node: DraftNode, inputs: DraftEdge[]): void {
    if (inputs.length === 0) {
      this.warnings.push(`${node.id} (Array) has nothing connected to its input yet.`);
      return;
    }
    if (node.data.batchMode === true) return;
    const items = this.arrayItems(node);
    if (!items) return;
    const outgoing = this.edges.filter((e) => e.source === node.id && (e.sourceHandle || "text") === "text" && !e.data?.isLoop);
    if (outgoing.length === 0) return;
    const indices = outgoing.map((e) => (typeof e.data?.arrayItemIndex === "number" ? e.data.arrayItemIndex : 0));
    if (outgoing.length <= items.length && indices.every((i) => i < items.length)) return;
    const sourceEdge = this.edges.find((e) => e.target === node.id && (e.targetHandle || "text") === "text");
    const source = sourceEdge ? this.nodes.get(sourceEdge.source) : undefined;
    const mode = typeof node.data.splitMode === "string" ? node.data.splitMode : "delimiter";
    const delimiter = typeof node.data.delimiter === "string" ? node.data.delimiter : "*";
    const how = mode === "delimiter" ? `delimiter ${JSON.stringify(delimiter)}` : mode === "newline" ? "one item per line" : "its regex";
    const text = source?.type === "prompt" && typeof source.data.prompt === "string" ? source.data.prompt : undefined;
    let fix = ` Make the split match the list (delimiter, splitMode), or connect only ${items.length} node${items.length === 1 ? "" : "s"}.`;
    if (text !== undefined && mode === "delimiter" && !text.includes(delimiter)) {
      const lines = text.split("\n").filter((line) => line.trim()).length;
      const separator = [",", ";", "|"].find((c) => text.includes(c));
      if (lines > 1) fix = ` Its text has no ${JSON.stringify(delimiter)} but one item per line: set splitMode "newline".`;
      else if (separator) fix = ` Its text has no ${JSON.stringify(delimiter)}: set delimiter ${JSON.stringify(separator)} to split it.`;
    }
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    this.warnings.push(
      `${node.id} (Array) splits the text from ${source?.id ?? "its input"} into ${plural(items.length, "item")} (${how}), but its ${plural(outgoing.length, "connection")} read item${indices.length === 1 ? "" : "s"} ${indices.join(", ")}; indices past the end wrap around, so several nodes get the same text.${fix}`,
    );
  }

  /**
   * LLM Generate has no system prompt: the Prompt on its text input is its
   * whole instruction. A bare idea there makes it chat instead of writing the
   * image prompt, and instructions left in a comment never reach any model.
   */
  private lintLLMInstruction(node: DraftNode, inputs: DraftEdge[]): void {
    const comment = typeof node.data.comment === "string" ? node.data.comment : "";
    if (comment.length > 80 && INSTRUCTION_WORDS.test(comment)) {
      this.warnings.push(`${node.id} (LLM Generate) has instructions in its comment, but comments are never sent to any model; put them in the Prompt on its text input.`);
    }
    if (!this.feedsMediaGenerator(node.id)) return;
    const edge = inputs.find((e) => e.targetHandle === "text");
    const source = edge ? this.nodes.get(edge.source) : undefined;
    if (source?.type !== "prompt" || typeof source.data.prompt !== "string") return;
    const text = source.data.prompt.trim();
    if (!text || !looksLikeBareIdea(text)) return;
    this.warnings.push(
      `${node.id} (LLM Generate) receives only ${JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)} from ${source.id}, with no instruction. Put the task in that Prompt, e.g. "Write one detailed image-generation prompt (subject, setting, composition, lighting, style) for: <idea>. Reply with only the prompt." There is no system prompt, and comments are never sent to a model.`,
    );
  }

  /** Whether a node's text output reaches an image/video/3D/audio generator (through pass-through nodes). */
  private feedsMediaGenerator(nodeId: string): boolean {
    const seen = new Set<string>([nodeId]);
    let frontier = [nodeId];
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of this.edges) {
          if (edge.source !== id || edge.data?.isLoop || seen.has(edge.target)) continue;
          const target = this.nodes.get(edge.target);
          if (!target) continue;
          if (MEDIA_GENERATOR_TYPES.has(target.type)) return true;
          if (TEXT_PASS_THROUGH_TYPES.has(target.type)) {
            seen.add(target.id);
            next.push(target.id);
          }
        }
      }
      frontier = next;
    }
    return false;
  }

  /**
   * New nodes start from the user's saved defaults, which the model never
   * sees. Say where a new node's model and settings came from, so the reply
   * describes the node the user actually gets, and flag a model or resolution
   * the agent picked that differs from what new nodes default to.
   */
  private noteDefaults(): void {
    const fromSaved = new Map<string, string[]>();
    const chosen = new Map<string, string[]>();
    for (const created of this.log.created) {
      const node = this.nodes.get(created.id);
      const fields = node ? STICKY_FIELDS[node.type] : undefined;
      if (!node || !fields) continue;
      const browser = this.draft.options.createDefaultNodeData(node.type);
      const builtIn = createDefaultNodeData(node.type) as Record<string, unknown>;
      const changes = this.log.changes.get(node.id) ?? [];
      const kept: string[] = [];
      const picked: string[] = [];
      const defaults: string[] = [];
      let savedDefault = false;
      for (const field of fields) {
        const value = stickyValue(node.type, node.data, field);
        const newDefault = stickyValue(node.type, browser, field);
        const builtInDefault = stickyValue(node.type, builtIn, field);
        if (changes.some((change) => change.startsWith(`${field}=`))) {
          if (DISCLOSED_FIELDS.has(field) && newDefault && value !== newDefault) {
            picked.push(`${field} ${value}`);
            defaults.push(`${field} ${newDefault}`);
            savedDefault ||= newDefault !== builtInDefault;
          }
        } else if (value && value !== builtInDefault) {
          kept.push(`${field} ${value}`);
        }
      }
      if (kept.length > 0) {
        const key = kept.join(", ");
        fromSaved.set(key, [...(fromSaved.get(key) ?? []), node.id]);
      }
      if (picked.length > 0) {
        const key = `you set ${picked.join(" and ")}, but new ${NODE_CATALOG[node.type].displayName} nodes start with ${defaults.join(" and ")}${savedDefault ? " (the user's saved defaults)" : ""}`;
        chosen.set(key, [...(chosen.get(key) ?? []), node.id]);
      }
    }
    for (const [settings, ids] of fromSaved) {
      const several = settings.includes(",");
      this.log.notes.push(
        `${ids.join(", ")} ${ids.length === 1 ? "has" : "have"} the user's saved default${several ? "s" : ""} ${settings} (you did not set ${several ? "them" : "it"}); set ${several ? "them" : "it"} explicitly only if the user asked for something else, and describe the node as it is.`,
      );
    }
    for (const [text, ids] of chosen) {
      this.log.notes.push(`${ids.join(", ")}: ${text}. Name your choice in the reply, or leave it unset if the user did not ask for it.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function titleOf(node: GraphNodeLike): string | undefined {
  const title = node.data.customTitle;
  return typeof title === "string" && title ? title : undefined;
}

export function describeEdge(edge: GraphEdgeLike): string {
  return `${edge.source}.${edge.sourceHandle ?? "default"} → ${edge.target}.${edge.targetHandle ?? "default"}`;
}

function cloneNode(node: DraftNode): DraftNode {
  return {
    ...node,
    position: { ...node.position },
    data: cloneJson(node.data),
    ...(node.content ? { content: { ...node.content } } : {}),
  };
}

function cloneEdge(edge: DraftEdge): DraftEdge {
  return { ...edge, ...(edge.data ? { data: { ...edge.data } } : {}) };
}

/** Node data as the agent sees it (whitelisted fields plus the title). */
function agentView(type: NodeType, data: Record<string, unknown>): Record<string, unknown> {
  const view = pickAgentData(type, data);
  if (typeof data.customTitle === "string" && data.customTitle) view.customTitle = data.customTitle;
  return view;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseGroup(value: unknown): DraftGroup | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const position = value.position as { x?: unknown; y?: unknown } | undefined;
  const size = value.size as { width?: unknown; height?: unknown } | undefined;
  const hasBox =
    isRecord(position) && isRecord(size) &&
    [position.x, position.y, size.width, size.height].every((v) => typeof v === "number" && Number.isFinite(v)) &&
    (size.width as number) > 0 && (size.height as number) > 0;
  return {
    id: value.id,
    name: typeof value.name === "string" && value.name ? value.name : value.id,
    ...(typeof value.color === "string" ? { color: value.color } : {}),
    ...(hasBox
      ? { position: { x: position!.x as number, y: position!.y as number }, size: { width: size!.width as number, height: size!.height as number } }
      : {}),
    ...(value.locked === true ? { locked: true } : {}),
  };
}

function groupBox(group: DraftGroup): LayoutBox | undefined {
  if (!group.position || !group.size) return undefined;
  return { id: `group:${group.id}`, x: group.position.x, y: group.position.y, width: group.size.width, height: group.size.height };
}

function removedEntry(node: DraftNode): RemovedNode {
  return { id: node.id, type: node.type, ...(titleOf(node) ? { title: titleOf(node) } : {}), ...(node.content ? { content: { ...node.content } } : {}) };
}

/** Pass text on unchanged or re-split it: an LLM's words still reach what follows. */
const TEXT_PASS_THROUGH_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["router", "switch", "prompt", "array", "promptConstructor"]);
const INSTRUCTION_WORDS = /\b(write|describe|expand|reply|return|respond|answer|create|generate|rewrite|summari[sz]e|list|give|output|turn|translate|improve|craft|compose|produce|convert|suggest|explain)\b/i;

/** A short phrase with no task in it ("a cabin at sunset"), not an instruction. */
function looksLikeBareIdea(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words < 20 && !INSTRUCTION_WORDS.test(text) && !/\bonly\b/i.test(text);
}

/** Fields new nodes take from the user's saved defaults (store nodeDefaults.ts). */
const STICKY_FIELDS: Partial<Record<NodeType, readonly string[]>> = {
  nanoBanana: ["model", "aspectRatio", "resolution"],
  generateVideo: ["model"],
  llmGenerate: ["model"],
  generate3d: ["model"],
  generateAudio: ["model"],
};
/** The ones whose choice changes quality or cost enough that the user should hear about it. */
const DISCLOSED_FIELDS: ReadonlySet<string> = new Set(["model", "resolution"]);

function stickyValue(type: NodeType, data: Record<string, unknown>, field: string): string | undefined {
  if (field === "model" && type !== "llmGenerate") {
    const selected = data.selectedModel as { modelId?: unknown } | undefined;
    if (typeof selected?.modelId === "string" && selected.modelId) return selected.modelId;
    return type === "nanoBanana" && typeof data.model === "string" ? data.model : undefined;
  }
  const value = data[field];
  return typeof value === "string" && value ? value : undefined;
}

function centerOf(node: DraftNode): { x: number; y: number } {
  return { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
}

/**
 * New-node defaults as the browser will create them: the store's built-in
 * defaults with the user's saved ones (sent in the snapshot) on top. The
 * browser applies its own defaults to `addNode`, so these only keep what the
 * draft reports and validates against in step with what appears.
 */
function browserDefaults(saved: AgentWorkflowSnapshot["nodeDefaults"]): (type: NodeType) => Record<string, unknown> {
  return (type) => {
    const builtIn = createDefaultNodeData(type) as Record<string, unknown>;
    const override = isRecord(saved) ? saved[type] : undefined;
    return isRecord(override) ? { ...builtIn, ...cloneJson(override) } : builtIn;
  };
}

function hasSetting(settings: Record<string, unknown> | undefined, field: string): boolean {
  return !!settings && typeof settings === "object" && Object.keys(settings).some((key) => key.toLowerCase() === field.toLowerCase());
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One past the highest `-ag<base36>` suffix on the canvas, so ids never repeat a live one. */
function nextAgentSuffix(ids: string[]): number {
  let max = 0;
  for (const id of ids) {
    const match = id.match(/-ag([0-9a-z]+)$/);
    if (match) {
      const value = parseInt(match[1], 36);
      if (Number.isFinite(value)) max = Math.max(max, value);
    }
  }
  return max + 1;
}

function defaultRandomId(): string {
  return Math.random().toString(36).slice(2, 9).padEnd(7, "0");
}
