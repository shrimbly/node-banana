"use client";

import { useEffect, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { useShallow } from "zustand/shallow";
import { nodeGraphIndex } from "@/lib/edges/graphIndex";
import { ImageCompareNodeData } from "@/types";
import { EmptyState, type SocketSpec } from "./ui";
import { useIsLiveLayerNode, useIsPaintedNode, useNodeUiState } from "./paintMode";

type ImageCompareNodeType = Node<ImageCompareNodeData, "imageCompare">;

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "image", type: "image", label: "A" },
  { id: "image-1", type: "image", label: "B" },
];
const EMPTY_HEIGHT = 160;
/** How long the divider rests before its position is kept for the node's painted copies. */
const POSITION_COMMIT_MS = 150;

/**
 * The divider's position on the GPU canvas, kept as node view state so a
 * painted copy and the next live mount show it where the user left it. The
 * live slider moves on its own; its position is written once it rests (and
 * when the node goes back to a picture), not on every drag frame, since each
 * write repaints the node. On the classic canvas the slider stays
 * uncontrolled, as before: `null`.
 *
 * While the node is not `ready` (an input disconnected) the slider is gone,
 * as on classic, where it mounts again at the centre: the kept position goes
 * back to the centre, and a drag still waiting to be written is dropped.
 */
export function useComparePosition(id: string, ready = true) {
  const live = useIsLiveLayerNode(), painted = useIsPaintedNode();
  const gpu = live || painted;
  const [position, setPosition] = useNodeUiState(id, "comparePosition", 50);
  const pending = useRef<number | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (pending.current !== null) setPosition(pending.current);
  }, [setPosition]);
  useEffect(() => {
    if (ready || !gpu) return;
    window.clearTimeout(timer.current);
    pending.current = null;
    setPosition(50);
  }, [ready, gpu, setPosition]);
  if (!gpu) return null;
  if (painted) return { position };
  return {
    position,
    onPositionChange: (next: number) => {
      pending.current = next;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        pending.current = null;
        setPosition(next);
      }, POSITION_COMMIT_MS);
    },
  };
}

export function ImageCompareNode({ id, data, selected }: NodeProps<ImageCompareNodeType>) {
  const nodeData = data;
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Collect images in real-time from connected nodes (same pattern as
  // OutputGalleryNode). Selected as the list of image strings, compared by
  // value, so a drag frame elsewhere does not re-render the comparison
  const displayImages = useWorkflowStore(useShallow((state) => {
    const connectedImages: string[] = [];
    const { byId } = nodeGraphIndex(state.nodes);

    // Get edges connected to this node, sorted by creation time for stable ordering
    const sortedEdges = state.edges
      .filter((edge) => edge.target === id)
      .sort((a, b) => {
        const aTime = (a.data?.createdAt as number) || 0;
        const bTime = (b.data?.createdAt as number) || 0;
        return aTime - bTime;
      });

    sortedEdges.forEach((edge) => {
      const sourceNode = byId.get(edge.source);
      if (!sourceNode) return;

      let image: string | null = null;
      const d = sourceNode.data as Record<string, unknown>;

      // Extract image from different node types
      if (sourceNode.type === "imageInput") {
        image = d.image as string | null;
      } else if (sourceNode.type === "annotation" || sourceNode.type === "nanoBanana" || sourceNode.type === "removeBackground") {
        image = d.outputImage as string | null;
      }

      if (image) {
        connectedImages.push(image);
      }
    });

    return connectedImages;
  }));

  const imageA = displayImages[0] || nodeData.imageA || null;
  const imageB = displayImages[1] || nodeData.imageB || null;
  const ready = Boolean(imageA && imageB);
  const sliderPosition = useComparePosition(id, ready);

  const media = ready
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === imageA ? loadedAspect.aspect : 1 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  return (
    <NodeShell id={id} selected={selected} media={media} inputs={INPUT_SOCKETS} minWidth={240}>
      {ready ? (
        <div className="absolute inset-0 nodrag nopan nowheel">
          {/* Measures A: the slider fills the clip, so the clip takes A's proportions. */}
          <img
            src={imageA!}
            alt=""
            aria-hidden
            className="hidden"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                setLoadedAspect({ src: imageA!, aspect: img.naturalWidth / img.naturalHeight });
              }
            }}
          />
          <ReactCompareSlider
            itemOne={<ReactCompareSliderImage src={imageA!} alt="Image A" style={{ objectFit: "cover" }} />}
            itemTwo={<ReactCompareSliderImage src={imageB!} alt="Image B" style={{ objectFit: "cover" }} />}
            portrait={false}
            {...sliderPosition}
            style={{ width: "100%", height: "100%" }}
          />
          <div className="absolute top-2 left-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">A</div>
          <div className="absolute top-2 right-2 bg-black/50 text-white text-[10px] font-medium px-2 py-1 rounded pointer-events-none">B</div>
        </div>
      ) : (
        <EmptyState
          message={!imageA && !imageB ? "Connect 2 images to compare" : "Connect another image to compare"}
          hint={imageA && !imageB ? "Image A connected" : !imageA && imageB ? "Image B connected" : undefined}
        />
      )}
    </NodeShell>
  );
}
