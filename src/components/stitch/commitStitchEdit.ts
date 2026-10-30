import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { draftPatch, readSequenceLayout, readStitchDraft, sameDraft, sameLayout, type StitchDraft } from "@/lib/stitch/draft";
import { dropMusicClips, hasMusicClip } from "@/lib/stitch/audioClips";
import { stitchVideoEdgeIds } from "@/lib/stitch/migrate";
import { stitchMusicEdge, stitchReadContext } from "@/lib/stitch/sources";
import { edgeIdsInOrder } from "@/lib/stitch/timeline";
import type { VideoStitchNodeData, WorkflowEdge } from "@/types";
import { mirrorStitchEditToEdits, type MirrorInput } from "./mirrorStitchEdit";

export type CommitResult = "closed" | "written" | "gone";
export type SaveResult = "saved" | "unchanged" | "gone";

/**
 * Done. Writes the draft to the node and closes the editor; it does not
 * encode. "closed" when nothing changed, so a legacy node stays legacy.
 * An edit project's session has no node: nothing is written or closed.
 * What was written is also kept in the Edits folder (mirrorStitchEditToEdits).
 */
export function commitStitchEdit(): CommitResult {
  if (useStitchEditorStore.getState().editId !== null) return "closed";
  const written = writeStitchEdit();
  const mirror = typeof written === "string" ? null : mirrorInputOf(written);
  useStitchEditorStore.getState().close();
  if (mirror) void mirrorStitchEditToEdits(mirror);
  return written === "gone" ? "gone" : written === "unchanged" ? "closed" : "written";
}

/** What the Edits mirror needs, taken from the session before Done closes it (the graph is read at the write). */
function mirrorInputOf(draft: StitchDraft): MirrorInput | null {
  const s = useStitchEditorStore.getState();
  return s.nodeId ? { nodeId: s.nodeId, draft, durations: s.durations } : null;
}

/**
 * Save (the header's Save, ⌘S, File › Save): Done's write with the editor
 * left open. What was written becomes the editor's starting point, so
 * Cancel keeps it and asks only about edits made since. The workflow file
 * is the save request's to write; this only puts the edit in the node first.
 */
export function saveStitchEdit(): SaveResult {
  if (useStitchEditorStore.getState().editId !== null) return "unchanged";
  const written = writeStitchEdit();
  const s = useStitchEditorStore.getState();
  if (written === "gone") {
    s.close();
    return "gone";
  }
  if (written === "unchanged") return "unchanged";
  // The next Save asks whether this edge is gone, not the one the editor opened with. A gone edge is kept while the
  // draft still holds music clips: the write dropped them from the node, not from the draft, so every later write
  // must drop them too (a new connection then gets one fresh clip from the re-read, never the old trims)
  const nodeId = s.nodeId;
  const edges = useWorkflowStore.getState().edges;
  const kept = nodeId && musicEdgeGone(nodeId, edges, s.musicEdgeIdAtOpen) && hasMusicClip(s.draft?.audioClips ?? []);
  s.markSaved(written, kept ? s.musicEdgeIdAtOpen : nodeId ? (stitchMusicEdge(nodeId, edges)?.id ?? null) : null);
  const mirror = mirrorInputOf(written);
  if (mirror) void mirrorStitchEditToEdits(mirror);
  return "saved";
}

/** The music edge `id` (recorded at open or by a Save) is no longer a non-loop edge into the node's audio socket. */
function musicEdgeGone(nodeId: string, edges: readonly WorkflowEdge[], id: string | null): boolean {
  return (
    id !== null &&
    !edges.some((e) => e.id === id && e.target === nodeId && e.targetHandle === "audio" && !e.data?.isLoop)
  );
}

/**
 * Writes the draft to the node in one updateNodeData, and returns what it
 * wrote.
 *
 * - The node is gone, or the canvas was replaced: writes nothing ("gone").
 * - Nothing changed: writes nothing ("unchanged").
 * - Otherwise: an edge the draft referenced when the dialog opened and whose
 *   every clip the user removed is disconnected (a live edge with no clip
 *   would be appended again on the next read), and the draft is reconciled once more against the edges that
 *   remain, picking up any that arrived while the editor was open. The edge
 *   removal pushes the canvas undo checkpoint and holds it for this task, so
 *   the data write joins it: one canvas undo step either way.
 *   sequenceLayout is left out when the stored value already reads as the
 *   draft's (read as non-legacy, so a legacy node with a hand-edited key gets
 *   the Track it showed): a trim does not add the key to every saved file, and
 *   a value from a newer build survives a Done that did not touch it.
 * - audioClips is written only when the audio is not legacy-shaped (draftPatch), or to remove the key from a node
 *   whose audio is legacy-shaped again; a node that never had it gains no key.
 * - The music edge the editor opened with (or last saved with) is gone: the music was disconnected on the canvas,
 *   which already dropped the node's music clips, so the draft's are dropped too and none is written back.
 * - Otherwise, every music clip removed while music is connected disconnects the music in the same step (any
 *   non-loop edge into audio, dimmed or not), and the re-read adds no music clip back.
 */
function writeStitchEdit(): StitchDraft | "unchanged" | "gone" {
  const s = useStitchEditorStore.getState();
  const wf = useWorkflowStore.getState();
  const nodeId = s.nodeId;
  const node = nodeId ? wf.nodes.find((n) => n.id === nodeId && n.type === "videoStitch") : undefined;
  if (!nodeId || !node || !s.draft || !s.initial || wf.canvasGeneration !== s.canvasGeneration) return "gone";

  const live = stitchVideoEdgeIds(nodeId, wf.edges);
  const referencedAtOpen = new Set(s.edgeIdsAtOpen);
  const referencedNow = new Set(edgeIdsInOrder(s.draft.timeline));
  const orphaned = live.filter((id) => referencedAtOpen.has(id) && !referencedNow.has(id));

  const musicGone = musicEdgeGone(nodeId, wf.edges, s.musicEdgeIdAtOpen);
  const base: StitchDraft = musicGone ? { ...s.draft, audioClips: dropMusicClips(s.draft.audioClips) } : s.draft;
  // A music edge connected since the music went away is new, and is never removed here. Nor is music a Save picked
  // up that the draft never held: only a music clip removed in this session disconnects
  const musicEdge = stitchMusicEdge(nodeId, wf.edges);
  const musicOrphaned =
    !musicGone &&
    musicEdge !== undefined &&
    hasMusicClip(s.initial.audioClips) &&
    !hasMusicClip(base.audioClips) &&
    s.musicHeld;
  if (musicOrphaned) orphaned.push(musicEdge.id);

  if (orphaned.length === 0 && sameDraft(s.initial, s.draft)) return "unchanged";

  // The card's read rule over the edges that stay (a video connected meanwhile follows the muting of the others)
  const ctx = stitchReadContext(nodeId, wf.nodes, wf.edges, wf.dimmedNodeIds);
  const orphanedIds = new Set(orphaned);
  const draft = readStitchDraft(draftPatch(base), {
    ...ctx,
    liveEdgeIds: ctx.liveEdgeIds.filter((id) => !orphanedIds.has(id)),
    hasMusic: ctx.hasMusic && !musicOrphaned,
  });

  if (orphaned.length > 0) wf.onEdgesChange(orphaned.map((id) => ({ type: "remove" as const, id })));
  const { sequenceLayout, audioClips, ...rest } = draftPatch(draft);
  const data = node.data as VideoStitchNodeData;
  // A node without audioClips gains no key; one that had them loses them by an undefined (the store merges)
  const patch = audioClips !== undefined || "audioClips" in data ? { ...rest, audioClips } : rest;
  const stored = readSequenceLayout(data.sequenceLayout, false);
  wf.updateNodeData(nodeId, sameLayout(stored, sequenceLayout) ? patch : { ...patch, sequenceLayout });
  return draft;
}
