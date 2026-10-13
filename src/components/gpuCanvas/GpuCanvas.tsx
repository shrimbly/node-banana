"use client";

/**
 * The GPU canvas (Settings › Canvas, desktop only): the workflow drawn by one
 * WebGL2 scene, every node as an image painted from its real component, and
 * only the nodes being worked in as live components over it. See
 * docs/gpu-canvas.md.
 *
 * This is phase 2 of the rewrite: a read-only canvas. It pans, zooms,
 * selects (click, Shift+click) and opens nodes (double-click), and live nodes
 * work as they do on today's canvas; dragging, connecting, menus and the
 * rest of editing come with phase 3.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DefaultEdgeOptions, EdgeTypes, NodeTypes } from "@xyflow/react";
import { frameLoadedGraph } from "@/utils/frameGraph";
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "@/store/workflowStore";
import { indexOfNode } from "@/store/nodeChanges";
import { APP_VERSION } from "@/lib/appVersion";
import { SceneGraph } from "@/lib/gpuCanvas/graph";
import { Scene, type View } from "@/lib/gpuCanvas/scene";
import { atlasBudget, readGpuInfo } from "@/lib/gpuCanvas/budget";
import { detectHtmlInCanvas } from "@/lib/gpuCanvas/htmlInCanvas";
import { reportGpuCanvasFailure } from "@/lib/gpuCanvas/setting";
import { openPaintStore } from "@/lib/gpuCanvas/paintCache";
import { GpuCanvasStats } from "@/lib/gpuCanvas/stats";
import { setZoomedOut } from "@/components/nodes/lowDetail";
import { createPanActivityTracker } from "@/hooks/useWheelPanZoom";
import { Painter, type PainterStatus } from "./painter";
import { LiveFlow, LiveLayer, type LiveConnection } from "./LiveLayer";
import { Editor, type GpuEditing } from "./editor";
import { setGpuCanvasBridge } from "./bridge";
import { routeSceneEdge } from "@/lib/gpuCanvas/edgeRoutes";
import { EDGE_THICKNESS_PX } from "@/lib/edges/appearance";
import { boundedNodeTypes, HEADER, PAD, type HeaderProps } from "./nodeSheets";

/** Workflows at least this large open behind the loading screen while they paint. */
const LOADING_MIN_NODES = 150;
/** The loading screen appears only if painting takes longer than this. */
const LOADING_DELAY_MS = 300;
/** Above this zoom every visible node is live. */
const LIVE_ZOOM = 1;
/** From this zoom, connections that show more than a line (labels, stubs, clamps) are live while on screen. */
const LIVE_EDGE_ZOOM = 0.3;
/** At most this many live connections besides the selected ones. */
const MAX_LIVE_EDGES = 250;

export interface GpuCanvasProps {
  nodeTypes: NodeTypes;
  /** The connection components, for the live connections (labels, stubs, toolbars). */
  edgeTypes: EdgeTypes;
  defaultEdgeOptions: DefaultEdgeOptions;
  headers: HeaderProps;
  /** Whether a wheel event zooms rather than pans (the canvas's navigation settings). */
  wheelZooms: (event: WheelEvent) => boolean;
  /** WorkflowCanvas's editing settings and handlers (connect, menus, group drops). */
  editing: GpuEditing;
  /** Drawn over the canvas (the performance overlay, the agent button). */
  children?: ReactNode;
  /** Drawn inside the page's React Flow, in its viewport's context (group controls, the navigator). */
  flowChildren?: ReactNode;
}

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
  /** Records the sheet state (placement, sizes, text fields, images) whenever these nodes are painted. */
  probe: (ids: string[]) => void;
  probeLog: () => Record<string, unknown>[];
  info: () => ReturnType<Scene["info"]> & { budget: ReturnType<typeof atlasBudget> | null; htmlInCanvas: boolean };
  /**
   * For a runner isolating frame-rate costs: takes a part of the page away
   * (on = false) or puts it back. "subtree" is the canvas's layoutsubtree
   * attribute, "sheet" the painter's sheet inside it, "live" the live layer,
   * "chrome" everything on the page but the canvas and the live layer.
   */
  diagnose: (part: "subtree" | "sheet" | "live" | "chrome", on: boolean) => void;
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

export function GpuCanvas({ nodeTypes, edgeTypes, defaultEdgeOptions, headers, wheelZooms, editing, children, flowChildren }: GpuCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  // Filled by the live flow as it mounts, read by the engine.
  const [liveConnection] = useState<LiveConnection>(() => ({}));
  const connectLive = useCallback((part: LiveConnection) => void Object.assign(liveConnection, part), [liveConnection]);
  const liveViewChanged = useCallback((view: View) => liveConnection.viewChanged?.(view), [liveConnection]);
  const [initialView] = useState(() => useWorkflowStore.getState().canvasViewport ?? { x: 0, y: 0, zoom: 1 });
  const types = useMemo(() => boundedNodeTypes(nodeTypes), [nodeTypes]);
  const [loading, setLoading] = useState<Loading | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // The latest props, read by the engine without rebuilding it.
  const propsRef = useRef({ headers, wheelZooms, editing });
  useLayoutEffect(() => {
    propsRef.current = { headers, wheelZooms, editing };
  });
  const loadCount = useWorkflowStore((state) => state.workflowLoadCount);
  const onEdgesChange = useWorkflowStore((state) => state.onEdgesChange);
  const engineRef = useRef<{ painter: Painter | null; scene: Scene } | null>(null);

  useEffect(() => {
    const host = hostRef.current, canvas = canvasRef.current, liveElement = liveRef.current;
    if (!host || !canvas || !liveElement) return;
    // Today's canvas sets this from its zoom; nodes here are never at low detail.
    setZoomedOut(false);
    const stats = new GpuCanvasStats();
    stats.observeLongFrames();
    const store = useWorkflowStore.getState();
    const graph = new SceneGraph(store.nodes, store.edges, store.groups);
    // Held while the user navigates, as today's canvas does, so work that
    // waits for a quiet canvas (the desktop recovery checkpoint) waits for it.
    const interacting = createPanActivityTracker({
      setActive: (active) => document.documentElement.classList.toggle("canvas-interacting", active),
      endDelayMs: 300,
    });
    let scene: Scene;
    try {
      scene = new Scene(canvas, graph, {
        onFrame: (now, jsMs) => stats.frame(now, jsMs),
        onFailure: reportGpuCanvasFailure,
        onInputLatency: (ms) => stats.record("input.latencyMs", ms),
        onInput: () => interacting.signal(),
        wheelZooms: (event) => propsRef.current.wheelZooms(event),
        onHover: (i) => live.wantOnly("hover", i >= 0 ? [scene.graph.nodes[i].id] : []),
        onPress: (event) => editor.press(event),
        onIdleMove: (event) => editor.idleMove(event),
        onContextMenu: (event) => editor.contextMenu(event),
        onOpen: (i) => open(scene.graph.nodes[i].id),
        onPaneDoubleClick: (_x, _y, screen) => editor.paneDoubleClick(screen),
        routeEdge: (e) => {
          const state = useWorkflowStore.getState();
          return routeSceneEdge(graph, e, { style: state.edgeStyle, appearance: state.edgeAppearance, edges: state.edges, nodes: state.nodes, thicknessPx: EDGE_THICKNESS_PX[state.edgeAppearance.thickness] });
        },
        onViewChange: (view) => live.setView(view),
      });
    } catch (error) {
      // WebGL2 is unavailable: say so instead of an empty canvas.
      const message = error instanceof Error ? error.message : String(error);
      queueMicrotask(() => setFailure(message));
      return;
    }
    // Chrome over the scene drops its backdrop blur (globals.css).
    document.documentElement.toggleAttribute("data-gpu-canvas-active", true);
    // The latest header props, read when used; spreadable, so a render takes them as they are then.
    const headerProxy: HeaderProps = new Proxy({} as HeaderProps, {
      get: (_, key: keyof HeaderProps) => propsRef.current.headers[key],
      ownKeys: () => Reflect.ownKeys(propsRef.current.headers),
      getOwnPropertyDescriptor: (_, key) => ({ value: propsRef.current.headers[key as keyof HeaderProps], enumerable: true, configurable: true, writable: false }),
    });
    const live = new LiveLayer(liveElement, liveConnection, scene, stats);
    const editor = new Editor(scene, live, host, () => propsRef.current.editing);
    // The routes above read the store: compute them now that the scene exists.
    scene.setEdgeAppearance(store.edgeAppearance.gradient, store.edgeAppearance.fadedOpacity);
    scene.rerouteAll();
    live.setView(scene.view);

    const gl = scene.renderer.getContext() as WebGL2RenderingContext;
    const htmlInCanvas = detectHtmlInCanvas().available;
    const budget = htmlInCanvas ? atlasBudget(readGpuInfo(gl)) : null;
    const painter = budget ? new Painter(scene, { nodeTypes: types, headers: headerProxy, budget, cache: openPaintStore(), salt: APP_VERSION, stats }) : null;
    live.painter = painter;
    engineRef.current = { painter, scene };

    // Selected nodes are live; store selection follows clicks.
    const selectedIds = new Set(store.nodes.filter((n) => n.selected).map((n) => n.id));
    const showSelection = () => {
      scene.setSelected([...selectedIds].map((id) => scene.graph.indexOf.get(id)).filter((i): i is number => i != null));
      live.wantOnly("selected", selectedIds);
    };
    showSelection();
    function open(id: string) {
      editor.selectNodes([id], false);
      const i = scene.graph.indexOf.get(id);
      if (i == null) return;
      const n = scene.graph.nodes[i];
      const zoom = Math.max(scene.view.zoom, 0.75);
      const { clientWidth: w, clientHeight: h } = scene.canvas;
      scene.setView({ zoom, x: w / 2 - (n.x + n.w / 2) * zoom, y: h / 2 - (n.y + n.h / 2) * zoom });
    }

    // Store changes reach the graph, the scene, the painter and the live layer.
    const unsubscribeNodes = subscribeToWorkflowNodeChanges((changes) => {
      const state = useWorkflowStore.getState();
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
      } else {
        if (moved.length) scene.nodesMoved(moved);
        // What a node's connections show can follow its data (a run's loading pulse, a bundle's clamp).
        const edges = new Set<number>();
        for (const id of changes.updated) for (const e of scene.graph.edgesOf[scene.graph.indexOf.get(id) ?? -1] ?? []) edges.add(e);
        if (edges.size) scene.reroute(edges);
      }
      showSelection();
      showLiveEdges();
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
      if (scene.view.zoom >= LIVE_EDGE_ZOOM) {
        const w = scene.canvas.clientWidth, h = scene.canvas.clientHeight;
        const a = scene.toWorld(-w * 0.25, -h * 0.25), b = scene.toWorld(w * 1.25, h * 1.25);
        let count = 0;
        for (const e of scene.edgesWithin(a.x, a.y, b.x, b.y)) {
          if (count >= MAX_LIVE_EDGES) break;
          const edge = scene.graph.edges[e];
          if (!scene.edgeRoute(e)?.decorated || edge.edge.selected) continue;
          ids.push(edge.id);
          count++;
        }
      }
      const key = ids.join("\n");
      if (key === liveEdgesKey && edges === liveEdgesSource) return;
      liveEdgesKey = key;
      liveEdgesSource = edges;
      live.setEdges(ids);
    };
    showLiveEdges();
    const unsubscribeStore = useWorkflowStore.subscribe((state, previous) => {
      if (state.edgeAppearance !== previous.edgeAppearance) scene.setEdgeAppearance(state.edgeAppearance.gradient, state.edgeAppearance.fadedOpacity);
      if (state.edgeStyle !== previous.edgeStyle || state.edgeAppearance.thickness !== previous.edgeAppearance.thickness || state.edgeAppearance.loadingPulse !== previous.edgeAppearance.loadingPulse) scene.rerouteAll();
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
    });

    // Above 100% every visible node is live, once the view settles; the view is kept for the tab.
    let settleTimer = 0;
    const unsubscribeView = scene.onViewChanged(() => {
      clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        const visible = scene.view.zoom > LIVE_ZOOM ? scene.visible(0).map((i) => scene.graph.nodes[i].id) : [];
        showLiveEdges();
        live.wantOnly("zoom", visible);
        useWorkflowStore.getState().setCanvasViewport({ ...scene.view });
      }, 120);
    });

    setGpuCanvasBridge({
      graph: () => scene.graph,
      view: () => scene.view,
      size: () => ({ width: scene.canvas.clientWidth, height: scene.canvas.clientHeight }),
      setView: (view) => scene.setView(view),
      fit: () => scene.fit(),
      subscribe: (listener) => {
        const offView = scene.onViewChanged(listener), offLayout = scene.onLayoutChanged(listener);
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
        const n = scene.graph.nodes[i], a = scene.toScreen(n.x - PAD, n.y - HEADER), z = scene.view.zoom;
        return { x: a.x, y: a.y, width: (n.w + PAD * 2) * z, height: (n.h + HEADER + PAD) * z };
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
    function diagnose(part: "subtree" | "sheet" | "live" | "chrome", on: boolean) {
      if (part === "subtree") canvas!.toggleAttribute("layoutsubtree", on);
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
      document.documentElement.toggleAttribute("data-gpu-canvas-active", false);
      clearTimeout(settleTimer);
      unsubscribeNodes();
      unsubscribeStore();
      unsubscribeView();
      engineRef.current = null;
      if (window.__gpuCanvas?.stats === stats) delete window.__gpuCanvas;
      interacting.dispose();
      setGpuCanvasBridge(null);
      editor.dispose();
      stats.dispose();
      live.dispose();
      painter?.dispose();
      scene.dispose();
    };
    // The engine is built once per mount; props it needs later are read through propsRef.
  }, [types, liveConnection]);

  // A workflow opened (or the canvas mounted): the tab's view, else the graph framed as today's
  // canvas frames it; painting starts over from the view, behind the loading screen when large.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const { scene, painter } = engine;
    const saved = useWorkflowStore.getState().canvasViewport;
    if (saved && saved.zoom > 0) scene.setView(saved);
    else {
      const framed = frameLoadedGraph(scene.graph.nodes.map((n) => ({ x: n.x, y: n.y, width: n.w, height: n.h })), scene.canvas.clientWidth, scene.canvas.clientHeight);
      if (framed) {
        scene.setView(framed);
        useWorkflowStore.getState().setCanvasViewport(framed);
      }
    }
    painter?.start();
    if (!painter || painter.status.total < LOADING_MIN_NODES) return;
    const done = () => painter.status.screenfulDone && painter.status.painted >= painter.status.total;
    let shown = false;
    const timer = window.setTimeout(() => {
      if (done()) return;
      shown = true;
      painter.setLoading(true);
      setLoading({ painted: painter.status.painted, total: painter.status.total });
    }, LOADING_DELAY_MS);
    painter.setStatusListener(() => {
      if (!shown) return;
      if (done()) {
        shown = false;
        painter.setLoading(false);
        setLoading(null);
      } else setLoading({ painted: painter.status.painted, total: painter.status.total });
    });
    return () => {
      clearTimeout(timer);
      painter.setStatusListener(() => {});
      if (shown) painter.setLoading(false);
      setLoading(null);
    };
  }, [loadCount, types]);

  return (
    <div ref={hostRef} className="absolute inset-0 overflow-hidden bg-neutral-900" data-gpu-canvas="">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none" />
      <div ref={liveRef} data-gpu-canvas-live="" className="pointer-events-none absolute inset-0 overflow-hidden">
        <LiveFlow connect={connectLive} onViewChanged={liveViewChanged} initialView={initialView} nodeTypes={types} edgeTypes={edgeTypes} defaultEdgeOptions={defaultEdgeOptions}
          onEdgesChange={onEdgesChange} headers={headers}>
          {flowChildren}
        </LiveFlow>
      </div>
      {children}
      {loading && <LoadingScreen painted={loading.painted} total={loading.total} />}
      {failure && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-400">
          The GPU canvas could not start: {failure}. Turn it off in Settings › Canvas.
        </div>
      )}
    </div>
  );
}

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
