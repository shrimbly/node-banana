"use client";

import { useCallback, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCropperStore } from "@/store/cropperStore";
import { downloadImage } from "@/utils/downloadImage";
import { OutputNodeData } from "@/types";

type OutputNodeType = Node<OutputNodeData, "output">;

export function OutputNode({ id, data, selected }: NodeProps<OutputNodeType>) {
  const nodeData = data;
  const [showLightbox, setShowLightbox] = useState(false);
  const openCropper = useCropperStore((state) => state.openModal);

  const handleDownload = useCallback(() => {
    if (!nodeData.image) return;
    downloadImage(nodeData.image, {
      filename: `generated-${Date.now()}.png`,
    });
  }, [nodeData.image]);

  const handleOpenCropper = useCallback(() => {
    if (!nodeData.image) return;
    openCropper(nodeData.image, id);
  }, [nodeData.image, id, openCropper]);

  return (
    <>
      <BaseNode id={id} title="Output" selected={selected} className="min-w-[200px]">
        <Handle
          type="target"
          position={Position.Left}
          id="image"
          data-handletype="image"
        />

        {nodeData.image ? (
          <div className="flex-1 flex flex-col min-h-0 gap-2">
            <div
              className="relative cursor-pointer group flex-1 min-h-0"
              onClick={() => setShowLightbox(true)}
            >
              <img
                src={nodeData.image}
                alt="Output"
                className="w-full h-full object-contain rounded"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center rounded">
                <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded">
                  View full size
                </span>
              </div>
            </div>
            <button
              onClick={handleDownload}
              className="w-full py-1.5 bg-white hover:bg-neutral-200 text-neutral-900 text-[10px] font-medium rounded transition-colors shrink-0"
            >
              Download
            </button>
            <button
              onClick={handleOpenCropper}
              className="w-full py-1.5 bg-neutral-700 hover:bg-neutral-600 text-white text-[10px] font-medium rounded transition-colors shrink-0"
            >
              Split Grid / Crop
            </button>
          </div>
        ) : (
          <div className="w-full flex-1 min-h-[144px] border border-dashed border-neutral-600 rounded flex items-center justify-center">
            <span className="text-neutral-500 text-[10px]">Waiting for image</span>
          </div>
        )}
      </BaseNode>

      {/* Lightbox Modal */}
      {showLightbox && nodeData.image && (
        <div
          className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
          onClick={() => setShowLightbox(false)}
        >
          <div className="relative max-w-full max-h-full">
            <img
              src={nodeData.image}
              alt="Output full size"
              className="max-w-full max-h-[90vh] object-contain rounded"
            />
            <button
              onClick={() => setShowLightbox(false)}
              className="absolute top-4 right-4 w-8 h-8 bg-white/10 hover:bg-white/20 rounded text-white text-sm transition-colors flex items-center justify-center"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
