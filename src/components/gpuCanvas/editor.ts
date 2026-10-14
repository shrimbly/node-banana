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
 *   empty canvas as today; a click on a handle opens its menu; a drag from
 *   a connection's end moves that end to another handle (React Flow's
 *   reconnect); the view pans while the pointer is near the canvas's edge;
 * - a drag on empty canvas pans or draws a marquee, as the navigation
 *   settings say;
 * - Delete and Backspace remove the selected nodes and connections; the
 *   arrow keys move the selection, and Enter, Space and Escape select and
 *   unselect a focused live node, as React Flow's keyboard handling does;
 *   Tab steps through the connections and nodes (keyboardFocus.ts).
 *
 * Painted nodes are pictures, so their handles and media cards are the ones
 * painting measured (SceneNode.handles, SceneNode.card). Live nodes are real
 * components: the live layer hands presses on their handles here.
 */
import type { Connection, EdgeChange, NodeChange } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { setConnectDrag } from "@/store/connectDragStore";
import { setHoveredSceneEdge, useEdgeHoverStore } from "@/store/edgeHoverStore";
import { useAssetStore } from "@/store/assetStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import type { CanvasNavigationSettings } from "@/types/canvas";
import type { HandleMenuTarget } from "@/components/HandleMenu";
import { routeEdge } from "@/lib/edges/route";
import { Position } from "@xyflow/react";
import type { Gesture, Scene } from "@/lib/gpuCanvas/scene";
import { autoPanVelocity, closestHandle, edgeEndAt, edgeEndHandle, handleAt, marqueeNodes, paneDragAction, RECONNECT_RADIUS, selectionKeyHeld, type CardBox, type HandleHit } from "@/lib/gpuCanvas/gestures";
import { cubicAt } from "@/lib/gpuCanvas/edgeRoutes";
import { connectCandidates } from "@/lib/gpuCanvas/connectCandidates";
import { pathIntersectsRect } from "@/lib/edges/marquee";
import { liveButtonPress, pressGoesToScene, type LiveLayer } from "./LiveLayer";
import { mediaCardBox } from "./nodeSheets";
import { KeyboardFocus } from "./keyboardFocus";

/** Pointer travel (css px) under which a press is a click (React Flow's nodeClickDistance and nodeDragThreshold). */
const CLICK_DISTANCE = 5;
/** Pointer travel (css px) a press on empty canvas must pass to start a marquee or a pan (React Flow's paneClickDistance). */
const PANE_CLICK_DISTANCE = 1;
/** FloatingNodeHeader's drag starts once the pointer is more than this far from the press on either axis. */
const HEADER_DRAG_DISTANCE = 5;
/** Under this a press on a handle is a click that opens its menu. */
const HANDLE_CLICK_SLOP = 4;
/** Pointer travel (css px) past which a press on a handle draws its connection line (React Flow's connectionDragThreshold). */
const CONNECTION_DRAG_THRESHOLD = 1;
/** How near (css px) to a painted handle's centre a press takes it, however small the zoom makes its socket. */
const HANDLE_HIT_PX = 9;
/** How near (flow units) to a handle's centre a dragged connection finds it (React Flow's connectionRadius). */
const CONNECTION_RADIUS = 20;
/** React Flow's default connection line (its style.css): 1px of #b1b1b7 in flow units. */
const CONNECTION_LINE_STROKE = "#b1b1b7";

/** What dropping a connection that found no handle hands WorkflowCanvas (React Flow's onConnectEnd state, as it reads it). */
export interface ConnectEndState {
  isValid: false;
  fromNode: WorkflowNode;
  fromHandle: { id: string | null; type: "source" | "target" };
}

/** WorkflowCanvas's side of editing: its settings and handlers, read when used. */
export interface GpuEditing {
  navigation: CanvasNavigationSettings;
  /** The navigator's lock: nodes cannot be moved or selected; a socket still connects, with no line drawn (as classic). */
  locked: boolean;
  /** A dialog is over the canvas: no gesture but the wheel. */
  disabled: boolean;
  /** The tutorial is running: dragging never pans (React Flow's panOnDrag and panActivationKeyCode off). */
  tutorial: boolean;
  isValidConnection: (connection: Connection) => boolean;
  onConnect: (connection: Connection) => void;
  /** A connection's end dragged onto another handle (React Flow's onReconnect). */
  onReconnect: (edge: WorkflowEdge, connection: Connection) => void;
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
  /** The selected nodes or connections changed, however (React Flow's onSelectionChange; GpuCanvas calls it). */
  onSelectionChange?: (params: { nodes: WorkflowNode[]; edges: WorkflowEdge[] }) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function typing(target: EventTarget | null) {
  const active = document.activeElement;
  const field = (element: unknown) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
  return field(target) || field(active);
}

/** React Flow's arrow-key velocity: 5px a press (Shift moves four times as far). */
const ARROW_STEPS: Record<string, { x: number; y: number }> = {
  ArrowUp: { x: 0, y: -5 },
  ArrowDown: { x: 0, y: 5 },
  ArrowLeft: { x: -5, y: 0 },
  ArrowRight: { x: 5, y: 0 },
};

/** Whether a release lands within a box (the canvas's client rect), edges included. */
export function releasedInside(box: { left: number; top: number; right: number; bottom: number }, at: { clientX: number; clientY: number }) {
  return at.clientX >= box.left && at.clientX <= box.right && at.clientY >= box.top && at.clientY <= box.bottom;
}

/** Stops the click the browser sends after a drag's release (removed a task later, if no click came). */
/** Whether a press landed on a live node's button or link (liveButtonPress): its node selects through its own click. */
function onLiveButton(event: PointerEvent): boolean {
  const target = event.target;
  return target instanceof Element && !!target.closest("[data-gpu-canvas-live]") && liveButtonPress(target);
}

/**
 * A live node's element whose click selects through LiveFlow's nodeClick (React Flow's NodeWrapper click on classic):
 * its buttons and links, and the fields and nodrag controls that keep their presses.
 */
function liveNodeClickSelects(event: PointerEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("[data-gpu-canvas-live]") || !target.closest(".react-flow__node")) return false;
  return !pressGoesToScene(target) || liveButtonPress(target);
}

/**
 * A group's title or resize grips (GroupsOverlay's interactive chrome), on the live layer. On classic they sit in
 * React Flow's zoom pane without `nopan`, and only listen for mousedown, which d3-zoom swallows when it pans.
 */
export function onGroupChrome(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("[data-gpu-canvas-live]") && !!target.closest(".group-controls-overlay")
    && !!target.closest("[data-group-label], .group-resize-controls") && !target.closest(".nopan");
}

/** A press on the live layer outside any node body: a floating header, group chrome, a connection's label. */
function onLiveChrome(event: PointerEvent): boolean {
  const target = event.target;
  return target instanceof Element && !!target.closest("[data-gpu-canvas-live]") && !target.closest(".react-flow__node");
}

function swallowNextClick() {
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    window.removeEventListener("click", swallow, true);
  };
  window.addEventListener("click", swallow, true);
  setTimeout(() => window.removeEventListener("click", swallow, true), 0);
}

/** React Flow's isInputDOMNode: the key went to a form field, an editable element, or something inside `.nokey`. */
function keyInField(event: KeyboardEvent) {
  const target = event.composedPath?.()[0] ?? event.target;
  if (!(target instanceof Element)) return false;
  return target.matches("input, select, textarea, [contenteditable]") || !!target.closest(".nokey") || typing(target);
}

export class Editor {
  private space = false;
  private hoveredHandle: string | null = null;
  /** The pointer's last idle move found empty canvas, whose cursor follows the selection key (paneCursor). */
  private idleOnPane = false;
  private overlay: SVGSVGElement;
  private marquee: HTMLDivElement;
  /** React Flow's NodesSelection: the dotted frame around the nodes a marquee selected, until a click or no node is selected. */
  private selectionFrame: HTMLDivElement;
  private selectionFrameActive = false;
  /**
   * Where classic's keyboard focus would be for the arrow keys while the document's focus is on the page or the
   * scene canvas: a painted node pressed last (its wrapper takes focus on classic), or the selection frame a
   * marquee left (React Flow's NodesSelection rect, focused as it shows). Null where classic's focus is on nothing.
   */
  private keyTarget: { kind: "node"; id: string } | { kind: "selection" } | null = null;
  private offs: (() => void)[] = [];
  /** Node and wire drags holding `canvas-interacting` (holdInteracting). */
  private interactingHolds = 0;
  /** Called as a drag lets go of `canvas-interacting` (the canvas resets its pan tracker, as classic's handleNodeDragEnd). */
  onInteractingEnd: (() => void) | null = null;
  /** Tab through the nodes and connections (keyboardFocus.ts). */
  readonly keyboard: KeyboardFocus;

  constructor(private scene: Scene, private live: LiveLayer, private host: HTMLElement, private editing: () => GpuEditing) {
    this.keyboard = new KeyboardFocus(scene, live, host, () => this.editing().locked);
    // The live layer hands the editor every press React Flow's pane would take for a selection on classic.
    live.selectionKeyActive = (event) => this.selectionKeyTakes(event);
    live.groupChromePans = (event) => this.groupChromePans(event);
    // The connection line, the marquee and the selection frame are mounted in the live flow as they show
    // (mountInFlow), where classic's own sit: under the flow's panels (the navigator), the line also under
    // what the viewport portal holds (the multi-select toolbar).
    this.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.overlay.setAttribute("class", "pointer-events-none absolute inset-0 h-full w-full");
    this.overlay.style.overflow = "visible";
    this.marquee = document.createElement("div");
    this.marquee.dataset.gpuCanvasMarquee = "";
    // React Flow's user selection look (globals.css styles .react-flow__selection the same way).
    this.marquee.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:4;background:rgba(0,89,220,0.08);border:1px dotted rgba(0,89,220,0.8);";
    this.selectionFrame = document.createElement("div");
    this.selectionFrame.dataset.gpuCanvasSelectionFrame = "";
    // .react-flow__nodesselection-rect's look (React Flow's selection colours).
    this.selectionFrame.style.cssText = "position:absolute;display:none;pointer-events:none;z-index:4;background:rgba(0,89,220,0.08);border:1px dotted rgba(0,89,220,0.8);";
    // The frame follows the view, the nodes' moves and sizes, and the selection.
    const placeFrame = () => { if (this.selectionFrameActive) this.placeSelectionFrame(); };
    this.offs.push(scene.onViewChanged(placeFrame), scene.onLayoutChanged(placeFrame));
    this.offs.push(useWorkflowStore.subscribe((state, previous) => {
      if (state.nodes === previous.nodes) return;
      placeFrame();
      // A removed node takes its focus with it, as its element's does.
      const target = this.keyTarget;
      if (target?.kind === "node" && !state.nodes.some((n) => n.id === target.id)) this.keyTarget = null;
    }));
    const on = <K extends keyof WindowEventMap>(type: K, listener: (event: WindowEventMap[K]) => void) => {
      window.addEventListener(type, listener);
      this.offs.push(() => window.removeEventListener(type, listener));
    };
    on("keydown", (event) => {
      this.keyDown(event);
      this.modifierChanged(event);
    });
    // Focus moving to an element (a field, a live node, a button) leaves wherever classic's focus stood.
    const focusIn = (event: FocusEvent) => {
      if (event.target !== document.body && event.target !== scene.canvas) this.keyTarget = null;
    };
    document.addEventListener("focusin", focusIn);
    this.offs.push(() => document.removeEventListener("focusin", focusIn));
    on("keyup", (event) => {
      if (event.code === "Space") this.space = false;
      this.modifierChanged(event);
    });
    // Off the canvas no connection is under the pointer, unless it went onto that live connection's own handle.
    const leave = (event: PointerEvent) => {
      const into = event.relatedTarget instanceof Element ? event.relatedTarget.closest(".react-flow__edge") : null;
      if (into?.getAttribute("data-id") !== useEdgeHoverStore.getState().edgeId) setHoveredSceneEdge(null);
    };
    scene.canvas.addEventListener("pointerleave", leave);
    this.offs.push(() => {
      scene.canvas.removeEventListener("pointerleave", leave);
      setHoveredSceneEdge(null);
    });
    on("blur", () => {
      this.space = false;
      if (this.idleOnPane && !scene.interacting) scene.canvas.style.cursor = this.paneCursor(false, false);
    });
  }

  dispose() {
    // A gesture the canvas did not get to end (GpuCanvas cancels it first): what a drag holds outside the
    // canvas is let go, so the classic canvas that may follow sees no connection drag or held interaction.
    if (this.interactingHolds > 0) {
      this.interactingHolds = 0;
      setConnectDrag(false);
      document.documentElement.classList.remove("canvas-interacting");
    }
    this.live.element?.removeAttribute("data-gpu-dragging");
    for (const off of this.offs) off();
    this.keyboard.dispose();
    this.overlay.remove();
    this.marquee.remove();
    this.selectionFrame.remove();
  }

  /**
   * Puts `element` in the live flow: in its wrapper after the renderer (z-index 4, under the panels' 5), as
   * classic's marquee and selection frame sit in its pane; or in its viewport, as the connection line
   * (z-index 1001, under the viewport portal's toolbar). The host stands in while the flow is not there.
   * Returns whether it went into the viewport, whose transform then places what it draws.
   */
  private mountInFlow(element: Element, where: "wrapper" | "viewport"): boolean {
    const wrapper = this.live.element?.querySelector<HTMLElement>(".react-flow") ?? null;
    const parent = where === "viewport" ? wrapper?.querySelector<HTMLElement>(".react-flow__viewport") ?? null : wrapper;
    if (element.parentNode !== (parent ?? this.host)) (parent ?? this.host).appendChild(element);
    return where === "viewport" && !!parent;
  }

  /** Space is held in the "space" pan mode (React Flow's panActivationKeyCode): wheels pan, as its panOnScroll. */
  get spaceHeld() {
    return this.space && this.editing().navigation.panMode === "space";
  }

  /** Whether a node or wire drag holds `canvas-interacting`: the pan tracker must not take it away mid-drag. */
  get holdsInteracting() {
    return this.interactingHolds > 0;
  }

  private holdInteracting(on: boolean) {
    this.interactingHolds = Math.max(0, this.interactingHolds + (on ? 1 : -1));
    if (on) document.documentElement.classList.add("canvas-interacting");
    else if (!this.interactingHolds) {
      document.documentElement.classList.remove("canvas-interacting");
      this.onInteractingEnd?.();
    }
  }

  // ── Keys ──────────────────────────────────────────────────────────────

  private keyDown(event: KeyboardEvent) {
    // Space is the pan key only in the "space" pan mode (WorkflowCanvas's panActivationKeyCode).
    if (event.code === "Space" && !typing(event.target) && this.editing().navigation.panMode === "space") this.space = true;
    if (event.defaultPrevented || keyInField(event)) return;
    const { disabled, locked } = this.editing();
    if (disabled || useAssetStore.getState().appView !== "canvas") return;
    if (event.key === "Delete" || event.key === "Backspace") {
      // React Flow's delete key: the key alone, with no modifier held.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (this.deleteSelection()) event.preventDefault();
      return;
    }
    // The keys React Flow gives a focused node: arrows move the selection, Enter and Space select, Escape unselects.
    if (locked) return;
    const step = ARROW_STEPS[event.key];
    if (step) {
      // Classic's arrows move the selection from a focused node that is selected and draggable (NodeWrapper's
      // onKeyDown), or from the focused selection frame; with focus on nothing they do nothing.
      if (!this.arrowsMove()) return;
      if (this.nudgeSelection(step.x * (event.shiftKey ? 4 : 1), step.y * (event.shiftKey ? 4 : 1))) event.preventDefault();
      return;
    }
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Escape") return;
    // The focused node: a live one holding focus, or the painted node a press left the keys with (classic's press
    // focuses the node's wrapper).
    const focused = this.focusedLiveNode();
    const target = focused ?? (this.keyboardFocusOnCanvas() && this.keyTarget?.kind === "node" ? this.keyTarget.id : null);
    if (!target) return;
    const node = useWorkflowStore.getState().nodes.find((n) => n.id === target);
    if (!node || node.selectable === false) return;
    // React Flow's handleNodeClick: an unselected node is selected (Shift adds it); a selected one leaves the
    // selection on Escape, or with Shift held (multiSelectionActive), and loses focus.
    if (!node.selected) this.selectNodes([target], event.shiftKey);
    else if (event.key === "Escape" || event.shiftKey) {
      useWorkflowStore.getState().onNodesChange([{ type: "select", id: target, selected: false }]);
      if (focused) {
        const active = document.activeElement;
        requestAnimationFrame(() => {
          if (active instanceof HTMLElement && document.activeElement === active) active.blur();
        });
      } else this.keyTarget = null;
    }
  }

  /** Whether an arrow key moves the selection: a focused live node, or the canvas's keyTarget, takes it. */
  private arrowsMove(): boolean {
    const nodes = useWorkflowStore.getState().nodes;
    const focusedNode = this.focusedLiveNode();
    if (focusedNode) return !!nodes.find((n) => n.id === focusedNode)?.selected;
    const target = this.keyTarget;
    if (!this.keyboardFocusOnCanvas() || !target) return false;
    if (target.kind === "selection") return nodes.some((n) => n.selected);
    const node = nodes.find((n) => n.id === target.id);
    return !!node?.selected && node.draggable !== false;
  }

  /** The live node holding keyboard focus (React Flow focuses a node when it is clicked). */
  private focusedLiveNode(): string | null {
    const active = document.activeElement;
    if (!(active instanceof Element) || !active.closest("[data-gpu-canvas-live]")) return null;
    return active.closest(".react-flow__node:not(.react-flow__node-gpuGhost)")?.getAttribute("data-id") ?? null;
  }

  /** Focus where a click on a painted node or empty canvas leaves it: on nothing. */
  private keyboardFocusOnCanvas() {
    const active = document.activeElement;
    return !active || active === document.body || active === this.scene.canvas;
  }

  /** Moves the selected nodes by (dx, dy) as React Flow's arrow keys do (one position change, no undo step of its own). */
  private nudgeSelection(dx: number, dy: number): boolean {
    const graph = this.scene.graph;
    const moving = useWorkflowStore.getState().nodes
      .filter((n) => n.selected && n.draggable !== false)
      .map((n) => graph.indexOf.get(n.id))
      .filter((i): i is number => i != null);
    if (!moving.length) return false;
    for (const i of moving) {
      graph.nodes[i].x += dx;
      graph.nodes[i].y += dy;
    }
    this.scene.nodesMoved(moving);
    this.live.refresh();
    useWorkflowStore.getState().onNodesChange(this.positionChanges(moving, false));
    return true;
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
    const scene = this.scene;
    const at = scene.local(event);
    // A middle press on a node or connection pans whatever the pan mode, the tutorial or a dialog say:
    // the first rule of React Flow's zoom filter, ahead of its panOnDrag checks. Only a node's body counts
    // (classic's floating header is outside .react-flow__node), and not on a locked canvas (its nodes let the
    // pointer through to the pane): those presses fall to the pan mode below.
    if (event.button === 1 && (this.middlePanOnNode(event, at) || scene.edgeAt(at.x, at.y) >= 0)) {
      return this.pan(event);
    }
    if (editing.disabled) return null;
    // With the selection key held, classic's pane takes the press before anything in it (React Flow's Pane
    // onPointerDownCapture): a floating header, group chrome or a connection's label does not get it. Their
    // click selects nothing (it never reaches a node's wrapper or the pane itself); a drag draws a marquee.
    const keyTakes = this.selectionKeyTakes(event);
    if (keyTakes && (onLiveChrome(event) || this.headerFromEvent(event, at) >= 0)) {
      return this.clickGesture(event, () => {}, () => this.marqueeGesture(event), 0);
    }
    // A group's title or grip pans where classic's zoom pane would take the press (its mousedown, which the group's
    // own drag and resize listen for, the live layer then stops): the live layer sends only those presses here.
    if (onGroupChrome(event.target)) {
      if (!this.groupChromePans(event)) return null;
      return event.button === 2 ? this.rightPan(event) : this.pan(event);
    }
    // A floating header's own drag (FloatingNodeHeader) takes a left press whatever the pan mode and the lock say.
    if (event.button === 0) {
      const header = this.headerFromEvent(event, at);
      if (header >= 0) return this.headerGesture(event, header);
    }
    // On the Mac a Control+click is a secondary click: the browser fires no click for it, only the context menu
    // (Editor.contextMenu), so classic's click-driven selection changes nothing. It starts no gesture here either.
    if (isMac && event.button === 0 && event.ctrlKey) return null;
    const space = this.space && !editing.tutorial;
    const modifiers = { button: event.button, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, space };
    const panning = paneDragAction(editing.navigation, modifiers, isMac);
    // The tutorial turns panning off: such a press selects, drags and connects as a plain one.
    const action = editing.tutorial && panning === "pan" ? null : panning;
    // The middle button pans from anywhere (a press on a node or connection is handled above). The right
    // button (the "middleMouse" mode's) does not from a handle, a draggable node or a connection: React Flow's nopan.
    // A left press, Space held or not, still takes a handle or a node first, for the same reason.
    if (action === "pan" && event.button !== 0) {
      if (event.button === 1) return this.pan(event);
      // Only a node's body is a node here: classic's floating header sits outside .react-flow__node, so React Flow's
      // filter lets a right press on it pan, except from an element marked nopan (its title field, picker, buttons).
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-gpu-canvas-live]") && target.closest(".nopan")) return null;
      const onNode = this.middlePanOnNode(event, at);
      if (onNode || this.handleFromEvent(event) || this.paintedHandleAt(at.x, at.y) || scene.edgeAt(at.x, at.y) >= 0) return null;
      return this.rightPan(event);
    }
    if (event.button !== 0) return null;
    const keyHeld = selectionKeyHeld(editing.navigation, modifiers);
    // With the selection key held, React Flow's pane takes the press before a handle can: no connection starts.
    // A locked canvas still connects from a socket, as classic's do (Socket's handles stay connectable).
    if (!keyHeld) {
      const handle = this.handleFromEvent(event) ?? this.paintedHandleAt(at.x, at.y);
      if (handle) return this.connectGesture(event, handle);
    }
    // A locked canvas's nodes do not take the pointer (React Flow gives them pointer-events none): a press on one is the pane's.
    let node = editing.locked ? -1 : this.nodeFromEvent(event) ?? scene.nodeAt(at.x, at.y);
    // With the selection key held, a socket (its half outside the node's box too) is its node's: React Flow's pane
    // takes the press and the click bubbles from the handle to its node's wrapper (Shift toggles it, Alt selects it).
    if (node < 0 && keyHeld && !editing.locked) node = (this.handleFromEvent(event) ?? this.paintedHandleAt(at.x, at.y))?.node ?? -1;
    // A connection's end, outside the handle it meets, moves that end (React Flow's reconnect anchors). A locked
    // canvas still reconnects, as classic's anchors check neither the lock nor nodesConnectable (no line is drawn).
    if (node < 0 && !keyHeld) {
      const end = this.edgeEndAt(at.x, at.y);
      if (end) return this.connectGesture(event, edgeEndHandle(scene.graph, end.edge, end.end === "source" ? "target" : "source"), end.edge);
    }
    const edge = node < 0 ? scene.edgeAt(at.x, at.y) : -1;
    // With the selection key held, a press on a node or connection starts a selection: a drag draws a
    // marquee at once, a release is still a click (Shift toggles it, as multiSelectionKeyCode).
    if ((node >= 0 || edge >= 0) && keyHeld && !editing.locked) {
      // Held by id from the press: a graph rebuilt before the release renumbers the nodes and connections.
      const nodeId = node >= 0 ? scene.graph.nodes[node].id : null, edgeId = edge >= 0 ? scene.graph.edges[edge].id : "";
      // A live node's button, link, field or nodrag control selects through LiveFlow's nodeClick (once, or not when
      // the element stops its click), as classic's NodeWrapper click: toggling here as well would undo it.
      const click = nodeId != null
        ? (liveNodeClickSelects(event) ? () => {} : () => this.clickNode(nodeId, event.shiftKey))
        : () => this.clickEdge(event, edgeId);
      return this.clickGesture(event, click, () => this.marqueeGesture(event), 0);
    }
    // Otherwise a drag that selects (selectionOnDrag) starts only on empty canvas, as React Flow's pane does.
    if (node >= 0) return this.nodeGesture(event, node);
    // A connection is React Flow's nopan: only the middle button pans from it (above), and a left drag moves nothing.
    if (edge >= 0) return this.edgePressGesture(scene.graph.edges[edge].id);
    if (action === "pan") return this.paneGesture(event, scene.panGesture(event));
    // A marquee starts once the press moves (at once with the selection key held); a release before that is a pane click.
    if (action === "select" && !editing.locked) {
      return this.clickGesture(event, () => this.paneClick(), () => this.marqueeGesture(event), keyHeld ? 0 : PANE_CLICK_DISTANCE);
    }
    return this.paneGesture(event, null);
  };

  /**
   * Whether a middle (or the right, panning) press is on a node's body, as React Flow's zoom filter sees it: the live node's element (not
   * its floating header) or a painted node's box (not its header band). A locked canvas's nodes are the pane's.
   */
  private middlePanOnNode(event: PointerEvent, at: { x: number; y: number }): boolean {
    if (this.editing().locked) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-gpu-canvas-live]")) {
      if (target.closest("[data-node-header]")) return false;
      if (target.closest(".react-flow__node:not(.react-flow__node-gpuGhost)")) return true;
    }
    return this.scene.nodeAt(at.x, at.y, false) >= 0;
  }

  /** The live node (or its floating header) a press from the live layer landed on. */
  private nodeFromEvent(event: PointerEvent): number | null {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-gpu-canvas-live]")) return null;
    const id = target.closest("[data-node-header]")?.getAttribute("data-node-header") ?? target.closest(".react-flow__node:not(.react-flow__node-gpuGhost)")?.getAttribute("data-id");
    return id ? this.scene.graph.indexOf.get(id) ?? null : null;
  }

  /**
   * The node whose floating header a press landed on: the live header's element, or a painted node's header band
   * (above its box). A locked canvas's headers take the pointer too, as classic's (only its node bodies are the pane's).
   */
  private headerFromEvent(event: PointerEvent, at: { x: number; y: number }): number {
    const target = event.target instanceof Element ? event.target : null;
    const graph = this.scene.graph;
    if (target?.closest("[data-gpu-canvas-live]")) {
      const id = target.closest("[data-node-header]")?.getAttribute("data-node-header");
      return id ? graph.indexOf.get(id) ?? -1 : -1;
    }
    const i = this.scene.nodeAt(at.x, at.y);
    return i >= 0 && this.scene.toWorld(at.x, at.y).y < graph.nodes[i].y ? i : -1;
  }

  /**
   * React Flow's Pane takes this press for a selection on classic: a primary left press with the selection key held
   * (Shift, or Alt in "altDrag"), the canvas selectable (no dialog, not locked), not from a `.nokey` element.
   */
  private selectionKeyTakes(event: PointerEvent): boolean {
    const editing = this.editing();
    if (editing.disabled || editing.locked || event.button !== 0 || event.isPrimary === false) return false;
    if (event.target instanceof Element && event.target.closest(".nokey")) return false;
    return selectionKeyHeld(editing.navigation, { button: event.button, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, space: false });
  }

  /**
   * Whether a press on a group's title or resize grip pans the canvas, as on classic, where d3-zoom takes its
   * mousedown whenever React Flow's filter lets the pane pan with that button (panOnDrag, or Space in the "space"
   * mode; never with Control, the selection key, a dialog or the tutorial).
   */
  groupChromePans(event: MouseEvent): boolean {
    const editing = this.editing();
    if (editing.disabled || editing.tutorial || !onGroupChrome(event.target)) return false;
    const modifiers = { button: event.button, shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, space: this.space };
    return paneDragAction(editing.navigation, modifiers, isMac) === "pan";
  }

  /** A handle of a live node, when the press came from the live layer. */
  private handleFromEvent(event: PointerEvent): HandleHit | null {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".react-flow__handle") : null;
    const nodeId = element?.dataset.nodeid;
    const i = nodeId ? this.scene.graph.indexOf.get(nodeId) : undefined;
    if (!element || i == null) return null;
    const rect = element.getBoundingClientRect(), box = this.scene.canvas.getBoundingClientRect();
    const p = this.scene.toWorld(rect.left + rect.width / 2 - box.left, rect.top + rect.height / 2 - box.top);
    const handleId = element.dataset.handleid ?? "", type = element.classList.contains("source") ? "source" : "target";
    const n = this.scene.graph.nodes[i], anchor = n.handles?.get(`${type}:${handleId}`);
    const classes = element.classList;
    return {
      node: i, handleId, type, x: anchor ? n.x + anchor.x : p.x, y: anchor ? n.y + anchor.y : p.y, cx: p.x, cy: p.y,
      connectableEnd: classes.contains("connectable") && classes.contains("connectableend"),
    };
  }

  /** The painted handle under a point (css px): on its socket, or within HANDLE_HIT_PX of its centre. */
  private paintedHandleAt(cssX: number, cssY: number): HandleHit | null {
    const scene = this.scene, p = scene.toWorld(cssX, cssY), floor = HANDLE_HIT_PX / scene.view.zoom;
    // Handles sit on a node's sides, a little outside it.
    let near = this.nodesNear(p.x, p.y, Math.max(floor, 24) + 24);
    // A node over the point covers the sockets of the nodes under it, as its element takes the pointer on today's canvas.
    const top = scene.nodeAt(cssX, cssY);
    if (top >= 0) near = near.filter((i) => scene.drawnAtOrAbove(i, top));
    return handleAt(scene.graph, near, p.x, p.y, floor);
  }

  /** The connection end (its reconnect anchor) under a point (css px). */
  private edgeEndAt(cssX: number, cssY: number) {
    const p = this.scene.toWorld(cssX, cssY);
    // The anchors sit beside the handles, a little outside their nodes.
    return edgeEndAt(this.scene.graph, this.nodesNear(p.x, p.y, RECONNECT_RADIUS * 2 + 24), p.x, p.y);
  }

  private nodesNear(x: number, y: number, reach: number): number[] {
    return this.scene.nodesWithin(x - reach, y - reach, x + reach, y + reach);
  }

  /**
   * Follows a press until it moves `distance` (any movement at 0) or ends; a release before that is a click.
   * A drag takes the pointer (the scene leaves a press on a live node uncaptured until then, so its click lands).
   */
  private clickGesture(event: PointerEvent, click: () => void, drag?: (move: PointerEvent) => Gesture | null, distance = CLICK_DISTANCE): Gesture {
    const startX = event.clientX, startY = event.clientY;
    const fromLive = event.target instanceof Element && !!event.target.closest("[data-gpu-canvas-live]");
    let dragging: Gesture | null = null, moved = false;
    return {
      move: (move) => {
        if (dragging) return dragging.move(move);
        const travel = Math.hypot(move.clientX - startX, move.clientY - startY);
        if (moved || travel === 0 || travel < distance) return;
        moved = true;
        dragging = drag?.(move) ?? null;
        // No drag (a locked canvas): the pointer stays free, so a press on a live node's button still clicks it.
        if (!dragging) return;
        this.scene.capture();
        dragging.move(move);
      },
      up: (up) => {
        if (dragging) {
          dragging.up(up);
          // As d3-drag's noclick: a drag that began on a live node's button or link does not click it as it drops.
          if (fromLive) swallowNextClick();
        } else if (!moved) click();
      },
      cancel: () => dragging?.cancel(),
    };
  }

  /**
   * A left press on a connection: it never drags or captures. As the browser's click, which needs the press and the
   * release on the same element, a release still on that connection clicks it, however far the pointer travelled.
   */
  private edgePressGesture(edgeId: string): Gesture {
    return {
      move: () => {},
      up: (up) => {
        const at = this.scene.local(up);
        // A node over the release point (its element on classic, unless locked) takes the release: no click.
        if (!this.editing().locked && this.scene.nodeAt(at.x, at.y) >= 0) return;
        const edge = this.scene.edgeAt(at.x, at.y);
        // The browser's click fires at the release: its point anchors the toolbar and its Shift selects.
        if (edge >= 0 && this.scene.graph.edges[edge]?.id === edgeId) this.clickEdge(up, edgeId);
      },
      cancel: () => {},
    };
  }

  /**
   * Empty canvas: a click clears the selection; a drag pans when `pan` is given, from the first
   * pixel as d3-zoom does (its clickDistance is React Flow's paneClickDistance).
   */
  private paneGesture(event: PointerEvent, pan: Gesture | null): Gesture {
    if (!pan) return this.paneReleaseGesture();
    const gesture = this.clickGesture(event, () => this.paneClick(), () => pan, PANE_CLICK_DISTANCE);
    // React Flow's pane is `dragging` from the press (d3-zoom's start), a click included.
    return pan ? this.withCursor(gesture, this.panCursor(event)) : gesture;
  }

  /**
   * A press on empty canvas that neither pans nor draws a marquee (d3-zoom refuses it: the tutorial, the
   * right-button pan mode, Control held, a locked canvas). Nothing suppresses the browser's click there, so it
   * lands however far the pointer travelled, as long as the release is still over the pane.
   */
  private paneReleaseGesture(): Gesture {
    return {
      move: () => {},
      up: (up) => {
        if (releasedInside(this.scene.canvas.getBoundingClientRect(), up)) this.paneClick();
      },
      cancel: () => {},
    };
  }

  /** A pan from this press, the canvas showing the pane's cursor while it runs. */
  private pan(event: PointerEvent): Gesture {
    return this.withCursor(this.scene.panGesture(event), this.panCursor(event));
  }

  /**
   * The right button's pan ("middleMouse" mode). A release that never moved opens the add-node menu there, as
   * React Flow's d3-zoom end calls onPaneContextMenu when the right press fired no zoom (any mousemove fires one).
   */
  private rightPan(event: PointerEvent): Gesture {
    const pan = this.scene.panGesture(event);
    let moved = false;
    return this.withCursor({
      move: (move) => {
        if (move.clientX !== event.clientX || move.clientY !== event.clientY) moved = true;
        pan.move(move);
      },
      up: (up) => {
        pan.up(up);
        const editing = this.editing();
        if (!moved && !editing.disabled && !editing.tutorial) editing.onPaneMenu(up.clientX, up.clientY);
      },
      cancel: () => pan.cancel(),
    }, this.panCursor(event));
  }

  /** The pane's cursor while it pans: its `dragging` class's grabbing, unless its `selection` class (paneCursor) wins. */
  private panCursor(event: PointerEvent) {
    return this.paneCursor(event.shiftKey, event.altKey) === "pointer" ? "pointer" : "grabbing";
  }

  /** Shows `cursor` on the canvas while `gesture` runs; as it ends, what is under the pointer sets the cursor again. */
  private withCursor(gesture: Gesture, cursor: string): Gesture {
    this.scene.canvas.style.cursor = cursor;
    return {
      move: (move) => gesture.move(move),
      up: (up) => {
        gesture.up(up);
        this.idleMove(up);
      },
      cancel: () => {
        gesture.cancel();
        this.scene.canvas.style.cursor = "";
      },
    };
  }

  /**
   * A click on empty canvas: clears the selection (not on a locked canvas, where React Flow's
   * resetSelectedElements keeps it), and WorkflowCanvas's onPaneClick (it collapses the stub group).
   */
  private paneClick() {
    this.hideSelectionFrame();
    this.keyTarget = null;
    if (!this.editing().locked) this.clearSelection();
    this.editing().onPaneClick();
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
  selectNodes(ids: string[], additive: boolean, evenLocked = false) {
    if (this.editing().locked && !evenLocked) return;
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

  /**
   * A click on a node, as React Flow's handleNodeClick: an unselected node becomes the selection (Shift
   * adds it); a selected one leaves it with Shift, and otherwise the selection stays as it is.
   */
  clickNode(id: string, additive: boolean) {
    this.hideSelectionFrame();
    // Classic's click focuses the node's wrapper, whether or not the selection changes.
    this.keyTarget = { kind: "node", id };
    const node = useWorkflowStore.getState().nodes.find((n) => n.id === id);
    if (!node || (node.selected && !additive)) return;
    // Shift on a selected node unselects it, and classic's handleNodeClick blurs it: the keys leave it.
    if (node.selected && node.selectable !== false) this.keyTarget = null;
    this.selectNodes([id], additive);
  }

  private clickEdge(event: PointerEvent, id: string) {
    const editing = this.editing();
    const store = useWorkflowStore.getState();
    const edge = store.edges.find((candidate) => candidate.id === id);
    if (!edge) return;
    // Classic's click focuses the connection's EdgeWrapper (when it is focusable), whatever the selection does:
    // its keys (Escape, Enter, Space) then act on it, not on a node pressed earlier.
    this.keyTarget = null;
    if (edge.focusable !== false) void this.keyboard.go({ kind: "edge", id });
    // On a locked canvas, or for a connection that cannot be selected, the click still reaches
    // WorkflowCanvas (its toolbar moves there) without changing the selection, as React Flow's EdgeWrapper.
    if (!editing.locked && edge.selectable !== false) {
      // Shift adds the connection, and selected nodes drop it again at once (WorkflowCanvas's handleSelectionChange,
      // which closes its toolbar too): nothing changes.
      if (event.shiftKey && store.nodes.some((n) => n.selected)) return;
      // React Flow's edge click: only this connection, or added to the selection with Shift.
      const additive = event.shiftKey;
      const nodes = additive ? [] : store.nodes.filter((n) => n.selected).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: false }));
      const edges = store.edges.flatMap((candidate): EdgeChange<WorkflowEdge>[] => {
        const selected = candidate.id === edge.id ? (additive ? !candidate.selected : true) : additive ? !!candidate.selected : false;
        return !!candidate.selected === selected ? [] : [{ type: "select", id: candidate.id, selected }];
      });
      if (nodes.length) store.onNodesChange(nodes);
      if (edges.length) store.onEdgesChange(edges);
    }
    editing.onEdgeClick(event, edge);
  }

  // ── Node drag ─────────────────────────────────────────────────────────

  private nodeGesture(event: PointerEvent, i: number): Gesture {
    const id = this.scene.graph.nodes[i].id;
    // The press focuses the node, as its wrapper takes focus on classic (a live node's own element takes it itself).
    this.keyTarget = { kind: "node", id };
    // A still press on a live node's button or link selects through the node's own click (LiveFlow's nodeClick),
    // which the button's stopPropagation cancels, as classic's NodeWrapper click.
    const click = onLiveButton(event) ? () => {} : () => this.clickNode(id, event.shiftKey);
    const gesture = this.clickGesture(event, click, (move) => this.editing().locked ? null : this.dragGesture(event, move, id));
    // Classic keeps a node mounted through a press: the pressed node stays live until the gesture ends (once the
    // click has selected it or the drag let go), though the press took its hover away (a capture, a jittery click).
    this.live.want(id, "press", true);
    const release = () => this.live.want(id, "press", false);
    return {
      move: gesture.move,
      up: (up) => {
        gesture.up(up);
        release();
      },
      cancel: () => {
        gesture.cancel();
        release();
      },
    };
  }

  /**
   * A press on a node's floating header, as FloatingNodeHeader's drag: the press makes an unselected node the only
   * selection, whatever the keys; past 5px on either axis the node moves, with the selection only if it was already
   * selected; on release every moved node is regrouped. A release before that changes nothing more. The lock
   * changes none of it, as the header's own setNodes ignores nodesDraggable and elementsSelectable.
   */
  private headerGesture(event: PointerEvent, i: number): Gesture {
    const id = this.scene.graph.nodes[i].id;
    const wasSelected = !!useWorkflowStore.getState().nodes.find((n) => n.id === id)?.selected;
    if (!wasSelected) {
      this.hideSelectionFrame();
      this.selectNodes([id], false, true);
    }
    const startX = event.clientX, startY = event.clientY;
    const fromLive = event.target instanceof Element && !!event.target.closest("[data-gpu-canvas-live]");
    let dragging: Gesture | null = null, moved = false;
    this.live.want(id, "press", true);
    const release = () => this.live.want(id, "press", false);
    return {
      move: (move) => {
        if (dragging) return dragging.move(move);
        if (moved || Math.max(Math.abs(move.clientX - startX), Math.abs(move.clientY - startY)) <= HEADER_DRAG_DISTANCE) return;
        moved = true;
        dragging = this.dragGesture(event, move, id, { header: true, carry: wasSelected });
        if (!dragging) return;
        this.scene.capture();
        dragging.move(move);
      },
      up: (up) => {
        if (dragging) {
          dragging.up(up);
          if (fromLive) swallowNextClick();
        }
        release();
      },
      cancel: () => {
        dragging?.cancel();
        release();
      },
    };
  }

  /**
   * The pressed node is held by id: a graph rebuilt between the press and the drag renumbers it. `header` is a
   * floating header's drag: it carries the selection only when `carry` says so, follows the pointer from the press
   * and regroups every moved node on release.
   */
  private dragGesture(down: PointerEvent, first: PointerEvent, pressedId: string, header?: { header: true; carry: boolean }): Gesture | null {
    const scene = this.scene, graph = scene.graph;
    const store = useWorkflowStore.getState();
    const pressedNode = store.nodes.find((n) => n.id === pressedId);
    // The header's drag moves the node whatever its draggable flag says, as its own setNodes does.
    if (!pressedNode || (!header && pressedNode.draggable === false)) return null;
    // React Flow's XYDrag with selectNodesOnDrag off: a selected node carries the selection; an unselected one
    // clears it and moves alone, unless Shift (multiSelectionKeyCode) is held, when it moves with the selection.
    if (!header && !pressedNode.selected && !down.shiftKey) this.clearSelection();
    const carries = header ? header.carry : pressedNode.selected || down.shiftKey;
    const carried = carries
      ? useWorkflowStore.getState().nodes.filter((n) => n.selected && (header || n.draggable !== false)).map((n) => n.id)
      : [];
    const ids = [...new Set([...carried, pressedId])].filter((id) => graph.indexOf.has(id));
    const start = new Map(ids.map((id) => {
      const n = graph.nodes[graph.indexOf.get(id)!];
      return [id, { x: n.x, y: n.y }];
    }));
    // The nodes are held by id: nodes added or removed mid-drag renumber the graph (GpuCanvas's sync).
    const moving = () => ids.map((id) => scene.graph.indexOf.get(id)).filter((n): n is number => n != null);
    const generation = store.canvasGeneration;
    const replaced = () => useWorkflowStore.getState().canvasGeneration !== generation;
    let last = { dx: 0, dy: 0 };
    const held = (id: string) => {
      const from = start.get(id);
      return from && { x: from.x + last.dx, y: from.y + last.dy };
    };
    const moveTo = (indices: number[]) => {
      for (const n of indices) {
        const node = scene.graph.nodes[n], at = held(node.id)!;
        node.x = at.x;
        node.y = at.y;
      }
    };
    // A store write to a dragged node mid-drag (a run's status, an edit elsewhere) keeps it where the drag holds it,
    // as classic's drag positions are laid over the store's nodes; a replaced canvas holds nothing.
    scene.graph.hold = (id) => replaced() ? undefined : held(id);
    // As React Flow's drag starts once past its threshold: from where the pointer is then, so the nodes do not jump.
    // The header's drag measures from the press.
    const at0 = scene.local(header ? down : first), origin = scene.toWorld(at0.x, at0.y);
    // The dragged nodes stay live while they move (the pressed one is hovered, a selection is live).
    this.live.wantOnly("drag", ids);
    this.holdInteracting(true);
    // React Flow's .draggable.dragging: grabbing while the nodes move, on the canvas and the live nodes.
    this.live.element.setAttribute("data-gpu-dragging", "");
    scene.canvas.style.cursor = "grabbing";
    let committedFirst = false, ended = false, panFrame = 0, pointer = first;
    const place = (event: PointerEvent) => {
      if (ended || replaced()) return;
      pointer = event;
      const p = scene.local(event), w = scene.toWorld(p.x, p.y);
      const dx = w.x - origin.x, dy = w.y - origin.y;
      if (dx === last.dx && dy === last.dy) return;
      last = { dx, dy };
      const indices = moving();
      moveTo(indices);
      scene.input(event);
      scene.nodesMoved(indices);
      this.live.refresh(true);
      // The first move reaches the store: it records the undo step.
      if (!committedFirst) {
        committedFirst = true;
        useWorkflowStore.getState().onNodesChange(this.positionChanges(indices, true));
      }
    };
    // React Flow's autoPanOnNodeDrag: near the canvas's edge the view pans every frame, the pointer still or not,
    // and the nodes move with it so they stay under the pointer. A floating header's drag has none: its own drag
    // (FloatingNodeHeader) stops the press before React Flow, so the view stays put at the edge.
    const autoPan = () => {
      if (ended || replaced() || scene.isDisposed) return;
      const { clientWidth: width, clientHeight: height } = scene.canvas;
      const [vx, vy] = width && height ? autoPanVelocity(scene.local(pointer), { width, height }) : [0, 0];
      if (vx || vy) {
        scene.setView({ x: scene.view.x + vx, y: scene.view.y + vy });
        place(pointer);
      }
      panFrame = requestAnimationFrame(autoPan);
    };
    const finish = (event: PointerEvent | null) => {
      ended = true;
      cancelAnimationFrame(panFrame);
      this.live.wantOnly("drag", []);
      this.holdInteracting(false);
      this.live.element.removeAttribute("data-gpu-dragging");
      if (event) this.idleMove(event);
      else scene.canvas.style.cursor = "";
      // The canvas was replaced mid-drag: the positions belong to the old one.
      if (replaced()) {
        scene.graph.hold = null;
        return;
      }
      const state = useWorkflowStore.getState();
      const indices = moving();
      if (!event) last = { dx: 0, dy: 0 };
      moveTo(indices);
      if (!event) scene.nodesMoved(indices);
      state.onNodesChange(this.positionChanges(indices, false));
      scene.graph.hold = null;
      if (!event) return;
      // React Flow's onNodeDragStop names the pressed node; the header's drag checks every moved node's group.
      for (const id of header ? ids : [pressedId]) {
        const node = useWorkflowStore.getState().nodes.find((n) => n.id === id);
        if (node) this.editing().onNodeDragStop(event, node);
      }
    };
    if (!header) panFrame = requestAnimationFrame(autoPan);
    return { move: place, up: (event) => finish(event), cancel: () => finish(null) };
  }

  private positionChanges(moving: number[], dragging: boolean): NodeChange<WorkflowNode>[] {
    const graph = this.scene.graph;
    return moving.map((n) => ({ type: "position", id: graph.nodes[n].id, position: { x: graph.nodes[n].x, y: graph.nodes[n].y }, dragging }));
  }

  // ── Marquee ───────────────────────────────────────────────────────────

  private marqueeGesture(down: PointerEvent): Gesture {
    const scene = this.scene;
    // The press is held in flow coordinates, so a pan or zoom mid-marquee keeps its corner on the same canvas spot.
    const down0 = scene.local(down);
    const anchor = scene.toWorld(down0.x, down0.y);
    let last = down0;
    let previousNodes = "", previousEdges = "";
    // A marquee replaces the selection: it starts from none (React Flow's resetSelectedElements as it starts).
    this.hideSelectionFrame();
    this.clearSelection();
    // The pane's cursor while a selection is under way (React Flow's userSelectionActive), wherever it started.
    scene.canvas.style.cursor = "pointer";
    // Live nodes are judged by their cards as they show now, as NodeMarqueeSelection measures the DOM as it starts.
    const cards = this.liveCards();
    const update = (at: { x: number; y: number }) => {
      last = at;
      const start = scene.toScreen(anchor.x, anchor.y);
      const left = Math.min(start.x, at.x), top = Math.min(start.y, at.y), width = Math.abs(at.x - start.x), height = Math.abs(at.y - start.y);
      this.mountInFlow(this.marquee, "wrapper");
      Object.assign(this.marquee.style, { display: "block", left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      const a = scene.toWorld(left, top), b = scene.toWorld(left + width, top + height);
      const box = { left: a.x, top: a.y, right: b.x, bottom: b.y };
      const taken = marqueeNodes(scene.graph, scene.nodesWithin(a.x, a.y, b.x, b.y), box, cards).map((i) => scene.graph.nodes[i].id);
      const key = taken.join("\n");
      const state = useWorkflowStore.getState();
      if (key !== previousNodes) {
        previousNodes = key;
        const next = new Set(taken);
        const changes = state.nodes.filter((n) => !!n.selected !== next.has(n.id) && n.selectable !== false).map((n): NodeChange<WorkflowNode> => ({ type: "select", id: n.id, selected: next.has(n.id) }));
        if (changes.length) state.onNodesChange(changes);
      }
      // With no node selected, the connections the marquee crosses (EdgeMarqueeSelection).
      const edgeIds = useWorkflowStore.getState().nodes.some((n) => n.selected) ? [] : this.edgesCrossing(box);
      const edgeKey = edgeIds.join("\n");
      if (edgeKey !== previousEdges) {
        previousEdges = edgeKey;
        const next = new Set(edgeIds);
        const now = useWorkflowStore.getState();
        const changes = now.edges.filter((e) => !!e.selected !== next.has(e.id)).map((e): EdgeChange<WorkflowEdge> => ({ type: "select", id: e.id, selected: next.has(e.id) }));
        if (changes.length) now.onEdgesChange(changes);
      }
    };
    // A wheel or pinch redraws the box at once, from where the pointer last was.
    const offView = scene.onViewChanged(() => update(last));
    const end = () => {
      offView();
      this.marquee.style.display = "none";
    };
    return {
      move: (event) => update(scene.local(event)),
      up: (event) => {
        end();
        // A marquee that took only connections opens the toolbar at the release (handleSelectionEnd).
        const now = useWorkflowStore.getState();
        const firstEdge = now.edges.find((e) => e.selected);
        if (now.nodes.some((n) => n.selected)) {
          // Nodes taken: React Flow frames them (nodesSelectionActive).
          this.selectionFrameActive = true;
          this.placeSelectionFrame();
          // React Flow focuses its NodesSelection rect as it shows: the arrows move the selection from there.
          if (this.selectionFrameActive) this.keyTarget = { kind: "selection" };
        } else if (firstEdge) {
          const p = scene.local(event), w = scene.toWorld(p.x, p.y);
          useWorkflowStore.setState({ edgeMenuAnchor: { edgeId: firstEdge.id, x: w.x, y: w.y } });
        }
      },
      cancel: end,
    };
  }

  /** The media cards of the live nodes as they show (an image loaded or a section opened since their paint). */
  private liveCards(): Map<number, CardBox> {
    const cards = new Map<number, CardBox>();
    for (const id of this.live.live) {
      const i = this.scene.graph.indexOf.get(id);
      if (i == null || !this.live.nodeElement(id)?.offsetWidth) continue;
      cards.set(i, mediaCardBox(this.live.element, id));
    }
    return cards;
  }

  /** Frames the selected nodes (the union of their boxes, in css px), or hides the frame when none is selected. */
  private placeSelectionFrame() {
    const scene = this.scene, graph = scene.graph;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of useWorkflowStore.getState().nodes) {
      const i = node.selected ? graph.indexOf.get(node.id) : undefined;
      if (i == null) continue;
      const n = graph.nodes[i];
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    if (minX > maxX) {
      this.hideSelectionFrame();
      return;
    }
    // Sized in flow units and scaled by the zoom, as React Flow's nodesselection wrapper is: its dotted border
    // is a flow pixel, thin zoomed out and heavy zoomed in.
    const a = scene.toScreen(minX, minY);
    this.mountInFlow(this.selectionFrame, "wrapper");
    Object.assign(this.selectionFrame.style, {
      display: "block", left: "0px", top: "0px", transformOrigin: "0 0",
      transform: `translate(${a.x}px, ${a.y}px) scale(${scene.view.zoom})`,
      width: `${maxX - minX}px`, height: `${maxY - minY}px`,
    });
  }

  private hideSelectionFrame() {
    if (!this.selectionFrameActive) return;
    this.selectionFrameActive = false;
    if (this.keyTarget?.kind === "selection") this.keyTarget = null;
    this.selectionFrame.style.display = "none";
  }

  private edgesCrossing(box: { left: number; top: number; right: number; bottom: number }): string[] {
    const scene = this.scene, ids: string[] = [];
    const rect = { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top };
    for (const e of scene.edgesWithin(box.left, box.top, box.right, box.bottom)) {
      const edge = scene.graph.edges[e]?.edge;
      const route = scene.edgeRoute(e);
      if (!edge || !route || edge.hidden || edge.data?.hidden || edge.selectable === false || edge.type === "reference") continue;
      // The noodle is one path; a bundle's shared stem is a path of its first member's (BundleStem).
      const sample = (c: (typeof route.segments)[number]) => Array.from({ length: 17 }, (_, k) => cubicAt(c, k / 16));
      const paths = [route.segments.flatMap(sample), ...route.stems.map((stem) => sample(stem.segment))];
      if (paths.some((points) => pathIntersectsRect(points, rect))) ids.push(edge.id);
    }
    return ids;
  }

  // ── Connecting ────────────────────────────────────────────────────────

  /**
   * A connection drawn from `from`. With `reconnecting`, the press took that edge's other end: the
   * edge is hidden while it is drawn and a valid drop moves its end (React Flow's reconnect anchors);
   * a press that does not move is a click on the edge.
   */
  private connectGesture(down: PointerEvent, pressed: HandleHit, reconnecting?: number): Gesture {
    const scene = this.scene;
    const fromLive = reconnecting == null && down.target instanceof Element && !!down.target.closest(".react-flow__handle");
    // The nodes and the connection are held by id, as React Flow's are: nodes added or removed mid-drag
    // renumber the graph (GpuCanvas's sync), so `from` and the target are looked up again as they are used.
    const fromId = scene.graph.nodes[pressed.node].id;
    let from = pressed;
    const heldEdgeId = reconnecting == null ? null : scene.graph.edges[reconnecting].id;
    const handleId = from.handleId || null;
    const startX = down.clientX, startY = down.clientY;
    let dragging = false, ended = false;
    let target: { hit: HandleHit; nodeId: string } | null = null;
    let last = down, panFrame = 0, inViewport = false;
    let offs: (() => void)[] = [];
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const wanted = from.type === "source" ? "target" : "source";
    // The on-screen nodes that turn live to label their sockets (connectCandidates); worked out as the drag
    // starts and again as the view moves, not per pointer move.
    let candidates: string[] = [];
    const findCandidates = () => {
      const at = scene.local(last), p = scene.toWorld(at.x, at.y);
      candidates = connectCandidates(scene.graph, scene.visible(0), p, wanted, fromId);
    };
    const draw = (event: PointerEvent) => {
      const fromIndex = scene.graph.indexOf.get(fromId);
      // The node it starts from was removed: the connection goes with it.
      if (fromIndex == null) {
        end();
        return;
      }
      if (fromIndex !== from.node) from = { ...from, node: fromIndex };
      const at = scene.local(event), p = scene.toWorld(at.x, at.y);
      // As React Flow finds it: the handle under the pointer, else the one whose centre is nearest within the
      // connection radius, of either kind. The line ends on it only if the connection would be made.
      const candidate = this.liveHandleAt(event) ?? this.paintedHandleAt(at.x, at.y)
        ?? closestHandle(scene.graph, this.nodesNear(p.x, p.y, CONNECTION_RADIUS + 24), p.x, p.y, CONNECTION_RADIUS, wanted, from);
      const candidateId = candidate ? scene.graph.nodes[candidate.node].id : "";
      const valid = !!candidate && candidate.type === wanted && candidate.connectableEnd
        && !(candidateId === fromId && candidate.handleId === from.handleId && candidate.type === from.type)
        && this.editing().isValidConnection(this.connection(fromId, from, candidateId, candidate));
      target = valid ? { hit: candidate, nodeId: candidateId } : null;
      // The nodes React Flow would show sockets for: their labels show, and a valid target's socket fills.
      setConnectDrag(true, target ? { nodeId: target.nodeId, handleId: target.hit.handleId || null, type: target.hit.type } : null);
      const under = scene.nodeAt(at.x, at.y);
      this.live.wantOnly("connect", [fromId, ...candidates, ...(under >= 0 ? [scene.graph.nodes[under].id] : []), ...(target ? [target.nodeId] : [])]);
      // React Flow's line runs between the handles' centres, in flow units inside the viewport (css px on the host).
      const tip = target ? { x: target.hit.cx, y: target.hit.cy } : p;
      const place = (x: number, y: number) => inViewport ? { x, y } : scene.toScreen(x, y);
      const a = place(from.cx, from.cy), b = place(tip.x, tip.y);
      const fromSource = from.type === "source";
      const [d] = routeEdge({
        style: "curved",
        sourceX: fromSource ? a.x : b.x, sourceY: fromSource ? a.y : b.y, sourcePosition: Position.Right,
        targetX: fromSource ? b.x : a.x, targetY: fromSource ? b.y : a.y, targetPosition: Position.Left,
      });
      path.setAttribute("d", d);
      path.setAttribute("stroke-width", inViewport ? "1" : String(scene.view.zoom));
    };
    // React Flow's autoPanOnConnect: near the canvas's edge the view pans every frame, the pointer still or not
    // (the pan redraws the line through the view listener).
    const autoPan = () => {
      if (ended || scene.isDisposed) return;
      const { clientWidth: width, clientHeight: height } = scene.canvas;
      const [vx, vy] = width && height ? autoPanVelocity(scene.local(last), { width, height }) : [0, 0];
      if (vx || vy) scene.setView({ x: scene.view.x + vx, y: scene.view.y + vy });
      if (!ended) panFrame = requestAnimationFrame(autoPan);
    };
    // The reconnected edge's live copy (its decorations), hidden with the scene's stroke.
    const liveEdge = () => heldEdgeId == null ? null : this.live.element?.querySelector<SVGElement>(`.react-flow__edge[data-id="${CSS.escape(heldEdgeId)}"]`) ?? null;
    // The reconnected edge stays hidden through a rebuilt graph (which shows it again, at its new index).
    const holdEdge = () => {
      const e = heldEdgeId == null ? undefined : scene.graph.edgeIndexOf.get(heldEdgeId);
      if (e != null) scene.setHeldEdge(e);
    };
    const start = (event: PointerEvent) => {
      dragging = true;
      scene.capture();
      if (heldEdgeId != null) {
        holdEdge();
        liveEdge()?.style.setProperty("visibility", "hidden");
      }
      // The pointer has left the pressed socket: its hidden connections stop ghosting back.
      this.hoveredHandle = null;
      if (useWorkflowStore.getState().hoveredHandle) useWorkflowStore.getState().setHoveredHandle(null);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", CONNECTION_LINE_STROKE);
      inViewport = this.mountInFlow(this.overlay, "viewport");
      this.overlay.style.zIndex = inViewport ? "1001" : "4";
      // React Flow draws no connection line while nodes are not connectable (a locked canvas).
      if (!this.editing().locked) this.overlay.append(path);
      this.holdInteracting(true);
      // A wheel, pinch or auto-pan keeps the line on its socket (React Flow's line is in flow units) and finds
      // what is now under the still pointer; a rebuilt graph renumbers the nodes and connections.
      offs = [
        scene.onViewChanged(() => {
          findCandidates();
          draw(last);
        }),
        scene.onLayoutChanged(() => {
          holdEdge();
          findCandidates();
          draw(last);
        }),
      ];
      findCandidates();
      draw(event);
      if (!ended) panFrame = requestAnimationFrame(autoPan);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      for (const off of offs) off();
      cancelAnimationFrame(panFrame);
      path.remove();
      if (heldEdgeId != null) {
        scene.setHeldEdge(-1);
        liveEdge()?.style.removeProperty("visibility");
      }
      setConnectDrag(false);
      this.live.wantOnly("connect", []);
      if (dragging) this.holdInteracting(false);
    };
    return {
      move: (event) => {
        if (ended) return;
        last = event;
        if (!dragging) {
          // React Flow's connectionDragThreshold: the line shows as soon as the pointer moves.
          if (Math.hypot(event.clientX - startX, event.clientY - startY) <= CONNECTION_DRAG_THRESHOLD) return;
          start(event);
          return;
        }
        scene.input(event);
        draw(event);
      },
      up: (event) => {
        if (ended) return;
        const wasDragging = dragging;
        if (dragging) end();
        // A press on a connection's end that did not move is a click on the connection.
        if (!wasDragging && heldEdgeId != null) {
          this.clickEdge(event, heldEdgeId);
          return;
        }
        const editing = this.editing();
        if (wasDragging && target) {
          const connection = this.connection(fromId, from, target.nodeId, target.hit);
          const store = useWorkflowStore.getState();
          if (!store.nodes.some((n) => n.id === connection.source) || !store.nodes.some((n) => n.id === connection.target)) return;
          const edge = heldEdgeId == null ? undefined : store.edges.find((e) => e.id === heldEdgeId);
          if (heldEdgeId == null) editing.onConnect(connection);
          else if (edge) editing.onReconnect(edge, connection);
          return;
        }
        // Released within HANDLE_CLICK_SLOP of the press, a handle's press is a click (WorkflowCanvas's handle
        // menu listener), wherever its line went: no add-node menu (handleConnectEnd's own guard).
        if (heldEdgeId == null && Math.hypot(event.clientX - startX, event.clientY - startY) <= HANDLE_CLICK_SLOP) {
          // The click reaches the node as well: it selects it, as React Flow's node click (connectOnClick is off).
          this.clickNode(fromId, event.shiftKey);
          // A click on the handle opens its menu at its centre. A live node's handle that was not captured gets the
          // browser's click, so WorkflowCanvas's own listener opens it; once the line started, the capture took that
          // click to the scene canvas, and the menu opens from here (at the handle element's centre, as classic's).
          if ((fromLive && !wasDragging) || !scene.graph.indexOf.has(fromId)) return;
          const element = fromLive && down.target instanceof Element ? down.target.closest<HTMLElement>(".react-flow__handle") : null;
          let position: { x: number; y: number };
          if (element?.isConnected) {
            const rect = element.getBoundingClientRect();
            position = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          } else {
            const p = scene.toScreen(from.cx, from.cy), box = scene.canvas.getBoundingClientRect();
            position = { x: box.left + p.x, y: box.top + p.y };
          }
          editing.onHandleClick({ nodeId: fromId, handleId, type: from.type, position });
          return;
        }
        // No handle: WorkflowCanvas connects to a compatible handle of the node under the pointer, or offers the
        // add-node menu (a reconnect too: the connection stays, and the new one starts from its other end).
        const fromNode = useWorkflowStore.getState().nodes.find((n) => n.id === fromId);
        if (!fromNode) return;
        // Classic finds the node by its element: its floating header is not part of it, its sockets are. A locked
        // canvas's node bodies let the pointer through (pointer-events none): only a socket names the drop node.
        const at = scene.local(event);
        let node = editing.locked ? -1 : scene.nodeAt(at.x, at.y, false);
        if (node < 0) node = (this.handleFromEvent(event) ?? this.paintedHandleAt(at.x, at.y))?.node ?? -1;
        editing.onConnectEnd(event, { isValid: false, fromNode, fromHandle: { id: handleId, type: from.type } }, node >= 0 ? scene.graph.nodes[node].id : null);
      },
      cancel: end,
    };
  }

  /** The handle of a live node under the pointer, for a connection being drawn over it. */
  private liveHandleAt(event: PointerEvent): HandleHit | null {
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      if (!(element instanceof HTMLElement) || !element.classList.contains("react-flow__handle") || !element.closest("[data-gpu-canvas-live]")) continue;
      const hit = this.handleFromEvent({ target: element } as unknown as PointerEvent);
      if (hit) return hit;
    }
    return null;
  }

  private connection(fromId: string, from: HandleHit, toId: string, to: HandleHit): Connection {
    const [source, target] = from.type === "source" ? [{ id: fromId, hit: from }, { id: toId, hit: to }] : [{ id: toId, hit: to }, { id: fromId, hit: from }];
    return { source: source.id, sourceHandle: source.hit.handleId || null, target: target.id, targetHandle: target.hit.handleId || null };
  }

  // ── Hover, double-click and context menus ─────────────────────────────

  /**
   * The scene's hoverAt: a painted socket hovers its node, as classic's handle sits in the node's element, so
   * the node goes live (its labels, hover controls and the handle's own tooltip) from outside its box too.
   */
  hoverAt = (cssX: number, cssY: number) => {
    const handle = this.editing().disabled ? null : this.paintedHandleAt(cssX, cssY);
    return handle ? handle.node : this.scene.nodeAt(cssX, cssY);
  };

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
    // On a locked canvas the pointer passes through node bodies to the pane (and the connections under them);
    // a header band still takes it (its grab cursor), as classic's floating header.
    const node = handle || this.nodeIsPane(at.x, at.y) ? -1 : scene.nodeAt(at.x, at.y);
    // A connection's end shows React Flow's move cursor where a press would reconnect it.
    const end = handle || node >= 0 || this.editing().disabled ? null : this.edgeEndAt(at.x, at.y);
    const edge = handle || node >= 0 ? -1 : end?.edge ?? scene.edgeAt(at.x, at.y);
    // Only the pointer hovers a connection: classic draws one holding keyboard focus unchanged.
    scene.setHoveredEdge(edge);
    // A live connection's label brightens under the pointer, as EditableEdge's own hover does.
    setHoveredSceneEdge(edge >= 0 ? scene.graph.edges[edge].id : null);
    // React Flow's `selectable` edge class (and its pointer cursor): the edge's own flag, else elementsSelectable,
    // which a locked canvas and a dialog turn off. An unselectable connection shows the pane's cursor.
    const editing = this.editing(), flagged = edge >= 0 ? scene.graph.edges[edge].edge.selectable : undefined;
    const edgeSelectable = edge >= 0 && (flagged === true || (!editing.locked && !editing.disabled && flagged === undefined));
    this.idleOnPane = !handle && node < 0 && !end && !edgeSelectable;
    // A node is React Flow's draggable one (grab), but under a dialog (nodesDraggable off: the default arrow).
    const nodeCursor = editing.disabled ? "" : "grab";
    scene.canvas.style.cursor = handle ? "crosshair" : node >= 0 ? nodeCursor : end ? "move" : edgeSelectable ? "pointer" : this.paneCursor(event.shiftKey, event.altKey);
  };

  /**
   * The scene's onHoverEnd: no connection is hovered (not even the one holding keyboard focus, as on
   * classic) until the next idle move. Off the canvas or under a wheel the painted handle is no longer hovered either, so
   * its hidden connections stop ghosting in; a pressed handle keeps it until its drag starts. The live
   * label's hover is the canvas's own pointerleave listener's on a leave (it may have gone onto that label).
   */
  hoverEnd = (reason: "leave" | "gesture" | "wheel") => {
    const scene = this.scene;
    if (reason !== "gesture" && this.hoveredHandle !== null) {
      this.hoveredHandle = null;
      if (useWorkflowStore.getState().hoveredHandle) useWorkflowStore.getState().setHoveredHandle(null);
    }
    scene.setHoveredEdge(-1);
    if (reason !== "leave") setHoveredSceneEdge(null);
  };

  /**
   * Empty canvas's cursor: the pointer while a drag there would draw a marquee, as React Flow's pane with its
   * `selection` class (the selection key held, or selectionOnDrag while panOnDrag is not on; Space in the
   * "space" pan mode turns panOnDrag on); otherwise grab while a left drag would pan (its `draggable` class:
   * panOnDrag on for the left button, which the tutorial turns off). No class while a dialog is open.
   */
  private paneCursor(shiftKey: boolean, altKey: boolean): string {
    const editing = this.editing();
    if (editing.disabled) return "";
    const modifiers = { button: 0, shiftKey, altKey, ctrlKey: false, space: this.space && !editing.tutorial };
    const action = paneDragAction(editing.navigation, modifiers, isMac);
    return action === "select" ? "pointer" : action === "pan" && !editing.tutorial ? "grab" : "";
  }

  /** The selection key (or Space) went down or up: empty canvas under the pointer takes its cursor at once. */
  private modifierChanged(event: KeyboardEvent) {
    if (event.key !== "Shift" && event.key !== "Alt" && event.code !== "Space") return;
    if (!this.idleOnPane || this.scene.interacting) return;
    this.scene.canvas.style.cursor = this.paneCursor(event.shiftKey, event.altKey);
  }

  /** The scene's onContextMenu: the add-node menu on empty canvas, the connection menu on a connection. */
  contextMenu = (event: MouseEvent) => {
    const editing = this.editing();
    const scene = this.scene, at = scene.local(event);
    // A node, its header band or a painted handle is not the pane: the browser's own menu shows. On a locked
    // canvas a node's body is (React Flow gives it pointer-events none); its floating header still takes the pointer.
    if (!this.nodeIsPane(at.x, at.y) || this.paintedHandleAt(at.x, at.y)) return;
    // A connection's reconnect anchors are part of it. Its menu opens in every pan mode, as classic's
    // onEdgeContextMenu does (React Flow's pane swallows only presses on the pane itself).
    const e = this.edgeEndAt(at.x, at.y)?.edge ?? scene.edgeAt(at.x, at.y);
    const edge = e >= 0 ? useWorkflowStore.getState().edges.find((candidate) => candidate.id === scene.graph.edges[e].id) : undefined;
    if (edge) {
      editing.onEdgeContextMenu(event, edge);
      return;
    }
    // The pane never shows the browser's menu. In "middleMouse" mode the right button pans, and React Flow opens
    // the pane menu from d3-zoom's end when the right press did not move (Editor.rightPan), not from this event;
    // with a modal or the tutorial open there is no pan, and no add-node menu.
    event.preventDefault();
    if (editing.disabled || editing.tutorial || editing.navigation.panMode === "middleMouse") return;
    editing.onPaneMenu(event.clientX, event.clientY);
  };

  /**
   * Whether a point (css px) is no node's, for a double-click or a context menu: off every node and its
   * header band, or on a locked canvas off every header band (the bodies let the pointer through, as classic's).
   */
  nodeIsPane = (cssX: number, cssY: number): boolean => {
    const scene = this.scene;
    if (!this.editing().locked) return scene.nodeAt(cssX, cssY) < 0;
    const i = scene.nodeAt(cssX, cssY);
    return i < 0 || scene.toWorld(cssX, cssY).y >= scene.graph.nodes[i].y;
  };

  /** A double-click on empty canvas (at a flow point) opens the add-node menu; on a connection or a handle it does nothing. */
  paneDoubleClick = (x: number, y: number, screen: { x: number; y: number }) => {
    if (this.editing().disabled) return;
    const at = this.scene.toScreen(x, y);
    if (this.scene.edgeAt(at.x, at.y) >= 0 || this.edgeEndAt(at.x, at.y) || this.paintedHandleAt(at.x, at.y)) return;
    this.editing().onPaneMenu(screen.x, screen.y);
  };
}
