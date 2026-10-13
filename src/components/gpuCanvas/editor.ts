/**
 * Editing on the GPU canvas: what a press on the scene does, and the keys
 * that edit the selection. It is today's canvas's behaviour (React Flow as
 * WorkflowCanvas configures it, and WorkflowCanvas's own handlers) on the
 * scene's hit tests:
 *
 * - a click selects a node (Shift adds or removes it) or a connection, and
 *   a click on empty canvas clears the selection;
 * - a drag on a node moves it, or the whole selection when it is selected;
 *   the first move and the drop go to the store (the first records the undo
 *   step), the moves between only to the scene and the live layer;
 * - a drag from a handle draws a connection, dropped on a handle, a node or
 *   empty canvas as today; a click on a handle opens its menu;
 * - a drag on empty canvas pans or draws a marquee, as the navigation
 *   settings say;
 * - Delete and Backspace remove the selected nodes and connections.
 *
 * Painted nodes are pictures, so their handles and media cards are the ones
 * painting measured (SceneNode.handles, SceneNode.card). Live nodes are real
 * components: the live layer hands presses on their handles here.
 */
import type { Connection, EdgeChange, NodeChange } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { useAssetStore } from "@/store/assetStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import type { CanvasNavigationSettings } from "@/types/canvas";
import type { HandleMenuTarget } from "@/components/HandleMenu";
import { EDGE_COLORS, edgeColorForHandles } from "@/lib/edges/colors";
import { routeEdge } from "@/lib/edges/route";
import { Position } from "@xyflow/react";
import type { Gesture, Scene } from "@/lib/gpuCanvas/scene";
import { handleAt, marqueeNodes, paneDragAction, type HandleHit } from "@/lib/gpuCanvas/gestures";
import { cubicAt } from "@/lib/gpuCanvas/edgeRoutes";
import { pathIntersectsRect } from "@/lib/edges/marquee";
import type { LiveLayer } from "./LiveLayer";

/** Pointer travel (css px) under which a press is a click (React Flow's nodeClickDistance and nodeDragThreshold). */
const CLICK_DISTANCE = 5;
/** Under this a press on a handle is a click that opens its menu. */
const HANDLE_CLICK_SLOP = 4;
/** How near (css px) a press must be to a painted handle to take it. */
const HANDLE_HIT_PX = 9;
/** How near (css px) a dragged connection snaps to a handle (React Flow's connectionRadius). */
const CONNECTION_RADIUS_PX = 20;

/** What dropping a connection that found no handle hands WorkflowCanvas (React Flow's onConnectEnd state, as it reads it). */
export interface ConnectEndState {
  isValid: false;
  fromNode: WorkflowNode;
  fromHandle: { id: string | null; type: "source" | "target" };
}

/** WorkflowCanvas's side of editing: its settings and handlers, read when used. */
export interface GpuEditing {
  navigation: CanvasNavigationSettings;
  /** The navigator's lock: nodes cannot be moved, connected or selected. */
  locked: boolean;
  /** A dialog or the tutorial is over the canvas: no gesture but the wheel. */
  disabled: boolean;
  isValidConnection: (connection: Connection) => boolean;
  onConnect: (connection: Connection) => void;
  /** A connection dropped without a handle: on a node (`nodeId`) or on empty canvas. */
  onConnectEnd: (event: MouseEvent, state: ConnectEndState, nodeId: string | null) => void;
  onHandleClick: (target: HandleMenuTarget) => void;
  /** A node drag ended on this node (group membership follows its centre). */
  onNodeDragStop: (event: MouseEvent, node: WorkflowNode) => void;
  onPaneClick: () => void;
  /** The add-node menu at a screen point (double-click or right-click on empty canvas). */
  onPaneMenu: (clientX: number, clientY: number) => void;
  onEdgeClick: (event: MouseEvent, edge: WorkflowEdge) => void;
  onEdgeContextMenu: (event: MouseEvent, edge: WorkflowEdge) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function typing(target: EventTarget | null) {
  const active = document.activeElement;
  const field = (element: unknown) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
  return field(target) || field(active);
}

export class Editor {
  private space = false;
  private hoveredHandle: string | null = null;
  private overlay: SVGSVGElement;
  private marquee: HTMLDivElement;
  private offs: (() => void)[] = [];

  constructor(private scene: Scene, private live: LiveLayer, host: HTMLElement, private editing: () => GpuEditing) {
    this.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.overlay.setAttribute("class", "pointer-events-none absolute inset-0 h-full w-full");
    this.overlay.style.zIndex = "4";
    this.overlay.style.overflow = "visible";
    host.appendChild(this.overlay);
    this.marquee = document.createElement("div");
    this.marquee.dataset.gpuCanvasMarquee = "";
    // React Flow's user selection look (globals.css styles .react-flow__selection the same way).
    this.marquee.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:4;background:rgba(0,89,220,0.08);border:1px dotted rgba(0,89,220,0.8);";
    host.appendChild(this.marquee);
    const on = <K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void) => {
      window.addEventListener(type, listener);
      this.offs.push(() => window.removeEventListener(type, listener));
    };
    on("keydown", (event) => this.keyDown(event));
    on("keyup", (event) => {
      if (event.code === "Space") this.space = false;
    });
    on("blur", () => { this.space = false; });
  }

  dispose() {
    for (const off of this.offs) off();
    this.overlay.remove();
    this.marquee.remove();
  }

  // ── Keys ──────────────────────────────────────────────────────────────

  private keyDown(event: KeyboardEvent) {
    if (event.code === "Space" && !typing(event.target)) this.space = true;
    if (event.key === "Escape") this.scene.cancelGesture();
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    if (typing(event.target) || event.defaultPrevented) return;
    const { disabled, locked } = this.editing();
    if (disabled || locked || useAssetStore.getState().appView !== "canvas") return;
    // A menu or dialog open over the canvas keeps its keys.
    if (document.querySelector('[role="menu"], [role="listbox"], [data-dialog-overlay]') || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return;
    if (this.deleteSelection()) event.preventDefault();
  }

  /** Removes the selected nodes and connections, as React Flow's delete key does: connections first, then nodes. */
  deleteSelection(): boolean {
    const store = useWorkflowStore.getState();
    const nodes = store.nodes.filter((n) => n.selected && n.deletable !== false);
    const removed = new Set(nodes.map((n) => n.id));
    const edges = store.edges.filter((e) => (e.selected && e.deletable !== false) || removed.has(e.source) || removed.has(e.target));
    if (!nodes.length && !edges.length) return false;
    if (edges.length) store.onEdgesChange(edges.map((e): EdgeChange<WorkflowEdge> => ({ type: "remove", id: e.id })));
    if (nodes.length) store.onNodesChange(nodes.map((n): NodeChange<WorkflowNode> => ({ type: "remove", id: n.id })));
    return true;
  }

  // ── Presses ───────────────────────────────────────────────────────────

  /** The scene's onPress: what this press starts. */
  press = (event: PointerEvent): Gesture | null => {
    const editing = this.editing();
    if (editing.disabled) return null;
    const scene = this.scene;
    const at = scene.local(event);
    const action = paneDragAction(editing.navigation, { button: event.button, shiftKey: event.shiftKey, altKey: event.altKey, space: this.space }, isMac);
    // Space held (or the pan button) pans wherever the press lands, as React Flow's pan key does.
    if (action === "pan" && (this.space || event.button !== 0)) return scene.panGesture(event);
    if (event.button !== 0) return null;
    if (!editing.locked) {
      const handle = this.handleFromEvent(event) ?? this.paintedHandleAt(at.x, at.y);
      if (handle) return this.connectGesture(event, handle);
    }
    const node = scene.nodeAt(at.x, at.y);
    if (node >= 0 && action !== "select") return this.nodeGesture(event, node);
    const edge = node < 0 && action !== "select" ? scene.edgeAt(at.x, at.y) : -1;
    if (edge >= 0) return this.clickGesture(event, () => this.clickEdge(event, edge));
    if (action === "pan") return this.paneGesture(event, scene.panGesture(event));
    if (action === "select" && !editing.locked) return this.marqueeGesture(event);
    return this.paneGesture(event, null);
  };

  /** A handle of a live node, when the press came from the live layer. */
  private handleFromEvent(event: PointerEvent): HandleHit | null {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__handle") : null;
    const nodeId = element?.dataset.nodeid;
    const i = nodeId ? this.scene.graph.indexOf.get(nodeId) : undefined;
    if (!element || i == null) return null;
    const rect = element.getBoundingClientRect(), box = this.scene.canvas.getBoundingClientRect();
    const p = this.scene.toWorld(rect.left + rect.width / 2 - box.left, rect.top + rect.height / 2 - box.top);
    return { node: i, handleId: element.dataset.handleid ?? "", type: element.classList.contains("source") ? "source" : "target", x: p.x, y: p.y };
  }

  /** The painted handle nearest a point (css px) within `reachPx`; only of `type` when given. */
  private paintedHandleAt(cssX: number, cssY: number, reachPx = HANDLE_HIT_PX, type?: "source" | "target"): HandleHit | null {
    const scene = this.scene, p = scene.toWorld(cssX, cssY), reach = reachPx / scene.view.zoom;
    // Handles sit on a node's sides, a little outside it.
    const near = this.nodesNear(p.x, p.y, reach + 24);
    return type ? this.nearestOfType(near, p.x, p.y, reach, type) : handleAt(scene.graph, near, p.x, p.y, reach);
  }

  private nearestOfType(nodes: number[], x: number, y: number, reach: number, type: "source" | "target"): HandleHit | null {
    let best: HandleHit | null = null, bestDistance = reach;
    for (const i of nodes) {
      const n = this.scene.graph.nodes[i];
      for (const [key, anchor] of n.handles ?? []) {
        if (!key.startsWith(`${type}:`)) continue;
        const d = Math.hypot(n.x + anchor.x - x, n.y + anchor.y - y);
        if (d <= bestDistance) {
          bestDistance = d;
          best = { node: i, handleId: key.slice(type.length + 1), type, x: n.x + anchor.x, y: n.y + anchor.y };
        }
      }
    }
    return best;
  }

  private nodesNear(x: number, y: number, reach: number): number[] {
    return this.scene.nodesWithin(x - reach, y - reach, x + reach, y + reach);
  }

  /** Follows a press until it moves past the click distance or ends; a release before that is a click. */
  private clickGesture(event: PointerEvent, click: () => void, drag?: (move: PointerEvent) => Gesture | null): Gesture {
    const startX = event.clientX, startY = event.clientY;
    let dragging: Gesture | null = null, moved = false;
    return {
      move: (move) => {
        if (dragging) return dragging.move(move);
        if (moved || Math.hypot(move.clientX - startX, move.clientY - startY) < CLICK_DISTANCE) return;
        moved = true;
        dragging = drag?.(move) ?? null;
        dragging?.move(move);
      },
      up: (up) => {
        if (dragging) dragging.up(up);
        else if (!moved) click();
      },
      cancel: () => dragging?.cancel(),
    };
  }

  /** Empty canvas: a click clears the selection; a drag pans when `pan` is given. */
  private paneGesture(event: PointerEvent, pan: Gesture | null): Gesture {
    return this.clickGesture(event, () => {
      this.clearSelection();
      this.editing().onPaneClick();
    }, () => pan);
  }

  // ── Selection ─────────────────────────────────────────────────────────

  private clearSelection() {
    const store = useWorkflowStore.getState();
    const nodes = store.nodes.filter((n) => n.selected).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: false }));
    const edges = store.edges.filter((e) => e.selected).map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: false }));
    if (nodes.length) store.onNodesChange(nodes);
    if (edges.length) store.onEdgesChange(edges);
  }

  /** Selects nodes as a click does: only these, or (additive) toggling them in the selection. */
  selectNodes(ids: string[], additive: boolean) {
    if (this.editing().locked) return;
    const store = useWorkflowStore.getState();
    const next = new Set(additive ? store.nodes.filter((n) => n.selected).map((n) => n.id) : []);
    for (const id of ids) {
      if (additive && next.has(id)) next.delete(id);
      else next.add(id);
    }
    const changes: NodeChange<WorkflowNode>[] = [];
    for (const node of store.nodes) if (!!node.selected !== next.has(node.id) && node.selectable !== false) changes.push({ type: "select", id: node.id, selected: next.has(node.id) });
    if (changes.length) store.onNodesChange(changes);
    // Selecting nodes drops a connection selection (WorkflowCanvas's handleSelectionChange).
    if (next.size) {
      const selectedEdges = useWorkflowStore.getState().edges.filter((e) => e.selected);
      if (selectedEdges.length) store.onEdgesChange(selectedEdges.map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: false })));
    }
  }

  private clickEdge(event: PointerEvent, e: number) {
    const editing = this.editing();
    if (editing.locked) return;
    const store = useWorkflowStore.getState();
    const edge = store.edges.find((candidate) => candidate.id === this.scene.graph.edges[e]?.id);
    if (!edge || edge.selectable === false) return;
    // React Flow's edge click: only this connection, or added to the selection with Shift.
    const additive = event.shiftKey;
    const nodes = additive ? [] : store.nodes.filter((n) => n.selected).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: false }));
    const edges = store.edges.flatMap((candidate): EdgeChange<WorkflowEdge>[] => {
      const selected = candidate.id === edge.id ? (additive ? !candidate.selected : true) : additive ? !!candidate.selected : false;
      return !!candidate.selected === selected ? [] : [{ type: "select", id: candidate.id, selected }];
    });
    if (nodes.length) store.onNodesChange(nodes);
    if (edges.length) store.onEdgesChange(edges);
    editing.onEdgeClick(event, edge);
  }

  // ── Node drag ─────────────────────────────────────────────────────────

  private nodeGesture(event: PointerEvent, i: number): Gesture {
    const id = this.scene.graph.nodes[i].id;
    return this.clickGesture(event, () => this.selectNodes([id], event.shiftKey), (move) => this.editing().locked ? null : this.dragGesture(event, move, i));
  }

  private dragGesture(down: PointerEvent, first: PointerEvent, pressed: number): Gesture | null {
    const scene = this.scene, graph = scene.graph;
    const store = useWorkflowStore.getState();
    const pressedId = graph.nodes[pressed].id;
    const pressedNode = store.nodes.find((n) => n.id === pressedId);
    if (!pressedNode || pressedNode.draggable === false) return null;
    // A selected node carries the selection; an unselected one moves alone (selectNodesOnDrag is off).
    const ids = pressedNode.selected ? store.nodes.filter((n) => n.selected && n.draggable !== false).map((n) => n.id) : [pressedId];
    const moving = ids.map((nodeId) => graph.indexOf.get(nodeId)).filter((n): n is number => n != null);
    const start = moving.map((n) => ({ x: graph.nodes[n].x, y: graph.nodes[n].y }));
    const generation = store.canvasGeneration;
    const origin = scene.toWorld(scene.local(down).x, scene.local(down).y);
    // The dragged nodes stay live while they move (the pressed one is hovered, a selection is live).
    this.live.wantOnly("drag", ids);
    document.documentElement.classList.add("canvas-interacting");
    let committedFirst = false;
    let last = { dx: 0, dy: 0 };
    const place = (event: PointerEvent) => {
      const p = scene.local(event), w = scene.toWorld(p.x, p.y);
      const dx = w.x - origin.x, dy = w.y - origin.y;
      if (dx === last.dx && dy === last.dy) return;
      last = { dx, dy };
      moving.forEach((n, k) => {
        graph.nodes[n].x = start[k].x + dx;
        graph.nodes[n].y = start[k].y + dy;
      });
      scene.input(event);
      scene.nodesMoved(moving);
      this.live.refresh();
      // The first move reaches the store: it records the undo step.
      if (!committedFirst) {
        committedFirst = true;
        useWorkflowStore.getState().onNodesChange(this.positionChanges(moving, true));
      }
    };
    const finish = (event: PointerEvent | null) => {
      this.live.wantOnly("drag", []);
      document.documentElement.classList.remove("canvas-interacting");
      const state = useWorkflowStore.getState();
      // The canvas was replaced mid-drag: the positions belong to the old one.
      if (state.canvasGeneration !== generation) return;
      if (!event) {
        moving.forEach((n, k) => {
          graph.nodes[n].x = start[k].x;
          graph.nodes[n].y = start[k].y;
        });
        scene.nodesMoved(moving);
        state.onNodesChange(this.positionChanges(moving, false));
        return;
      }
      state.onNodesChange(this.positionChanges(moving, false));
      const node = useWorkflowStore.getState().nodes.find((n) => n.id === pressedId);
      if (node) this.editing().onNodeDragStop(event, node);
    };
    place(first);
    return { move: place, up: (event) => finish(event), cancel: () => finish(null) };
  }

  private positionChanges(moving: number[], dragging: boolean): NodeChange<WorkflowNode>[] {
    const graph = this.scene.graph;
    return moving.map((n) => ({ type: "position", id: graph.nodes[n].id, position: { x: graph.nodes[n].x, y: graph.nodes[n].y }, dragging }));
  }

  // ── Marquee ───────────────────────────────────────────────────────────

  private marqueeGesture(down: PointerEvent): Gesture {
    const scene = this.scene;
    const start = scene.local(down);
    let previousNodes = "", previousEdges = "";
    // A marquee replaces the selection, and drops a connection selection as it starts.
    const store = useWorkflowStore.getState();
    const selectedEdges = store.edges.filter((e) => e.selected);
    if (selectedEdges.length) store.onEdgesChange(selectedEdges.map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: false })));
    const update = (event: PointerEvent) => {
      const at = scene.local(event);
      const left = Math.min(start.x, at.x), top = Math.min(start.y, at.y), width = Math.abs(at.x - start.x), height = Math.abs(at.y - start.y);
      Object.assign(this.marquee.style, { display: "block", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      const a = scene.toWorld(left, top), b = scene.toWorld(left + width, top + height);
      const box = { left: a.x, top: a.y, right: b.x, bottom: b.y };
      const taken = marqueeNodes(scene.graph, scene.nodesWithin(a.x, a.y, b.x, b.y), box).map((i) => scene.graph.nodes[i].id);
      const key = taken.join("\n");
      const state = useWorkflowStore.getState();
      if (key !== previousNodes) {
        previousNodes = key;
        const next = new Set(taken);
        const changes = state.nodes.filter((n) => !!n.selected !== next.has(n.id) && n.selectable !== false).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: next.has(n.id) }));
        if (changes.length) state.onNodesChange(changes);
      }
      // With no node taken, the connections the marquee crosses (EdgeMarqueeSelection).
      const edgeIds = taken.length ? [] : this.edgesCrossing(box);
      const edgeKey = edgeIds.join("\n");
      if (edgeKey !== previousEdges) {
        previousEdges = edgeKey;
        const next = new Set(edgeIds);
        const now = useWorkflowStore.getState();
        const changes = now.edges.filter((e) => !!e.selected !== next.has(e.id)).map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: next.has(e.id) }));
        if (changes.length) now.onEdgesChange(changes);
      }
    };
    const end = () => { this.marquee.style.display = "none"; };
    return {
      move: update,
      up: (event) => {
        end();
        // A marquee that took only connections opens the toolbar at the release (handleSelectionEnd).
        const now = useWorkflowStore.getState();
        const firstEdge = now.edges.find((e) => e.selected);
        if (firstEdge && !now.nodes.some((n) => n.selected)) {
          const p = scene.local(event), w = scene.toWorld(p.x, p.y);
          useWorkflowStore.setState({ edgeMenuAnchor: { edgeId: firstEdge.id, x: w.x, y: w.y } });
        }
      },
      cancel: end,
    };
  }

  private edgesCrossing(box: { left: number; top: number; right: number; bottom: number }): string[] {
    const scene = this.scene, ids: string[] = [];
    for (const e of scene.edgesWithin(box.left, box.top, box.right, box.bottom)) {
      const edge = scene.graph.edges[e]?.edge;
      const route = scene.edgeRoute(e);
      if (!edge || !route || edge.hidden || edge.data?.hidden || edge.selectable === false || edge.type === "reference") continue;
      const points = route.segments.flatMap((c) => Array.from({ length: 17 }, (_, k) => cubicAt(c, k / 16)));
      if (pathIntersectsRect(points, { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top })) ids.push(edge.id);
    }
    return ids;
  }

  // ── Connecting ────────────────────────────────────────────────────────

  private connectGesture(down: PointerEvent, from: HandleHit): Gesture {
    const scene = this.scene;
    const fromLive = down.target instanceof Element && !!down.target.closest(".react-flow__handle");
    const fromId = scene.graph.nodes[from.node].id;
    const handleId = from.handleId || null;
    const startX = down.clientX, startY = down.clientY;
    let dragging = false;
    let target: HandleHit | null = null;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const wanted = from.type === "source" ? "target" : "source";
    const draw = (event: PointerEvent) => {
      const at = scene.local(event), p = scene.toWorld(at.x, at.y);
      // Snap to the nearest handle of the other kind within the connection radius.
      const snap = this.paintedHandleAt(at.x, at.y, CONNECTION_RADIUS_PX, wanted) ?? this.liveHandleAt(event, wanted);
      target = snap && snap.node !== from.node ? snap : null;
      const end = target ? { x: target.x, y: target.y } : p;
      const a = scene.toScreen(from.x, from.y), b = scene.toScreen(end.x, end.y);
      const fromSource = from.type === "source";
      const [d] = routeEdge({
        style: "curved",
        sourceX: fromSource ? a.x : b.x, sourceY: fromSource ? a.y : b.y, sourcePosition: Position.Right,
        targetX: fromSource ? b.x : a.x, targetY: fromSource ? b.y : a.y, targetPosition: Position.Left,
      });
      path.setAttribute("d", d);
      const valid = target ? this.editing().isValidConnection(this.connection(from, target)) : true;
      path.setAttribute("stroke", valid ? edgeColorForHandles(from.type === "source" ? handleId : null, from.type === "target" ? handleId : null) : EDGE_COLORS.default);
      ring.style.display = target ? "" : "none";
      if (target) {
        ring.setAttribute("cx", String(b.x));
        ring.setAttribute("cy", String(b.y));
        ring.setAttribute("stroke", valid ? "#ffffff" : "#ef4444");
      }
    };
    const start = (event: PointerEvent) => {
      dragging = true;
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "3");
      path.setAttribute("stroke-linecap", "round");
      ring.setAttribute("r", "8");
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke-width", "2");
      this.overlay.append(path, ring);
      document.documentElement.classList.add("canvas-interacting");
      draw(event);
    };
    const end = () => {
      path.remove();
      ring.remove();
      document.documentElement.classList.remove("canvas-interacting");
    };
    return {
      move: (event) => {
        if (!dragging) {
          if (Math.hypot(event.clientX - startX, event.clientY - startY) <= HANDLE_CLICK_SLOP) return;
          start(event);
          return;
        }
        scene.input(event);
        draw(event);
      },
      up: (event) => {
        if (!dragging) {
          // A click on the handle opens its menu (a live node's handle opens it through WorkflowCanvas's own listener).
          if (fromLive) return;
          const p = scene.toScreen(from.x, from.y), box = scene.canvas.getBoundingClientRect();
          this.editing().onHandleClick({ nodeId: fromId, handleId, type: from.type, position: { x: box.left + p.x, y: box.top + p.y } });
          return;
        }
        end();
        const editing = this.editing();
        if (target) {
          const connection = this.connection(from, target);
          if (editing.isValidConnection(connection)) {
            editing.onConnect(connection);
            return;
          }
        }
        // No handle: WorkflowCanvas connects to a compatible handle of the node under the pointer, or offers the add-node menu.
        const fromNode = useWorkflowStore.getState().nodes.find((n) => n.id === fromId);
        if (!fromNode) return;
        const at = scene.local(event), node = scene.nodeAt(at.x, at.y);
        editing.onConnectEnd(event, { isValid: false, fromNode, fromHandle: { id: handleId, type: from.type } }, node >= 0 ? scene.graph.nodes[node].id : null);
      },
      cancel: end,
    };
  }

  /** The handle of a live node under the pointer, for a connection being dropped on it. */
  private liveHandleAt(event: PointerEvent, type: "source" | "target"): HandleHit | null {
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      if (!(element instanceof HTMLElement) || !element.classList.contains("react-flow__handle") || !element.closest("[data-gpu-canvas-live]")) continue;
      const hit = this.handleFromEvent({ target: element } as unknown as PointerEvent);
      if (hit && hit.type === type) return hit;
    }
    return null;
  }

  private connection(from: HandleHit, to: HandleHit): Connection {
    const graph = this.scene.graph;
    const [source, target] = from.type === "source" ? [from, to] : [to, from];
    return { source: graph.nodes[source.node].id, sourceHandle: source.handleId || null, target: graph.nodes[target.node].id, targetHandle: target.handleId || null };
  }

  // ── Hover, double-click and context menus ─────────────────────────────

  /** The scene's onIdleMove: the cursor, and the handle under the pointer (hidden connections ghost back). */
  idleMove = (event: PointerEvent) => {
    const scene = this.scene, at = scene.local(event);
    const handle = this.editing().disabled ? null : this.paintedHandleAt(at.x, at.y);
    const key = handle ? `${handle.node}:${handle.type}:${handle.handleId}` : null;
    if (key !== this.hoveredHandle) {
      const hadOne = this.hoveredHandle !== null;
      this.hoveredHandle = key;
      const store = useWorkflowStore.getState();
      if (handle) store.setHoveredHandle({ nodeId: scene.graph.nodes[handle.node].id, handleId: handle.handleId || null, type: handle.type });
      else if (hadOne) store.setHoveredHandle(null);
    }
    const node = handle ? -1 : scene.nodeAt(at.x, at.y);
    const edge = handle || node >= 0 ? -1 : scene.edgeAt(at.x, at.y);
    scene.setHoveredEdge(edge);
    scene.canvas.style.cursor = handle ? "crosshair" : node >= 0 ? "grab" : edge >= 0 ? "pointer" : "";
  };

  /** The scene's onContextMenu: the add-node menu on empty canvas, the connection menu on a connection. */
  contextMenu = (event: MouseEvent) => {
    const editing = this.editing();
    if (editing.disabled) return;
    const scene = this.scene, at = scene.local(event);
    if (scene.nodeAt(at.x, at.y) >= 0) return;
    const e = scene.edgeAt(at.x, at.y);
    const edge = e >= 0 ? useWorkflowStore.getState().edges.find((candidate) => candidate.id === scene.graph.edges[e].id) : undefined;
    // The right button pans in "middleMouse" mode (React Flow's panOnDrag [2] swallows the menu).
    if (editing.navigation.panMode === "middleMouse") {
      event.preventDefault();
      return;
    }
    if (edge) {
      editing.onEdgeContextMenu(event, edge);
      return;
    }
    event.preventDefault();
    editing.onPaneMenu(event.clientX, event.clientY);
  };

  /** A double-click on empty canvas opens the add-node menu. */
  paneDoubleClick = (screen: { x: number; y: number }) => {
    if (this.editing().disabled) return;
    this.editing().onPaneMenu(screen.x, screen.y);
  };
}
