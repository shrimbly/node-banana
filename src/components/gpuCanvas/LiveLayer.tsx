"use client";

/**
 * The live layer: real React nodes (a real <ReactFlow> with the scene's
 * viewport) over the scene for the nodes being worked in: the hovered node,
 * selected nodes, the node holding focus, and every visible node above 100%
 * zoom. They are the canvas's own components, so typing, buttons and menus
 * work as they do today and write to the store. It also renders the
 * connections that show more than a line (labels, stubs, bundles, their
 * toolbars), with their strokes hidden: the scene draws every stroke. It is
 * the page's React Flow while the GPU canvas runs.
 *
 * A node's painted image stays in the scene until its live component has
 * been measured and its images decoded; only then is the scene's copy
 * hidden, so the swap shows no gap. A node leaving the layer waits until its
 * painted image is current (it may have been edited while live), then goes
 * back to the scene.
 */
import { useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { ReactFlow, useReactFlow, useStoreApi, type DefaultEdgeOptions, type Edge, type EdgeTypes, type Node, type NodeTypes, type OnEdgesChange, type ReactFlowState } from "@xyflow/react";
import { FloatingNodeHeaders } from "@/components/nodes/FloatingNodeHeaders";
import { HoldLiveProvider, type HoldLive } from "@/components/nodes/paintMode";
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "@/store/workflowStore";
import { indexOfNode } from "@/store/nodeChanges";
import type { Scene, View } from "@/lib/gpuCanvas/scene";
import type { SceneNode } from "@/lib/gpuCanvas/graph";
import type { Position } from "@xyflow/react";
import type { GpuCanvasStats } from "@/lib/gpuCanvas/stats";
import { flowNode, noop, settleNodes, type HeaderProps } from "./nodeSheets";

// The pane must not take the pointer: pans and clicks on empty space go to the scene.
// Pointer events are inherited, so what sits on the flow and takes clicks opts back in. React
// Flow sets a node's pointer-events inline (none, since this flow selects and drags nothing), hence !important.
const LIVE_STYLE = `
  [data-gpu-canvas-live] .react-flow__pane, [data-gpu-canvas-live] .react-flow__renderer, [data-gpu-canvas-live] .react-flow { pointer-events: none !important; background: transparent !important; }
  [data-gpu-canvas-live] .react-flow__node, [data-gpu-canvas-live] .react-flow__panel { pointer-events: all !important; }
  [data-gpu-canvas-live] .react-flow__node-gpuGhost { visibility: hidden; pointer-events: none !important; }
  [data-gpu-canvas-live] .react-flow__edge-path { visibility: hidden; }
`;

/**
 * A painted node a live connection ends at: React Flow draws an edge only
 * between nodes it holds, so the ends that are not live are stood in for by
 * an invisible node of the same box and handles (as painting measured them).
 */
function GhostNode() {
  return null;
}

type FlowState = { nodes: Node[]; edges: Edge[]; committed: () => void };

/** How long a leaving node waits for its painted image to be current. */
const LEAVE_TIMEOUT_MS = 1500;
/** How long the layer waits for React to commit a change of live nodes. */
const RENDER_TIMEOUT_MS = 2000;

/**
 * Why a node is live. Besides being worked in (hover, selection, focus, a
 * drag, zoomed in): "held" while it shows something of its own (a dialog,
 * a lightbox), "playing" while its video plays, "resident" for types that
 * stay live as they stay mounted on today's canvas (the 3D viewer), and
 * "pending" while it has work to pick up only a mounted node can (a
 * ComfyUI workflow to import, a run streaming previews), and "running"
 * while it works on its output (its spinner turns).
 */
export type LiveReason = "hover" | "selected" | "focus" | "zoom" | "open" | "drag" | "test" | "held" | "playing" | "resident" | "pending" | "running";

/** What the layer's React tree hands its owner once mounted. */
export interface LiveConnection {
  setNodes?: (state: FlowState) => void;
  setView?: (view: View) => void;
  /** The page's React Flow state (the live flow is the page's flow while the GPU canvas runs). */
  flow?: () => ReactFlowState;
  /** Set by the layer: called when something other than the scene moved the flow's viewport (setCenter, a tab switch). */
  viewChanged?: (view: View) => void;
  /** Set by the layer: keeps a node live until the returned release is called (useHoldLive). */
  hold?: HoldLive;
}

function ViewSync({ connect, onViewChanged }: { connect: (part: LiveConnection) => void; onViewChanged: (view: View) => void }) {
  const flow = useReactFlow();
  const store = useStoreApi();
  useLayoutEffect(() => {
    connect({ setView: (view) => void flow.setViewport(view), flow: () => store.getState() });
    let last = store.getState().transform;
    return store.subscribe((state) => {
      if (state.transform === last) return;
      last = state.transform;
      const [x, y, zoom] = state.transform;
      onViewChanged({ x, y, zoom });
    });
  }, [flow, store, connect, onViewChanged]);
  return null;
}

interface LiveFlowProps {
  /** Hands the owner what the flow offers (LiveConnection), as it mounts. */
  connect: (part: LiveConnection) => void;
  /** Something other than the scene moved the flow's viewport. */
  onViewChanged: (view: View) => void;
  initialView: View;
  nodeTypes: NodeTypes;
  edgeTypes: EdgeTypes;
  defaultEdgeOptions: DefaultEdgeOptions;
  onEdgesChange: OnEdgesChange;
  headers: HeaderProps;
  /** Keeps a node live while it shows something of its own (useHoldLive in the nodes). */
  hold: HoldLive;
  /** Drawn inside the flow, in its viewport's context (group controls, the navigator). */
  children?: ReactNode;
}

/**
 * The live nodes' React Flow. It is the page's React Flow while the GPU
 * canvas runs (it renders under the page's ReactFlowProvider), so whatever
 * the app asks of React Flow (screenToFlowPosition, setCenter, the viewport
 * portal, the selection's positions) answers for the GPU canvas, its
 * viewport kept equal to the scene's.
 */
export function LiveFlow({ connect, onViewChanged, initialView, nodeTypes, edgeTypes, defaultEdgeOptions, onEdgesChange, headers, hold, children }: LiveFlowProps) {
  const [state, setState] = useState<FlowState>({ nodes: [], edges: [], committed: noop });
  const { nodes, edges } = state;
  const types = useMemo(() => ({ ...nodeTypes, gpuGhost: GhostNode }), [nodeTypes]);
  // Floating headers belong to the live nodes, not to the stand-ins.
  const real = useMemo(() => nodes.filter((n) => n.type !== "gpuGhost"), [nodes]);
  useLayoutEffect(() => connect({ setNodes: setState }), [connect]);
  useLayoutEffect(() => state.committed(), [state]);
  return (
    <HoldLiveProvider hold={hold}>
      <style>{LIVE_STYLE}</style>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={types} edgeTypes={edgeTypes} defaultEdgeOptions={defaultEdgeOptions} onEdgesChange={onEdgesChange}
        defaultViewport={initialView} minZoom={0.01} maxZoom={4} edgesFocusable={false} edgesReconnectable={false}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} panOnScroll={false} zoomOnPinch={false}
        zoomOnDoubleClick={false} preventScrolling={false} deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
        proOptions={{ hideAttribution: true }} style={{ background: "transparent" }}>
        <ViewSync connect={connect} onViewChanged={onViewChanged} />
        <FloatingNodeHeaders nodes={real} {...headers} />
        {children}
      </ReactFlow>
    </HoldLiveProvider>
  );
}

export interface LivePainter {
  /** Resolves once the node's painted image is current. */
  paintNow(id: string): Promise<void>;
}

export class LiveLayer {
  /** Nodes asked to be live, and why. */
  private wanted = new Map<string, Set<LiveReason>>();
  /** Nodes whose live component is on screen and whose scene image is hidden. */
  readonly live = new Set<string>();
  /** Nodes on their way back to the scene, waiting for a current image. */
  private leaving = new Set<string>();
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  private listeners: (() => void)[] = [];
  painter: LivePainter | null = null;
  /** The live node under the pointer, if any. */
  pointerNode: string | null = null;
  /** Called when the pointer moves onto a live node or off the live nodes. */
  onPointerNode: ((id: string | null) => void) | null = null;

  /** `element` holds the LiveFlow rendered with `connection`. */
  constructor(readonly element: HTMLElement, private connection: LiveConnection, private scene: Scene, private stats: GpuCanvasStats) {
    const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions | boolean) => {
      element.addEventListener(type, listener, options);
      this.listeners.push(() => element.removeEventListener(type, listener, options));
    };
    // Wheel over a live node still pans and zooms the scene, unless an inner area scrolls.
    on("wheel", (event) => {
      const target = event.target as Element;
      if (target.closest(".nowheel, textarea")) return;
      scene.wheel(event);
    }, { passive: false });
    // A press on a live node's body goes to the scene (click to select, drag to move), and so does
    // one on its handles (drag to connect); its fields and buttons keep theirs.
    on("pointerdown", (event) => {
      const target = event.target as Element;
      if (!target.closest(".react-flow__node")) return;
      if (!target.closest(".react-flow__handle") && target.closest("input, textarea, select, button, a, [contenteditable='true'], .nodrag")) return;
      scene.pointerDown(event);
    }, true);
    // The pointer over a live node: it is hovered, though the scene below no longer sees the pointer.
    on("pointerover", (event) => {
      const id = liveNodeId(event.target);
      if (id !== this.pointerNode) {
        this.pointerNode = id;
        this.onPointerNode?.(id);
      }
    });
    on("pointerout", (event) => {
      if (liveNodeId(event.relatedTarget) || !this.pointerNode) return;
      this.pointerNode = null;
      this.onPointerNode?.(null);
    });
    // The node holding focus stays live wherever the pointer goes.
    on("focusin", (event) => {
      const id = (event.target as Element).closest(".react-flow__node")?.getAttribute("data-id");
      if (id) this.wantOnly("focus", [id]);
    });
    on("focusout", (event) => {
      const next = (event.relatedTarget as Element | null)?.closest?.("[data-gpu-canvas-live] .react-flow__node")?.getAttribute("data-id");
      this.wantOnly("focus", next ? [next] : []);
    });
    connection.hold = (id) => this.hold(id);
    // Someone else moved the flow's viewport (setCenter, fitView, a tab restored): the scene follows.
    connection.viewChanged = (view) => {
      const current = scene.view;
      if (Math.abs(view.x - current.x) < 0.01 && Math.abs(view.y - current.y) < 0.01 && Math.abs(view.zoom - current.zoom) < 1e-6) return;
      scene.setView(view);
    };
    // Live nodes show the store's data as it changes.
    this.unsubscribe = subscribeToWorkflowNodeChanges((changes) => {
      for (const id of changes.updated) if (this.live.has(id) || this.wanted.has(id) || this.leaving.has(id)) {
        void this.render();
        return;
      }
      for (const id of changes.removed) if (this.wanted.has(id) || this.live.has(id)) {
        this.drop(id);
        this.pending = this.sync();
        return;
      }
    });
  }

  private setNodes(next: FlowState) {
    (this.connection.setNodes ?? ((n: FlowState) => n.committed()))(next);
  }

  /** Connections the layer renders (their labels, stubs, clamps and toolbars; the scene draws their strokes). */
  private edgeIds: string[] = [];

  private holds = new Map<string, number>();

  /** Keeps a node live until the release is called; holds count. */
  hold(id: string): () => void {
    this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    if (this.holds.get(id) === 1) this.want(id, "held", true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.holds.get(id) ?? 1) - 1;
      if (count > 0) {
        this.holds.set(id, count);
        return;
      }
      this.holds.delete(id);
      this.want(id, "held", false);
    };
  }

  /** Sets the live connections; renders when they or what they show changed. */
  setEdges(ids: string[]) {
    this.edgeIds = ids;
    void this.render();
  }

  setView(view: View) {
    this.connection.setView?.({ ...view });
  }

  /** The page's React Flow state, while the live flow is mounted. */
  flowState(): ReactFlowState | null {
    return this.connection.flow?.() ?? null;
  }

  /** Whether the node is wanted live for this reason. */
  has(id: string, reason: LiveReason) {
    return !!this.wanted.get(id)?.has(reason);
  }

  /** Re-renders the live nodes at the scene graph's positions (a drag moved them). */
  refresh() {
    void this.render();
  }

  /** Resolves once the latest change of live nodes has finished swapping. */
  settled() {
    return this.pending;
  }

  /** Adds or removes a reason for a node to be live. */
  want(id: string, reason: LiveReason, on: boolean) {
    const reasons = this.wanted.get(id) ?? new Set<LiveReason>();
    if (on) reasons.add(reason);
    else reasons.delete(reason);
    if (reasons.size) this.wanted.set(id, reasons);
    else this.wanted.delete(id);
    this.pending = this.sync();
  }

  /** Replaces one reason's set of nodes. */
  wantOnly(reason: LiveReason, ids: Iterable<string>) {
    const next = new Set(ids);
    let changed = false;
    for (const [id, reasons] of this.wanted) if (reasons.has(reason) && !next.has(id)) {
      reasons.delete(reason);
      if (!reasons.size) this.wanted.delete(id);
      changed = true;
    }
    for (const id of next) {
      const reasons = this.wanted.get(id);
      if (reasons?.has(reason)) continue;
      if (reasons) reasons.add(reason);
      else this.wanted.set(id, new Set([reason]));
      changed = true;
    }
    if (changed) this.pending = this.sync();
  }

  private drop(id: string) {
    this.wanted.delete(id);
    this.live.delete(id);
    this.leaving.delete(id);
  }

  /** The nodes the layer renders (wanted ones and those still leaving), and the live connections with stand-ins for their painted ends. */
  private render(): Promise<void> {
    const { nodes } = useWorkflowStore.getState();
    const graph = this.scene.graph;
    const flowNodes: Node[] = [];
    const present = new Set<string>();
    // A node handed to React Flow without its measured size is hidden until
    // it is measured again, which blurs the field being typed in: carry the
    // size React Flow already measured.
    const lookup = this.flowState()?.nodeLookup;
    for (const id of new Set([...this.wanted.keys(), ...this.leaving])) {
      const i = indexOfNode(nodes, id), g = graph.indexOf.get(id);
      if (i < 0 || g == null) continue;
      const n = graph.nodes[g];
      const node = flowNode(nodes[i], n.x, n.y, n.w, !!nodes[i].selected);
      const measured = lookup?.get(id)?.measured;
      if (measured?.width && measured.height) node.measured = { width: measured.width, height: measured.height };
      flowNodes.push(node);
      present.add(id);
    }
    const flowEdges: Edge[] = [];
    for (const id of this.edgeIds) {
      const e = graph.edgeIndexOf.get(id);
      const edge = e == null ? undefined : graph.edges[e];
      if (!edge) continue;
      for (const end of [edge.source, edge.target]) {
        const n = graph.nodes[end];
        if (present.has(n.id)) continue;
        present.add(n.id);
        flowNodes.push(ghostNode(n));
      }
      flowEdges.push(edge.edge);
    }
    // A commit that never comes (the tree failed) must not hold up whoever waits on the layer.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RENDER_TIMEOUT_MS);
      this.setNodes({ nodes: flowNodes, edges: flowEdges, committed: () => { clearTimeout(timer); resolve(); } });
    });
  }

  /** Resolves when every wanted node is live and every other node is back in the scene. */
  private async sync() {
    const generation = ++this.generation;
    const started = performance.now();
    const graph = this.scene.graph;
    // Nodes no longer wanted head back to the scene once their image is current.
    for (const id of [...this.live]) {
      if (this.wanted.has(id)) continue;
      this.live.delete(id);
      this.leaving.add(id);
      void this.leave(id);
    }
    await this.render();
    const entering = [...this.wanted.keys()].filter((id) => !this.live.has(id) && graph.indexOf.has(id));
    if (!entering.length || generation !== this.generation) return;
    for (const id of entering) this.leaving.delete(id);
    await settleNodes(this.element, entering, performance.now() + 3000, () => generation !== this.generation);
    if (generation !== this.generation) return;
    for (const id of entering) {
      if (!this.wanted.has(id)) continue;
      const i = this.scene.graph.indexOf.get(id);
      if (i == null) continue;
      this.live.add(id);
      this.scene.setHidden(i, true);
    }
    this.stats.record("live.swapMs", performance.now() - started);
  }

  private async leave(id: string) {
    if (this.painter) await Promise.race([this.painter.paintNow(id), new Promise((resolve) => setTimeout(resolve, LEAVE_TIMEOUT_MS))]);
    // Wanted again meanwhile: it stays.
    if (this.wanted.has(id) || !this.leaving.has(id)) return;
    this.leaving.delete(id);
    const i = this.scene.graph.indexOf.get(id);
    if (i != null) this.scene.setHidden(i, false);
    // Off the layer a frame later, once the scene has drawn its image.
    requestAnimationFrame(() => {
      if (!this.wanted.has(id) && !this.leaving.has(id)) void this.render();
    });
  }

  /** The graph was rebuilt: the scene forgot which nodes it hid. */
  graphRebuilt() {
    for (const id of this.live) {
      const i = this.scene.graph.indexOf.get(id);
      if (i == null) this.drop(id);
      else this.scene.setHidden(i, true);
    }
    void this.render();
  }

  /** The live node's element, for a runner comparing it with its painted image. */
  nodeElement(id: string): HTMLElement | null {
    return this.element.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
  }

  dispose() {
    this.unsubscribe();
    for (const off of this.listeners) off();
    this.connection.viewChanged = undefined;
    this.connection.hold = undefined;
    this.generation++;
    this.setNodes({ nodes: [], edges: [], committed: noop });
  }
}

/** The live node (not a stand-in) an element belongs to. */
function liveNodeId(target: EventTarget | null): string | null {
  const element = target as Element | null;
  if (!element?.closest?.("[data-gpu-canvas-live]")) return null;
  // A node's floating header is the node's too.
  const header = element.closest("[data-node-header]");
  if (header) return header.getAttribute("data-node-header");
  const node = element.closest(".react-flow__node");
  return node && !node.classList.contains("react-flow__node-gpuGhost") ? node.getAttribute("data-id") : null;
}

/** A stand-in for a painted node at a live connection's end: its box, and its handles where painting measured them. */
function ghostNode(n: SceneNode): Node {
  const handles = [...(n.handles ?? [])].map(([key, anchor]) => {
    const colon = key.indexOf(":");
    const position = (anchor.position ?? (key.startsWith("source") ? "right" : "left")) as Position;
    return { id: key.slice(colon + 1) || null, type: key.slice(0, colon) as "source" | "target", position, x: anchor.x, y: anchor.y, width: 0, height: 0 };
  });
  return { id: n.id, type: "gpuGhost", position: { x: n.x, y: n.y }, width: n.w, height: n.h, data: {}, handles, selectable: false, draggable: false, connectable: false, focusable: false } as Node;
}
