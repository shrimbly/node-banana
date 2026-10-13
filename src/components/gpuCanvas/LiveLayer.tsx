"use client";

/**
 * The live layer: real React nodes (a real <ReactFlow> with the scene's
 * viewport) over the scene for the nodes being worked in: the hovered node,
 * selected nodes, the node holding focus, and every visible node above 100%
 * zoom. They are the canvas's own components, so typing, buttons and menus
 * work as they do today and write to the store.
 *
 * A node's painted image stays in the scene until its live component has
 * been measured and its images decoded; only then is the scene's copy
 * hidden, so the swap shows no gap. A node leaving the layer waits until its
 * painted image is current (it may have been edited while live), then goes
 * back to the scene.
 */
import { useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeTypes } from "@xyflow/react";
import { FloatingNodeHeaders } from "@/components/nodes/FloatingNodeHeaders";
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "@/store/workflowStore";
import { indexOfNode } from "@/store/nodeChanges";
import type { Scene, View } from "@/lib/gpuCanvas/scene";
import type { GpuCanvasStats } from "@/lib/gpuCanvas/stats";
import { flowNode, noop, settleNodes, type HeaderProps } from "./nodeSheets";

// The pane must not take the pointer: pans and clicks on empty space go to the scene.
const LIVE_STYLE = `
  [data-gpu-canvas-live] .react-flow__pane, [data-gpu-canvas-live] .react-flow__renderer, [data-gpu-canvas-live] .react-flow { pointer-events: none !important; background: transparent !important; }
  [data-gpu-canvas-live] .react-flow__node { pointer-events: all; }
`;

/** How long a leaving node waits for its painted image to be current. */
const LEAVE_TIMEOUT_MS = 1500;
/** How long the layer waits for React to commit a change of live nodes. */
const RENDER_TIMEOUT_MS = 2000;

export type LiveReason = "hover" | "selected" | "focus" | "zoom" | "open" | "test";

/** What the layer's React tree hands its owner once mounted. */
interface LiveConnection {
  setNodes?: (nodes: { nodes: Node[]; committed: () => void }) => void;
  setView?: (view: View) => void;
}

function ViewSync({ connect }: { connect: (connection: LiveConnection) => void }) {
  const flow = useReactFlow();
  useLayoutEffect(() => connect({ setView: (view) => void flow.setViewport(view) }), [flow, connect]);
  return null;
}

function Live({ connect, initialView, nodeTypes, headers }: { connect: (connection: LiveConnection) => void; initialView: View; nodeTypes: NodeTypes; headers: HeaderProps }) {
  const [state, setState] = useState<{ nodes: Node[]; committed: () => void }>({ nodes: [], committed: noop });
  const { nodes } = state;
  useLayoutEffect(() => connect({ setNodes: setState }), [connect]);
  useLayoutEffect(() => state.committed(), [state]);
  return (
    <ReactFlowProvider>
      <style>{LIVE_STYLE}</style>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={nodeTypes} defaultViewport={initialView} minZoom={0.01} maxZoom={4}
        nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} panOnScroll={false} zoomOnPinch={false}
        zoomOnDoubleClick={false} preventScrolling={false} proOptions={{ hideAttribution: true }} style={{ background: "transparent" }}>
        <ViewSync connect={connect} />
        <FloatingNodeHeaders nodes={nodes} {...headers} />
      </ReactFlow>
    </ReactFlowProvider>
  );
}

export interface LivePainter {
  /** Resolves once the node's painted image is current. */
  paintNow(id: string): Promise<void>;
}

export class LiveLayer {
  readonly element: HTMLDivElement;
  private root: Root;
  private setNodes: (next: { nodes: Node[]; committed: () => void }) => void = noop;
  private setFlowView: (view: View) => void = noop;
  /** Nodes asked to be live, and why. */
  private wanted = new Map<string, Set<LiveReason>>();
  /** Nodes whose live component is on screen and whose scene image is hidden. */
  readonly live = new Set<string>();
  /** Nodes on their way back to the scene, waiting for a current image. */
  private leaving = new Set<string>();
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  painter: LivePainter | null = null;

  constructor(host: HTMLElement, private scene: Scene, nodeTypes: NodeTypes, headers: HeaderProps, private stats: GpuCanvasStats) {
    this.element = document.createElement("div");
    this.element.dataset.gpuCanvasLive = "";
    this.element.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;";
    host.appendChild(this.element);
    // Wheel over a live node still pans and zooms the scene, unless an inner area scrolls.
    this.element.addEventListener("wheel", (event) => {
      const target = event.target as Element;
      if (target.closest(".nowheel, textarea")) return;
      scene.wheel(event);
    }, { passive: false });
    // A press on a live node's body goes to the scene (click to select, drag to pan); its fields and buttons keep it.
    this.element.addEventListener("pointerdown", (event) => {
      const target = event.target as Element;
      if (!target.closest(".react-flow__node") || target.closest("input, textarea, select, button, a, [contenteditable='true'], .nodrag, .react-flow__handle")) return;
      scene.pointerDown(event);
    }, true);
    // The node holding focus stays live wherever the pointer goes.
    this.element.addEventListener("focusin", (event) => {
      const id = (event.target as Element).closest(".react-flow__node")?.getAttribute("data-id");
      if (id) this.wantOnly("focus", [id]);
    });
    this.element.addEventListener("focusout", (event) => {
      const next = (event.relatedTarget as Element | null)?.closest?.("[data-gpu-canvas-live] .react-flow__node")?.getAttribute("data-id");
      this.wantOnly("focus", next ? [next] : []);
    });
    this.root = createRoot(this.element);
    const connect = (connection: LiveConnection) => {
      if (connection.setNodes) this.setNodes = connection.setNodes;
      if (connection.setView) this.setFlowView = connection.setView;
    };
    this.root.render(<Live connect={connect} initialView={{ ...scene.view }} nodeTypes={nodeTypes} headers={headers} />);
    // Live nodes show the store's data as it changes.
    this.unsubscribe = subscribeToWorkflowNodeChanges((changes) => {
      for (const id of changes.updated) if (this.live.has(id) || this.wanted.has(id) || this.leaving.has(id)) {
        this.render();
        return;
      }
      for (const id of changes.removed) if (this.wanted.has(id) || this.live.has(id)) {
        this.drop(id);
        this.pending = this.sync();
        return;
      }
    });
  }

  setView(view: View) {
    this.setFlowView({ ...view });
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

  /** The nodes the layer renders: wanted ones and those still leaving. */
  private render(): Promise<void> {
    const { nodes } = useWorkflowStore.getState();
    const graph = this.scene.graph;
    const flowNodes: Node[] = [];
    for (const id of new Set([...this.wanted.keys(), ...this.leaving])) {
      const i = indexOfNode(nodes, id), g = graph.indexOf.get(id);
      if (i < 0 || g == null) continue;
      const n = graph.nodes[g];
      flowNodes.push(flowNode(nodes[i], n.x, n.y, n.w, !!nodes[i].selected));
    }
    // A commit that never comes (the tree failed) must not hold up whoever waits on the layer.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RENDER_TIMEOUT_MS);
      this.setNodes({ nodes: flowNodes, committed: () => { clearTimeout(timer); resolve(); } });
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
    this.root.unmount();
    this.element.remove();
  }
}
