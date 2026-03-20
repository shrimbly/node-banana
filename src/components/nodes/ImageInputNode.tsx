"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { ImageInputNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";

type ImageInputNodeType = Node<ImageInputNodeData, "imageInput">;

export function ImageInputNode({ id, data, selected }: NodeProps<ImageInputNodeType>) {
  const nodeData = data;
  const adaptiveImage = useAdaptiveImageSrc(nodeData.image, id);
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Variable naming state
  const [showVarDialog, setShowVarDialog] = useState(false);
  const [varNameInput, setVarNameInput] = useState(nodeData.variableName || "");

  const handleSaveVariableName = useCallback(() => {
    updateNodeData(id, { variableName: varNameInput || undefined });
    setShowVarDialog(false);
  }, [id, varNameInput, updateNodeData]);

  const handleClearVariableName = useCallback(() => {
    setVarNameInput("");
    updateNodeData(id, { variableName: undefined });
    setShowVarDialog(false);
  }, [id, updateNodeData]);

  const handleVariableNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const sanitized = e.target.value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 30);
    setVarNameInput(sanitized);
  }, []);

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
        const img = new Image();
        img.onload = () => {
          updateNodeData(id, {
            image: base64,
            imageRef: undefined,
            filename: file.name,
            dimensions: { width: img.width, height: img.height },
          });
        };
        img.src = base64;
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

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      image: null,
      imageRef: undefined,
      filename: null,
      dimensions: null,
    });
  }, [id, updateNodeData]);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      contentClassName="flex-1 min-h-0 overflow-clip"
      aspectFitMedia={nodeData.image}
      fullBleed
    >
      {/* Reference input handle for visual links from Split Grid node */}
      <Handle
        type="target"
        position={Position.Left}
        id="reference"
        data-handletype="reference"
        className="!bg-gray-500"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      {nodeData.image ? (
        <div className="relative group w-full h-full">
          <img
            src={adaptiveImage ?? undefined}
            alt={nodeData.filename || "Uploaded image"}
            className="w-full h-full object-cover rounded-lg"
          />
          <button
            onClick={handleRemove}
            aria-label="Remove image"
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 focus:ring-1 focus:ring-red-400 transition-all flex items-center justify-center"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload image"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="w-full h-full bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-900/60 transition-colors"
        >
          <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
          <span className="text-xs text-neutral-500 mt-2">Drop image</span>
        </div>
      )}

      {/* Variable name badge */}
      <div className="absolute bottom-0 left-0 right-0 z-10 px-3 py-1.5 bg-neutral-900/90 rounded-b-lg">
        <button
          onClick={() => setShowVarDialog(true)}
          className="nodrag nopan text-[10px] text-emerald-400 hover:text-emerald-300 transition-colors"
          title="Set image variable name"
        >
          {nodeData.variableName ? `@${nodeData.variableName}` : "Add variable"}
        </button>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
      />
    </BaseNode>

    {/* Variable Naming Dialog */}
    {showVarDialog && createPortal(
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]">
        <div className="bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-4 w-96">
          <h3 className="text-sm font-semibold text-neutral-100 mb-3">Set Image Variable Name</h3>
          <p className="text-xs text-neutral-400 mb-3">
            Reference this image as <span className="text-emerald-400">@name</span> in prompts and PromptConstructor templates
          </p>
          <div className="mb-4">
            <label className="block text-xs text-neutral-300 mb-1">Variable name</label>
            <input
              type="text"
              value={varNameInput}
              onChange={handleVariableNameChange}
              onKeyDown={(e) => {
                if (e.key === "Enter" && varNameInput) {
                  handleSaveVariableName();
                }
              }}
              placeholder="e.g. photo, reference, style"
              className="w-full px-3 py-2 text-sm text-neutral-100 bg-neutral-900 border border-neutral-700 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500"
              autoFocus
            />
            {varNameInput && (
              <div className="mt-2 text-xs text-emerald-400">
                Preview: <span className="font-mono">@{varNameInput}</span>
              </div>
            )}
          </div>
          <div className="flex gap-2 justify-end">
            {nodeData.variableName && (
              <button
                onClick={handleClearVariableName}
                className="px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setShowVarDialog(false)}
              className="px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-300 hover:bg-neutral-700 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSaveVariableName}
              disabled={!varNameInput}
              className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Save
            </button>
          </div>
        </div>
      </div>,
      document.body
    )}
    </>
  );
}
