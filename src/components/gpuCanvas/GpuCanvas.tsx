"use client";

/**
 * The GPU canvas (the desktop app's canvas; Settings › Canvas): the workflow
 * drawn by one WebGL2 scene, every node as an image painted from its real
 * component, and only the nodes being worked in as live components over it.
 * See docs/gpu-canvas.md.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { DefaultEdgeOptions, EdgeTypes, NodeTypes } from "@xyflow/react";
import { frameLoadedGraph } from "@/utils/frameGraph";
import { isPanningRef } from "@/components/WorkflowCanvas";
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "@/store/workflowStore";
import { indexOfNode } from "@/store/nodeChanges";
import { useNodeUiStore } from "@/store/nodeUiStore";
import { APP_VERSION } from "@/lib/appVersion";
import { controlsOverhang, headersUnder, NODE_HEADER, SceneGraph } from "@/lib/gpuCanvas/graph";
import { Scene, type View } from "@/lib/gpuCanvas/scene";
import { holdOverScrollArea, type SceneWheel } from "@/lib/gpuCanvas/wheel";
import { atlasBudget, readGpuInfo } from "@/lib/gpuCanvas/budget";
import { detectHtmlInCanvas } from "@/lib/gpuCanvas/htmlInCanvas";
import { openPaintStore } from "@/lib/gpuCanvas/paintCache";
import { GpuCanvasStats } from "@/lib/gpuCanvas/stats";
import { getLowDetailSettings } from "@/components/nodes/lowDetail";
import { createPanActivityTracker } from "@/hooks/useWheelPanZoom";
import { Painter, type PainterStatus } from "./painter";
import { LiveFlow, LiveLayer, type LiveConnection } from "./LiveLayer";
import { Editor, type GpuEditing } from "./editor";
import { setGpuCanvasBridge } from "./bridge";
import { LiveContent } from "./liveContent";
import { watchOutputAutoRun } from "@/lib/gpuCanvas/outputAutoRun";
import { watchPromptConnectedText } from "@/lib/gpuCanvas/promptConnectedText";
import { watchVideoTrimDurations } from "@/lib/gpuCanvas/videoTrimDuration";
import { watchGenerationErrors } from "@/lib/gpuCanvas/errorToasts";
import { useToast } from "@/components/Toast";
import { HISTORY_DRAG_TYPE } from "@/components/GlobalImageHistory";
import { pickLiveEdges, routePolylines, routeSceneEdge } from "@/lib/gpuCanvas/edgeRoutes";
import { dimOpacities } from "@/lib/gpuCanvas/dimming";
import type { HookPath } from "@/components/edges/EdgeHookSelection";
import { EDGE_THICKNESS_PX } from "@/lib/edges/appearance";
import { OVERVIEW_ZOOM_THRESHOLD } from "@/utils/canvasPerformance";
import { boundedNodeTypes, HEADER, noop, PAD, PAD_X, type HeaderProps } from "./nodeSheets";

/** The drags WorkflowCanvas's wrapper takes on drop (a file, a node type from the action bar, a history image). */
const CANVAS_DRAG_TYPES = ["Files", "application/node-type", HISTORY_DRAG_TYPE];
/** Workflows at least this large open behind the loading screen while they paint. */
const LOADING_MIN_NODES = 150;
/** The loading screen appears only if painting takes longer than this. */
const LOADING_DELAY_MS = 300;
/** An opened workflow framed on default node heights is framed again on painted ones, waiting at most this long. */
const REFRAME_WAIT_MS = 2000;
/** Above this zoom every visible node is live. */
const LIVE_ZOOM = 1;
/**
 * Without HTML-in-Canvas (a browser, or a Chromium whose API changed) nothing is painted: every node in view is live
 * from the low-detail zoom up (or the overview's, with low detail off), as classic renders them, and the rest are
 * stand-in cards. Past this many nodes in view they are all stand-ins, as no page holds that many live.
 */
const LIVE_MODE_MAX_NODES = 400;
/**
 * From this zoom, connections that show more than a line (labels, stubs, clamps) are live while near the view:
 * where classic stops drawing connections (its overview). Those showing a run's comet are live at any zoom.
 */
const LIVE_EDGE_ZOOM = OVERVIEW_ZOOM_THRESHOLD;
/** At most this many live connections besides the selected ones, unless more are on screen (pickLiveEdges). */
const MAX_LIVE_EDGES = 250;
/** Added nodes on screen made live until painted (the rest are held undrawn until painted: `Scene.holdStandIn`). */
const MAX_ADDED_LIVE = 8;
/** How long an added node stays live at most, should its paint not land. */
const ADDED_LIVE_TIMEOUT_MS = 3000;
/** A view still this long has stopped moving: d3-zoom's wheel end delay, after which classic's onMoveEnd fires. */
const MOVE_END_MS = 150;

/** After the GPU resets, the canvas is rebuilt once WebGL is back, or after this long at the latest. */
const CONTEXT_RESTORE_WAIT_MS = 3000;

/** What a wheel's decision needs from the canvas besides the event. */
export interface GpuWheelState {
  /** Over the pane (nodes, connections, empty canvas), not chrome beside it. */
  pane: boolean;
  /** Space is held in the "space" pan mode. */
  panKey: boolean;
}

export interface GpuCanvasProps {
  nodeTypes: NodeTypes;
  /** The connection components, for the live connections (labels, stubs, toolbars). */
  edgeTypes: EdgeTypes;
  defaultEdgeOptions: DefaultEdgeOptions;
  headers: HeaderProps;
  /** What a wheel does (the canvas's navigation settings, as classic's wheel handlers read them). */
  wheel: (event: WheelEvent, state: GpuWheelState) => SceneWheel;
  /**
   * The element classic's wrapper wheel handler listens on: wheels over chrome in it beside the canvas
   * (the agent pill, the history drop-down) still pan and zoom. The canvas's own box when not given.
   */
  wheelRoot?: RefObject<HTMLElement | null>;
  /** WorkflowCanvas's editing settings and handlers (connect, menus, group drops). */
  editing: GpuEditing;
  /** The dot grid at 30%, as classic's Background while the tutorial locks the canvas. */
  dimBackground?: boolean;
  /** Drawn over the canvas (the performance overlay, the agent button). */
  children?: ReactNode;
  /** Drawn inside the page's React Flow, in its viewport's context (group controls, the navigator). */
  flowChildren?: ReactNode;
  /** The scene could not start or draw (no WebGL2, a shader failed): the page shows why in the canvas's place. */
  onFailure: (reason: string) => void;
  /** The GPU reset and WebGL is back (or gave up coming back): the page builds the canvas again. */
  onContextLost: () => void;
}

/**
 * WebGL drawn by the CPU: the desktop app allows SwiftShader (--enable-unsafe-swiftshader) so a machine
 * whose GPU is missing or blocked still gets a canvas, and says so once a session.
 */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software/i;
let toldSoftwareRendering = false;

export interface GpuCanvasApi {
  stats: GpuCanvasStats;
  painter: () => PainterStatus | null;
  sharpness: () => ReturnType<Painter["sharpness"]> | null;
  view: () => View;
  setView: (view: Partial<View>) => void;
  fit: () => void;
  nodeRect: (id: string) => { x: number; y: number; width: number; height: number; type: string } | null;
  /** The node's painted rectangle on screen (header and margin included), in css px. */
  paintRect: (id: string) => { x: number; y: number; width: number; height: number } | null;
  /** Node ids at or near a point, for runners choosing where to press. */
  nodeAt: (x: number, y: number) => string | null;
  nodeIds: () => string[];
  live: () => string[];
  setLive: (ids: string[]) => Promise<string[]>;
  paintNow: (id: string) => Promise<void>;
  repaint: (id: string) => Promise<void>;
  /** Edits a node's data in the store, as typing elsewhere would (the repaint's latency lands in stats). */
  change: (id: string, data: Record<string, unknown>) => void;
  /** A node's data as the store holds it. */
  data: (id: string) => Record<string, unknown> | null;
  /** Selects exactly these nodes, as a marquee does (one store write). */
  select: (ids: string[]) => void;
  /** Holds the canvas as a marquee would (selections are drawn, not made live, until it ends). */
  marquee: (active: boolean) => void;
  /** Records the sheet state (placement, sizes, text fields, images) whenever these nodes are painted. */
  probe: (ids: string[]) => void;
  probeLog: () => Record<string, unknown>[];
  info: () => ReturnType<Scene["info"]> & { budget: ReturnType<typeof atlasBudget> | null; htmlInCanvas: boolean };
  /**
   * For a runner isolating frame-rate costs: takes a part of the page away
   * (on = false) or puts it back. "subtree" is the canvas's layoutsubtree
   * attribute, "sheet" the painter's sheet inside it, "live" the live layer,
   * "chrome" everything on the page but the canvas and the live layer, "draw" the scene's
   * drawing (the view and everything following it still run).
   */
  diagnose: (part: "subtree" | "sheet" | "live" | "chrome" | "draw", on: boolean) => void;
}

declare global {
  interface Window {
    __gpuCanvas?: GpuCanvasApi;
  }
}

interface Loading {
  painted: number;
  total: number;
}

/**
 * Memoised: the canvas page re-renders for many store changes (each selection step, each keystroke) that the
 * canvas takes from the store itself, and its props stay the same objects then.
 */
export const GpuCanvas = memo(function GpuCanvas({ nodeTypes, edgeTypes, defaultEdgeOptions, headers, wheel, wheelRoot, editing, dimBackground = false, children, flowChildren, onFailure, onContextLost }: GpuCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  // Filled by the live flow as it mounts, read by the engine.
  const [liveConnection] = useState<LiveConnection>(() => ({}));
  const connectLive = useCallback((part: LiveConnection) => void Object.assign(liveConnection, part), [liveConnection]);
  const liveViewChanged = useCallback((view: View) => liveConnection.viewChanged?.(view), [liveConnection]);
  const holdLive = useCallback((id: string) => liveConnection.hold?.(id) ?? noop, [liveConnection]);
  const liveNodeClick = useCallback((id: string, additive: boolean) => liveConnection.nodeClick?.(id, additive), [liveConnection]);
  const liveMeasured = useCallback((id: string) => liveConnection.measured?.(id), [liveConnection]);
  const [initialView] = useState(() => useWorkflowStore.getState().canvasViewport ?? { x: 0, y: 0, zoom: 1 });
  const types = useMemo(() => boundedNodeTypes(nodeTypes), [nodeTypes]);
  const [loading, setLoading] = useState<Loading | null>(null);
  // The latest props, read by the engine without rebuilding it.
  const propsRef = useRef({ headers, wheel, wheelRoot, editing, dimBackground, onFailure, onContextLost });
  useLayoutEffect(() => {
    propsRef.current = { headers, wheel, wheelRoot, editing, dimBackground, onFailure, onContextLost };
  });
  const loadCount = useWorkflowStore((state) => state.workflowLoadCount);
  const onEdgesChange = useWorkflowStore((state) => state.onEdgesChange);
  const engineRef = useRef<{ painter: Painter | null; scene: Scene } | null>(null);

  useEffect(() => {
    const host = hostRef.current, canvas = canvasRef.current, liveElement = liveRef.current;
    if (!host || !canvas || !liveElement) return;
    const stats = new GpuCanvasStats();
    stats.observeLongFrames();
    // What writes the store, for runners: a write mid-gesture re-runs every selector over the whole graph.
    const unsubscribeStoreWrites = useWorkflowStore.subscribe((state, previous) => {
      const keys = (Object.keys(state) as (keyof typeof state)[]).filter((key) => key !== "nodes" && state[key] !== previous[key]);
      if (keys.length) stats.storeWrite(keys.sort().join(","));
    });
    const unsubscribeNodeWrites = subscribeToWorkflowNodeChanges((changes) => {
      if (changes.added.size || changes.removed.size) return stats.storeWrite("nodes:added/removed");
      const fields = new Set<string>();
      for (const id of changes.updated) {
        const before = changes.previous[indexOfNode(changes.previous, id)], after = changes.nodes[indexOfNode(changes.nodes, id)];
        if (!before || !after) continue;
        const a = after as unknown as Record<string, unknown>, b = before as unknown as Record<string, unknown>;
        for (const key of Object.keys(a)) {
          if (key === "data") {
            const ad = a.data as Record<string, unknown>, bd = b.data as Record<string, unknown>;
            for (const field of Object.keys(ad)) if (ad[field] !== bd[field]) fields.add(`data.${field}`);
          } else if (a[key] !== b[key]) fields.add(key);
        }
      }
      stats.storeWrite(`nodes(${changes.updated.size}):${[...fields].sort().join(",")}`);
    });
    const store = useWorkflowStore.getState();
    const graph = new SceneGraph(store.nodes, store.edges, store.groups);
    // Held while the user navigates, as today's canvas does, so work that
    // waits for a quiet canvas (the desktop recovery checkpoint) waits for it.
    const interacting = createPanActivityTracker({
      // A node or wire drag holds the class itself: a pause mid-drag must not take it away.
      setActive: (active) => {
        if (active || !editor.holdsInteracting) document.documentElement.classList.toggle("canvas-interacting", active);
      },
    });
    // The hovered node: the one under the pointer in the scene, or the live node it moved onto
    // (the scene sees the pointer leave as it enters a live node). Applied a task later, so
    // leaving the scene for a live node is one change, not a drop and a return.
    let sceneHover: string | null = null, hoverTimer = 0;
    const showHover = () => {
      clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => {
        const id = live.pointerNode ?? sceneHover;
        live.wantOnly("hover", id ? [id] : []);
      }, 0);
    };
    // Zoomed out past the low-detail zoom, running nodes show a halo (as today's low-detail cards do).
    const haloBelow = () => {
      const { enabled, zoom } = getLowDetailSettings();
      return enabled ? zoom : 0;
    };
    let scene: Scene;
    try {
      scene = new Scene(canvas, graph, {
        onFrame: (now, jsMs) => stats.frame(now, jsMs),
        // Something the scene draws would be missing (a shader failed): the classic canvas takes over.
        onFailure: (reason) => queueMicrotask(() => propsRef.current.onFailure(reason)),
        onInputLatency: (ms) => stats.record("input.latencyMs", ms),
        onInput: () => interacting.signal(),
        wheel: (event, pane) => {
          const action = propsRef.current.wheel(event, { pane, panKey: editor.spaceHeld });
          if (!action || event.target !== canvas) return action;
          // Over a painted node's inner area that scrolls: held until the node is live (holdOverScrollArea).
          const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
          const i = scene.nodeAt(x, y), n = i >= 0 ? scene.graph.nodes[i] : undefined;
          if (!n) return action;
          const p = scene.toWorld(x, y);
          return holdOverScrollArea(action, engineRef.current?.painter?.scrollAreaAt(n.id, p.x - n.x, p.y - n.y) ?? null);
        },
        // React Flow's zoomOnPinch: off in the tutorial and under a dialog.
        pinchZooms: () => !propsRef.current.editing.disabled && !propsRef.current.editing.tutorial,
        onHover: (i) => {
          sceneHover = i >= 0 ? scene.graph.nodes[i].id : null;
          showHover();
        },
        onPress: (event) => editor.press(event),
        hoverAt: (x, y) => editor.hoverAt(x, y),
        onIdleMove: (event) => editor.idleMove(event),
        onHoverEnd: (reason) => editor.hoverEnd(reason),
        onContextMenu: (event) => editor.contextMenu(event),
        paneAt: (x, y) => editor.nodeIsPane(x, y),
        onPaneDoubleClick: (x, y, screen) => editor.paneDoubleClick(x, y, screen),
        routeEdge: (e) => {
          const state = useWorkflowStore.getState();
          return routeSceneEdge(graph, e, { style: state.edgeStyle, appearance: state.edgeAppearance, edges: state.edges, nodes: state.nodes, thicknessPx: EDGE_THICKNESS_PX[state.edgeAppearance.thickness], hookDrag: state.hookDrag });
        },
        onViewChange: (view) => live.setView(view),
        runningHaloBelow: haloBelow,
      });
    } catch (error) {
      // WebGL2 is unavailable: the classic canvas takes over.
      const message = error instanceof Error ? error.message : String(error);
      queueMicrotask(() => propsRef.current.onFailure(message));
      return;
    }
    // A GPU reset loses the atlas and every buffer: once WebGL is back, the page builds the
    // canvas afresh (the disk cache makes the repaint quick). three.js asks for the restore.
    let lostTimer = 0;
    const rebuild = () => {
      clearTimeout(lostTimer);
      canvas.removeEventListener("webglcontextrestored", rebuild);
      propsRef.current.onContextLost();
    };
    const contextLost = () => {
      canvas.addEventListener("webglcontextrestored", rebuild);
      lostTimer = window.setTimeout(rebuild, CONTEXT_RESTORE_WAIT_MS);
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    // Chrome beside the canvas (the agent pill, the history drop-down) is not the pane: there a wheel
    // does what classic's wrapper handler makes of it. The canvas and the live layer handle their own.
    const wheelRoot = propsRef.current.wheelRoot?.current ?? host;
    const chromeWheel = (event: WheelEvent) => {
      const target = event.target;
      if (event.defaultPrevented || target === canvas || (target instanceof Node && liveElement.contains(target))) return;
      scene.wheel(event, false);
    };
    wheelRoot.addEventListener("wheel", chromeWheel, { passive: false });
    // Chrome over the scene drops its backdrop blur (globals.css).
    document.documentElement.toggleAttribute("data-gpu-canvas-active", true);
    // The latest header props, read when used; spreadable, so a render takes them as they are then.
    const headerProxy: HeaderProps = new Proxy({} as HeaderProps, {
      get: (_, key: keyof HeaderProps) => propsRef.current.headers[key],
      ownKeys: () => Reflect.ownKeys(propsRef.current.headers),
      getOwnPropertyDescriptor: (_, key) => ({ value: propsRef.current.headers[key as keyof HeaderProps], enumerable: true, configurable: true, writable: false }),
    });
    const live = new LiveLayer(liveElement, liveConnection, scene, stats);
    live.onPointerNode = showHover;
    // Nodes live for what they hold (the 3D viewer, a playing video, a ComfyUI run, a spinner),
    // and Output nodes run on a new connection though they are not mounted.
    const liveContent = new LiveContent(live, {
      zoomedOut: () => scene.view.zoom < haloBelow(),
      onViewChanged: (listener) => scene.onViewChanged(listener),
      setRunning: (ids) => scene.setRunning(ids),
    });
    const stopAutoRun = watchOutputAutoRun(useWorkflowStore);
    // Prompt nodes copy their connected text as classic's mounted ones do, not on every live mount.
    const stopPromptText = watchPromptConnectedText(useWorkflowStore);
    // Video Trim nodes learn their source's length though they are not mounted.
    const stopTrimDurations = watchVideoTrimDurations(useWorkflowStore);
    const stopErrorToasts = watchGenerationErrors(useWorkflowStore, (title, error) => useToast.getState().show(title, "error", true, error));
    const editor = new Editor(scene, live, host, () => propsRef.current.editing);
    // A press just before the drag may still hold the tracker active: resetting it lets the next pan put the class back.
    editor.onInteractingEnd = () => interacting.dispose();
    connectLive({ nodeClick: (id, additive) => editor.clickNode(id, additive) });
    // The routes above read the store: compute them now that the scene exists.
    scene.setEdgeAppearance(store.edgeAppearance.gradient, store.edgeAppearance.fadedOpacity);
    scene.setGridDim(propsRef.current.dimBackground ? 0.3 : 1);
    scene.rerouteAll();
    live.setView(scene.view);

    const gl = scene.renderer.getContext() as WebGL2RenderingContext;
    const gpuInfo = readGpuInfo(gl);
    if (SOFTWARE_RENDERER.test(gpuInfo.renderer) && !toldSoftwareRendering) {
      toldSoftwareRendering = true;
      useToast.getState().show("No graphics card is available, so the canvas draws in software and may be slow", "warning");
    }
    const htmlInCanvas = detectHtmlInCanvas().available;
    const budget = htmlInCanvas ? atlasBudget(gpuInfo) : null;
    const painter = budget ? new Painter(scene, { nodeTypes: types, headers: headerProxy, budget, cache: openPaintStore(), salt: APP_VERSION, stats }) : null;
    live.painter = painter;
    engineRef.current = { painter, scene };

    // Selected nodes are live; store selection follows clicks. Mid-marquee they are only drawn selected: each
    // step would otherwise mount the nodes it took, and a sweep across a zoomed-out graph takes hundreds.
    const selectedIds = new Set(store.nodes.filter((n) => n.selected).map((n) => n.id));
    const showSelection = () => {
      scene.setSelected([...selectedIds].map((id) => scene.graph.indexOf.get(id)).filter((i): i is number => i != null));
      if (!editor.marqueeing) live.wantOnly("selected", selectedIds);
    };
    editor.onMarqueeEnd = showSelection;
    showSelection();

    // React Flow's SelectionListener: WorkflowCanvas hears of every change in the selected nodes or
    // connections, a click's or the store's own (paste, undo, the agent), once the change is through.
    let selectionCheck = false, disposed = false;
    const readSelection = () => {
      const { nodes, edges } = useWorkflowStore.getState();
      const selected = { nodes: nodes.filter((n) => n.selected), edges: edges.filter((e) => e.selected) };
      return { selected, key: `${selected.nodes.map((n) => n.id).join("\n")}\t${selected.edges.map((e) => e.id).join("\n")}` };
    };
    let selectionKey = readSelection().key;
    function selectionChanged() {
      if (selectionCheck) return;
      selectionCheck = true;
      queueMicrotask(() => {
        selectionCheck = false;
        if (disposed) return;
        const { selected, key } = readSelection();
        if (key === selectionKey) return;
        selectionKey = key;
        propsRef.current.editing.onSelectionChange?.(selected);
      });
    }

    // A node just added (dropped, pasted, from a menu or a key) is live until its painted image shows,
    // as classic renders it whole at once: the scene would draw its stand-in card while it paints.
    const added = new Set<string>();
    let loadSeen = store.workflowLoadCount;
    // Visible added nodes past MAX_ADDED_LIVE (a large agent batch, grid cells) show nothing until painted rather
    // than the stand-in card: they appear whole, as the rest of the batch does.
    const heldAdded = new Set<string>();
    const releaseHeld = (id: string) => {
      if (heldAdded.delete(id)) scene.holdStandIn(id, false);
    };
    const showAdded = (ids: ReadonlySet<string>) => {
      if (!painter) return;
      const visible = new Set(scene.visible(0).map((i) => scene.graph.nodes[i].id));
      const onScreen = [...ids].filter((id) => visible.has(id));
      const shown = onScreen.slice(0, MAX_ADDED_LIVE);
      if (!shown.length) return;
      // A paint that never lands must not pin a node live, nor keep one undrawn.
      const painted = (id: string) => Promise.race([painter.paintNow(id), new Promise((resolve) => setTimeout(resolve, ADDED_LIVE_TIMEOUT_MS))]);
      for (const id of shown) {
        added.add(id);
        void painted(id).then(() => {
          if (disposed || !added.delete(id)) return;
          live.wantOnly("added", added);
        });
      }
      for (const id of onScreen.slice(MAX_ADDED_LIVE)) {
        // A node the live layer renders anyway (selected) needs no hold.
        if (selectedIds.has(id) || live.renders(id) || heldAdded.has(id)) continue;
        heldAdded.add(id);
        scene.holdStandIn(id, true);
        void painted(id).then(() => {
          if (!disposed) releaseHeld(id);
        });
      }
      live.wantOnly("added", added);
    };

    // The nodes live for the view: those visible above 100%, or without a painter every one in view (LIVE_MODE_MAX_NODES).
    const showViewLive = () => {
      const { zoom } = scene.view;
      let ids: string[] = [];
      if (painter) {
        if (zoom > LIVE_ZOOM) ids = scene.visible(0).map((i) => scene.graph.nodes[i].id);
      } else {
        const lowDetail = getLowDetailSettings();
        if (zoom >= (lowDetail.enabled ? lowDetail.zoom : OVERVIEW_ZOOM_THRESHOLD)) {
          const visible = scene.visible(0);
          if (visible.length <= LIVE_MODE_MAX_NODES) ids = visible.map((i) => scene.graph.nodes[i].id);
        }
      }
      live.wantOnly("zoom", ids);
    };
    if (!painter) showViewLive();

    // Store changes reach the graph, the scene, the painter and the live layer.
    const unsubscribeNodes = subscribeToWorkflowNodeChanges((changes) => {
      const state = useWorkflowStore.getState();
      // An opened workflow's nodes are not added ones: it paints behind its loading screen.
      const opened = state.workflowLoadCount !== loadSeen;
      loadSeen = state.workflowLoadCount;
      for (const id of changes.removed) selectedIds.delete(id);
      for (const ids of [changes.updated, changes.added]) for (const id of ids) {
        const i = indexOfNode(state.nodes, id);
        if (i >= 0 && state.nodes[i].selected) selectedIds.add(id);
        else selectedIds.delete(id);
      }
      const moved = changes.added.size || changes.removed.size ? null : scene.graph.updateNodes(state.nodes, changes.updated);
      if (moved === null) {
        scene.graph.sync(state.nodes, state.edges, state.groups);
        scene.setGraph(scene.graph);
        painter?.graphRebuilt();
        live.graphRebuilt();
        for (const id of changes.removed) {
          added.delete(id);
          releaseHeld(id);
        }
        // An opened workflow paints behind its loading screen: nothing of the canvas before it stays held.
        if (opened) for (const id of [...heldAdded]) releaseHeld(id);
        if (!opened && changes.added.size) showAdded(changes.added);
        // The view state of nodes that went (or of the workflow before an opened one) goes with them, as classic's unmount.
        if (opened) useNodeUiStore.getState().forget();
        else if (changes.removed.size) useNodeUiStore.getState().forget(changes.removed);
      } else {
        if (moved.length) {
          // A painted node moved by the store trails its controls card, as classic's do (Scene.nodesMoved).
          scene.nodesMoved(moved, true);
          // Painted nodes that moved mask the live connections they now lie over (LiveLayer's EdgeMask), and a
          // node the layer renders, moved or resized from the store (a group drag, arrange, undo, its resize grips),
          // takes its new box from the graph: the layer's own listener ran first and rendered the old one.
          if (live.hasEdges || moved.some((i) => live.renders(scene.graph.nodes[i].id))) live.refresh();
        }
        // What a node's connections show can follow its data (a run's loading pulse, a bundle's clamp).
        const edges = new Set<number>();
        for (const id of changes.updated) for (const e of scene.graph.edgesOf[scene.graph.indexOf.get(id) ?? -1] ?? []) edges.add(e);
        if (edges.size) scene.reroute(edges);
      }
      showSelection();
      showLiveEdges();
      // Without a painter a node added, removed or moved in or out of view is live or a stand-in at once.
      if (!painter && (moved === null || moved.length)) showViewLive();
      selectionChanged();
    });
    const showEdgeSelection = () => {
      const { edges } = useWorkflowStore.getState();
      scene.setSelectedEdges(edges.filter((e) => e.selected).map((e) => scene.graph.edgeIndexOf.get(e.id)).filter((e): e is number => e != null));
    };
    showEdgeSelection();
    // Connections the live layer renders: the selected ones, and those on screen that show more than a line.
    let liveEdgesKey = "", liveEdgesSource: unknown = null;
    const showLiveEdges = () => {
      const { edges } = useWorkflowStore.getState();
      const ids = edges.filter((e) => e.selected).map((e) => e.id);
      const all = scene.view.zoom >= LIVE_EDGE_ZOOM;
      const w = scene.canvas.clientWidth, h = scene.canvas.clientHeight;
      const a = scene.toWorld(-w * 0.25, -h * 0.25), b = scene.toWorld(w * 1.25, h * 1.25);
      const candidates: { id: string; distance: number; onScreen: boolean; e: number }[] = [];
      const centre = scene.toWorld(w / 2, h / 2);
      const s0 = scene.toWorld(0, 0), s1 = scene.toWorld(w, h);
      for (const e of scene.edgesWithin(a.x, a.y, b.x, b.y)) {
        const edge = scene.graph.edges[e], route = scene.edgeRoute(e);
        if (!route?.decorated || edge.edge.selected || (!all && !route.running)) continue;
        candidates.push({ id: edge.id, distance: Math.hypot(route.labelX - centre.x, route.labelY - centre.y), onScreen: false, e });
      }
      // Which of them are on screen, asked only when there are some: zoomed out, a frame's pan asked it of every edge.
      if (candidates.length) {
        const onScreen = new Set(scene.edgesWithin(s0.x, s0.y, s1.x, s1.y));
        for (const c of candidates) c.onScreen = onScreen.has(c.e);
      }
      // Those on screen are never capped; the limit bounds only those made live early in the margin.
      for (const id of pickLiveEdges(candidates, MAX_LIVE_EDGES)) ids.push(id);
      const key = ids.join("\n");
      if (key === liveEdgesKey && edges === liveEdgesSource) return;
      liveEdgesKey = key;
      liveEdgesSource = edges;
      live.setEdges(ids);
    };
    showLiveEdges();
    // Nodes downstream of a disabled Switch output and skipped ones are dimmed, as classic's classes dim them.
    const showDimming = (instant = false) => {
      const { dimmedNodeIds, skippedNodeIds } = useWorkflowStore.getState();
      const typeOf = (id: string) => scene.graph.nodes[scene.graph.indexOf.get(id) ?? -1]?.type;
      scene.setNodeOpacity(dimOpacities(typeOf, dimmedNodeIds, skippedNodeIds), instant);
    };
    showDimming(true);

    // Classic draws node headers (z-index 1500) over the group labels and menus (1000), but the live layer holding
    // those draws over the scene's painted headers: a node whose header a label or open menu overlaps is made live,
    // its header then above them again. The chrome is measured once its DOM has settled (a view, a group or a menu
    // changed), and the overlaps follow the nodes as they move. Not when zoomed out to the overview.
    let chromeRects: { x0: number; y0: number; x1: number; y1: number }[] = [], chromeFrame = 0, chromeKey = "";
    const showChromeCover = () => {
      const ids = new Set<string>();
      if (scene.view.zoom >= OVERVIEW_ZOOM_THRESHOLD) {
        for (const r of chromeRects) for (const id of headersUnder(scene.graph, scene.nodesWithin(r.x0, r.y0, r.x1, r.y1 + NODE_HEADER), [r])) ids.add(id);
      }
      const key = [...ids].join("\n");
      if (key === chromeKey) return;
      chromeKey = key;
      live.wantOnly("groupChrome", ids);
    };
    const measureChrome = () => {
      if (chromeFrame) return;
      chromeFrame = requestAnimationFrame(() => {
        chromeFrame = 0;
        const box = canvas.getBoundingClientRect();
        chromeRects = [...liveElement.querySelectorAll("[data-group-label], [data-group-label] [role=menu]")].map((element) => {
          const r = element.getBoundingClientRect();
          const a = scene.toWorld(r.left - box.left, r.top - box.top), b = scene.toWorld(r.right - box.left, r.bottom - box.top);
          return { x0: a.x, y0: a.y, x1: b.x, y1: b.y };
        }).filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
        showChromeCover();
      });
    };
    measureChrome();
    const unsubscribeChromeLayout = scene.onLayoutChanged(showChromeCover);
    // A group's menu opens and closes on a click or a key.
    document.addEventListener("click", measureChrome, true);
    document.addEventListener("keydown", measureChrome, true);

    // A drag the canvas takes (a file, a node type from the action bar, a history image) over a painted node makes
    // it live, so the drop lands on the node's own drop zone (an empty input loads a file and swallows the rest, as
    // every node is mounted on classic) rather than the canvas's, which adds a node: browsers send no pointer events
    // during a drag. A node with no drop zone lets the drop through to the canvas, as on classic.
    let dropTarget: string | null = null;
    const showDropTarget = (id: string | null) => {
      if (id === dropTarget) return;
      dropTarget = id;
      live.wantOnly("drop", id ? [id] : []);
    };
    const fileDragOver = (event: DragEvent) => {
      const types = event.dataTransfer?.types;
      if (!types || !CANVAS_DRAG_TYPES.some((type) => types.includes(type))) return;
      const at = scene.local(event), i = scene.nodeAt(at.x, at.y, false);
      showDropTarget(i >= 0 ? scene.graph.nodes[i].id : null);
    };
    const fileDragLeave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node && host.contains(event.relatedTarget))) showDropTarget(null);
    };
    // A task later, so the node is still mounted when its own drop handler runs.
    const fileDragEnd = () => setTimeout(() => {
      if (!disposed) showDropTarget(null);
    }, 0);
    host.addEventListener("dragenter", fileDragOver, true);
    host.addEventListener("dragover", fileDragOver, true);
    host.addEventListener("dragleave", fileDragLeave, true);
    window.addEventListener("drop", fileDragEnd, true);
    window.addEventListener("dragend", fileDragEnd, true);

    const unsubscribeStore = useWorkflowStore.subscribe((state, previous) => {
      if (state.dimmedNodeIds !== previous.dimmedNodeIds || state.skippedNodeIds !== previous.skippedNodeIds) showDimming();
      if (state.edgeAppearance !== previous.edgeAppearance) scene.setEdgeAppearance(state.edgeAppearance.gradient, state.edgeAppearance.fadedOpacity);
      if (state.edgeStyle !== previous.edgeStyle || state.edgeAppearance.thickness !== previous.edgeAppearance.thickness || state.edgeAppearance.loadingPulse !== previous.edgeAppearance.loadingPulse) {
        scene.rerouteAll();
        // Which connections show more than a line (a running one's comet) follows the routes.
        showLiveEdges();
      }
      // A hook sweep carries the connections it caught on the fork, and lets go of them as it ends.
      if (state.hookDrag !== previous.hookDrag) {
        const swept = new Set([...(previous.hookDrag?.edgeIds ?? []), ...(state.hookDrag?.edgeIds ?? [])]);
        scene.reroute([...swept].map((id) => scene.graph.edgeIndexOf.get(id)).filter((e): e is number => e != null));
      }
      if (state.groups !== previous.groups) measureChrome();
      if (state.edges === previous.edges && state.groups === previous.groups) return;
      const sync = scene.graph.sync(state.nodes, state.edges, state.groups);
      if (sync.rebuilt) {
        scene.setGraph(scene.graph);
        painter?.graphRebuilt();
        live.graphRebuilt();
        showSelection();
      } else {
        if (sync.edgesChanged) scene.edgesChanged();
        else if (sync.groupsChanged) scene.groupsChanged();
        if (sync.edgesUpdated?.length) {
          // A replaced connection, and the others at its handles (a selected member splits its bundle).
          const edges = new Set<number>();
          for (const e of sync.edgesUpdated) {
            const edge = scene.graph.edges[e];
            for (const n of [edge.source, edge.target]) for (const other of scene.graph.edgesOf[n] ?? []) edges.add(other);
          }
          scene.reroute(edges);
        }
      }
      showEdgeSelection();
      showLiveEdges();
      selectionChanged();
    });

    // As classic's onMoveStart: a moving view drops the hovered node's header controls and video preview,
    // and live nodes take no hover (NodeShell reads isPanningRef) until it has been still a moment (onMoveEnd).
    // The scene still hovers what comes under the pointer, so a node turning live there takes the next wheels.
    let settleTimer = 0, moveEndTimer = 0, liveEdgesFrame = 0, viewLiveFrame = 0, lastView = { ...scene.view };
    const unsubscribeView = scene.onViewChanged(() => {
      // Connections coming into view are live as they arrive, once a frame while the view moves.
      if (!liveEdgesFrame) liveEdgesFrame = requestAnimationFrame(() => {
        liveEdgesFrame = 0;
        showLiveEdges();
      });
      const { x, y, zoom } = scene.view;
      if (x !== lastView.x || y !== lastView.y || zoom !== lastView.zoom) {
        lastView = { x, y, zoom };
        if (!isPanningRef.current) {
          isPanningRef.current = true;
          useWorkflowStore.getState().setHoveredNodeId(null);
        }
        clearTimeout(moveEndTimer);
        moveEndTimer = window.setTimeout(() => { isPanningRef.current = false; }, MOVE_END_MS);
      }
      // Without a painter the nodes coming into view are live as they arrive, once a frame.
      if (!painter && !viewLiveFrame) viewLiveFrame = requestAnimationFrame(() => {
        viewLiveFrame = 0;
        showViewLive();
      });
      // Above 100% every visible node is live, once the view settles; the view is kept for the tab.
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        showLiveEdges();
        showViewLive();
        measureChrome();
        useWorkflowStore.getState().setCanvasViewport({ ...scene.view });
      }, 120);
    });

    setGpuCanvasBridge({
      graph: () => scene.graph,
      view: () => scene.view,
      size: () => ({ width: scene.canvas.clientWidth, height: scene.canvas.clientHeight }),
      setView: (view) => scene.setView(view),
      animateView: (view, duration) => scene.animateView(view, duration),
      fit: () => scene.fit(),
      edgePaths: (ids) => {
        // The connections near the view, sampled every 5 css px or so, in client px (as EdgeHookSelection samples classic's).
        const box = scene.canvas.getBoundingClientRect(), w = scene.canvas.clientWidth, h = scene.canvas.clientHeight;
        const a = scene.toWorld(0, 0), b = scene.toWorld(w, h), step = 5 / scene.view.zoom;
        const paths: HookPath[] = [];
        for (const e of scene.edgesWithin(a.x, a.y, b.x, b.y)) {
          const id = scene.graph.edges[e].id, route = scene.edgeRoute(e);
          if (!route || !ids.has(id)) continue;
          for (const line of routePolylines(route, step)) {
            paths.push({ id, points: line.map((p) => {
              const at = scene.toScreen(p.x, p.y);
              return { x: box.left + at.x, y: box.top + at.y };
            }) });
          }
        }
        return paths;
      },
      holdLive: (ids) => {
        const visible = new Set(scene.visible(0).map((i) => scene.graph.nodes[i].id));
        const releases = ids.filter((id) => visible.has(id)).map((id) => live.hold(id));
        return { ready: live.settled(), release: () => { for (const release of releases) release(); } };
      },
      subscribe: (listener) => {
        const offView = scene.onViewChanged(() => listener(false)), offLayout = scene.onLayoutChanged(() => listener(true));
        return () => { offView(); offLayout(); };
      },
    });

    window.__gpuCanvas = {
      stats,
      painter: () => (painter ? { ...painter.status } : null),
      sharpness: () => painter?.sharpness() ?? null,
      view: () => ({ ...scene.view }),
      setView: (view) => scene.setView(view),
      fit: () => scene.fit(),
      nodeRect: (id) => {
        const i = scene.graph.indexOf.get(id);
        if (i == null) return null;
        const n = scene.graph.nodes[i], a = scene.toScreen(n.x, n.y), z = scene.view.zoom;
        return { x: a.x, y: a.y, width: n.w * z, height: n.h * z, type: n.type };
      },
      paintRect: (id) => {
        const i = scene.graph.indexOf.get(id);
        if (i == null) return null;
        const { nodes } = useWorkflowStore.getState(), k = indexOfNode(nodes, id);
        const n = scene.graph.nodes[i], left = PAD_X + (k >= 0 ? controlsOverhang(nodes[k].data, n.w) : 0);
        const a = scene.toScreen(n.x - left, n.y - HEADER), z = scene.view.zoom;
        return { x: a.x, y: a.y, width: (n.w + left * 2) * z, height: (n.h + HEADER + PAD) * z };
      },
      nodeAt: (x, y) => {
        const i = scene.nodeAt(x, y);
        return i >= 0 ? scene.graph.nodes[i].id : null;
      },
      nodeIds: () => scene.graph.nodes.map((n) => n.id),
      live: () => [...live.live],
      setLive: async (ids) => {
        live.wantOnly("test", ids);
        await live.settled();
        return [...live.live];
      },
      paintNow: (id) => painter?.paintNow(id) ?? Promise.resolve(),
      repaint: (id) => painter?.repaint(id) ?? Promise.resolve(),
      change: (id, data) => useWorkflowStore.getState().updateNodeData(id, data),
      data: (id) => {
        const { nodes } = useWorkflowStore.getState();
        const i = indexOfNode(nodes, id);
        return i >= 0 ? (nodes[i].data as unknown as Record<string, unknown>) : null;
      },
      select: (ids) => {
        const state = useWorkflowStore.getState(), next = new Set(ids);
        const changes = state.nodes.filter((n) => !!n.selected !== next.has(n.id)).map((n) => ({ type: "select" as const, id: n.id, selected: next.has(n.id) }));
        if (changes.length) state.onNodesChange(changes);
      },
      marquee: (active) => {
        editor.marqueeing = active;
        if (!active) editor.onMarqueeEnd?.();
      },
      probe: (ids) => {
        painter?.probeIds.clear();
        for (const id of ids) painter?.probeIds.add(id);
      },
      probeLog: () => painter?.probeLog ?? [],
      info: () => ({ ...scene.info(), budget, htmlInCanvas }),
      diagnose: (part, on) => diagnose(part, on),
    };
    const sheetElement = canvas.querySelector<HTMLElement>("[data-gpu-canvas-sheet]");
    const hidden = new Map<HTMLElement, string>();
    function diagnose(part: "subtree" | "sheet" | "live" | "chrome" | "draw", on: boolean) {
      if (part === "draw") scene.drawing = on;
      else if (part === "subtree") canvas!.toggleAttribute("layoutsubtree", on);
      else if (part === "sheet" && sheetElement) {
        if (on) canvas!.appendChild(sheetElement);
        else sheetElement.remove();
      } else if (part === "live") live.element.style.display = on ? "" : "none";
      else if (part === "chrome") {
        if (on) {
          for (const [element, display] of hidden) element.style.display = display;
          hidden.clear();
          return;
        }
        const keep = new Set<Element>([canvas!, live.element]);
        for (let at: Element | null = canvas!; at && at !== document.body; at = at.parentElement) keep.add(at);
        for (const at of [...keep]) for (const sibling of at.parentElement?.children ?? []) {
          if (keep.has(sibling) || !(sibling instanceof HTMLElement) || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
          hidden.set(sibling, sibling.style.display);
          sibling.style.display = "none";
        }
      }
    }

    return () => {
      // A node or connection drag still running ends first (its cancel path: the auto-pan loop, the connection
      // drag store and the held `canvas-interacting`), while the live layer and the store subscriptions are there.
      scene.cancelGesture();
      canvas.removeEventListener("webglcontextlost", contextLost);
      wheelRoot.removeEventListener("wheel", chromeWheel);
      canvas.removeEventListener("webglcontextrestored", rebuild);
      clearTimeout(lostTimer);
      document.documentElement.toggleAttribute("data-gpu-canvas-active", false);
      clearTimeout(settleTimer);
      clearTimeout(moveEndTimer);
      cancelAnimationFrame(liveEdgesFrame);
      cancelAnimationFrame(viewLiveFrame);
      cancelAnimationFrame(chromeFrame);
      unsubscribeChromeLayout();
      document.removeEventListener("click", measureChrome, true);
      document.removeEventListener("keydown", measureChrome, true);
      host.removeEventListener("dragenter", fileDragOver, true);
      host.removeEventListener("dragover", fileDragOver, true);
      host.removeEventListener("dragleave", fileDragLeave, true);
      window.removeEventListener("drop", fileDragEnd, true);
      window.removeEventListener("dragend", fileDragEnd, true);
      isPanningRef.current = false;
      clearTimeout(hoverTimer);
      disposed = true;
      unsubscribeNodes();
      unsubscribeStore();
      unsubscribeView();
      engineRef.current = null;
      if (window.__gpuCanvas?.stats === stats) delete window.__gpuCanvas;
      unsubscribeStoreWrites();
      unsubscribeNodeWrites();
      interacting.dispose();
      setGpuCanvasBridge(null);
      editor.dispose();
      connectLive({ nodeClick: undefined });
      liveContent.dispose();
      stopAutoRun();
      stopPromptText();
      stopTrimDurations();
      stopErrorToasts();
      stats.dispose();
      live.dispose();
      painter?.dispose();
      scene.dispose();
    };
    // The engine is built once per mount; props it needs later are read through propsRef.
  }, [types, liveConnection, connectLive]);

  useEffect(() => {
    engineRef.current?.scene.setGridDim(dimBackground ? 0.3 : 1);
  }, [dimBackground]);

  // Painted headers show the readiness hints as they are now; the nodes whose hint changed are painted again.
  useEffect(() => {
    engineRef.current?.painter?.hintsChanged(headers.hints ?? {});
  }, [headers.hints]);

  // A workflow opened (or the canvas mounted): the tab's view, else the graph framed as today's
  // canvas frames it; painting starts over from the view, behind the loading screen when large.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const { scene, painter } = engine;
    const saved = useWorkflowStore.getState().canvasViewport;
    const frame = () => frameLoadedGraph(scene.graph.nodes.map((n) => ({ x: n.x, y: n.y, width: n.w, height: n.h })), scene.canvas.clientWidth, scene.canvas.clientHeight);
    // Framed on the default heights until the nodes have painted theirs: classic frames on measured ones.
    let provisional: View | null = null;
    if (saved && saved.zoom > 0) scene.setView(saved);
    else {
      const framed = frame();
      if (framed) {
        scene.setView(framed);
        useWorkflowStore.getState().setCanvasViewport(framed);
        provisional = { ...scene.view };
      }
    }
    painter?.start();
    if (!painter) return;
    // Framed again once every node has its painted height (or the wait is over, on what is known by
    // then), unless the view moved in the meantime.
    const reframe = (force: boolean) => {
      if (!provisional || (!force && painter.status.painted < painter.status.total)) return;
      const view = scene.view, moved = Math.abs(view.x - provisional.x) > 0.5 || Math.abs(view.y - provisional.y) > 0.5 || Math.abs(view.zoom - provisional.zoom) > 1e-6;
      provisional = null;
      const framed = moved ? null : frame();
      if (!framed) return;
      scene.setView(framed);
      useWorkflowStore.getState().setCanvasViewport(framed);
    };
    const reframeTimer = window.setTimeout(() => reframe(true), REFRAME_WAIT_MS);
    const large = painter.status.total >= LOADING_MIN_NODES;
    const done = () => painter.status.screenfulDone && painter.status.painted >= painter.status.total;
    let shown = false;
    const timer = window.setTimeout(() => {
      if (!large || done()) return;
      shown = true;
      painter.setLoading(true);
      setLoading({ painted: painter.status.painted, total: painter.status.total });
    }, LOADING_DELAY_MS);
    painter.setStatusListener(() => {
      reframe(false);
      if (!shown) return;
      if (done()) {
        shown = false;
        painter.setLoading(false);
        setLoading(null);
      } else setLoading({ painted: painter.status.painted, total: painter.status.total });
    });
    reframe(false);
    return () => {
      clearTimeout(timer);
      clearTimeout(reframeTimer);
      painter.setStatusListener(() => {});
      if (shown) painter.setLoading(false);
      setLoading(null);
    };
  }, [loadCount, types]);

  return (
    <div ref={hostRef} className="absolute inset-0 overflow-hidden bg-neutral-900" data-gpu-canvas="">
      {/* select-none: as globals.css gives React Flow's pane (Chromium need not hit-test the canvas to extend a selection). */}
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none select-none" />
      <div ref={liveRef} data-gpu-canvas-live="" data-locked={editing.locked ? "" : undefined} data-disabled={editing.disabled ? "" : undefined} className="pointer-events-none absolute inset-0 overflow-hidden">
        <LiveFlow connect={connectLive} onViewChanged={liveViewChanged} initialView={initialView} nodeTypes={types} edgeTypes={edgeTypes} defaultEdgeOptions={defaultEdgeOptions}
          onEdgesChange={onEdgesChange} headers={headers} hold={holdLive} onNodeClick={liveNodeClick} onMeasured={liveMeasured}>
          {flowChildren}
        </LiveFlow>
      </div>
      {children}
      {loading && <LoadingScreen painted={loading.painted} total={loading.total} />}
    </div>
  );
});

/** Covers the canvas while a large workflow paints, as Figma does while a file opens. */
function LoadingScreen({ painted, total }: Loading) {
  const share = total ? painted / total : 0;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-neutral-900" role="status" aria-live="polite">
      <div className="flex w-72 flex-col gap-3">
        <p className="text-sm font-medium text-neutral-200">Opening workflow</p>
        <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-800">
          <div className="h-full rounded-full bg-neutral-300 transition-[width] duration-200" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        <p className="text-xs text-neutral-500 tabular-nums">
          {painted.toLocaleString()} of {total.toLocaleString()} nodes
        </p>
      </div>
    </div>
  );
}
