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
 * hidden and the live one (kept invisible till then) shown, so the swap
 * shows no gap and nothing doubled. A node leaving the layer waits until its
 * painted image is current (it may have been edited while live), then goes
 * back to the scene.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { ReactFlow, useReactFlow, useStoreApi, type DefaultEdgeOptions, type Edge, type EdgeTypes, type InternalNode, type Node, type NodeChange, type NodeDimensionChange, type NodeTypes, type OnEdgesChange, type ReactFlowState } from "@xyflow/react";
import { FloatingNodeHeaders } from "@/components/nodes/FloatingNodeHeaders";
import { HoldLiveProvider, type HoldLive } from "@/components/nodes/paintMode";
import { StoreSocketConnections } from "@/components/nodes/ui/socketConnections";
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "@/store/workflowStore";
import { indexOfNode } from "@/store/nodeChanges";
import type { Scene, View } from "@/lib/gpuCanvas/scene";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "@/lib/canvasZoom";
import type { SceneNode } from "@/lib/gpuCanvas/graph";
import { PAINTED_HEADER_HEIGHT, paintedCover } from "@/lib/gpuCanvas/edgeRoutes";
import { dimClassName } from "@/lib/gpuCanvas/dimming";
import type { Position } from "@xyflow/react";
import type { GpuCanvasStats } from "@/lib/gpuCanvas/stats";
import type { WorkflowNode } from "@/types";
import { controlsOverhangBox, flowNode, handleAnchors, noop, settleNodes, type HeaderProps } from "./nodeSheets";
import { EdgeLabelCoverContext } from "@/components/edges/edgeLabelCover";

// The pane must not take the pointer: pans and clicks on empty space go to the scene.
// Pointer events are inherited, so what sits on the flow and takes clicks opts back in. React
// Flow sets a node's pointer-events inline (none, since this flow selects and drags nothing), hence !important.
// Its sockets start no connection of their own (the editor draws them), so React Flow's connectionindicator
// pointer and cursor are given back here: a socket takes the pointer (its tooltip, its crosshair, the hover that
// ghosts its hidden connections) whether or not the canvas is locked, as classic's stay connectable. On a locked canvas the nodes take no pointer, as classic's (presses go to the scene's pane).
// A panel that opts out (the navigator in the locked tutorial) stays inert, as classic's.
// A selected angular connection's segment handle drags its middle segment (EditableEdge's own drag), so it takes the pointer.
// The scene drags the nodes, so React Flow's draggable cursors are given here: grab, grabbing while a drag moves them (the
// editor's data-gpu-dragging), the default arrow when locked or under a dialog. A focused node shows no ring, as classic's
// selectable nodes (React Flow's .selectable:focus outline none; the wrappers stay focusable, as classic's); a locked
// canvas or one under a dialog keeps the browser's ring, as classic's wrappers that elementsSelectable off leaves unselectable.
// A node swapping in is laid out (measured, its images decoding) but not shown until its painted copy goes.
const ENTERING = "gpu-entering";
export const LIVE_STYLE = `
  [data-gpu-canvas-live] .react-flow__pane, [data-gpu-canvas-live] .react-flow__renderer, [data-gpu-canvas-live] .react-flow { pointer-events: none !important; background: transparent !important; }
  [data-gpu-canvas-live] .react-flow__node, [data-gpu-canvas-live] .react-flow__panel:not(.pointer-events-none) { pointer-events: all !important; }
  [data-gpu-canvas-live] .react-flow__node-gpuGhost { visibility: hidden; pointer-events: none !important; }
  [data-gpu-canvas-live][data-locked] .react-flow__node { pointer-events: none !important; }
  [data-gpu-canvas-live] .react-flow__edge-path { visibility: hidden; }
  [data-gpu-canvas-live] .react-flow__handle.connectable { pointer-events: all; cursor: crosshair; }
  [data-gpu-canvas-live] .edge-segment-handle { pointer-events: all !important; }
  [data-gpu-canvas-live]:not([data-locked]):not([data-disabled]) .react-flow__node { cursor: grab; }
  [data-gpu-canvas-live][data-gpu-dragging]:not([data-locked]):not([data-disabled]) .react-flow__node { cursor: grabbing; }
  [data-gpu-canvas-live]:not([data-locked]):not([data-disabled]) .react-flow__node:focus, [data-gpu-canvas-live]:not([data-locked]):not([data-disabled]) .react-flow__node:focus-visible { outline: none; }
  [data-gpu-canvas-live] .react-flow__node.${ENTERING} { visibility: hidden; }
`;

/**
 * A painted node a live connection ends at: React Flow draws an edge only
 * between nodes it holds, so the ends that are not live are stood in for by
 * an invisible node of the same box and handles (as painting measured them).
 */
function GhostNode() {
  return null;
}

/** Painted nodes over live connections (paintedCover): the connections they cover, and their boxes. */
type EdgeCover = { edgeIds: string[]; boxes: { x: number; y: number; w: number; h: number }[] };

/**
 * `headers`: painted nodes whose floating header a live node would cover; the flow shows those headers, above it.
 * `entering`: nodes swapping in, whose floating headers are hidden with them.
 */
type FlowState = { nodes: Node[]; edges: Edge[]; headers?: Node[]; cover?: EdgeCover; entering?: string[]; committed: () => void };

/** A floating header's height above its node (FloatingNodeHeader's top offset). */
const HEADER_HEIGHT = PAINTED_HEADER_HEIGHT;

/** The mask live connections under painted nodes wear: the nodes' boxes cut out, at the card's corner radius (--radius-card). */
const EDGE_MASK_ID = "gpu-live-edge-mask";
const NODE_RADIUS = 12;
const FAR = 1e6;

/**
 * On classic every node covers the edge layer. The live layer draws over the scene, so a live connection
 * passing under a painted node is masked there (its comet, pause badge, stubs and ghost). Its HTML pills (EdgeLabel)
 * are cut by the same boxes through EdgeLabelCoverContext: a stacking context round them would change what sits over what.
 */
function EdgeMask({ cover }: { cover?: EdgeCover }) {
  if (!cover?.edgeIds.length) return null;
  const selector = cover.edgeIds.map((id) => `[data-gpu-canvas-live] .react-flow__edge[data-id="${CSS.escape(id)}"]`).join(", ");
  return (
    <>
      <style>{`${selector} { mask: url(#${EDGE_MASK_ID}); }`}</style>
      <svg aria-hidden width={0} height={0} style={{ position: "absolute" }}>
        <defs>
          <mask id={EDGE_MASK_ID} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x={-FAR} y={-FAR} width={2 * FAR} height={2 * FAR}>
            <rect x={-FAR} y={-FAR} width={2 * FAR} height={2 * FAR} fill="white" />
            {cover.boxes.map((b, k) => <rect key={k} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(NODE_RADIUS, b.w / 2, b.h / 2)} fill="black" />)}
          </mask>
        </defs>
      </svg>
    </>
  );
}

/** How long a leaving node waits for its painted image to be current, when the painter has no paint of it under way. */
const LEAVE_TIMEOUT_MS = 1500;
/** How many paints a leaving node asks for, each finishing before a newer change (an edit, a zoom) needed another. */
const LEAVE_REPAINTS = 4;
/** How long the layer waits for React to commit a change of live nodes. */
const RENDER_TIMEOUT_MS = 2000;

/**
 * Why a node is live. Besides being worked in (hover, selection, focus, a
 * press, a drag, zoomed in, a connection being drawn to or over it): "held" while it shows something of its own (a dialog,
 * a lightbox), "playing" while its video plays, "resident" for types that
 * stay live as they stay mounted on today's canvas (the 3D viewer), "animated"
 * while it shows an animation only its component plays (a GIF Encoder's GIF), and
 * "pending" while it has work to pick up only a mounted node can (a
 * ComfyUI workflow to import, a run streaming previews), and "running"
 * while it works on its output (its spinner turns). "added" holds a node just added until its first paint shows. "cover" keeps a later node in the store over an
 * unselected live node it overlaps, as classic stacks nodes in store order (the layer sets it, coverChanged).
 * "groupChrome" holds a node whose header a group's label or open menu overlaps, so the header stays above them as on classic.
 * "drop" holds the node a file, node type or history image is dragged over, so the drop lands on the node's own drop zone as on classic.
 */
export type LiveReason = "hover" | "selected" | "focus" | "zoom" | "open" | "press" | "drag" | "connect" | "test" | "held" | "playing" | "animated" | "resident" | "pending" | "running" | "added" | "cover" | "groupChrome" | "drop";

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
  /** Set by the canvas: a click in a live node that its fields kept from the scene selects the node (Editor.clickNode). */
  nodeClick?: (id: string, additive: boolean) => void;
  /** Set by the layer: React Flow measured a live node again. */
  measured?: (id: string) => void;
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

type HandleBounds = NonNullable<InternalNode["internals"]["handleBounds"]>;

/** Whether two measured handle lists place every handle (id, side, box) alike. */
export function sameHandleBounds(a: HandleBounds | undefined, b: HandleBounds | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const same = (x: HandleBounds["source"], y: HandleBounds["source"]) => {
    if (!x || !y) return !x === !y;
    return x.length === y.length && x.every((h, k) => {
      const o = y[k];
      return h.id === o.id && h.position === o.position && h.x === o.x && h.y === o.y && h.width === o.width && h.height === o.height;
    });
  };
  return same(a.source, b.source) && same(a.target, b.target);
}

/**
 * A live node's handles React Flow measured again at the same size (updateNodeInternals emits no dimensions change
 * then: reordered or renamed sockets) reach the scene, as classic's edges follow handleBounds at once.
 */
function HandleSync({ ids, onMeasured }: { ids: ReadonlySet<string>; onMeasured: (id: string) => void }) {
  const store = useStoreApi();
  // The last handles seen per live node; a node that leaves the layer is forgotten, so it applies again when back.
  const [seen] = useState(() => new Map<string, HandleBounds>());
  useLayoutEffect(() => {
    const check = (state: ReactFlowState) => {
      for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
      for (const id of ids) {
        const bounds = state.nodeLookup.get(id)?.internals.handleBounds;
        if (!bounds) continue;
        const last = seen.get(id);
        if (last === bounds) continue;
        seen.set(id, bounds);
        // Idempotent (LiveLayer.applyLiveSize), and a no-op until the node shows.
        if (!sameHandleBounds(last, bounds)) onMeasured(id);
      }
    };
    check(store.getState());
    return store.subscribe(check);
  }, [store, ids, onMeasured, seen]);
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
  /** A click in a live node that did not go to the scene (on a field or button): it selects the node, as React Flow's node click. */
  onNodeClick: (id: string, additive: boolean) => void;
  /** React Flow measured a live node (its size or handles changed). */
  onMeasured: (id: string) => void;
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
export function LiveFlow({ connect, onViewChanged, initialView, nodeTypes, edgeTypes, defaultEdgeOptions, onEdgesChange, headers, hold, onNodeClick, onMeasured, children }: LiveFlowProps) {
  const [state, setState] = useState<FlowState>({ nodes: [], edges: [], committed: noop });
  const { nodes, edges } = state;
  const types = useMemo(() => ({ ...nodeTypes, gpuGhost: GhostNode }), [nodeTypes]);
  // Floating headers belong to the live nodes, not to the stand-ins, and to the painted nodes a live node covers.
  const real = useMemo(() => nodes.filter((n) => n.type !== "gpuGhost"), [nodes]);
  const headerNodes = useMemo(() => state.headers?.length ? [...real, ...state.headers] : real, [real, state.headers]);
  useLayoutEffect(() => connect({ setNodes: setState }), [connect]);
  useLayoutEffect(() => state.committed(), [state]);
  // A live node's measured size reaches the store, as on the classic canvas (the painted ones' come from painting).
  const realIds = useMemo(() => new Set(real.map((n) => n.id)), [real]);
  // Sizes measured while nodes mount wait for a quiet moment and reach the store in one write: each write runs every
  // store selector over the graph, and a pan in live mode mounts nodes nearly every frame.
  const pendingSizes = useRef(new Map<string, NodeDimensionChange>());
  const flushTimer = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; since: number }>({ timer: undefined, since: 0 });
  const flushSizes = useCallback(() => {
    clearTimeout(flushTimer.current.timer);
    flushTimer.current = { timer: undefined, since: 0 };
    const store = useWorkflowStore.getState();
    const changes = [...pendingSizes.current.values()].filter((change) => indexOfNode(store.nodes, change.id) >= 0);
    pendingSizes.current.clear();
    if (changes.length) store.onNodesChange(changes.map((change) => ({ ...change, setAttributes: false })));
  }, []);
  useEffect(() => flushSizes, [flushSizes]);
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const store = useWorkflowStore.getState();
    for (const change of changes) if (change.type === "dimensions" && change.dimensions && realIds.has(change.id)) onMeasured(change.id);
    // A selected node's width grips (NodeShell's NodeResizeControl): as on classic, React Flow's resize (its width,
    // and its position from the left grip) and NodeShell's setNodes for the other selected nodes and a
    // double-click reset reach the store; the layer re-renders the nodes at the widths the store then holds.
    const resized = resizeChanges(changes, realIds, store.nodes);
    if (resized.length) store.onNodesChange(resized);
    const measured = changes.filter((change): change is NodeDimensionChange => {
      if (change.type !== "dimensions" || change.resizing !== undefined || !change.dimensions || !realIds.has(change.id)) return false;
      const k = indexOfNode(store.nodes, change.id);
      const known = k < 0 ? undefined : store.nodes[k].measured;
      const same = known?.width != null && known.height != null && Math.abs(known.width - change.dimensions.width) <= 0.5 && Math.abs(known.height - change.dimensions.height) <= 0.5;
      // Back to the size the store holds: a size still waiting is out of date.
      if (same) pendingSizes.current.delete(change.id);
      return k >= 0 && !same;
    });
    if (!measured.length) return;
    for (const change of measured) pendingSizes.current.set(change.id, change);
    const now = performance.now(), flush = flushTimer.current;
    if (!flush.since) flush.since = now;
    clearTimeout(flush.timer);
    flush.timer = setTimeout(flushSizes, now - flush.since >= SIZE_WRITE_MAX_WAIT_MS ? 0 : SIZE_WRITE_QUIET_MS);
  }, [realIds, onMeasured, flushSizes]);
  // Presses the scene took have selected already, except on a button or link (liveButtonPress), which selects here
  // as classic's NodeWrapper click; a stopped click (OutputNode, the curve editor, a button's own) never arrives.
  const nodeClick = useCallback((event: ReactMouseEvent, node: Node) => {
    if (node.type === "gpuGhost" || !(event.target instanceof Element)) return;
    if (pressGoesToScene(event.target) && !liveButtonPress(event.target)) return;
    onNodeClick(node.id, event.shiftKey);
  }, [onNodeClick]);
  return (
    <HoldLiveProvider hold={hold}>
      {/* The flow holds only the connections it decorates: sockets show the store's. */}
      <StoreSocketConnections>
        <style>{LIVE_STYLE}</style>
        <EdgeMask cover={state.cover} />
        {state.entering?.length ? <style>{state.entering.map((id) => `[data-gpu-canvas-live] [data-node-header="${CSS.escape(id)}"]`).join(", ")}{" { visibility: hidden; }"}</style> : null}
        <EdgeLabelCoverContext.Provider value={state.cover?.edgeIds.length ? state.cover.boxes : null}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={types} edgeTypes={edgeTypes} defaultEdgeOptions={defaultEdgeOptions} onEdgesChange={onEdgesChange} onNodesChange={onNodesChange} onNodeClick={nodeClick}
          defaultViewport={initialView} minZoom={CANVAS_MIN_ZOOM} maxZoom={CANVAS_MAX_ZOOM} edgesFocusable={false} edgesReconnectable={false} connectOnClick={false} autoPanOnConnect={false}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} panOnDrag={false} zoomOnScroll={false} panOnScroll={false} zoomOnPinch={false}
          zoomOnDoubleClick={false} preventScrolling={false} deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null}
          panActivationKeyCode={null} zoomActivationKeyCode={null} proOptions={{ hideAttribution: true }} style={{ background: "transparent" }}>
          <ViewSync connect={connect} onViewChanged={onViewChanged} />
          <HandleSync ids={realIds} onMeasured={onMeasured} />
          <FloatingNodeHeaders nodes={headerNodes} {...headers} />
          {children}
        </ReactFlow>
        </EdgeLabelCoverContext.Provider>
      </StoreSocketConnections>
    </HoldLiveProvider>
  );
}

export interface LivePainter {
  /** Resolves once the node's painted image is current. */
  paintNow(id: string): Promise<void>;
  /** Whether the node's painted image is current (or the node is gone). */
  isFresh(id: string): boolean;
  /** Whether the painter still has the node's paint to do. */
  painting(id: string): boolean;
  /** Gives the scene (and the store) the node's box, handles and cards as its painted image has them. */
  restoreMeasured(id: string): boolean;
}

/** Live nodes' measured sizes reach the store once none has been measured for this long, */
const SIZE_WRITE_QUIET_MS = 300;
/** or at the latest this long after the first of them. */
const SIZE_WRITE_MAX_WAIT_MS = 1500;

/** The elements alignToPixels moves: live node wrappers and floating headers. */
const SNAP_TARGETS = ".react-flow__node[data-id], [data-node-header]";

export class LiveLayer {
  /** Nodes asked to be live, and why. */
  private wanted = new Map<string, Set<LiveReason>>();
  /** Nodes whose live component is on screen and whose scene image is hidden. */
  readonly live = new Set<string>();
  /** Nodes on their way back to the scene, waiting for a current image. */
  private leaving = new Set<string>();
  /** Nodes swapping in: rendered but invisible while their painted image still shows. */
  private entering = new Set<string>();
  private generation = 0;
  /** Entering nodes waiting to lay out and load (settle), each with its batch's promise. */
  private settling = new Map<string, Promise<void>>();
  /** Bumped by dispose, so a batch still settling shows nothing. */
  private disposed = 0;
  private pending: Promise<void> = Promise.resolve();
  private unsubscribe: () => void;
  private listeners: (() => void)[] = [];
  painter: LivePainter | null = null;
  /** The live node under the pointer, if any. */
  pointerNode: string | null = null;
  /** Called when the pointer moves onto a live node or off the live nodes. */
  onPointerNode: ((id: string | null) => void) | null = null;
  /**
   * Whether React Flow's pane would take this press for a selection on classic (the editor's settings: the
   * selection key held, no dialog open, the canvas unlocked). Set by the Editor.
   */
  selectionKeyActive: ((event: PointerEvent) => boolean) | null = null;
  /** Whether a press on a group's title or resize grip pans the canvas, as classic's zoom pane takes it. Set by the Editor. */
  groupChromePans: ((event: MouseEvent) => boolean) | null = null;

  /** `element` holds the LiveFlow rendered with `connection`. */
  constructor(readonly element: HTMLElement, private connection: LiveConnection, private scene: Scene, private stats: GpuCanvasStats) {
    let releasePress: (() => void) | null = null;
    const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions | boolean) => {
      element.addEventListener(type, listener, options);
      this.listeners.push(() => element.removeEventListener(type, listener, options));
    };
    // Wheel over a live node still pans and zooms the scene; the scene leaves one to an inner area
    // that can still scroll (sceneWheel), as on classic.
    on("wheel", (event) => scene.wheel(event), { passive: false });
    // A press on a live node's body or floating header goes to the scene (click to select, drag to
    // move), and so does one on its handles (drag to connect); its fields keep theirs (pressGoesToScene),
    // except from the middle button, which pans from anywhere in a node as classic's zoom pane lets it.
    on("pointerdown", (event) => {
      const target = event.target as Element;
      // With the selection key held, classic's pane takes every left press inside it first (fields, nodrag
      // controls, floating headers, group chrome, connection labels), save on `.nokey`: a drag draws a marquee.
      if (selectionKeyTakesPress(event, this.selectionKeyActive)) {
        event.preventDefault();
        event.stopPropagation();
        scene.pointerDown(event);
        return;
      }
      // A group's title or grip pans where classic's zoom pane takes the press (d3-zoom swallows its mousedown).
      if (this.groupChromePans?.(event)) {
        scene.pointerDown(event);
        return;
      }
      const middle = event.button === 1 && !!target.closest(".react-flow__node");
      if (!middle && (!target.closest(".react-flow__node, [data-node-header]") || !pressGoesToScene(target))) {
        // A press the node keeps (a slider, a grid line) may drag off it: the node stays live until it lifts.
        const id = liveNodeId(target);
        if (id) {
          releasePress?.();
          releasePress = this.hold(id);
        }
        // A right press on a floating header's button or link is still the zoom pane's on classic (the header sits
        // outside the node, and only nopan stops React Flow's filter): the scene may pan from it ("middleMouse"
        // mode), while the element keeps the press as well (its own handlers ignore the right button).
        if (rightPressPansFromHeader(event)) scene.pointerDown(event);
        return;
      }
      // The header's own drag moves nodes through this flow, whose nodes are the layer's: the scene's drag stands in.
      if (!target.closest(".react-flow__node")) {
        event.preventDefault();
        event.stopPropagation();
      }
      scene.pointerDown(event);
    }, true);
    // ...and the group's own drag and resize, which listen for mousedown, do not start: d3-zoom stops it on classic.
    on("mousedown", (event) => {
      if (this.groupChromePans?.(event)) event.stopImmediatePropagation();
    }, true);
    // The pointer over a live node: it is hovered, though the scene below no longer sees the pointer.
    on("pointerover", (event) => {
      const id = liveNodeId(event.target);
      if (id !== this.pointerNode) {
        this.pointerNode = id;
        this.onPointerNode?.(id);
      }
    });
    // While a gesture runs the hover holds, as NodeShell ignores a leave with a button down (the gesture capturing
    // the pointer, or a press dragged off its node); once the button lifts, what is under the pointer is hovered.
    let heldOut = false;
    on("pointerout", (event) => {
      if (liveNodeId(event.relatedTarget) || !this.pointerNode) return;
      if (scene.interacting) {
        heldOut = true;
        return;
      }
      this.pointerNode = null;
      this.onPointerNode?.(null);
    });
    const lifted = (event: PointerEvent) => {
      releasePress?.();
      releasePress = null;
      if (!heldOut) return;
      heldOut = false;
      const id = event.pointerType === "touch" ? null : liveNodeId(document.elementFromPoint(event.clientX, event.clientY));
      if (id === this.pointerNode) return;
      this.pointerNode = id;
      this.onPointerNode?.(id);
    };
    window.addEventListener("pointerup", lifted, true);
    window.addEventListener("pointercancel", lifted, true);
    this.listeners.push(() => {
      window.removeEventListener("pointerup", lifted, true);
      window.removeEventListener("pointercancel", lifted, true);
    });
    // The node holding focus (in it or its floating header) stays live wherever the pointer goes.
    on("focusin", (event) => {
      const id = liveNodeId(event.target);
      if (id) this.wantOnly("focus", [id]);
    });
    on("focusout", (event) => {
      const next = liveNodeId(event.relatedTarget);
      // The window losing focus keeps the field mounted, as classic's stays, so the browser can give it back.
      if (!next && !event.relatedTarget && !document.hasFocus()) return;
      this.wantOnly("focus", next ? [next] : []);
    });
    // Back in the window: the node keeps the reason only if its field got the focus back.
    let refocusFrame = 0;
    const refocused = () => {
      cancelAnimationFrame(refocusFrame);
      refocusFrame = requestAnimationFrame(() => {
        const id = liveNodeId(document.activeElement);
        this.wantOnly("focus", id ? [id] : []);
      });
    };
    window.addEventListener("focus", refocused);
    this.listeners.push(() => {
      window.removeEventListener("focus", refocused);
      cancelAnimationFrame(refocusFrame);
    });
    connection.hold = (id) => this.hold(id);
    connection.measured = (id) => this.applyLiveSize(id);
    // Someone else moved the flow's viewport (setCenter, fitView, a tab restored): the scene follows.
    connection.viewChanged = (view) => {
      const current = scene.view;
      if (Math.abs(view.x - current.x) < 0.01 && Math.abs(view.y - current.y) < 0.01 && Math.abs(view.zoom - current.zoom) < 1e-6) return;
      // The flow holds this view already: handing it back would interrupt its animated move (setCenter with a duration).
      this.followingFlow = true;
      try {
        scene.setView(view);
      } finally {
        this.followingFlow = false;
      }
    };
    // Live nodes are dimmed as classic's are (its .switch-dimmed / .node-skipped).
    const unsubscribeDim = useWorkflowStore.subscribe((state, previous) => {
      if ((state.dimmedNodeIds !== previous.dimmedNodeIds || state.skippedNodeIds !== previous.skippedNodeIds) && (this.live.size || this.wanted.size || this.leaving.size)) void this.render();
    });
    // Live nodes show the store's data as it changes.
    const unsubscribeNodes = subscribeToWorkflowNodeChanges((changes) => {
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
    this.unsubscribe = () => {
      unsubscribeDim();
      unsubscribeNodes();
    };
  }

  private setNodes(next: FlowState, sync = false) {
    const set = this.connection.setNodes ?? ((n: FlowState) => n.committed());
    if (sync) flushSync(() => set(next));
    else set(next);
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

  /** Whether any connection is live. */
  get hasEdges() {
    return this.edgeIds.length > 0;
  }

  /** Sets the live connections; renders when they or what they show changed. */
  setEdges(ids: string[]) {
    this.edgeIds = ids;
    void this.render();
  }

  /** The nodes the flow shows (live, or for their floating header), which alignToPixels places. */
  private shown: string[] = [];
  /** The `translate` alignToPixels last wrote on each node and header element. */
  private snapped = new Map<HTMLElement, string>();
  /** Places node and header elements the flow mounts after its commit (React Flow renders nodes a pass later). */
  private snapObserver: MutationObserver | null = null;

  /**
   * The scene starts a painted node on a whole css pixel (Scene.pixelSnap): each node the flow shows, and its
   * floating header, is moved by the same offset, so a swap between painted and live does not shift it. The
   * offset is written on the elements themselves (only those whose offset changed), so a pan or zoom frame
   * restyles those elements alone, not the document as a replaced stylesheet would.
   */
  private alignToPixels() {
    const graph = this.scene.graph;
    const offsets = new Map<string, string>();
    // Without a painter there is no painted copy to line up with, and each offset written in a pan repaints its node.
    if (this.painter) for (const id of this.shown) {
      const i = graph.indexOf.get(id);
      if (i == null) continue;
      const [dx, dy] = this.scene.pixelSnap(i);
      if (dx || dy) offsets.set(id, `${dx}px ${dy}px`);
    }
    const next = new Map<HTMLElement, string>();
    if (offsets.size) {
      for (const element of this.element.querySelectorAll<HTMLElement>(SNAP_TARGETS)) {
        const id = element.getAttribute("data-node-header") ?? element.getAttribute("data-id");
        const offset = id == null ? undefined : offsets.get(id);
        if (offset) next.set(element, offset);
      }
    }
    for (const element of this.snapped.keys()) if (!next.has(element)) element.style.translate = "";
    for (const [element, offset] of next) if (this.snapped.get(element) !== offset) element.style.translate = offset;
    this.snapped = next;
    this.observeSnapTargets();
  }

  private observeSnapTargets() {
    if (this.snapObserver || typeof MutationObserver === "undefined") return;
    this.snapObserver = new MutationObserver((records) => {
      if (!this.shown.length) return;
      const added = records.some((record) => [...record.addedNodes].some((n) => n instanceof Element && (n.matches(SNAP_TARGETS) || !!n.querySelector(SNAP_TARGETS))));
      if (added) this.alignToPixels();
    });
    this.snapObserver.observe(this.element, { childList: true, subtree: true });
  }

  /** Set while the scene follows a view the flow moved to (connection.viewChanged). */
  private followingFlow = false;

  /** Whether the scene's view is changing to follow the flow's. */
  get followingFlowView() {
    return this.followingFlow;
  }

  setView(view: View) {
    this.alignToPixels();
    if (this.followingFlow) return;
    this.connection.setView?.({ ...view });
  }

  /** The page's React Flow state, while the live flow is mounted. */
  flowState(): ReactFlowState | null {
    return this.connection.flow?.() ?? null;
  }

  /** Whether the layer renders the node: live, swapping in, or on its way back to the scene. */
  renders(id: string) {
    return this.wanted.has(id) || this.live.has(id) || this.leaving.has(id);
  }

  /** Whether the node is wanted live for this reason. */
  has(id: string, reason: LiveReason) {
    return !!this.wanted.get(id)?.has(reason);
  }

  /**
   * Re-renders the live nodes at the scene graph's positions (a drag moved them). `sync` commits before it
   * returns, the flow's store and nodes included, so a dragged live node moves in the same frame as the
   * connections the scene reroutes, as React Flow's drag writes its store from the pointer handler.
   */
  refresh(sync = false) {
    void this.render(sync);
    // Moved nodes may overlap others now.
    if (this.coverChanged()) this.pending = this.sync();
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
    this.coverChanged();
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
    if (this.coverChanged() || changed) this.pending = this.sync();
  }

  /**
   * Gives "cover" to the nodes that must stay over a live one: the live layer draws over the scene, so a node later
   * in the store that overlaps an unselected live node (a hovered or dragged one) is made live too, and the flow
   * stacks them in store order, as classic's (only a selected node is raised, by React Flow's elevateNodesOnSelect).
   * Returns whether the set changed.
   */
  private coverChanged(): boolean {
    const nodes = useWorkflowStore.getState().nodes;
    const graph = this.scene.graph;
    const raised = [...this.wanted].filter(([, reasons]) => reasons.size > 1 || !reasons.has("cover")).map(([id]) => id);
    const live = new Set(raised), cover = new Set<string>();
    for (let next = raised.pop(); next !== undefined; next = raised.pop()) {
      const i = indexOfNode(nodes, next), g = graph.indexOf.get(next);
      if (i < 0 || g == null || nodes[i].selected) continue;
      const n = graph.nodes[g];
      for (const j of this.scene.nodesWithin(n.x, n.y, n.x + n.w, n.y + n.h)) {
        const o = graph.nodes[j];
        if (live.has(o.id) || cover.has(o.id) || indexOfNode(nodes, o.id) < i) continue;
        // Overlapping, not only touching.
        if (o.x >= n.x + n.w || o.x + o.w <= n.x || o.y >= n.y + n.h || o.y + o.h <= n.y) continue;
        cover.add(o.id);
        raised.push(o.id);
      }
    }
    let changed = false;
    for (const [id, reasons] of this.wanted) if (reasons.has("cover") && !cover.has(id)) {
      reasons.delete("cover");
      if (!reasons.size) this.wanted.delete(id);
      changed = true;
    }
    for (const id of cover) {
      const reasons = this.wanted.get(id);
      if (reasons?.has("cover")) continue;
      if (reasons) reasons.add("cover");
      else this.wanted.set(id, new Set(["cover"]));
      changed = true;
    }
    return changed;
  }

  private drop(id: string) {
    this.wanted.delete(id);
    this.entering.delete(id);
    this.live.delete(id);
    this.leaving.delete(id);
  }

  /** The nodes the layer renders (wanted ones and those still leaving), and the live connections with stand-ins for their painted ends. */
  private render(sync = false): Promise<void> {
    const { nodes, dimmedNodeIds, skippedNodeIds } = useWorkflowStore.getState();
    const graph = this.scene.graph;
    const flowNodes: Node[] = [];
    const present = new Set<string>();
    // A node handed to React Flow without its measured size is hidden until
    // it is measured again, which blurs the field being typed in: carry the
    // size React Flow already measured.
    const lookup = this.flowState()?.nodeLookup;
    // In store order, as classic's flow stacks its nodes.
    const ids = [...new Set([...this.wanted.keys(), ...this.leaving])].sort((a, b) => indexOfNode(nodes, a) - indexOfNode(nodes, b));
    for (const id of ids) {
      const i = indexOfNode(nodes, id), g = graph.indexOf.get(id);
      if (i < 0 || g == null) continue;
      const n = graph.nodes[g];
      const className = [dimClassName(id, nodes[i].type, dimmedNodeIds, skippedNodeIds), this.entering.has(id) ? ENTERING : ""].filter(Boolean).join(" ");
      const node = flowNode(nodes[i], n.x, n.y, n.w, !!nodes[i].selected, className || undefined);
      const measured = lookup?.get(id)?.measured;
      if (measured?.width && measured.height) node.measured = { width: measured.width, height: measured.height };
      flowNodes.push(node);
      present.add(id);
    }
    // A painted node's floating header sits over every node on classic, but the live nodes draw over the scene:
    // where one would cover a painted header, the flow shows that header (the scene leaves it out, setHeadersLive).
    const headers: Node[] = [];
    for (const id of ids) {
      const g = graph.indexOf.get(id);
      if (g == null) continue;
      const n = graph.nodes[g];
      for (const j of this.scene.nodesWithin(n.x, n.y, n.x + n.w, n.y + n.h + HEADER_HEIGHT)) {
        const p = graph.nodes[j], k = indexOfNode(nodes, p.id);
        if (k < 0 || present.has(p.id) || headers.some((h) => h.id === p.id)) continue;
        if (p.x >= n.x + n.w || p.x + p.w <= n.x || p.y <= n.y || p.y - HEADER_HEIGHT >= n.y + n.h) continue;
        const header = flowNode(nodes[k], p.x, p.y, p.w, !!nodes[k].selected);
        header.measured = { width: p.w, height: p.h };
        headers.push(header);
      }
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
    const scene = this.scene;
    const cover = flowEdges.length
      ? paintedCover(graph, flowEdges.map((edge) => graph.edgeIndexOf.get(edge.id)!), (e) => scene.edgeRoute(e), (x0, y0, x1, y1) => scene.nodesWithin(x0, y0, x1, y1), (id) => this.live.has(id))
      : undefined;
    // A commit that never comes (the tree failed) must not hold up whoever waits on the layer.
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RENDER_TIMEOUT_MS);
      const committed = () => {
        clearTimeout(timer);
        // The flow shows these headers now: the scene stops drawing them.
        const graph = this.scene.graph;
        this.scene.setHeadersLive(headers.map((h) => graph.indexOf.get(h.id)).filter((i): i is number => i != null));
        this.shown = [...flowNodes.filter((n) => n.type !== "gpuGhost").map((n) => n.id), ...headers.map((h) => h.id)];
        this.alignToPixels();
        resolve();
      };
      this.setNodes({ nodes: flowNodes, edges: flowEdges, headers, cover, entering: [...this.entering].filter((id) => present.has(id)), committed }, sync);
    });
  }

  /** Resolves when every wanted node is live and every other node is back in the scene. */
  private async sync() {
    const generation = ++this.generation;
    const graph = this.scene.graph;
    // Nodes no longer wanted head back to the scene once their image is current.
    for (const id of [...this.live]) {
      if (this.wanted.has(id)) continue;
      this.live.delete(id);
      this.leaving.add(id);
      void this.leave(id);
    }
    const entering = [...this.wanted.keys()].filter((id) => !this.live.has(id) && graph.indexOf.has(id));
    // Invisible over its painted image until the swap. One still leaving shows already (its painted copy is
    // hidden), and one with no image yet (just added: the scene draws its stand-in card) shows at once.
    this.entering = new Set(entering.filter((id) => !this.leaving.has(id) && this.scene.hasPainted(graph.indexOf.get(id)!)));
    await this.render();
    if (!entering.length || generation !== this.generation) return;
    // Each batch settles on its own: a later sync (a pan asks for one a frame) adds the nodes it brings and leaves
    // those already settling to finish, rather than starting every waiting node over.
    const batch = entering.filter((id) => !this.settling.has(id));
    if (batch.length) {
      const settled = this.settle(batch);
      for (const id of batch) this.settling.set(id, settled);
    }
    await Promise.all(entering.map((id) => this.settling.get(id)));
  }

  /** Waits for a batch of entering nodes to lay out and load, then shows those still wanted live. */
  private async settle(batch: string[]) {
    const started = performance.now(), disposed = this.disposed;
    for (const id of batch) this.leaving.delete(id);
    try {
      await settleNodes(this.element, batch, started + 3000, () => this.disposed !== disposed || batch.every((id) => !this.wanted.has(id)));
    } finally {
      for (const id of batch) this.settling.delete(id);
    }
    if (this.disposed !== disposed) return;
    let shown = false;
    for (const id of batch) {
      if (this.entering.delete(id)) shown = true;
      if (!this.wanted.has(id) || this.live.has(id)) continue;
      const i = this.scene.graph.indexOf.get(id);
      if (i == null) continue;
      this.live.add(id);
      this.scene.setHidden(i, true);
      this.applyLiveSize(id);
    }
    // Shown in the frame the scene stops drawing their painted copies.
    if (shown) void this.render(true);
    this.stats.record("live.swapMs", performance.now() - started);
  }

  private async leave(id: string) {
    // It stays live (its painted copy hidden) until the painted image is current: one from before an edit made while
    // it was live would show the old content and height. A paint the painter holds back (a pan, a wheel, a long
    // batch) is waited for; the cap is for a paint that is not coming (a failed one).
    const painter = this.painter;
    for (let paints = 0; painter && paints < LEAVE_REPAINTS; ) {
      const painted = await Promise.race([painter.paintNow(id).then(() => true), new Promise<false>((resolve) => setTimeout(resolve, LEAVE_TIMEOUT_MS, false))]);
      // Wanted again meanwhile: it stays.
      if (this.wanted.has(id) || !this.leaving.has(id)) return;
      if (painter.isFresh(id) || (!painted && !painter.painting(id))) break;
      if (painted) paints++;
    }
    if (this.wanted.has(id) || !this.leaving.has(id)) return;
    this.leaving.delete(id);
    const i = this.scene.graph.indexOf.get(id);
    if (i != null) {
      this.scene.setHidden(i, false);
      // The scene's box (handles, cards) is the painted image's again, and the store's measured size with it.
      this.painter?.restoreMeasured(id);
    }
    // Off the layer a frame later, once the scene has drawn its image.
    requestAnimationFrame(() => {
      if (!this.wanted.has(id) && !this.leaving.has(id)) void this.render();
    });
  }

  /**
   * A live node's box and handles as React Flow measures them: presses, the marquee and its connections
   * follow the node as it shows, though it grew or shrank since it was painted (an opened section, more text).
   */
  private applyLiveSize(id: string) {
    const state = this.flowState(), i = this.scene.graph.indexOf.get(id);
    const measured = state?.nodeLookup.get(id)?.measured, height = measured?.height;
    if (!this.live.has(id) || i == null || !state || !height) return;
    if (Math.abs(this.scene.graph.nodes[i].h - height) > 0.5) this.scene.setNodeHeight(i, height);
    this.scene.setOverhang(i, controlsOverhangBox(this.element, id));
    const handles = handleAnchors(state, id, this.element);
    // Measured at the live node's width, which reaches the store (and the scene's box) just after.
    if (handles) this.scene.setHandles(i, handles, measured?.width);
  }

  /** The graph was rebuilt: the scene forgot which nodes it hid. */
  graphRebuilt() {
    for (const id of this.live) {
      const i = this.scene.graph.indexOf.get(id);
      if (i == null) this.drop(id);
      else {
        this.scene.setHidden(i, true);
        // The painter set every node's painted height again: a live node's is React Flow's.
        this.applyLiveSize(id);
      }
    }
    // One still leaving shows on the layer until its painted image is current: its copy stays hidden.
    for (const id of this.leaving) {
      const i = this.scene.graph.indexOf.get(id);
      if (i != null) this.scene.setHidden(i, true);
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
    this.connection.measured = undefined;
    this.generation++;
    this.disposed++;
    this.snapObserver?.disconnect();
    this.snapObserver = null;
    for (const element of this.snapped.keys()) element.style.translate = "";
    this.snapped.clear();
    this.setNodes({ nodes: [], edges: [], committed: noop });
  }
}

/**
 * A press in a live node or its header that the scene takes: on a handle, or on anything but its fields
 * and `.nodrag`. In a node a button or link is taken too, as React Flow's drag starts from them (the scene
 * leaves the pointer uncaptured until the press drags, so a click still lands); a floating header's own
 * drag leaves its buttons and links out.
 */
/** A right press on a floating header outside any nopan element: classic's React Flow lets it reach the zoom pane. */
export function rightPressPansFromHeader(event: { button: number; target: EventTarget | null }): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return event.button === 2 && !!target && !target.closest(".react-flow__node") && !!target.closest("[data-node-header]") && !target.closest(".nopan");
}

/**
 * React Flow's Pane `onPointerDownCapture` on classic: with the selection key held, a primary left press anywhere
 * inside the pane (nodes, the viewport portal, connection labels) starts a selection, whatever element it lands on,
 * unless that element is in `.nokey`. The press never reaches the element: no focus, no control moves.
 */
export function selectionKeyTakesPress(event: PointerEvent, keyActive: ((event: PointerEvent) => boolean) | null): boolean {
  const target = event.target;
  if (!keyActive || !(target instanceof Element) || event.button !== 0 || event.isPrimary === false) return false;
  if (!target.closest(".react-flow__pane") || target.closest(".nokey")) return false;
  return keyActive(event);
}

export function pressGoesToScene(target: Element): boolean {
  if (target.closest(".react-flow__handle")) return true;
  const kept = target.closest(".react-flow__node") ? "input, textarea, select, [contenteditable='true'], .nodrag" : "input, textarea, select, button, a, [contenteditable='true'], .nodrag";
  return !target.closest(kept);
}

/**
 * A press the scene takes on a live node's button or link. Its click selects through React Flow's node click
 * (LiveFlow's nodeClick), not the scene's: a button whose onClick stops propagation then leaves the selection as
 * it was, as on classic, where a still press selects only through NodeWrapper's click.
 */
export function liveButtonPress(target: Element): boolean {
  return !!target.closest(".react-flow__node") && !!target.closest("button, a") && pressGoesToScene(target);
}

/**
 * What of a live flow's node changes is a resize, as store changes: React Flow's own resize ("dimensions"
 * changes that carry `resizing`, and the position changes sent with them), and widths NodeShell sets through
 * setNodes ("replace" changes, as the store's node at that width). Anything else a replace carries (the layer's
 * position, selection, its own copy of the data) is the layer's, not the store's, and is left out.
 */
export function resizeChanges(changes: readonly NodeChange[], realIds: ReadonlySet<string>, storeNodes: readonly WorkflowNode[]): NodeChange<WorkflowNode>[] {
  const resizing = changes.some((change) => change.type === "dimensions" && change.resizing !== undefined && realIds.has(change.id));
  const out: NodeChange<WorkflowNode>[] = [];
  for (const change of changes) {
    if (change.type === "remove" || change.type === "add" || !realIds.has(change.id)) continue;
    if (change.type === "dimensions" && change.resizing !== undefined) out.push(change);
    else if (change.type === "position" && resizing && change.position && !change.dragging) out.push(change);
    else if (change.type === "replace") {
      const k = indexOfNode(storeNodes, change.id);
      const item = change.item as Node, style = item.style?.width;
      const width = item.width ?? (typeof style === "number" ? style : undefined);
      if (k < 0 || width == null) continue;
      const node = storeNodes[k];
      if (node.width === width && node.style?.width === width) continue;
      out.push({ type: "replace", id: node.id, item: { ...node, width, style: { ...node.style, width } } });
    }
  }
  return out;
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
