"use client";

import { useCallback, useEffect, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useMaskPainterStore } from "@/store/maskPainterStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { MaskPainterNodeData } from "@/types";

type MaskPainterNodeType = Node<MaskPainterNodeData, "maskPainter">;

export function MaskPainterNode({ id, data, selected }: NodeProps<MaskPainterNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const openModal = useMaskPainterStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reactively update sourceImage when an edge is connected
  useEffect(() => {
    const inputs = getConnectedInputs(id);
    if (inputs.images.length > 0 && inputs.images[0] !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: inputs.images[0] });
    }
  }, [edges, id, getConnectedInputs, nodeData.sourceImage, updateNodeData]);

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
          strokes: [],
          outputMask: null,
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

  const handleEdit = useCallback(() => {
    const imageToEdit = nodeData.sourceImage;
    if (!imageToEdit) {
      alert("No image available. Connect an image or load one manually.");
      return;
    }
    openModal(id, imageToEdit, nodeData.strokes);
  }, [id, nodeData, openModal]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      strokes: [],
      outputMask: null,
    });
  }, [id, updateNodeData]);

  // Only show the painted mask output — sourceImage is the reference for the modal, not the node preview
  const displayImage = nodeData.outputMask;

  return (
    <BaseNode
      id={id}
      title="Mask Painter"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      commentNavigation={commentNavigation ?? undefined}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
      />

      {displayImage ? (
        <div
          className="relative group cursor-pointer flex-1 flex flex-col min-h-0"
          onClick={handleEdit}
        >
          <img
            src={displayImage}
            alt="Mask"
            className="w-full flex-1 min-h-0 object-contain rounded"
          />
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
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors rounded flex items-center justify-center pointer-events-none">
            <span className="text-[10px] font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/50 px-2 py-1 rounded">
              {nodeData.strokes.length > 0 ? `Edit mask (${nodeData.strokes.length} elements)` : "Paint mask"}
            </span>
          </div>
        </div>
      ) : nodeData.sourceImage ? (
        <div
          className="relative group cursor-pointer flex-1 flex flex-col min-h-0"
          onClick={handleEdit}
        >
          <div className="w-full flex-1 min-h-[112px] bg-black rounded flex flex-col items-center justify-center">
            <svg className="w-5 h-5 text-neutral-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.53 16.122a3 3 0 0 0-5.78 1.128 2.25 2.25 0 0 1-2.4 2.245 4.5 4.5 0 0 0 8.4-2.245c0-.399-.078-.78-.22-1.128Zm0 0a15.998 15.998 0 0 0 3.388-1.62m-5.043-.025a15.994 15.994 0 0 1 1.622-3.395m3.42 3.42a15.995 15.995 0 0 0 4.764-4.648l3.876-5.814a1.151 1.151 0 0 0-1.597-1.597L14.146 6.32a15.996 15.996 0 0 0-4.649 4.763m3.42 3.42a6.776 6.776 0 0 0-3.42-3.42" />
            </svg>
            <span className="text-[10px] text-neutral-400 mt-1">Click to paint mask</span>
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

    </BaseNode>
  );
}
