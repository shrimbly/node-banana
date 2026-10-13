/**
 * Nodes kept live for what they hold, not because they are worked in.
 *
 * On today's canvas some nodes are always mounted (nodeCulling's
 * ALWAYS_MOUNTED) because their component holds what the store does not:
 * the 3D viewer's model, camera and auto-rotate; a video's playback; a
 * ComfyUI run's streamed previews. On the GPU canvas a node is a picture
 * unless it is live, so these stay live while they hold something:
 *
 * - **resident**: the 3D viewer, always (a WebGL viewer the user orbits).
 * - **playing**: a node whose video or audio is playing (pressed play, or a
 *   hover preview), so playback and its sound go on wherever the pointer goes.
 * - **pending**: a ComfyUI node with a workflow to import (made from the
 *   connection menu or a dropped file) or a "Replace workflow…" to answer,
 *   which only its component can open; and one whose run is in progress, so
 *   its preview stream shows as on today's canvas. Runs are few at a time
 *   (the run's concurrency limit).
 * - **running**: a node working on its own output (`status: "loading"`), so
 *   its spinner turns and its progress shows. Not while zoomed out past the
 *   low-detail zoom: there the scene draws a halo over its picture instead,
 *   as today's canvas draws its low-detail card. The halo marks every node
 *   the run is on as well as those loading.
 */
import { useWorkflowStore, subscribeToWorkflowNodeChanges } from "@/store/workflowStore";
import { useComfyAppRequestStore } from "@/store/comfyAppRequestStore";
import { indexOfNode } from "@/store/nodeChanges";
import type { WorkflowNode } from "@/types";
import type { LiveLayer } from "./LiveLayer";

export interface LiveContentOptions {
  /** Whether the view is zoomed out past the low-detail zoom. */
  zoomedOut: () => boolean;
  /** Called as the view changes; returns the unsubscribe. */
  onViewChanged: (listener: () => void) => () => void;
  /** The nodes a run is on, for the scene's halos. */
  setRunning: (ids: Iterable<string>) => void;
}

/** A node working on its own output. */
export function isLoading(node: WorkflowNode): boolean {
  return (node.data as { status?: string } | undefined)?.status === "loading";
}

/** Node types that stay live, as they stay mounted on today's canvas. */
export const RESIDENT_TYPES = new Set(["glbViewer"]);

/** Whether a node has work only its mounted component can pick up. */
export function pendingWork(node: WorkflowNode): boolean {
  if (node.type !== "comfyApp") return false;
  const data = node.data as { _autoOpenImport?: boolean; _pendingWorkflow?: unknown; status?: string; jobId?: string | null };
  return !!data._autoOpenImport || !!data._pendingWorkflow || (data.status === "loading" && !!data.jobId);
}

export class LiveContent {
  private resident = new Set<string>();
  private pending = new Set<string>();
  private requested: string | null = null;
  private loading = new Set<string>();
  /** The loading nodes made live (none while zoomed out). */
  private liveLoading = new Set<string>();
  private zoomedOut: boolean;
  private currentNodeIds: readonly string[];
  private off: (() => void)[] = [];

  constructor(private live: LiveLayer, private options: LiveContentOptions) {
    this.zoomedOut = options.zoomedOut();
    this.currentNodeIds = useWorkflowStore.getState().currentNodeIds;
    this.scan();
    this.off.push(options.onViewChanged(() => {
      const zoomedOut = options.zoomedOut();
      if (zoomedOut === this.zoomedOut) return;
      this.zoomedOut = zoomedOut;
      for (const id of this.loading) this.wantLoading(id);
    }));
    this.off.push(useWorkflowStore.subscribe((state) => {
      if (state.currentNodeIds === this.currentNodeIds) return;
      this.currentNodeIds = state.currentNodeIds;
      this.publishRunning();
    }));
    this.off.push(subscribeToWorkflowNodeChanges((changes) => {
      if (changes.added.size || changes.removed.size) {
        this.scan();
        return;
      }
      const { nodes } = useWorkflowStore.getState();
      for (const id of changes.updated) {
        const i = indexOfNode(nodes, id);
        if (i >= 0) this.check(nodes[i]);
      }
    }));
    // The node header's "Replace workflow…": the node answers once mounted.
    this.off.push(useComfyAppRequestStore.subscribe((state) => this.request(state.request?.nodeId ?? null)));
    this.request(useComfyAppRequestStore.getState().request?.nodeId ?? null);
    const element = live.element;
    const media = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLMediaElement)) return;
      const node = target.closest(".react-flow__node");
      const id = node?.getAttribute("data-id");
      if (!node || !id) return;
      const playing = [...node.querySelectorAll<HTMLMediaElement>("video, audio")].some((m) => !m.paused && !m.ended);
      live.want(id, "playing", playing);
    };
    // Media events do not bubble: listen in the capture phase.
    for (const type of ["play", "pause", "ended", "emptied"]) {
      element.addEventListener(type, media, true);
      this.off.push(() => element.removeEventListener(type, media, true));
    }
  }

  /** Every node again (the graph was rebuilt or nodes came and went). */
  scan() {
    const { nodes } = useWorkflowStore.getState();
    const seen = new Set<string>();
    for (const node of nodes) {
      seen.add(node.id);
      this.check(node);
    }
    for (const id of [...this.resident]) if (!seen.has(id)) this.resident.delete(id);
    for (const id of [...this.pending]) if (!seen.has(id)) this.pending.delete(id);
    for (const id of [...this.loading]) if (!seen.has(id)) this.loading.delete(id);
    for (const id of [...this.liveLoading]) if (!seen.has(id)) this.liveLoading.delete(id);
    this.publishRunning();
  }

  private wantLoading(id: string) {
    const live = this.loading.has(id) && !this.zoomedOut;
    if (live === this.liveLoading.has(id)) return;
    if (live) this.liveLoading.add(id);
    else this.liveLoading.delete(id);
    this.live.want(id, "running", live);
  }

  private publishRunning() {
    this.options.setRunning(new Set([...this.loading, ...this.currentNodeIds]));
  }

  private check(node: WorkflowNode) {
    const resident = RESIDENT_TYPES.has(node.type);
    if (resident !== this.resident.has(node.id)) {
      if (resident) this.resident.add(node.id);
      else this.resident.delete(node.id);
      this.live.want(node.id, "resident", resident);
    }
    const pending = pendingWork(node) || this.requested === node.id;
    if (pending !== this.pending.has(node.id)) {
      if (pending) this.pending.add(node.id);
      else this.pending.delete(node.id);
      this.live.want(node.id, "pending", pending);
    }
    const loading = isLoading(node);
    if (loading !== this.loading.has(node.id)) {
      if (loading) this.loading.add(node.id);
      else this.loading.delete(node.id);
      this.wantLoading(node.id);
      this.publishRunning();
    }
  }

  private request(id: string | null) {
    if (id === this.requested) return;
    const previous = this.requested;
    this.requested = id;
    const { nodes } = useWorkflowStore.getState();
    for (const at of [previous, id]) {
      const i = at ? indexOfNode(nodes, at) : -1;
      if (i >= 0) this.check(nodes[i]);
    }
  }

  dispose() {
    for (const off of this.off) off();
  }
}
