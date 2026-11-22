/**
 * Image batches: an Image Input node holding several images, and a run of
 * the flow per image.
 *
 * The node keeps its images in parallel arrays (`batchImages`, their saved
 * files in `batchImageRefs`, names and sizes alongside) and shows one of them
 * as its ordinary `image`, so everything that reads an Image Input reads the
 * current item unchanged. A batch run (`runBatch` in the store) moves every
 * batch node to the run's item before each run.
 */

import type { ImageInputNodeData, WorkflowEdge, WorkflowNode } from "@/types";

/** Most images one node holds. */
export const MAX_BATCH_IMAGES = 200;

/** Most runs a batch of images may make (images × the Runs count). */
export const MAX_IMAGE_BATCH_RUNS = 500;

export interface ImageBatchItem {
  image: string;
  /** The item's saved file, when it has one. */
  imageRef?: string;
  filename: string | null;
  dimensions: { width: number; height: number } | null;
}

type BatchFields = Pick<
  ImageInputNodeData,
  "image" | "imageRef" | "filename" | "dimensions" | "batchImages" | "batchImageRefs" | "batchFilenames" | "batchDimensions" | "batchIndex"
>;

/** The node's images: its batch, else its one image, else none. */
export function batchItems(data: Partial<ImageInputNodeData>): ImageBatchItem[] {
  const images = data.batchImages;
  if (images && images.length > 0) {
    return images.map((image, i) => ({
      image,
      ...(data.batchImageRefs?.[i] ? { imageRef: data.batchImageRefs[i] } : {}),
      filename: data.batchFilenames?.[i] ?? null,
      dimensions: data.batchDimensions?.[i] ?? null,
    }));
  }
  if (data.image || data.imageRef) {
    return [{ image: data.image ?? "", ...(data.imageRef ? { imageRef: data.imageRef } : {}), filename: data.filename ?? null, dimensions: data.dimensions ?? null }];
  }
  return [];
}

/** How many images a run goes through: 0 or 1 is no batch. */
export function batchLength(data: Partial<ImageInputNodeData> | undefined): number {
  return data?.batchImages?.length ?? 0;
}

/** The node data for these images, showing item `index`. */
export function batchData(items: ImageBatchItem[], index = 0): BatchFields {
  if (items.length === 0) {
    return { image: null, imageRef: undefined, filename: null, dimensions: null, ...noBatch() };
  }
  const at = Math.max(0, Math.min(items.length - 1, index));
  const current = items[at]!;
  const shown = { image: current.image || null, imageRef: current.imageRef, filename: current.filename, dimensions: current.dimensions };
  if (items.length === 1) return { ...shown, ...noBatch() };
  const refs = items.map((item) => item.imageRef ?? "");
  return {
    ...shown,
    batchImages: items.map((item) => item.image),
    batchImageRefs: refs.some(Boolean) ? refs : undefined,
    batchFilenames: items.map((item) => item.filename),
    batchDimensions: items.map((item) => item.dimensions),
    batchIndex: at,
  };
}

function noBatch() {
  return { batchImages: undefined, batchImageRefs: undefined, batchFilenames: undefined, batchDimensions: undefined, batchIndex: undefined };
}

/** Show item `index` of the batch (wrapping), leaving the batch as it is. */
export function showBatchItem(data: Partial<ImageInputNodeData>, index: number): Partial<ImageInputNodeData> | null {
  const length = batchLength(data);
  if (length < 2) return null;
  const at = ((index % length) + length) % length;
  const ref = data.batchImageRefs?.[at];
  return {
    image: data.batchImages![at] || null,
    imageRef: ref || undefined,
    filename: data.batchFilenames?.[at] ?? null,
    dimensions: data.batchDimensions?.[at] ?? null,
    batchIndex: at,
  };
}

/** Add images after the node's own, up to MAX_BATCH_IMAGES; shows the first added. */
export function addToBatch(data: Partial<ImageInputNodeData>, added: ImageBatchItem[]): { data: BatchFields; dropped: number } {
  const existing = batchItems(data);
  const room = Math.max(0, MAX_BATCH_IMAGES - existing.length);
  const kept = added.slice(0, room);
  const showIndex = existing.length === 0 ? 0 : kept.length > 0 ? existing.length : data.batchIndex ?? 0;
  return { data: batchData([...existing, ...kept], showIndex), dropped: added.length - kept.length };
}

/** Remove item `index`; the one after it (or the new last) is shown. */
export function removeFromBatch(data: Partial<ImageInputNodeData>, index: number): BatchFields {
  const items = batchItems(data);
  items.splice(index, 1);
  return batchData(items, Math.min(index, items.length - 1));
}

/** File names in the order a person reads a folder: "img2" before "img10". */
export function compareFilenames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * The Image Input nodes in batch mode that a run of this scope reads: every
 * one on the canvas for a whole-workflow run, and for selected nodes, those
 * among them or upstream of them.
 */
export function batchNodesFor(
  nodes: Pick<WorkflowNode, "id" | "type" | "data">[],
  edges: Pick<WorkflowEdge, "source" | "target">[],
  scope: { kind: "all" } | { kind: "from"; nodeId: string } | { kind: "nodes"; nodeIds: string[] }
): Pick<WorkflowNode, "id" | "type" | "data">[] {
  const batched = nodes.filter((node) => node.type === "imageInput" && batchLength(node.data as ImageInputNodeData) > 1);
  if (scope.kind !== "nodes" || batched.length === 0) return batched;
  const reached = new Set(scope.nodeIds);
  const queue = [...scope.nodeIds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const edge of edges) {
      if (edge.target === id && !reached.has(edge.source)) {
        reached.add(edge.source);
        queue.push(edge.source);
      }
    }
  }
  return batched.filter((node) => reached.has(node.id));
}
