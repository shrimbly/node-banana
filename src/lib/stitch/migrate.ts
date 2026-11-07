import { ASSET_ID_PATTERN } from "@/lib/assets/types";
import type { StitchClipSource, StitchTimelineClip, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";
import { sanitizeAudioClips } from "./audioClips";
import { createClip, edgeIdsInOrder, MAX_START_SEC, newClipId } from "./timeline";

/**
 * Reading a Stitch node's sequence from what is saved.
 *
 * A node without `timeline` is "legacy": the editor's Done never wrote it,
 * which holds for every saved workflow from before the editor and for every
 * new node. Its sequence is derived from `clipOrder` and the live edges on
 * each read and never written back, so opening a workflow does not dirty it.
 * Edge clips follow the canvas: a vanished edge drops its clips, a new
 * `video-*` edge appends one.
 */

export function isLegacyStitch(data: Pick<VideoStitchNodeData, "timeline">): boolean {
  return !Array.isArray(data.timeline);
}

/** Edges into nodeId on a "video-*" handle, not loop edges, in store array order (today's executor order). */
export function stitchVideoEdgeIds(nodeId: string, edges: readonly WorkflowEdge[]): string[] {
  return edges
    .filter((e) => e.target === nodeId && !e.data?.isLoop && e.targetHandle?.startsWith("video-"))
    .map((e) => e.id);
}

/** Deterministic, so migrating twice gives the same ids. */
export function legacyClipId(edgeId: string): string {
  return `clip:${edgeId}`;
}

function readSource(raw: unknown): StitchClipSource | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (source.kind === "edge" && typeof source.edgeId === "string" && source.edgeId) {
    return { kind: "edge", edgeId: source.edgeId };
  }
  // The card, the editor and a run build /api/assets/<id> URLs from it: a crafted id ("../browse-directory?") would
  // reach another route as soon as a shared workflow loads
  if (source.kind === "asset" && typeof source.assetId === "string" && ASSET_ID_PATTERN.test(source.assetId)) {
    return { kind: "asset", assetId: source.assetId };
  }
  return null;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Drop entries without a string id or valid source. Coerce in (finite, >= 0, else 0), out (finite and > in, else null),
 * muted (boolean), volume (finite, clamp 0..1, else 1), startSec (finite, clamp 0..MAX_START_SEC, else absent). A
 * repeated id gets a new one, derived from it so every read gives the same answer.
 */
export function sanitizeTimeline(raw: unknown): StitchTimelineClip[] {
  if (!Array.isArray(raw)) return [];
  const clips: StitchTimelineClip[] = [];
  const ids = new Set<string>();
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const clip = entry as Record<string, unknown>;
    const source = readSource(clip.source);
    if (typeof clip.id !== "string" || !clip.id || !source) continue;
    let id = clip.id;
    for (let n = 2; ids.has(id); n++) id = `${clip.id}~${n}`;
    ids.add(id);
    const inSec = finite(clip.inSec) && clip.inSec >= 0 ? clip.inSec : 0;
    clips.push({
      id,
      source,
      inSec,
      outSec: finite(clip.outSec) && clip.outSec > inSec ? clip.outSec : null,
      muted: clip.muted === true,
      volume: finite(clip.volume) ? Math.min(Math.max(clip.volume, 0), 1) : 1,
      // Not rounded: runs compare starts to within a nanosecond
      ...(finite(clip.startSec) ? { startSec: Math.min(Math.max(clip.startSec, 0), MAX_START_SEC) } : {}),
    });
  }
  return clips;
}

/**
 * timeline present → sanitizeTimeline(timeline), order unchanged (reconcile separately).
 * Absent (legacy) → (clipOrder ∩ live, in clipOrder order) then (live ∖ clipOrder, in live order).
 * Each becomes an edge clip with id legacyClipId(edgeId), muted iff ctx.hasMusic: today the music replaces
 * the clips' own sound, so a migrated sequence encodes exactly that.
 */
export function migrateStitchTimeline(
  data: Pick<VideoStitchNodeData, "clipOrder" | "timeline">,
  ctx: { liveEdgeIds: readonly string[]; hasMusic: boolean },
): StitchTimelineClip[] {
  if (!isLegacyStitch(data)) return sanitizeTimeline(data.timeline);
  const live = new Set(ctx.liveEdgeIds);
  const order: string[] = [];
  const clipOrder = Array.isArray(data.clipOrder) ? data.clipOrder : [];
  for (const edgeId of [...clipOrder, ...ctx.liveEdgeIds]) {
    if (live.has(edgeId) && !order.includes(edgeId)) order.push(edgeId);
  }
  return order.map((edgeId) => createClip({ kind: "edge", edgeId }, { id: legacyClipId(edgeId), muted: ctx.hasMusic }));
}

/**
 * Drop every edge clip whose edge is not live (every piece of it). Append one clip for each live edge no clip
 * references, in liveEdgeIds order, with id legacyClipId(edgeId), or newClipId() if that id is taken, and
 * muted: opts.muteNew ?? false. Asset clips keep their place.
 * changed === false → returns the input array.
 */
export function reconcileTimelineWithEdges(
  timeline: StitchTimelineClip[],
  liveEdgeIds: readonly string[],
  opts: { muteNew?: boolean } = {},
): { timeline: StitchTimelineClip[]; changed: boolean } {
  const live = new Set(liveEdgeIds);
  const kept = timeline.filter((c) => c.source.kind !== "edge" || live.has(c.source.edgeId));
  const referenced = new Set(edgeIdsInOrder(kept));
  const ids = new Set(kept.map((c) => c.id));
  const added: StitchTimelineClip[] = [];
  for (const edgeId of live) {
    if (referenced.has(edgeId)) continue;
    let id = legacyClipId(edgeId);
    while (ids.has(id)) id = newClipId();
    ids.add(id);
    added.push(createClip({ kind: "edge", edgeId }, { id, muted: opts.muteNew ?? false }));
  }
  if (kept.length === timeline.length && added.length === 0) return { timeline, changed: false };
  return { timeline: [...kept, ...added], changed: true };
}

/** What the card writes after an edge change or a reorder: legacy → { clipOrder }; otherwise { timeline, clipOrder }. */
export function stitchOrderPatch(
  data: Pick<VideoStitchNodeData, "timeline">,
  timeline: StitchTimelineClip[],
): Pick<VideoStitchNodeData, "clipOrder"> & Partial<Pick<VideoStitchNodeData, "timeline">> {
  const clipOrder = edgeIdsInOrder(timeline);
  return isLegacyStitch(data) ? { clipOrder } : { timeline, clipOrder };
}

/**
 * pasteNodes: rewrite timeline[].source.edgeId and clipOrder through the map. Ids that are not in the map are
 * left as they are; reconciliation drops them.
 */
export function remapStitchEdgeIds<T extends Pick<VideoStitchNodeData, "clipOrder" | "timeline">>(
  data: T,
  edgeIdMap: ReadonlyMap<string, string>,
): T {
  const remap = (edgeId: string) => edgeIdMap.get(edgeId) ?? edgeId;
  const clipOrder = Array.isArray(data.clipOrder) ? data.clipOrder.map(remap) : data.clipOrder;
  if (!Array.isArray(data.timeline)) return { ...data, clipOrder };
  // A saved workflow can hold anything; a malformed entry passes through for sanitizeTimeline to drop.
  const timeline = data.timeline.map((clip) =>
    clip?.source?.kind === "edge" && typeof clip.source.edgeId === "string"
      ? { ...clip, source: { kind: "edge" as const, edgeId: remap(clip.source.edgeId) } }
      : clip,
  );
  return { ...data, clipOrder, timeline };
}

/**
 * A removed edge removes its clips: every clip (each piece of a split) whose source is one of `removedEdgeIds`, and
 * those ids from clipOrder. Returns the input when nothing references them.
 *
 * Read-time reconciliation alone cannot do this. Edge ids are built from source, target and handles, and a Stitch
 * plugs a source back into the first free socket, so a source unplugged and plugged back in returns with the same id:
 * unless its removal was written when it happened, its old clip, trims and place would come back. The store applies
 * this wherever edges are removed (dropRemovedStitchEdges), in the removal's own undo step.
 */
export function dropStitchEdges<T extends Pick<VideoStitchNodeData, "clipOrder" | "timeline">>(
  data: T,
  removedEdgeIds: ReadonlySet<string>,
): T {
  const clipOrder = Array.isArray(data.clipOrder) ? data.clipOrder.filter((id) => !removedEdgeIds.has(id)) : data.clipOrder;
  // A saved workflow can hold anything; a malformed entry stays for sanitizeTimeline to drop.
  const timeline = Array.isArray(data.timeline)
    ? data.timeline.filter((clip) => !(clip?.source?.kind === "edge" && removedEdgeIds.has(clip.source.edgeId)))
    : data.timeline;
  const orderChanged = Array.isArray(data.clipOrder) && clipOrder!.length !== data.clipOrder.length;
  const timelineChanged = Array.isArray(data.timeline) && timeline!.length !== data.timeline.length;
  if (!orderChanged && !timelineChanged) return data;
  return {
    ...data,
    ...(orderChanged ? { clipOrder } : {}),
    ...(timelineChanged ? { timeline } : {}),
  };
}

/**
 * The music's connection went away (a disconnect, or a node pasted without it): when data.audioClips holds a music
 * clip, the music clips are removed (the rest kept as sanitizeAudioClips reads them, rows compacted) and audioCurve and audioMuted reset to [] and false (on a node
 * with audioClips they were only a copy for older builds); when nothing is left, the audioClips key is removed, so
 * the node reads as legacy with fresh music. A new connection starts as one whole clip, never with the old trims.
 * Returns the input when there is nothing to drop. Legacy nodes are never touched.
 */
export function dropStitchMusicClips<T extends Pick<VideoStitchNodeData, "audioClips" | "audioCurve" | "audioMuted">>(
  data: T,
): T {
  const isMusic = (clip: unknown) => (clip as { source?: { kind?: unknown } } | null)?.source?.kind === "music";
  if (!Array.isArray(data.audioClips) || !data.audioClips.some(isMusic)) return data;
  const kept = sanitizeAudioClips(data.audioClips, { allowMusic: false });
  if (kept.length > 0) return { ...data, audioClips: kept, audioCurve: [], audioMuted: false };
  const next: Partial<Pick<VideoStitchNodeData, "audioClips">> = { ...data, audioCurve: [], audioMuted: false };
  delete next.audioClips;
  return next as T;
}

/**
 * dropStitchEdges on every Stitch node the removed edges led into, and dropStitchMusicClips on those whose music
 * connection (a non-loop edge into `audio`) was removed. Returns the input array when nothing changes.
 */
export function dropRemovedStitchEdges(nodes: WorkflowNode[], removedEdges: readonly WorkflowEdge[]): WorkflowNode[] {
  if (removedEdges.length === 0) return nodes;
  const byTarget = new Map<string, Set<string>>();
  const musicGone = new Set<string>();
  for (const edge of removedEdges) {
    const ids = byTarget.get(edge.target) ?? new Set<string>();
    ids.add(edge.id);
    byTarget.set(edge.target, ids);
    if (edge.targetHandle === "audio" && !edge.data?.isLoop) musicGone.add(edge.target);
  }
  let changed = false;
  const next = nodes.map((node) => {
    const removed = node.type === "videoStitch" ? byTarget.get(node.id) : undefined;
    if (!removed) return node;
    const data = node.data as VideoStitchNodeData;
    const withoutEdges = dropStitchEdges(data, removed);
    const dropped = musicGone.has(node.id) ? dropStitchMusicClips(withoutEdges) : withoutEdges;
    if (dropped === data) return node;
    changed = true;
    return { ...node, data: dropped } as WorkflowNode;
  });
  return changed ? next : nodes;
}
