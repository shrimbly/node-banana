"use client";

import React, { useCallback, useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { InpaintNodeData, InpaintProvider } from "@/types";
import { InpaintMaskModal } from "@/components/InpaintMaskModal";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";

type InpaintNodeType = Node<InpaintNodeData, "inpaint">;

const PROVIDER_OPTIONS: { value: InpaintProvider; label: string }[] = [
  { value: "gemini", label: "Gemini" },
  { value: "wavespeed", label: "WaveSpeed" },
];

export function InpaintNode({ id, data, selected }: NodeProps<InpaintNodeType>) {
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const [maskModalOpen, setMaskModalOpen] = useState(false);

  // Reactively read connected image from upstream nodes
  const connectedImage = useWorkflowStore((state) => {
    const { images } = getConnectedInputsPure(id, state.nodes, state.edges);
    return images[0] ?? null;
  });

  const connectedText = useWorkflowStore((state) => {
    const { text } = getConnectedInputsPure(id, state.nodes, state.edges);
    return text;
  });

  // Sync connected inputs into node data so executor and mask modal can use them
  useEffect(() => {
    if (connectedImage && connectedImage !== data.inputImage) {
      updateNodeData(id, { inputImage: connectedImage });
    }
  }, [connectedImage, data.inputImage, id, updateNodeData]);

  useEffect(() => {
    if (connectedText !== undefined && connectedText !== data.inputPrompt) {
      updateNodeData(id, { inputPrompt: connectedText });
    }
  }, [connectedText, data.inputPrompt, id, updateNodeData]);

  const adaptiveOutputImage = useAdaptiveImageSrc(data.outputImage, id);
  const adaptiveInputImage = useAdaptiveImageSrc(connectedImage || data.inputImage, id);

  const handleGenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleMaskSave = useCallback(
    (maskDataUrl: string, brushSize: number) => {
      updateNodeData(id, { maskImage: maskDataUrl, maskBrushSize: brushSize });
      setMaskModalOpen(false);
    },
    [id, updateNodeData]
  );

  const handleProviderChange = useCallback(
    (provider: InpaintProvider) => {
      updateNodeData(id, { inpaintProvider: provider });
    },
    [id, updateNodeData]
  );

  const displayImage = adaptiveOutputImage || adaptiveInputImage;
  const hasMask = !!data.maskImage;
  const hasInput = !!(connectedImage || data.inputImage);
  const hasPrompt = !!(connectedText || data.inputPrompt);
  // Image + mask required; prompt is optional (will use default if not connected)
  const canGenerate = hasInput && hasMask;

  // Status hint for user
  let statusHint: string | null = null;
  if (!hasInput) statusHint = "Connect an image";
  else if (!hasMask) statusHint = "Draw a mask";
  else if (!hasPrompt) statusHint = "No prompt — will use default";

  return (
    <>
      <BaseNode id={id} selected={selected}>
        {/* Input handles */}
        <Handle type="target" position={Position.Left} id="image" style={{ top: "40%" }} />
        <Handle type="target" position={Position.Left} id="text" style={{ top: "60%" }} />

        {/* Output handle */}
        <Handle type="source" position={Position.Right} id="image" />

        <div className="p-2 space-y-2">
          {/* Image preview */}
          <div className="relative w-full aspect-square bg-neutral-800 rounded overflow-hidden flex items-center justify-center">
            {displayImage ? (
              <img src={displayImage} alt="Preview" className="w-full h-full object-contain" />
            ) : (
              <span className="text-neutral-500 text-xs">Connect image</span>
            )}

            {/* Mask overlay indicator */}
            {hasMask && hasInput && (
              <div className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-white/20 text-[10px] text-white">
                Masked
              </div>
            )}

            {/* Status overlay */}
            {data.status === "loading" && (
              <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              </div>
            )}
          </div>

          {/* Provider selection */}
          <div className="flex gap-1">
            {PROVIDER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`flex-1 px-2 py-1 rounded text-xs ${
                  data.inpaintProvider === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
                }`}
                onClick={() => handleProviderChange(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Draw mask button */}
          <button
            className={`w-full px-2 py-1.5 rounded text-xs font-medium ${
              hasInput
                ? hasMask
                  ? "bg-neutral-700 text-white hover:bg-neutral-600"
                  : "bg-orange-600 text-white hover:bg-orange-500"
                : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
            }`}
            onClick={() => hasInput && setMaskModalOpen(true)}
            disabled={!hasInput}
          >
            {hasMask ? "Edit Mask" : "Draw Mask"}
          </button>

          {/* Generate button */}
          <button
            className={`w-full px-2 py-1.5 rounded text-xs font-medium ${
              canGenerate && data.status !== "loading"
                ? "bg-green-600 text-white hover:bg-green-500"
                : "bg-neutral-800 text-neutral-500 cursor-not-allowed"
            }`}
            onClick={handleGenerate}
            disabled={!canGenerate || data.status === "loading"}
          >
            {data.status === "loading" ? "Generating..." : "Inpaint"}
          </button>

          {/* Status hint */}
          {statusHint && data.status !== "loading" && !data.error && (
            <div className="text-[10px] text-neutral-500 text-center">
              {statusHint}
            </div>
          )}

          {/* Error display */}
          {data.error && (
            <div className="text-[10px] text-red-400 truncate" title={data.error}>
              {data.error}
            </div>
          )}
        </div>
      </BaseNode>

      {/* Mask drawing modal */}
      {maskModalOpen && (connectedImage || data.inputImage) && (
        <InpaintMaskModal
          isOpen={maskModalOpen}
          sourceImage={(connectedImage || data.inputImage)!}
          existingMask={data.maskImage}
          brushSize={data.maskBrushSize}
          onClose={() => setMaskModalOpen(false)}
          onSave={handleMaskSave}
        />
      )}
    </>
  );
}
