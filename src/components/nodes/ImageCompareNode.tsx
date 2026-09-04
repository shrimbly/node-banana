"use client";

import { useMemo, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { ImageCompareNodeData } from "@/types";
import { EmptyState, type SocketSpec } from "./ui";

type ImageCompareNodeType = Node<ImageCompareNodeData, "imageCompare">;

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "image", type: "image", label: "A" },
  { id: "image-1", type: "image", label: "B" },
];
const EMPTY_HEIGHT = 160;

export function ImageCompareNode({ id, data, selected }: NodeProps<ImageCompareNodeType>) {
  const nodeData = data;
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Collect images in real-time from connected nodes (same pattern as OutputGalleryNode)
  const displayImages = useMemo(() => {
    const connectedImages: string[] = [];

    // Get edges connected to this node, sorted by creation time for stable ordering
    const sortedEdges = edges
      .filter((edge) => edge.target === id)
      .sort((a, b) => {
        const aTime = (a.data?.createdAt as number) || 0;
        const bTime = (b.data?.createdAt as number) || 0;
        return aTime - bTime;
      });

    sortedEdges.forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
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
  }, [edges, nodes, id]);

  const imageA = displayImages[0] || nodeData.imageA || null;
  const imageB = displayImages[1] || nodeData.imageB || null;
  const ready = Boolean(imageA && imageB);

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
