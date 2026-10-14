/**
 * The painter: paints real node components into the atlas with
 * HTML-in-Canvas, nearest the view first, and keeps them up to date as the
 * workflow store changes.
 *
 * A batch is one tier: render a sheet of real nodes (PainterSheet) at that
 * tier's zoom, wait for React Flow to measure them and their images to
 * decode, pack them by their measured size, paint the sheet into a staging
 * texture in one call, then copy each node's rectangle into its atlas slot.
 * Images found in the disk cache skip the sheet: they are uploaded straight
 * into their slot.
 *
 * Painting gives way to input. No batch starts during a pan or within
 * QUIET_MS of the last wheel or pointer move, and a batch whose sheet is
 * ready when input arrives is put back rather than painted: on the Mac, one
 * full-screen sheet upload stalled the GPU for 106 ms just as a pan began.
 * Sheets are also capped in device pixels, so one upload stays small at 2×.
 * Behind the loading screen nobody can pan, so the painter uses larger
 * sheets and does not wait.
 *
 * What a node's image depends on is its paint key (paintKey.ts). The painter
 * recomputes the keys of the nodes a store change touched (and the nodes
 * they feed) a frame later, off the typing path, and repaints those whose
 * key changed. Moving or selecting a node never repaints it. What of a run
 * a node shows (its running outline) is marked on its key apart from that
 * (runMark): a run starting repaints the nodes near the view that show it at
 * once, and the rest as they come into view.
 */
import * as THREE from "three";
import type { NodeTypes } from "@xyflow/react";
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "@/store/workflowStore";
import { indexOfNode, type NodeChanges } from "@/store/nodeChanges";
import { useNodeUiStore } from "@/store/nodeUiStore";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import type { Scene } from "@/lib/gpuCanvas/scene";
import { controlsOverhang, measuredChanges, type HandleAnchor, type SceneNode } from "@/lib/gpuCanvas/graph";
import { PaintedAtlas, type BlitItem } from "@/lib/gpuCanvas/atlas";
import type { Slot } from "@/lib/gpuCanvas/atlasLayout";
import type { AtlasBudget } from "@/lib/gpuCanvas/budget";
import { enableLayoutSubtree, paintElement } from "@/lib/gpuCanvas/htmlInCanvas";
import { edgesByNode, READS_RUN_IN_PROGRESS, runMark, upstreamPaintKeys, withRunMark, type RunState } from "@/lib/gpuCanvas/paintKey";
import { BACKGROUND, EIGHTH, PREFETCH, PaintQueue, URGENT, VIEW, packSheet, tierToShow, tiersFor, wantedTier, type PaintRequest } from "@/lib/gpuCanvas/paintQueue";
import { cachedHandle, cacheKey, deflate, handleFromCache, inflate, PAINT_CACHE_BYTES, PAINT_CACHE_FORMAT, type CachedHandle, type PaintStore } from "@/lib/gpuCanvas/paintCache";
import type { GpuCanvasStats } from "@/lib/gpuCanvas/stats";
import { HEADER_HINTLESS_TYPES as HINTLESS_TYPES } from "@/components/nodes/FloatingNodeHeaders";
import { SCRUB_ROW_NODE_TYPES } from "@/components/nodes/ui/ScrubRow";
import { soundAudible, useVideoSoundStore } from "@/store/videoSoundStore";
import { PainterSheet } from "./PainterSheet";
import { controlsOverhangBox, flowNode, HEADER, nextFrame, noop, PAD, PAD_X, handleAnchors, mediaCardBox, scrollAreaBoxes, type HeaderProps, type ScrollArea } from "./nodeSheets";

/** A sheet's size in device pixels while the canvas is in use: one upload is about 12 MB. */
const SHEET_TEXELS = { w: 2048, h: 1536 };
/** Behind the loading screen nobody pans, so sheets are four times larger. */
const LOADING_SHEET_TEXELS = { w: 4096, h: 3072 };
/** No batch starts until the pointer and wheel have been still this long. */
const QUIET_MS = 120;
/** Space between nodes on the sheet, in css px. */
const GAP_PX = 4;
/** The view's tiers are chosen this long after it stops moving. */
const VIEW_SETTLE_MS = 50;
/** Nodes this far outside the view (in screens) are painted ahead and kept from eviction. */
const MARGIN = 0.25;
/**
 * Nodes per batch. Each batch costs a few frames of settling whatever its
 * size, so a jump at 25% (about 170 nodes) goes in two batches rather than
 * four. Not more: committing 192 nodes held the page for 300 ms a batch, and
 * the 1/8 paints of a whole graph got slower, not faster.
 */
const maxBatch = (tier: number, priority: number) => (priority === PREFETCH ? PREFETCH_BATCH : tier === 0.25 ? 96 : 48);
/** Painting for the disk cache goes in small batches, so a change never waits long behind one. */
const PREFETCH_BATCH = 8;
/** The zoom whose tier every node is painted at for the disk cache. */
const PREFETCH_ZOOM = 0.25;
/** How long a batch waits for its images and sizes; a node whose image is still loading is painted provisionally and again later. */
const SETTLE_MS = 1500, LOADING_SETTLE_MS = 5000;
/** Times a node painted before its images loaded is painted again. */
const MAX_PROVISIONAL_REPAINTS = 3;
/** Cache uploads per frame, in texels, so a cache hit never stalls a frame either. */
const UPLOAD_TEXELS_PER_FRAME = 2048 * 1024;

interface HeldImage {
  slot: Slot;
  /** The paint key it was painted for. */
  key: string;
  /** Its size in flow units (node, header and margins). */
  w: number;
  h: number;
  /** Where the node starts within it: the side margin, and a controls card's overhang (controlsOverhang). */
  left: number;
}

interface NodePaint {
  images: Map<number, HeldImage>;
  /** The node's measured height, in flow units. */
  height?: number;
  /** Its handles' anchors as painting measured them. */
  handles?: Map<string, HandleAnchor>;
  /** The node's width when they were measured (the scene's own when not known). */
  handlesWidth?: number;
  /** Its media card's and controls card's boxes as painting measured them. */
  card?: SceneNode["card"];
  overhang?: SceneNode["overhang"];
  /** Its inner areas that scroll (scrollAreaBoxes), as painting measured them. */
  scroll?: ScrollArea[];
  shown?: HeldImage;
  lastSeen: number;
}

interface Readback {
  buffer: WebGLBuffer;
  sync: WebGLSync;
  entries: { key: string; offset: number; width: number; height: number; nodeHeight: number; handles: CachedHandle[]; card: [number, number, number, number] | null; overhang: [number, number, number, number] | null; scroll: [number, number, number, number, number][] }[];
  bytes: number;
}

export interface PainterStatus {
  running: boolean;
  queued: number;
  /** Nodes with at least their 1/8 image, of all nodes. */
  painted: number;
  total: number;
  /** Every node that was in view when painting started is as sharp as the view needs. */
  screenfulDone: boolean;
  screenfulMs: number | null;
  allMs: number | null;
  batches: number;
  cacheHits: number;
  evicted: number;
  atlasFull: boolean;
  atlasLayers: number;
  atlasMB: number;
}

export interface PainterOptions {
  nodeTypes: NodeTypes;
  headers: HeaderProps;
  budget: AtlasBudget;
  cache: PaintStore | null;
  /** Anything outside the graph that changes how nodes look (app version). */
  salt: string;
  stats: GpuCanvasStats;
}

const NO_HEADERS: HeaderProps = {
  getNodeTitle: () => "",
  onCustomTitleChange: noop,
  onCommentChange: noop,
  onRunNode: noop,
  onExpandNode: noop,
  onBrowse: noop,
  onToggleOptional: noop,
  onOpenFallback: noop,
};

export class Painter {
  readonly atlas: PaintedAtlas;
  readonly tiers: number[];
  readonly status: PainterStatus;
  private sheet: PainterSheet;
  private staging = new THREE.Texture();
  private stagingGl: WebGLTexture;
  private paints = new Map<string, NodePaint>();
  /** Each node's current paint key, with its run mark. */
  private keys = new Map<string, string>();
  /** Each node's key without its run mark: what the nodes it feeds take in. */
  private baseKeys = new Map<string, string>();
  private runState: RunState = { isRunning: false, currentNodeIds: [] };
  /** The readiness hint each node's header shows ("needs a prompt"), as WorkflowCanvas last worked them out. */
  private hints: Record<string, string>;
  private queue = new PaintQueue();
  private running = false;
  private startedAt = 0;
  private screenful = new Set<string>();
  private near = new Set<string>();
  private viewTimer = 0;
  private keyFrame = 0;
  private dirtyKeys = new Set<string>();
  private dirtySince = 0;
  /** Stale only because something upstream changed: timed apart from the nodes that changed. */
  private downstream = new Set<string>();
  /** Nodes to paint again whatever the disk cache holds. */
  private uncached = new Set<string>();
  /** Nodes last painted before their images loaded, and how many times in a row. */
  private provisional = new Map<string, number>();
  private unplacedRetries = 0;
  /** Nodes whose sheet state is recorded when painted (for a runner diagnosing a mismatch). */
  readonly probeIds = new Set<string>();
  readonly probeLog: Record<string, unknown>[] = [];
  /** A sheet size to switch to when the next batch starts. */
  private sheetSize: { width: number; height: number } | null = null;
  private unsubscribers: (() => void)[] = [];
  private waiters = new Map<string, (() => void)[]>();
  private readbacks: Readback[] = [];
  private readbackFrame = 0;
  private loading = false;
  private storedSinceTrim = 0;
  private disposed = false;
  /** Nodes measured since the store last heard their sizes. */
  private measuredIds = new Set<string>();
  private onStatus: () => void = noop;

  constructor(private scene: Scene, private options: PainterOptions) {
    enableLayoutSubtree(scene.canvas);
    this.tiers = tiersFor(scene.scale);
    this.hints = options.headers.hints ?? {};
    // A getter: the sheet spreads the headers on every batch, and takes the hints as they are then.
    const hints = () => this.hints;
    const headers: HeaderProps = { ...NO_HEADERS, getNodeTitle: options.headers.getNodeTitle, get hints() { return hints(); } };
    this.sheet = new PainterSheet(scene.canvas, SHEET_TEXELS.w / scene.scale, SHEET_TEXELS.h / scene.scale, options.nodeTypes, headers);
    this.atlas = new PaintedAtlas(scene.renderer, options.budget.layerSize, options.budget.layers);
    scene.setPaintedAtlas(this.atlas.target.texture);
    this.status = {
      running: false, queued: 0, painted: 0, total: scene.graph.nodes.length, screenfulDone: false, screenfulMs: null, allMs: null,
      batches: 0, cacheHits: 0, evicted: 0, atlasFull: false, atlasLayers: 0, atlasMB: Math.round(this.atlas.bytes / 2 ** 20),
    };
    // The staging texture is ours; three only binds it for the blit.
    const gl = this.gl;
    this.stagingGl = gl.createTexture()!;
    const props = scene.renderer.properties.get(this.staging) as { __webglTexture?: WebGLTexture; __webglInit?: boolean };
    props.__webglTexture = this.stagingGl;
    props.__webglInit = true;

    this.unsubscribers.push(scene.onViewChanged(() => {
      clearTimeout(this.viewTimer);
      if (this.startedAt) this.viewTimer = window.setTimeout(() => this.refreshView(), VIEW_SETTLE_MS);
    }));
    this.unsubscribers.push(subscribeToWorkflowNodeChanges((changes) => this.nodesChanged(changes)));
    this.unsubscribers.push(useWorkflowStore.subscribe((state, previous) => {
      if (state.edges !== previous.edges) this.edgesChanged(previous.edges, state.edges);
      if (state.isRunning !== previous.isRunning || state.currentNodeIds !== previous.currentNodeIds) this.runChanged(state);
    }));
    // A node's view state (a collapsed card, a settings tab) is painted as the live node shows it.
    this.unsubscribers.push(useNodeUiStore.subscribe((state, previous) => {
      if (state.byNode === previous.byNode) return;
      this.rekey([...new Set([...Object.keys(previous.byNode), ...Object.keys(state.byNode)])].filter((id) => previous.byNode[id] !== state.byNode[id]));
    }));
    // The video players' sound button shows the shared setting: their nodes are painted again as it turns.
    this.unsubscribers.push(useVideoSoundStore.subscribe((state, previous) => {
      if (soundAudible(state) === soundAudible(previous)) return;
      this.rekey(useWorkflowStore.getState().nodes.filter((n) => SCRUB_ROW_NODE_TYPES.has(n.type ?? "")).map((n) => n.id));
    }));
  }

  private get gl() {
    return this.scene.renderer.getContext() as WebGL2RenderingContext;
  }

  /** Called whenever the status changes (for the loading screen). */
  setStatusListener(listener: () => void) {
    this.onStatus = listener;
  }

  /** Larger sheets and no waiting for quiet: nobody can pan behind the loading screen. */
  setLoading(loading: boolean) {
    this.loading = loading;
    const texels = loading ? LOADING_SHEET_TEXELS : SHEET_TEXELS;
    const max = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
    // Applied when the next batch starts: a batch laid out on one size and
    // painted on another would copy the wrong regions.
    this.sheetSize = { width: Math.min(texels.w, max) / this.scene.scale, height: Math.min(texels.h, max) / this.scene.scale };
  }

  /** Paints the view at the tier it needs, then every node at 1/8. Called again when a workflow opens: its timings start over. */
  start() {
    this.startedAt = performance.now();
    Object.assign(this.status, { screenfulDone: false, screenfulMs: null, allMs: null, batches: 0, cacheHits: 0 });
    this.recomputeAllKeys();
    this.screenful = new Set(this.scene.visible(0).map((i) => this.scene.graph.nodes[i].id));
    this.refreshView();
    for (const i of this.byDistance(this.scene.graph.nodes.map((_, i) => i))) this.queue.add(this.scene.graph.nodes[i].id, EIGHTH, BACKGROUND, performance.now());
    this.updateStatus();
    void this.run();
    void this.prefetch();
  }

  /**
   * After the 1/8 pass, paints every node at the tier a 25% view needs, for
   * the disk cache only (the atlas keeps it only for nodes near the view): a
   * jump at that zoom then uploads its images instead of painting a few
   * hundred nodes. Nodes the cache already holds are skipped.
   */
  private async prefetch() {
    const cache = this.options.cache;
    const tier = wantedTier(PREFETCH_ZOOM, this.scene.scale, this.tiers);
    if (!cache || tier === EIGHTH) return;
    let held: Set<string>;
    try {
      held = await cache.keys();
    } catch {
      return;
    }
    if (this.disposed) return;
    const now = performance.now();
    for (const i of this.byDistance(this.scene.graph.nodes.map((_, i) => i))) {
      const id = this.scene.graph.nodes[i].id, key = this.keys.get(id);
      if (key && !held.has(cacheKey(key, tier)) && !this.fresh(id, tier)) this.queue.add(id, tier, PREFETCH, now);
    }
    this.updateStatus();
    void this.run();
  }

  /** The graph was rebuilt: indices moved. Shows what is held for each node again and paints new ones. */
  graphRebuilt() {
    const ids = new Set(this.scene.graph.nodes.map((n) => n.id));
    for (const [id, paint] of this.paints) {
      if (ids.has(id)) continue;
      for (const image of paint.images.values()) this.atlas.layout.release(image.slot);
      this.paints.delete(id);
      this.keys.delete(id);
      this.baseKeys.delete(id);
      this.queue.delete(id);
    }
    this.recomputeAllKeys();
    for (const n of this.scene.graph.nodes) {
      const paint = this.paints.get(n.id);
      if (paint?.height != null) this.scene.setNodeHeight(this.scene.graph.indexOf.get(n.id)!, paint.height);
      this.show(n.id, true);
      if (!paint?.images.has(EIGHTH)) this.queue.add(n.id, EIGHTH, BACKGROUND, performance.now());
    }
    this.status.total = this.scene.graph.nodes.length;
    if (this.startedAt) this.refreshView();
    this.updateStatus();
    void this.run();
  }

  /** Paints a node at the view's tier now (ahead of the queue) and resolves once the scene shows it. */
  /** Whether the scene's image of the node is current at the view's tier (or the node is gone). */
  isFresh(id: string) {
    return !this.scene.graph.indexOf.has(id) || this.fresh(id, this.wanted());
  }

  /**
   * The inner area that scrolls (a long prompt's textarea, a `.nowheel` list) under a point of the node's painted
   * image, in flow units relative to the node; null when none. Classic scrolls it under a wheel; until the node is
   * live, the GPU canvas holds the wheel there rather than moving the view.
   */
  scrollAreaAt(id: string, x: number, y: number): ScrollArea | null {
    return this.paints.get(id)?.scroll?.find((a) => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) ?? null;
  }

  /** Whether a paintNow for the node is still to come: its paint waits in the loop (behind a pan, a long batch). */
  painting(id: string) {
    return this.running && this.waiters.has(id);
  }

  paintNow(id: string): Promise<void> {
    if (!this.startedAt) this.startedAt = performance.now();
    const tier = this.wanted();
    if (this.fresh(id, tier) || !this.scene.graph.indexOf.has(id)) return Promise.resolve();
    const done = new Promise<void>((resolve) => {
      const list = this.waiters.get(id);
      if (list) list.push(resolve);
      else this.waiters.set(id, [resolve]);
    });
    this.queue.add(id, tier, URGENT, performance.now());
    void this.run();
    return done;
  }

  private probe(ids: string[], placed: Map<string, { x: number; y: number }>, tier: number) {
    const sheet = this.sheet.element.getBoundingClientRect();
    const rect = (element: Element) => {
      const r = element.getBoundingClientRect();
      return [r.x - sheet.x, r.y - sheet.y, r.width, r.height].map((v) => Math.round(v * 10) / 10);
    };
    for (const id of ids) {
      // An id, or "type:<node type>" for every node of a type (the first few of each).
      const i = this.scene.graph.indexOf.get(id);
      const type = i == null ? "" : this.scene.graph.nodes[i].type;
      const byType = this.probeIds.has(`type:${type}`) && this.probeLog.filter((e) => e.type === type).length < 6;
      if (!this.probeIds.has(id) && !byType) continue;
      const element = this.sheet.nodeElement(id);
      this.probeLog.push({
        id, type, tier, loading: this.loading, batch: ids.length, index: ids.indexOf(id), sheet: [this.sheet.width, this.sheet.height], placed: placed.get(id),
        transform: element?.style.transform, rect: element ? rect(element) : null, height: element?.offsetHeight,
        children: element ? [...element.querySelectorAll("*")].filter((e) => e.scrollTop || e.scrollLeft).length : null,
        textareas: element ? [...element.querySelectorAll("textarea")].map((t) => ({ length: t.value.length, rect: rect(t), clientHeight: t.clientHeight, scrollHeight: t.scrollHeight, scrollTop: t.scrollTop })) : null,
        images: element ? [...element.querySelectorAll("img")].map((img) => ({ complete: img.complete, natural: [img.naturalWidth, img.naturalHeight], rect: rect(img), src: (img.getAttribute("src") ?? "").slice(0, 60) })) : null,
        hidden: element ? getComputedStyle(element).visibility : null,
      });
    }
  }

  /** Drops a node's images and paints it again on its own (for a runner checking a fresh paint). */
  repaint(id: string): Promise<void> {
    const paint = this.paints.get(id);
    if (paint) {
      for (const image of paint.images.values()) this.atlas.layout.release(image.slot);
      paint.images.clear();
      paint.shown = undefined;
    }
    this.show(id, true);
    this.uncached.add(id);
    return this.paintNow(id);
  }

  /** The smallest tier as sharp as the view's zoom needs. */
  wanted() {
    return wantedTier(this.scene.view.zoom, this.scene.scale, this.tiers);
  }

  /** How many visible nodes are drawn as sharp as the view needs. */
  sharpness() {
    const tier = this.wanted();
    const visible = this.scene.visible(0);
    let sharp = 0;
    for (const i of visible) if ((this.paints.get(this.scene.graph.nodes[i].id)?.shown?.slot.tier ?? 0) >= tier) sharp++;
    return { visible: visible.length, sharp, tier };
  }

  // ---- keys and changes ----

  private keyContext() {
    const { nodes, edges } = useWorkflowStore.getState();
    const byNode = edgesByNode(edges);
    return {
      nodes,
      context: {
        nodeById: (id: string) => {
          const i = indexOfNode(nodes, id);
          return i >= 0 ? nodes[i] : undefined;
        },
        edgesOf: (id: string) => byNode.get(id) ?? [],
        salt: `${this.options.salt}|${this.scene.scale}|${PAINT_CACHE_FORMAT}`,
      },
    };
  }

  /**
   * A node's key: its base key, its run mark, the hint its header shows, its
   * own view state (useNodeUiState) and, for a video player, the sound
   * setting, the last three kept out of the base so they reach no node
   * downstream.
   */
  private fullKey(node: WorkflowNode, base: string) {
    const hint = HINTLESS_TYPES.has(node.type) ? "" : this.hints[node.id] ?? "";
    const ui = useNodeUiStore.getState().byNode[node.id];
    let key = withRunMark(base, runMark(node, this.runState));
    if (hint) key += `|h:${hint}`;
    if (ui) key += `|ui:${JSON.stringify(ui)}`;
    if (SCRUB_ROW_NODE_TYPES.has(node.type ?? "")) key += `|snd:${soundAudible(useVideoSoundStore.getState()) ? 1 : 0}`;
    return key;
  }

  /** Something outside a node's base key changed for these nodes: those whose key did are repainted. */
  private rekey(ids: Iterable<string>) {
    const { nodes } = useWorkflowStore.getState();
    const now = performance.now();
    for (const id of ids) {
      const i = indexOfNode(nodes, id), base = this.baseKeys.get(id);
      if (i < 0 || base == null) continue;
      const key = this.fullKey(nodes[i], base);
      if (this.keys.get(id) === key) continue;
      this.keys.set(id, key);
      this.stale(id, now);
    }
  }

  /** The headers' readiness hints changed: the nodes whose hint did are repainted. */
  hintsChanged(next: Record<string, string>) {
    const previous = this.hints;
    if (next === previous) return;
    this.hints = next;
    this.rekey([...new Set([...Object.keys(previous), ...Object.keys(next)])].filter((id) => previous[id] !== next[id]));
  }

  private recomputeAllKeys() {
    const { nodes, context } = this.keyContext();
    const { isRunning, currentNodeIds } = useWorkflowStore.getState();
    this.runState = { isRunning, currentNodeIds };
    const keyOf = upstreamPaintKeys(context);
    for (const node of nodes) {
      const base = keyOf(node.id)!;
      this.baseKeys.set(node.id, base);
      this.keys.set(node.id, this.fullKey(node, base));
    }
  }

  /**
   * A run started or ended, or moved on to other nodes: the nodes whose run
   * mark changed get their new key. Those the run is on are painted at once;
   * for a run starting or ending, which marks every node of the types that
   * show it, nodes away from the view wait until it comes to them.
   */
  private runChanged(state: RunState) {
    const previous = this.runState;
    this.runState = { isRunning: state.isRunning, currentNodeIds: state.currentNodeIds };
    const { nodes } = useWorkflowStore.getState();
    const before = new Set(previous.currentNodeIds), after = new Set(state.currentNodeIds);
    const urgent = new Set<string>();
    for (const id of before) if (!after.has(id)) urgent.add(id);
    for (const id of after) if (!before.has(id)) urgent.add(id);
    const ids = new Set(urgent);
    if (state.isRunning !== previous.isRunning) for (const node of nodes) if (READS_RUN_IN_PROGRESS.has(node.type)) ids.add(node.id);
    const now = performance.now();
    for (const id of ids) {
      const i = indexOfNode(nodes, id), base = this.baseKeys.get(id);
      if (i < 0 || base == null) continue;
      const key = this.fullKey(nodes[i], base);
      if (this.keys.get(id) === key) continue;
      this.keys.set(id, key);
      this.stale(id, now, !urgent.has(id));
    }
  }

  private nodesChanged(changes: NodeChanges) {
    if (!this.dirtyKeys.size) this.dirtySince = performance.now();
    for (const id of changes.updated) {
      // The painter's own size report changes no paint key: it must not preempt the batch being painted.
      if (this.reportedSizes.delete(id)) continue;
      this.dirtyKeys.add(id);
    }
    for (const id of changes.added) this.dirtyKeys.add(id);
    this.scheduleKeys();
  }

  private edgesChanged(previous: readonly WorkflowEdge[], next: readonly WorkflowEdge[]) {
    const before = new Set(previous);
    const after = new Set(next);
    if (!this.dirtyKeys.size) this.dirtySince = performance.now();
    for (const edge of previous) if (!after.has(edge)) this.dirtyKeys.add(edge.source).add(edge.target);
    for (const edge of next) if (!before.has(edge)) this.dirtyKeys.add(edge.source).add(edge.target);
    this.scheduleKeys();
  }

  /** Keys are recomputed a frame later, off the typing path. */
  private scheduleKeys() {
    if (this.keyFrame || !this.dirtyKeys.size) return;
    this.keyFrame = requestAnimationFrame(() => {
      this.keyFrame = 0;
      const { nodes, context } = this.keyContext();
      const since = this.dirtySince;
      // A node's image shows what feeds it, so everything downstream is dirty
      // too (a Set visits what is added while it is iterated).
      const changed = new Set(this.dirtyKeys);
      const dirty = new Set(this.dirtyKeys);
      this.dirtyKeys.clear();
      for (const id of dirty) for (const edge of context.edgesOf(id)) if (edge.source === id) dirty.add(edge.target);
      const keyOf = upstreamPaintKeys(context, (id) => (dirty.has(id) ? undefined : this.baseKeys.get(id)));
      for (const id of dirty) {
        const i = indexOfNode(nodes, id);
        if (i < 0) continue;
        const base = keyOf(id)!;
        this.baseKeys.set(id, base);
        const key = this.fullKey(nodes[i], base);
        if (this.keys.get(id) === key) continue;
        this.keys.set(id, key);
        if (changed.has(id)) this.downstream.delete(id);
        else this.downstream.add(id);
        this.stale(id, since);
      }
    });
  }

  /**
   * A node's key changed: its images are stale. Repaint what the view shows
   * and the 1/8, and drop the rest. `nearOnly`: a node away from the view is
   * left for refreshView to paint when the view comes to it.
   */
  private stale(id: string, changedAt: number, nearOnly = false) {
    const paint = this.paints.get(id), tier = this.wanted();
    if (paint) {
      for (const [t, image] of paint.images) {
        if (t === tier || t === EIGHTH) continue;
        this.atlas.layout.release(image.slot);
        paint.images.delete(t);
      }
    }
    if (nearOnly && !this.near.has(id)) {
      this.show(id);
      return;
    }
    // Queued as of the store change, so the time to shown counts the frame keys wait for.
    if (this.near.has(id) && tier !== EIGHTH) this.queue.add(id, tier, URGENT, changedAt);
    this.queue.add(id, EIGHTH, URGENT, changedAt);
    this.show(id);
    void this.run();
  }

  // ---- the view ----

  private byDistance(nodes: number[]) {
    const c = this.scene.toWorld(this.scene.canvas.clientWidth / 2, this.scene.canvas.clientHeight / 2);
    const graph = this.scene.graph;
    const d = (i: number) => {
      const n = graph.nodes[i];
      return Math.hypot(n.x + n.w / 2 - c.x, n.y + n.h / 2 - c.y);
    };
    return [...nodes].sort((a, b) => d(a) - d(b));
  }

  /** The view settled: drop requests it no longer needs, ask for its tier, and show each node's best image. */
  private refreshView() {
    const tier = this.wanted(), now = performance.now();
    const graph = this.scene.graph;
    const nearIndices = this.scene.visible(MARGIN);
    this.near = new Set(nearIndices.map((i) => graph.nodes[i].id));
    for (const id of this.near) {
      const paint = this.paint(id);
      paint.lastSeen = now;
    }
    this.queue.filter((r) => r.priority !== VIEW || (r.tier === tier && this.near.has(r.id)));
    for (const i of this.byDistance(nearIndices)) {
      const id = graph.nodes[i].id;
      if (!this.fresh(id, tier)) this.queue.add(id, tier, VIEW, now);
    }
    for (const n of graph.nodes) this.show(n.id);
    this.updateStatus();
    void this.run();
  }

  private paint(id: string): NodePaint {
    let paint = this.paints.get(id);
    if (!paint) {
      paint = { images: new Map(), lastSeen: 0 };
      this.paints.set(id, paint);
    }
    return paint;
  }

  /** The node holds an image of this tier painted for its current key. */
  private fresh(id: string, tier: number) {
    const image = this.paints.get(id)?.images.get(tier);
    return !!image && image.key === this.keys.get(id);
  }

  // ---- the loop ----

  private async run() {
    if (this.running || !this.startedAt || this.disposed) return;
    this.running = this.status.running = true;
    try {
      while (this.queue.size && !this.disposed) {
        if (!this.loading) {
          while ((this.scene.interacting || performance.now() - this.scene.lastInputAt < QUIET_MS) && !this.disposed) await nextFrame();
        }
        // A change's keys come a frame after it: don't start other work in that frame.
        while (this.dirtyKeys.size && !this.disposed) await nextFrame();
        await this.batch();
        this.phase("between batches");
        await nextFrame();
      }
    } finally {
      this.phase("idle");
      this.running = this.status.running = false;
      this.updateStatus();
    }
  }

  /** Names what the painter is doing, for a long frame's record. */
  private phase(name: string) {
    this.options.stats.phase = name;
  }

  /**
   * A node's image box: the node with its header and margins, widened each side by a controls card that
   * reaches past it (as classic shows it, overflowing the node); `left` is where the node starts within it.
   */
  private boxOf(id: string) {
    const i = this.scene.graph.indexOf.get(id);
    const n = i == null ? undefined : this.scene.graph.nodes[i];
    const height = this.paints.get(id)?.height ?? (n ? n.h : 300);
    const nodes = useWorkflowStore.getState().nodes, k = indexOfNode(nodes, id);
    const w = n?.w ?? 300, left = PAD_X + (k >= 0 ? controlsOverhang(nodes[k].data, w) : 0);
    return { w: w + left * 2, h: height + HEADER + PAD, left };
  }

  private sheetFlowSize(zoom: number) {
    return { width: this.sheet.width / zoom, height: this.sheet.height / zoom, gap: GAP_PX / zoom };
  }

  private async batch() {
    const t0 = performance.now();
    if (this.sheetSize) {
      this.sheet.resize(this.sheetSize.width, this.sheetSize.height);
      this.sheetSize = null;
    }
    // Take a tier's worth that fits on one sheet by estimated size; requests for nodes that left the graph are dropped.
    const zoomOf = (tier: number) => tier / this.scene.scale;
    const taken = this.queue.take(maxBatch, (request, taken) => {
      if (!this.scene.graph.indexOf.has(request.id) || this.fresh(request.id, request.tier)) return true;
      const sheet = this.sheetFlowSize(zoomOf(request.tier));
      const boxes = [...taken, request].filter((r) => this.scene.graph.indexOf.has(r.id)).map((r) => ({ key: r.id, ...this.boxOf(r.id) }));
      return packSheet(boxes, sheet.width, sheet.height, sheet.gap).size === boxes.length;
    });
    const requests = taken.filter((r) => this.scene.graph.indexOf.has(r.id) && !this.fresh(r.id, r.tier));
    // Nothing to paint for the rest (gone, or current already): whoever waits on them can go on.
    this.resolveWaiters(taken.filter((r) => !requests.includes(r)));
    this.status.queued = this.queue.size;
    if (!requests.length) return;
    const tier = requests[0].tier, zoom = zoomOf(tier);

    // Images the disk cache holds go straight in.
    this.phase(`cache ${tier}`);
    const misses = await this.fromCache(requests);
    this.resolveWaiters(requests.filter((r) => !misses.includes(r)));
    if (this.disposed || !misses.length) {
      this.afterBatch(requests.filter((r) => !misses.includes(r)), t0);
      return;
    }

    const sheet = this.sheetFlowSize(zoom);
    const store = useWorkflowStore.getState();
    const sourceOf = (id: string) => {
      const i = indexOfNode(store.nodes, id);
      return i >= 0 ? store.nodes[i] : undefined;
    };
    const place = (list: PaintRequest[], heights: (id: string) => number) =>
      packSheet(list.map((r) => ({ key: r.id, w: this.boxOf(r.id).w, h: heights(r.id) + HEADER + PAD })), sheet.width, sheet.height, sheet.gap);
    const sheetNodes = (list: PaintRequest[], placed: Map<string, { x: number; y: number }>) => list.flatMap((r) => {
      const node = sourceOf(r.id), at = placed.get(r.id), n = this.scene.graph.nodes[this.scene.graph.indexOf.get(r.id)!];
      return node && at && n ? [flowNode(node, at.x + this.boxOf(r.id).left, at.y + HEADER, n.w)] : [];
    });

    // First pass at estimated heights, to measure.
    const first = place(misses, (id) => this.boxOf(id).h - HEADER - PAD);
    // The key each node is drawn for: the sheet reads node data and header hints as it renders, and an urgent
    // batch does not give way to a change after that, so its image is stamped with this key, not the one current
    // at the blit. A change meanwhile leaves the image stale, and the repaint stale() queued still runs.
    const renderedKeys = new Map(misses.map((r) => [r.id, this.keys.get(r.id) ?? ""]));
    this.phase(`render ${tier} ×${misses.length}`);
    await this.sheet.render(sheetNodes(misses, first), zoom);
    const t1 = performance.now();
    // Input, or a change to paint, arrived while the sheet was getting ready: give way.
    const urgentBatch = requests[0].priority === URGENT;
    // A change whose keys are still to be worked out (a frame after the store change) counts as urgent.
    const yielded = () => (!this.loading && this.scene.lastInputAt > t0) || (!urgentBatch && (this.queue.hasUrgent() || this.dirtyKeys.size > 0));
    if (yielded()) {
      this.queue.restore(misses);
      this.options.stats.record(this.scene.lastInputAt > t0 ? "painter.yielded" : "painter.preempted", misses.length);
      return;
    }
    this.phase(`settle ${tier} ×${misses.length}`);
    const { decodeMs, unloaded } = await this.sheet.settle(misses.map((r) => r.id), this.loading ? LOADING_SETTLE_MS : SETTLE_MS, () => this.disposed || yielded());
    const t2 = performance.now();
    for (const r of misses) {
      const element = this.sheet.nodeElement(r.id);
      if (element) this.paint(r.id).height = element.offsetHeight;
    }
    // Second pass at measured heights; nodes that no longer fit wait for the next sheet.
    const placed = place(misses, (id) => this.paints.get(id)?.height ?? this.boxOf(id).h);
    const fits = misses.filter((r) => placed.has(r.id));
    this.queue.restore(misses.filter((r) => !placed.has(r.id)));
    const moved = fits.some((r) => {
      const a = first.get(r.id), b = placed.get(r.id)!;
      return !a || a.x !== b.x || a.y !== b.y;
    });
    this.phase(`place ${tier} ×${fits.length}`);
    if (moved || fits.length !== misses.length) {
      for (const r of fits) renderedKeys.set(r.id, this.keys.get(r.id) ?? "");
      await this.sheet.render(sheetNodes(fits, placed), zoom);
    }
    const nodePositions = new Map(fits.map((r) => {
      const p = placed.get(r.id)!;
      return [r.id, { x: p.x + this.boxOf(r.id).left, y: p.y + HEADER }];
    }));
    const inPlace = await this.sheet.positioned(nodePositions, 2000, () => this.disposed || yielded());
    if (this.disposed) return;
    if (!inPlace && !yielded() && this.unplacedRetries < 2) {
      // Still elsewhere: painting now would misplace it. Try again (twice, then paint what is there).
      this.unplacedRetries++;
      this.queue.restore(fits);
      this.options.stats.record("painter.unplaced", fits.length);
      return;
    }
    this.unplacedRetries = 0;
    if (yielded()) {
      this.queue.restore(misses);
      this.options.stats.record(this.scene.lastInputAt > t0 ? "painter.yielded" : "painter.preempted", misses.length);
      return;
    }
    const scrolled = this.sheet.resetScroll();
    if (scrolled) this.options.stats.record("painter.scrollReset", scrolled);
    // The sheet is painted from its last rendering, not its DOM: let a frame
    // render what the DOM now holds (the second placement, the reset scroll),
    // or the copy shows the first placement or the previous batch.
    this.phase(`frames ${tier} ×${fits.length}`);
    await nextFrame();
    await nextFrame();
    if (this.disposed) return;
    if (yielded()) {
      this.queue.restore(misses);
      this.options.stats.record(this.scene.lastInputAt > t0 ? "painter.yielded" : "painter.preempted", misses.length);
      return;
    }
    if (this.probeIds.size) this.probe(fits.map((r) => r.id), placed, tier);
    const t3 = performance.now();
    this.phase(`paint ${tier} ×${fits.length}`);

    // Paint the sheet into the staging texture.
    const renderer = this.scene.renderer;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.stagingGl);
    paintElement(gl, this.sheet.element);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    renderer.resetState();
    const t4 = performance.now();

    // Copy each node into its slot. The texture is the sheet's css size times
    // the backing scale; a flow unit on the sheet is `tier` texels.
    const scale = this.scene.scale;
    const staging = { width: this.sheet.width * scale, height: this.sheet.height * scale };
    const flow = this.sheet.flow();
    const items: BlitItem[] = [], done: PaintRequest[] = [];
    for (const r of fits) {
      const p = placed.get(r.id)!, paint = this.paint(r.id), box = this.boxOf(r.id);
      const src = { x: p.x * tier, y: p.y * tier, w: box.w * tier, h: box.h * tier };
      const slot = this.slotFor(r.id, tier, Math.ceil(box.w * tier), Math.ceil(box.h * tier), r.priority !== PREFETCH);
      if (!slot) continue;
      paint.images.set(tier, { slot, key: renderedKeys.get(r.id) ?? "", w: box.w, h: box.h, left: box.left });
      const handles = flow ? handleAnchors(flow, r.id, this.sheet.element) : undefined;
      paint.scroll = scrollAreaBoxes(this.sheet.element, r.id);
      this.applyMeasured(r.id, paint.height!, handles, mediaCardBox(this.sheet.element, r.id), flow?.nodeLookup.get(r.id)?.measured.width, controlsOverhangBox(this.sheet.element, r.id));
      items.push({ src, dst: slot });
      done.push(r);
    }
    this.atlas.blit(this.staging, staging, items);
    renderer.resetState();
    for (const r of done) this.show(r.id, true);
    const t5 = performance.now();
    // A node whose image had not loaded is shown as painted, kept out of the
    // disk cache, and painted again later (a few times at most).
    const provisional = done.filter((r) => unloaded.has(r.id));
    for (const r of provisional) {
      const tries = (this.provisional.get(r.id) ?? 0) + 1;
      this.provisional.set(r.id, tries);
      if (tries <= MAX_PROVISIONAL_REPAINTS) this.queue.add(r.id, r.tier, Math.max(BACKGROUND, r.priority), performance.now());
    }
    for (const r of done) if (!unloaded.has(r.id)) this.provisional.delete(r.id);
    if (provisional.length) this.options.stats.record("painter.provisional", provisional.length);
    this.phase(`readback ${tier} ×${done.length}`);
    if (this.options.cache) this.readBack(provisional.length ? done.filter((r) => !unloaded.has(r.id)) : done);
    // Painted for the disk cache: the atlas keeps only what is near the view.
    // (The read-back is queued on the GPU ahead of anything that reuses the slots.)
    for (const r of done) if (r.priority === PREFETCH && !this.near.has(r.id) && r.tier !== this.wanted()) this.drop(r.id, r.tier);

    const { stats } = this.options;
    stats.record("painter.nodesPerBatch", done.length);
    stats.record("painter.renderMs", t1 - t0);
    stats.record("painter.settleMs", t2 - t1 - decodeMs);
    stats.record("painter.decodeMs", decodeMs);
    stats.record("painter.repackMs", t3 - t2);
    stats.record("painter.paintMs", t4 - t3);
    stats.record("painter.blitMs", t5 - t4);
    stats.record("painter.batchMs", t5 - t0);
    this.status.batches++;
    this.afterBatch(done, t0);
  }

  /**
   * The node's measured height and handles reach the scene (its edges move to them). A live node (its painted copy
   * hidden) keeps the box React Flow measures for it, as on classic, where the DOM is the node: they are only held,
   * and reach the scene when it goes back to its painted image (restoreMeasured).
   */
  private applyMeasured(id: string, height: number, handles?: Map<string, HandleAnchor>, card?: SceneNode["card"], width?: number, overhang?: SceneNode["overhang"]) {
    const i = this.scene.graph.indexOf.get(id);
    if (i == null) return;
    const paint = this.paint(id);
    paint.height = height;
    if (card !== undefined) paint.card = card;
    if (overhang !== undefined) paint.overhang = overhang;
    if (handles) {
      paint.handles = handles;
      paint.handlesWidth = width;
    }
    if (this.scene.isHidden(i)) return;
    this.measuredToScene(id, i, height, handles, card, width, overhang);
  }

  private measuredToScene(id: string, i: number, height: number, handles?: Map<string, HandleAnchor>, card?: SceneNode["card"], width?: number, overhang?: SceneNode["overhang"]) {
    if (card !== undefined) this.scene.graph.nodes[i].card = card;
    if (overhang !== undefined) this.scene.setOverhang(i, overhang);
    this.scene.setNodeHeight(i, height);
    // At the width it was painted at: a width changed since moves them until the next paint.
    if (handles) this.scene.setHandles(i, handles, width);
    if (!this.measuredIds.size) queueMicrotask(() => this.reportMeasured());
    this.measuredIds.add(id);
  }

  /**
   * A node leaving the live layer: the scene's box, handles and cards are its painted image's again, and that size
   * reaches the store. Whether the painter has measured the node.
   */
  restoreMeasured(id: string): boolean {
    const paint = this.paints.get(id), i = this.scene.graph.indexOf.get(id);
    if (paint?.height == null || i == null) return false;
    this.measuredToScene(id, i, paint.height, paint.handles, paint.card, paint.handlesWidth, paint.overhang);
    return true;
  }

  /** The measured sizes reach the store as React Flow's measuring does on the classic canvas (no undo step, nothing unsaved). */
  private reportMeasured() {
    const ids = this.measuredIds;
    this.measuredIds = new Set();
    if (this.disposed) return;
    // A node live by now: the live flow reports React Flow's measurement of it.
    for (const id of ids) {
      const i = this.scene.graph.indexOf.get(id);
      if (i != null && this.scene.isHidden(i)) ids.delete(id);
    }
    const store = useWorkflowStore.getState();
    const changes = measuredChanges(store.nodes, (id) => indexOfNode(store.nodes, id), this.scene.graph, ids);
    if (!changes.length) return;
    for (const change of changes) if ("id" in change) this.reportedSizes.add(change.id);
    store.onNodesChange(changes);
    requestAnimationFrame(() => this.reportedSizes.clear());
  }

  /** Nodes whose measured size the painter just wrote to the store, until that change is seen. */
  private reportedSizes = new Set<string>();

  /** Resolves paintNow for these nodes on the next frame, once the scene has drawn them. */
  private resolveWaiters(requests: readonly PaintRequest[]) {
    for (const r of requests) {
      const waiting = this.waiters.get(r.id);
      this.waiters.delete(r.id);
      if (waiting) void nextFrame().then(() => { for (const resolve of waiting) resolve(); });
    }
  }

  private afterBatch(done: readonly PaintRequest[], t0: number) {
    const now = performance.now();
    this.resolveWaiters(done);
    // A change counts once the image the view shows has it.
    const shownTier = this.wanted();
    for (const r of done) {
      if (r.priority !== URGENT || r.tier !== shownTier) continue;
      const name = this.downstream.delete(r.id) ? "painter.downstreamToShownMs" : "painter.changeToShownMs";
      void nextFrame().then(() => this.options.stats.record(name, performance.now() - r.queuedAt));
    }
    if (this.status.screenfulMs == null && this.screenfulSharp()) {
      this.status.screenfulMs = Math.round(now - this.startedAt);
      this.status.screenfulDone = true;
    }
    this.updateStatus();
    if (this.status.allMs == null && this.status.painted === this.status.total) this.status.allMs = Math.round(now - this.startedAt);
    this.options.stats.record("painter.cycleMs", now - t0);
  }

  private screenfulSharp() {
    const tier = this.wanted();
    for (const id of this.screenful) {
      if (!this.scene.graph.indexOf.has(id)) continue;
      if ((this.paints.get(id)?.shown?.slot.tier ?? 0) < tier) return false;
    }
    return true;
  }

  private updateStatus() {
    let painted = 0;
    for (const n of this.scene.graph.nodes) if (this.paints.get(n.id)?.images.has(EIGHTH)) painted++;
    this.status.painted = painted;
    this.status.total = this.scene.graph.nodes.length;
    this.status.queued = this.queue.size;
    this.status.atlasLayers = this.atlas.layout.layersInUse();
    if (!this.status.screenfulDone && this.startedAt && this.screenfulSharp()) {
      this.status.screenfulDone = true;
      this.status.screenfulMs ??= Math.round(performance.now() - this.startedAt);
    }
    this.onStatus();
  }

  // ---- the atlas ----

  /** Gives back a node's image of a tier and shows what it has left. */
  private drop(id: string, tier: number) {
    const paint = this.paints.get(id), image = paint?.images.get(tier);
    if (!paint || !image) return;
    this.atlas.layout.release(image.slot);
    paint.images.delete(tier);
    this.show(id);
  }

  /** A slot for a node's tier, reusing the one it holds when the size matches; a paint for the disk cache evicts nothing. */
  private slotFor(id: string, tier: number, w: number, h: number, evict = true): Slot | null {
    const paint = this.paint(id);
    const held = paint.images.get(tier);
    if (held && held.slot.w === w && held.slot.h === h) return held.slot;
    if (held) {
      this.atlas.layout.release(held.slot);
      paint.images.delete(tier);
      if (paint.shown === held) paint.shown = undefined;
    }
    return evict ? this.allocate(id, tier, w, h) : this.atlas.layout.allocateCell(tier, w, h, id);
  }

  /** A slot: 1/8 on a shelf for good, others in a cell, evicting the longest unseen nodes outside the view. */
  private allocate(id: string, tier: number, w: number, h: number): Slot | null {
    const layout = this.atlas.layout;
    if (tier === EIGHTH) {
      const slot = layout.allocateShelf(w, h, tier);
      if (!slot) this.status.atlasFull = true;
      return slot;
    }
    let slot = layout.allocateCell(tier, w, h, id);
    if (slot) return slot;
    // Only the view's own tier is kept for nodes near it: their other tiers
    // (left from an earlier zoom) go like any unseen node's. Cells of this
    // image's size class first (one frees a cell at once), then the rest of
    // its tier, then other tiers until a layer comes free; longest unseen first.
    const wanted = this.wanted(), key = layout.cellClass(tier, w, h).key;
    const lastSeen = (o: string) => this.paints.get(o)?.lastSeen ?? 0;
    const victims = (t: number) => layout.cellOwners(t).filter((o) => o !== id && (t !== wanted || !this.near.has(o))).sort((a, b) => lastSeen(a) - lastSeen(b));
    const same = victims(tier);
    const inClass = (o: string) => this.paints.get(o)?.images.get(tier)?.slot.cellKey === key;
    // Built lazily: with thousands of cells held, listing every tier's victims
    // for each allocation stalled the page for seconds.
    function* order(this: Painter): Generator<[string, number]> {
      for (const o of same) if (inClass(o)) yield [o, tier];
      for (const o of same) if (!inClass(o)) yield [o, tier];
      for (const t of this.tiers) if (t !== tier && t !== EIGHTH) for (const o of victims(t)) yield [o, t];
    }
    for (const [o, t] of order.call(this)) {
      const paint = this.paints.get(o), held = paint?.images.get(t);
      if (!paint || !held) continue;
      layout.release(held.slot);
      paint.images.delete(t);
      this.status.evicted++;
      this.show(o);
      slot = layout.allocateCell(tier, w, h, id);
      if (slot) return slot;
    }
    this.status.atlasFull = true;
    return null;
  }

  /** Draws the node with the smallest tier it holds that is sharp enough, else its sharpest. */
  private show(id: string, force = false) {
    const i = this.scene.graph.indexOf.get(id);
    if (i == null) return;
    const paint = this.paints.get(id);
    const tier = paint ? tierToShow(paint.images.keys(), this.wanted()) : undefined;
    const best = tier == null ? undefined : paint!.images.get(tier);
    if (paint && best === paint.shown && !force) return;
    if (paint) paint.shown = best;
    if (!best) {
      this.scene.setPainted(i, null);
      return;
    }
    this.scene.setPainted(i, { x: -best.left, y: -HEADER, w: best.w, h: best.h, layer: best.slot.layer, ...this.atlas.layout.uv(best.slot) });
  }

  // ---- the disk cache ----

  /** Uploads the requests the cache holds; returns the rest. */
  private async fromCache(requests: PaintRequest[]): Promise<PaintRequest[]> {
    const cache = this.options.cache;
    if (!cache) return requests;
    const started = performance.now();
    const found = await Promise.all(requests.map(async (r) => {
      if (this.uncached.delete(r.id)) return undefined;
      try {
        const key = this.keys.get(r.id);
        return key ? await cache.get(cacheKey(key, r.tier)) : undefined;
      } catch {
        return undefined;
      }
    }));
    const misses: PaintRequest[] = [];
    const hits: string[] = [];
    let texels = 0;
    for (let k = 0; k < requests.length; k++) {
      const r = requests[k], entry = found[k];
      const key = this.keys.get(r.id);
      if (!entry || !key || this.disposed) {
        misses.push(r);
        continue;
      }
      let pixels: Uint8Array;
      try {
        pixels = await inflate(entry.bytes);
      } catch {
        misses.push(r);
        continue;
      }
      if (pixels.length !== entry.width * entry.height * 4) {
        misses.push(r);
        continue;
      }
      // Spread uploads over frames, and give way to input like a painted batch.
      if (texels + entry.width * entry.height > UPLOAD_TEXELS_PER_FRAME) {
        await nextFrame();
        texels = 0;
      }
      if (!this.scene.graph.indexOf.has(r.id) || this.keys.get(r.id) !== key) continue;
      const slot = this.slotFor(r.id, r.tier, entry.width, entry.height);
      if (!slot) {
        misses.push(r);
        continue;
      }
      this.atlas.upload(slot, pixels, entry.width, entry.height);
      texels += entry.width * entry.height;
      const paint = this.paint(r.id);
      paint.height = entry.nodeHeight;
      paint.scroll = (entry.scroll ?? []).map(([x, y, w, h, nowheel]) => ({ x, y, w, h, nowheel: !!nowheel }));
      const { w, left } = this.boxOf(r.id);
      paint.images.set(r.tier, { slot, key, w, h: entry.nodeHeight + HEADER + PAD, left });
      this.applyMeasured(r.id, entry.nodeHeight, new Map(entry.handles.map(handleFromCache)), boxFromTuple(entry.card), undefined, boxFromTuple(entry.overhang));
      this.show(r.id, true);
      hits.push(entry.key);
      this.status.cacheHits++;
    }
    if (hits.length) {
      void cache.touch(hits).catch(noop);
      this.options.stats.record("painter.cacheMs", performance.now() - started);
    }
    return misses;
  }

  /** Reads the painted images back without waiting (a pixel buffer and a fence), to store them once the GPU is done. */
  private readBack(done: readonly PaintRequest[]) {
    const gl = this.gl;
    const texture = (this.scene.renderer.properties.get(this.atlas.target.texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!texture || !done.length) return;
    let bytes = 0;
    const plan: { r: PaintRequest; image: HeldImage }[] = [];
    for (const r of done) {
      const image = this.paints.get(r.id)?.images.get(r.tier);
      if (image) {
        plan.push({ r, image });
        bytes += image.slot.w * image.slot.h * 4;
      }
    }
    if (!bytes) return;
    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const entries: Readback["entries"] = [];
    let offset = 0;
    const flow = this.sheet.flow();
    for (const { r, image } of plan) {
      const { slot } = image;
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, slot.layer);
      gl.readPixels(slot.x, slot.y, slot.w, slot.h, gl.RGBA, gl.UNSIGNED_BYTE, offset);
      const handles = flow ? handleAnchors(flow, r.id, this.sheet.element) : undefined;
      // The card and overhang this paint measured: a live node's reach the scene only once it goes back to its
      // painted image (restoreMeasured), after this readback, so the scene's would be the previous (or none).
      const paint = this.paints.get(r.id), sceneNode = this.scene.graph.nodes[this.scene.graph.indexOf.get(r.id) ?? -1];
      entries.push({
        key: cacheKey(image.key, r.tier), offset, width: slot.w, height: slot.h, nodeHeight: paint?.height ?? 0,
        handles: handles ? [...handles].map(([k, a]) => cachedHandle(k, a)) : [],
        card: cardTuple(paint?.card !== undefined ? paint.card : sceneNode?.card),
        overhang: cardTuple(paint?.overhang !== undefined ? paint.overhang : sceneNode?.overhang),
        scroll: (paint?.scroll ?? []).map((a) => [a.x, a.y, a.w, a.h, a.nowheel ? 1 : 0]),
      });
      offset += slot.w * slot.h * 4;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.scene.renderer.resetState();
    this.readbacks.push({ buffer, sync, entries, bytes });
    if (!this.readbackFrame) this.readbackFrame = requestAnimationFrame(this.pollReadbacks);
  }

  private pollReadbacks = () => {
    this.readbackFrame = 0;
    if (this.disposed) return;
    // Reading the pixels back can wait while the user navigates.
    if (this.scene.interacting || performance.now() - this.scene.lastInputAt < QUIET_MS) {
      this.readbackFrame = requestAnimationFrame(this.pollReadbacks);
      return;
    }
    const gl = this.gl;
    const pending: Readback[] = [];
    for (const readback of this.readbacks) {
      const state = gl.clientWaitSync(readback.sync, 0, 0);
      if (state === gl.TIMEOUT_EXPIRED) {
        pending.push(readback);
        continue;
      }
      gl.deleteSync(readback.sync);
      const data = new Uint8Array(readback.bytes);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, readback.buffer);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, data);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.deleteBuffer(readback.buffer);
      void this.store(readback, data);
    }
    this.scene.renderer.resetState();
    this.readbacks = pending;
    if (pending.length) this.readbackFrame = requestAnimationFrame(this.pollReadbacks);
  };

  private async store(readback: Readback, data: Uint8Array) {
    const cache = this.options.cache;
    if (!cache) return;
    try {
      for (const entry of readback.entries) {
        const pixels = data.subarray(entry.offset, entry.offset + entry.width * entry.height * 4);
        const bytes = await deflate(pixels);
        await cache.put({ key: entry.key, width: entry.width, height: entry.height, nodeHeight: entry.nodeHeight, handles: entry.handles, card: entry.card, overhang: entry.overhang, scroll: entry.scroll, bytes, size: bytes.size, usedAt: Date.now() });
      }
      this.storedSinceTrim += readback.entries.length;
      if (this.storedSinceTrim > 200) {
        this.storedSinceTrim = 0;
        const trimStarted = performance.now();
        await cache.trim(PAINT_CACHE_BYTES);
        this.options.stats.record("painter.trimMs", performance.now() - trimStarted);
      }
    } catch {
      // A full disk or a closed database only costs a repaint next time.
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.viewTimer);
    cancelAnimationFrame(this.keyFrame);
    cancelAnimationFrame(this.readbackFrame);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    const gl = this.gl;
    for (const readback of this.readbacks) {
      gl.deleteSync(readback.sync);
      gl.deleteBuffer(readback.buffer);
    }
    gl.deleteTexture(this.stagingGl);
    this.sheet.dispose();
    this.atlas.dispose();
  }
}

function cardTuple(card: { x: number; y: number; w: number; h: number } | null | undefined): [number, number, number, number] | null {
  return card ? [card.x, card.y, card.w, card.h] : null;
}

function boxFromTuple(box: [number, number, number, number] | null | undefined): { x: number; y: number; w: number; h: number } | null | undefined {
  return box ? { x: box[0], y: box[1], w: box[2], h: box[3] } : box;
}
