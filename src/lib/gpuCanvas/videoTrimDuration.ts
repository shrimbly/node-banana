/**
 * A Video Trim node learns its source video's length by loading the video's
 * metadata (VideoTrimNode's own effect on today's canvas, where the node is
 * always mounted), and sets its end time to it while that is still 0. On the
 * GPU canvas a node is mounted only while it is worked in, its painted
 * copies write nothing, and a live copy that unmounts before the metadata
 * loads drops the write, so a trim whose source arrives while it is a picture
 * would keep an end time of 0 and its run would fail. The canvas watches the
 * store instead: each trim's source URL is probed once when it changes, and
 * the probe stops only when the source changes again, the node goes or the
 * canvas is replaced.
 */
import { indexOfNode } from "@/store/nodeChanges";
import type { WorkflowEdge, WorkflowNode } from "@/types";

interface TrimState {
  nodes: readonly WorkflowNode[];
  edges: readonly WorkflowEdge[];
  canvasGeneration: number;
  updateNodeData: (nodeId: string, data: { duration: number; endTime: number }) => void;
}

interface TrimStore {
  getState: () => TrimState;
  subscribe: (listener: (state: TrimState, previous: TrimState) => void) => () => void;
}

/** Resolves a video's duration in seconds, or null when it has none; stops when `signal` aborts. */
export type ProbeDuration = (url: string, signal: AbortSignal) => Promise<number | null>;

/** Loads a video's metadata in a detached element (a data: URL through a blob URL, as the node does). */
export const probeVideoDuration: ProbeDuration = async (url, signal) => {
  let src = url;
  let blobUrl: string | null = null;
  if (url.startsWith("data:")) {
    try {
      const blob = await (await fetch(url, { signal })).blob();
      if (signal.aborted) return null;
      blobUrl = src = URL.createObjectURL(blob);
    } catch {
      if (signal.aborted) return null;
    }
  }
  const video = document.createElement("video");
  video.preload = "metadata";
  try {
    return await new Promise<number | null>((resolve) => {
      video.onloadedmetadata = () => resolve(video.duration);
      video.onerror = () => resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
      video.src = src;
    });
  } finally {
    video.onloadedmetadata = null;
    video.onerror = null;
    video.removeAttribute("src");
    video.load();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
};

/** Each Video Trim node's source video URL (the node feeding its video socket). */
export function trimSources(state: Pick<TrimState, "nodes" | "edges">): Map<string, string | null> {
  const sources = new Map<string, string | null>();
  for (const node of state.nodes) if (node.type === "videoTrim") sources.set(node.id, null);
  if (!sources.size) return sources;
  const found = new Set<string>();
  for (const edge of state.edges) {
    // The first connection into the socket, as the node reads it.
    if (edge.targetHandle !== "video" || !sources.has(edge.target) || found.has(edge.target)) continue;
    found.add(edge.target);
    const i = indexOfNode(state.nodes, edge.source);
    const url = i >= 0 ? (state.nodes[i].data as { outputVideo?: string | null }).outputVideo ?? null : null;
    sources.set(edge.target, url);
  }
  return sources;
}

/** Keeps Video Trim nodes' durations as classic's mounted nodes do; returns the unsubscribe. */
export function watchVideoTrimDurations(store: TrimStore, probe: ProbeDuration = probeVideoDuration): () => void {
  const probes = new Map<string, { url: string; abort: AbortController }>();

  const start = (id: string, url: string) => {
    const abort = new AbortController();
    probes.set(id, { url, abort });
    probe(url, abort.signal).then((duration) => {
      if (abort.signal.aborted || duration == null || !Number.isFinite(duration) || duration <= 0) return;
      const state = store.getState();
      const i = indexOfNode(state.nodes, id);
      if (i < 0) return;
      const data = state.nodes[i].data as { endTime?: number };
      // Only an end time still at its default follows the source, as in the node.
      state.updateNodeData(id, { duration, endTime: data.endTime === 0 ? duration : data.endTime ?? duration });
    }, () => {});
  };

  const sync = (state: TrimState) => {
    const sources = trimSources(state);
    for (const [id, running] of probes) {
      if (sources.get(id) === running.url) continue;
      running.abort.abort();
      probes.delete(id);
    }
    for (const [id, url] of sources) if (url && !probes.has(id)) start(id, url);
  };

  sync(store.getState());
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.canvasGeneration !== previous.canvasGeneration) {
      // A different canvas: its nodes probe their sources afresh, as on mount.
      for (const running of probes.values()) running.abort.abort();
      probes.clear();
    } else if (state.nodes === previous.nodes && state.edges === previous.edges) {
      return;
    }
    sync(state);
  });
  return () => {
    unsubscribe();
    for (const running of probes.values()) running.abort.abort();
    probes.clear();
  };
}
