"use client";

import { useCallback, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useAnnotationStore } from "@/store/annotationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { AnnotationNodeData } from "@/types";

type AnnotationNodeType = Node<AnnotationNodeData, "annotation">;

export function AnnotationNode({ id, data, selected }: NodeProps<AnnotationNodeType>) {
  const nodeData = data;
  const openModal = useAnnotationStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
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
          annotations: [],
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
    const imageToEdit = nodeData.sourceImage || nodeData.outputImage;
    if (!imageToEdit) {
      alert("No image available. Connect an image or load one manually.");
      return;
    }
    openModal(id, imageToEdit, nodeData.annotations);
  }, [id, nodeData, openModal]);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      outputImage: null,
      annotations: [],
    });
  }, [id, updateNodeData]);

  const displayImage = nodeData.outputImage || nodeData.sourceImage;

  return (
    <BaseNode
      id={id}
      title="Annotate"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
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
            alt="Annotated"
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
              {nodeData.annotations.length > 0 ? `Edit (${nodeData.annotations.length})` : "Add annotations"}
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
    </BaseNode>
  );
}
