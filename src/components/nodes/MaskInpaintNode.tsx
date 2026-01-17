"use client";

import { useCallback, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useMaskInpaintStore } from "@/store/maskInpaintStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { MaskInpaintNodeData } from "@/types";

type MaskInpaintNodeType = Node<MaskInpaintNodeData, "maskInpaint">;

export function MaskInpaintNode({ id, data, selected }: NodeProps<MaskInpaintNodeType>) {
  const nodeData = data;
  const openModal = useMaskInpaintStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.match(/^image\/(png|jpeg|webp)$/)) {
        alert("Unsupported format. Use PNG, JPG, or WebP.");
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        alert("Image too large. Maximum size is 10MB.");
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        updateNodeData(id, {
          sourceImage: base64,
          outputImage: null,
          maskStrokes: [],
          maskImage: null,
        });
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dt.files;
        fileInputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleEditMask = useCallback(() => {
    const imageToEdit = nodeData.sourceImage;
    if (!imageToEdit) {
      alert("No image available. Connect an image or load one manually.");
      return;
    }
    openModal(id, imageToEdit, nodeData.maskStrokes, {
      brushSize: nodeData.brushSize,
      maskFeather: nodeData.maskFeather,
      maskExpansion: nodeData.maskExpansion,
    });
  }, [id, nodeData, openModal]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      outputImage: null,
      maskStrokes: [],
      maskImage: null,
    });
  }, [id, updateNodeData]);

  const handleRun = useCallback(() => {
    if (!isRunning) {
      regenerateNode(id);
    }
  }, [id, isRunning, regenerateNode]);

  // Show output if available, otherwise show source with mask overlay indicator
  const displayImage = nodeData.outputImage || nodeData.sourceImage;
  const hasMask = nodeData.maskStrokes.length > 0;

  return (
    <BaseNode
      id={id}
      title="Mask Inpaint"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      isExecuting={nodeData.status === "loading"}
      hasError={nodeData.status === "error"}
      onRun={handleRun}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Image input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
        style={{ top: "30%" }}
      />

      {/* Text/prompt input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        data-handletype="text"
        style={{ top: "70%" }}
      />

      {/* Output image handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
      />

      {/* Status indicator */}
      {nodeData.status === "loading" && (
        <div className="absolute top-2 right-2 z-10">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Error message */}
      {nodeData.status === "error" && nodeData.error && (
        <div className="mb-2 p-2 bg-red-500/20 border border-red-500/40 rounded text-xs text-red-300 truncate">
          {nodeData.error}
        </div>
      )}

      {displayImage ? (
        <div
          className="relative group cursor-pointer flex-1 flex flex-col min-h-0"
          onClick={handleEditMask}
        >
          <img
            src={displayImage}
            alt="Image for inpainting"
            className="w-full flex-1 min-h-0 object-contain rounded"
          />

          {/* Mask indicator badge */}
          {hasMask && (
            <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-purple-500/80 text-white text-[10px] rounded font-medium">
              Mask ready
            </div>
          )}

          {/* Remove button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          {/* Hover overlay with edit prompt */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded flex items-center justify-center pointer-events-none">
            <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded">
              {hasMask ? "Edit mask" : "Paint mask"}
            </span>
          </div>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full flex-1 min-h-[112px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center cursor-pointer hover:border-neutral-500 hover:bg-neutral-700/50 transition-colors"
        >
          <svg className="w-5 h-5 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-[10px] text-neutral-400 mt-1">
            Drop, click, or connect
          </span>
        </div>
      )}

      {/* Mask settings summary */}
      {displayImage && (
        <div className="mt-2 flex gap-2 text-[9px] text-neutral-500">
          <span>Brush: {nodeData.brushSize}px</span>
          <span>Feather: {nodeData.maskFeather}px</span>
          <span>Expand: {nodeData.maskExpansion}px</span>
        </div>
      )}
    </BaseNode>
  );
}
