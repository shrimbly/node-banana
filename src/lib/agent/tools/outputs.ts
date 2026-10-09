/**
 * view_outputs: the results nodes generated, as pictures the model can look
 * at. The snapshot names each node's results by asset id; a reader turns an
 * id into a downsized image and what made it.
 */

import type { AgentSnapshotOutput, AgentToolImage, AgentToolResult } from "../types";
import type { DraftNode, GraphDraft } from "../graph/draft";
import { titleOf } from "../graph/draft";

/** Images per call: about 1,400 tokens each at 1024px, so a dozen stays well inside a turn. */
export const VIEW_OUTPUTS_MAX_IMAGES = 12;
const PROMPT_LIMIT = 280;

/** One result as the model sees it: a picture when there is one, and what made it. */
export interface ViewableOutput {
  kind: "image" | "video" | "audio" | "3d";
  image?: { mime: string; data: string };
  prompt?: string;
  model?: string;
  createdAt?: number;
  batch?: { index: number; count: number };
}

export interface AgentOutputReader {
  /** Null when the library has no such result (deleted, or made before the library). */
  read(assetId: string): Promise<ViewableOutput | null>;
}

interface ViewOutputsArgs {
  nodeIds?: string[];
  takes?: number;
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const nameOf = (node: DraftNode) => `${titleOf(node) ?? node.type} (${node.id})`;

export async function viewOutputs(draft: GraphDraft, reader: AgentOutputReader, args: ViewOutputsArgs): Promise<AgentToolResult> {
  const notes: string[] = [];
  let nodes: DraftNode[];
  if (args.nodeIds?.length) {
    nodes = [];
    for (const key of args.nodeIds) {
      const node = draft.getNode(key) ?? draft.getNode(draft.refs.get(key) ?? "");
      if (!node) notes.push(`No node "${key}" on the canvas.`);
      else if (!nodes.includes(node)) nodes.push(node);
    }
  } else {
    // Every node with a result, left to right as the canvas reads.
    nodes = [...draft.nodes.values()]
      .filter((node) => node.outputs?.length)
      .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  }

  const takes = Math.min(Math.max(args.takes ?? 1, 1), 4);
  const wanted: Array<{ node: DraftNode; output: AgentSnapshotOutput; take: number }> = [];
  for (const node of nodes) {
    const outputs = node.outputs ?? [];
    if (outputs.length === 0) {
      notes.push(`${nameOf(node)} has no generated result to look at${node.content?.image || node.content?.video ? " (an uploaded or copied file is not viewable)" : ""}.`);
      continue;
    }
    outputs.slice(0, takes).forEach((output, take) => wanted.push({ node, output, take }));
  }
  const shown = wanted.slice(0, VIEW_OUTPUTS_MAX_IMAGES);
  if (wanted.length > shown.length) {
    notes.push(`${wanted.length - shown.length} more results were left out (at most ${VIEW_OUTPUTS_MAX_IMAGES} per call): ask for fewer nodes or takes to see them.`);
  }

  const read = await Promise.all(shown.map(({ output }) => reader.read(output.assetId).catch(() => null)));
  const images: AgentToolImage[] = [];
  const seenNodes = new Set<string>();
  shown.forEach(({ node, output, take }, index) => {
    const found = read[index];
    const which = output.current ? "the result it shows" : `an earlier take (${take + 1} of its latest)`;
    if (!found) {
      notes.push(`${nameOf(node)}, ${which}: no longer in the asset library.`);
      return;
    }
    if (!found.image) {
      const why =
        found.kind === "video" ? "the video has no captured frame yet" : found.kind === "audio" ? "audio cannot be viewed" : "3D models cannot be viewed";
      notes.push(`${nameOf(node)}, ${which}: ${why}.`);
      return;
    }
    seenNodes.add(node.id);
    const caption = [
      `Image ${images.length + 1}: ${nameOf(node)}, ${which}${found.kind === "video" ? ", the video's first frame" : ""}`,
      found.batch ? `run ${found.batch.index + 1} of ${found.batch.count}` : "",
      found.model ? `model ${found.model}` : "",
      found.prompt ? `prompt ${JSON.stringify(clip(found.prompt, PROMPT_LIMIT))}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    images.push({ mime: found.image.mime, data: found.image.data, caption });
  });

  const head =
    images.length > 0
      ? `${plural(images.length, "image")} from ${plural(seenNodes.size, "node")} follow, each after its caption.`
      : "There is nothing to look at: no node has a generated image or video frame in the asset library yet.";
  return {
    ok: true,
    text: [head, ...notes].join("\n"),
    summary: images.length > 0 ? `Looked at ${plural(images.length, "image")} from ${plural(seenNodes.size, "node")}` : "Nothing to look at yet",
    ops: [],
    ...(seenNodes.size > 0 ? { focusNodeIds: [...seenNodes] } : {}),
    ...(images.length > 0 ? { images } : {}),
  };
}
