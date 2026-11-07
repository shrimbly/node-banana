import { useToast } from "@/components/Toast";
import { fetchAsset } from "@/lib/assets/client/api";
import type { AssetView } from "@/lib/assets/types";
import { createEdit, EditApiError, saveEdit } from "@/lib/edits/client";
import { editAssetIds, editSequenceFromDraft, snapshotEditAssets, summarizeEdit } from "@/lib/edits/document";
import type { EditAssetSnapshot, EditSequence, EditSummaryFields } from "@/lib/edits/types";
import { getAssetInfo, primeAssetInfo } from "@/lib/stitch/assetInfo";
import type { StitchDraft } from "@/lib/stitch/draft";
import { mirrorDraft, mirrorIsEmpty, type MirrorSources } from "@/lib/stitch/editMirror";
import { provisionalDurations } from "@/lib/stitch/libraryInsert";
import { resolveEdgeVideo, stitchMusicEdge, stitchMusicMedia } from "@/lib/stitch/sources";
import type { SourceDurations } from "@/lib/stitch/timeline";
import { useEditProjectStore } from "@/store/editProjectStore";
import { useWorkflowStore } from "@/store/workflowStore";
import type { ComfyAppNodeData, VideoStitchNodeData, WorkflowNode } from "@/types";

/**
 * The dialog's Save and Done also write the node's edit to the Edits
 * folder, as an edit project the Edit video view lists: created on the
 * first write and named after the node (its title, else the workflow), then
 * replaced on every later write; the node keeps the edit's id
 * (`editProjectId`). The node is the original: what it saves is what the
 * edit holds, whatever was done to the edit in the view since.
 *
 * The graph is read when the write happens, before the dialog closes; only
 * the requests are asynchronous.
 */

/** What the write needs from the editor's session, taken before it closes. */
export interface MirrorInput {
  nodeId: string;
  draft: StitchDraft;
  durations: SourceDurations;
}

type Fields = Record<string, unknown>;

const PASSTHROUGH_TYPES = new Set(["router", "switch", "conditionalSwitch"]);
/** The fields a node holds its video or sound in (getConnectedInputsPure reads the same). */
const VIDEO_FIELDS = ["outputVideo", "video"];
const AUDIO_FIELDS = ["outputAudio", "audioFile"];

/** The library id of the output the node shows: from its carousel, or a Comfy app's run history. */
export function shownAssetId(data: Fields, kind: "video" | "audio"): string | null {
  const history = kind === "video" ? "videoHistory" : "audioHistory";
  const selected = kind === "video" ? "selectedVideoHistoryIndex" : "selectedAudioHistoryIndex";
  const entries = Array.isArray(data[history]) ? (data[history] as unknown[]) : null;
  if (entries) {
    const index = typeof data[selected] === "number" ? (data[selected] as number) : 0;
    const entry = entries[index];
    const assetId = entry && typeof entry === "object" ? (entry as { assetId?: unknown }).assetId : undefined;
    return typeof assetId === "string" && assetId ? assetId : null;
  }
  const runs = (data as Partial<ComfyAppNodeData>).runHistory;
  if (Array.isArray(runs)) {
    const index = typeof data.selectedRunHistoryIndex === "number" ? (data.selectedRunHistoryIndex as number) : 0;
    const outputs = runs[index]?.outputs;
    if (outputs) {
      for (const output of Object.values(outputs)) {
        if (output.type === kind && typeof output.assetId === "string" && output.assetId) return output.assetId;
      }
    }
  }
  return null;
}

/** The node whose `fields` hold `media`: the edge's source, or past a router or switch the node it was read from. */
function producerOf(edgeId: string, media: string | null, nodes: WorkflowNode[], fields: string[]): WorkflowNode | null {
  const wf = useWorkflowStore.getState();
  const edge = wf.edges.find((e) => e.id === edgeId);
  const direct = edge ? nodes.find((n) => n.id === edge.source) : undefined;
  if (direct && !PASSTHROUGH_TYPES.has(direct.type ?? "")) return direct;
  if (!media) return null;
  return nodes.find((n) => fields.some((field) => (n.data as Fields)[field] === media)) ?? null;
}

/** Sockets → library assets, read from the graph as the executor reads it. */
export function graphMirrorSources(nodeId: string): MirrorSources {
  const wf = useWorkflowStore.getState();
  const nodes = wf.nodes;
  const edges = wf.edges;
  const dimmed = wf.dimmedNodeIds;
  return {
    videoAssetOfEdge(edgeId) {
      const media = resolveEdgeVideo(nodeId, edgeId, nodes, edges, dimmed);
      const producer = producerOf(edgeId, media, nodes, VIDEO_FIELDS);
      return producer ? shownAssetId(producer.data as Fields, "video") : null;
    },
    musicAsset() {
      const edge = stitchMusicEdge(nodeId, edges, dimmed);
      if (!edge) return null;
      const producer = producerOf(edge.id, stitchMusicMedia(nodeId, nodes, edges, dimmed), nodes, AUDIO_FIELDS);
      return producer ? shownAssetId(producer.data as Fields, "audio") : null;
    },
  };
}

/** The library records the edit's clips use: the editor's cache, else read now; unknown ones stay unknown. */
async function lookupAssets(ids: readonly string[]): Promise<(id: string) => AssetView | null | undefined> {
  const known = new Map<string, AssetView | null | undefined>();
  const read: AssetView[] = [];
  await Promise.all(
    ids.map(async (id) => {
      const cached = getAssetInfo(id);
      if (cached !== undefined) {
        known.set(id, cached);
        return;
      }
      try {
        const view = await fetchAsset(id);
        known.set(id, view);
        if (view) read.push(view);
      } catch {
        known.set(id, undefined);
      }
    }),
  );
  if (read.length > 0) primeAssetInfo(read);
  return (id) => known.get(id);
}

interface MirrorBody {
  sequence: EditSequence;
  /** The sequence's assets in first-use order: the node is the original, so media only the view added goes. */
  media: string[];
  assets: Record<string, EditAssetSnapshot>;
  summary: EditSummaryFields;
}

async function mirrorBody(input: MirrorInput, sources: MirrorSources): Promise<{ body: MirrorBody; leftOut: number } | null> {
  const mirror = mirrorDraft(input.draft, sources, input.durations);
  if (mirrorIsEmpty(mirror)) return null;
  const sequence = editSequenceFromDraft(mirror.draft);
  const media = editAssetIds(sequence);
  const lookup = await lookupAssets(media);
  const durations = provisionalDurations(mirror.draft, mirror.durations, lookup, {});
  return {
    body: {
      sequence,
      media,
      assets: snapshotEditAssets(media, lookup, {}),
      summary: summarizeEdit(mirror.draft, durations),
    },
    leftOut: mirror.leftOut,
  };
}

/** The edit's name on its first write: the node's title, else the workflow's name, else the node's kind. */
function mirrorName(node: WorkflowNode): string {
  const data = node.data as Fields;
  const title = typeof data.customTitle === "string" ? data.customTitle.trim() : "";
  if (title) return title;
  const workflow = useWorkflowStore.getState().workflowName?.trim();
  return workflow || "Edit Video";
}

const isGone = (error: unknown) => error instanceof EditApiError && error.status === 404;

/**
 * Writes the edit to the Edits folder. Returns the edit's id, or null when
 * there was nothing to write. A failure is reported in a toast and never
 * thrown: the node's own save has already happened.
 */
export async function mirrorStitchEditToEdits(input: MirrorInput, sources: MirrorSources = graphMirrorSources(input.nodeId)): Promise<string | null> {
  const toast = useToast.getState();
  try {
    const built = await mirrorBody(input, sources);
    if (!built) return null;
    const { body, leftOut } = built;
    const wf = useWorkflowStore.getState();
    const node = wf.nodes.find((n) => n.id === input.nodeId && n.type === "videoStitch");
    if (!node) return null;
    let id = (node.data as VideoStitchNodeData).editProjectId ?? null;
    if (id) {
      try {
        await saveEdit(id, { baseUpdatedAt: 0, force: true, ...body, renders: [] });
      } catch (error) {
        if (!isGone(error)) throw error;
        id = null;
      }
    }
    if (!id) {
      const document = await createEdit({ name: mirrorName(node), ...body });
      id = document.id;
      const now = useWorkflowStore.getState();
      if (now.nodes.some((n) => n.id === input.nodeId && n.type === "videoStitch")) {
        now.updateNodeData(input.nodeId, { editProjectId: id } as Partial<VideoStitchNodeData>);
      }
    }
    const edits = useEditProjectStore.getState();
    if (edits.list.status === "ready") void edits.refreshList();
    if (leftOut > 0) {
      const clips = leftOut === 1 ? "one clip that is" : `${leftOut} clips that are`;
      toast.show(`Saved to Edits without ${clips} not in the library.`, "info");
    }
    return id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast.show(`The edit was kept on the node but couldn't be saved to Edits: ${message}`, "error");
    return null;
  }
}
