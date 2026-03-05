"use client";

import { useState, useCallback, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { OutputGalleryNodeData } from "@/types";

type OutputGalleryNodeType = Node<OutputGalleryNodeData, "outputGallery">;

export function OutputGalleryNode({ id, data, selected }: NodeProps<OutputGalleryNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Collect images in real-time from connected nodes (not just during execution)
  const displayImages = useMemo(() => {
    // Start with images from execution (data.images)
    const executionImages = [...(nodeData.images || [])];

    // Also collect images from currently connected nodes
    const connectedImages: string[] = [];
    edges
      .filter((edge) => edge.target === id)
      .forEach((edge) => {
        const sourceNode = nodes.find((n) => n.id === edge.source);
        if (!sourceNode) return;

        let image: string | null = null;

        // Extract image from different node types
        if (sourceNode.type === "imageInput") {
          image = (sourceNode.data as any).image;
        } else if (sourceNode.type === "annotation") {
          image = (sourceNode.data as any).outputImage;
        } else if (sourceNode.type === "nanoBanana") {
          image = (sourceNode.data as any).outputImage;
        }

        if (image) {
          connectedImages.push(image);
        }
      });

    // Combine both sources, removing duplicates
    const allImages = [...new Set([...executionImages, ...connectedImages])];
    return allImages;
  }, [nodeData.images, edges, nodes, id]);

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const navigateLightbox = useCallback(
    (direction: "prev" | "next") => {
      if (lightboxIndex === null) return;

      if (direction === "prev" && lightboxIndex > 0) {
        setLightboxIndex(lightboxIndex - 1);
      } else if (direction === "next" && lightboxIndex < displayImages.length - 1) {
        setLightboxIndex(lightboxIndex + 1);
      }
    },
    [lightboxIndex, displayImages.length]
  );

  const downloadImage = useCallback(() => {
    if (lightboxIndex === null) return;

    const image = displayImages[lightboxIndex];
    if (!image) return;

    const link = document.createElement("a");
    link.href = image;
    link.download = `gallery-image-${lightboxIndex + 1}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [lightboxIndex, displayImages]);

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          closeLightbox();
          break;
        case "ArrowLeft":
          navigateLightbox("prev");
          break;
        case "ArrowRight":
          navigateLightbox("next");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxIndex, closeLightbox, navigateLightbox]);

  return (
    <>
      <BaseNode
        id={id}
        selected={selected}
        className="min-w-[200px]"
      >
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          data-handletype="image"
        />

        {displayImages.length === 0 ? (
          <div className="w-full flex-1 min-h-[200px] border border-dashed border-neutral-600 rounded flex items-center justify-center">
            <span className="text-neutral-500 text-[10px] text-center px-4">
              Connect image nodes to view gallery
            </span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto nodrag nopan nowheel">
            <div className="grid grid-cols-3 gap-1.5 p-1">
              {displayImages.map((img, idx) => (
                <button
                  key={idx}
                  onClick={() => openLightbox(idx)}
                  className="aspect-square rounded border border-neutral-700 hover:border-neutral-500 overflow-hidden transition-colors"
                >
                  <img
                    src={img}
                    alt={`Image ${idx + 1}`}
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
          </div>
        )}
      </BaseNode>

      {/* Lightbox Portal */}
      {lightboxIndex !== null && typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
            onClick={closeLightbox}
          >
            <div className="relative max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
              <img
                src={displayImages[lightboxIndex]}
                alt={`Gallery image ${lightboxIndex + 1}`}
                className="max-w-full max-h-[90vh] object-contain rounded"
              />

              {/* Close button */}
              <button
                onClick={closeLightbox}
                className="absolute top-4 right-4 w-8 h-8 bg-white/10 hover:bg-white/20 rounded text-white text-sm transition-colors flex items-center justify-center"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              {/* Download button */}
              <button
                onClick={downloadImage}
                className="absolute top-4 left-4 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-white text-xs font-medium transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download
              </button>

              {/* Left arrow */}
              {lightboxIndex > 0 && (
                <button
                  onClick={() => navigateLightbox("prev")}
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors flex items-center justify-center"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}

              {/* Right arrow */}
              {lightboxIndex < displayImages.length - 1 && (
                <button
                  onClick={() => navigateLightbox("next")}
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors flex items-center justify-center"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}

              {/* Image counter */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-black/50 rounded text-white text-xs font-medium">
                {lightboxIndex + 1} / {displayImages.length}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
