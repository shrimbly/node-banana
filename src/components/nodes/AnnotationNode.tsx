"use client";

import { useCallback, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useAnnotationStore } from "@/store/annotationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { AnnotationNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { downloadMedia } from "@/utils/downloadMedia";
import { ControlsCard, SummaryValues, type SocketSpec } from "./ui";

type AnnotationNodeType = Node<AnnotationNodeData, "annotation">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image" }];

export function AnnotationNode({ id, data, selected }: NodeProps<AnnotationNodeType>) {
  const nodeData = data;
  const openModal = useAnnotationStore((state) => state.openModal);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

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
          sourceImageRef: undefined,
          outputImage: null,
          outputImageRef: undefined,
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
      sourceImageRef: undefined,
      outputImage: null,
      outputImageRef: undefined,
      annotations: [],
    });
  }, [id, updateNodeData]);

  const displayImage = nodeData.outputImage || nodeData.sourceImage;
  const adaptiveDisplayImage = useAdaptiveImageSrc(displayImage, id);
  const aspect = displayImage && loadedAspect?.src === displayImage ? loadedAspect.aspect : 1;
  const count = nodeData.annotations.length;

  return (
    <NodeShell
      id={id}
      selected={selected}
      media={{ kind: "aspect", aspect }}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
      controls={
        displayImage ? (
          <ControlsCard
            id={id}
            summary={{
              title: count > 0 ? `${count} annotation${count === 1 ? "" : "s"}` : "No annotations",
              values: <SummaryValues items={[nodeData.outputImage ? "rendered" : null]} />,
            }}
          />
        ) : undefined
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      {displayImage ? (
        <div className="absolute inset-0 cursor-pointer" onClick={handleEdit}>
          <img
            src={adaptiveDisplayImage ?? undefined}
            alt="Annotated"
            className="absolute inset-0 w-full h-full object-cover"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0 && displayImage) {
                setLoadedAspect({ src: displayImage, aspect: img.naturalWidth / img.naturalHeight });
              }
            }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              downloadMedia(displayImage!, "image");
            }}
            aria-label="Download image"
            className="absolute top-2 right-10 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-white transition-opacity flex items-center justify-center"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleRemove();
            }}
            aria-label="Remove image"
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center pointer-events-none">
            <span className="text-xs font-medium text-white opacity-0 group-hover:opacity-100 transition-opacity bg-black/60 px-3 py-1.5 rounded">
              {count > 0 ? `Edit (${count})` : "Add annotations"}
            </span>
          </div>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="absolute inset-0 bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-800/60 transition-colors"
        >
          <div className="absolute inset-2 rounded-[6px] squircle border border-dashed border-neutral-700/70 pointer-events-none" />
          <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-xs text-neutral-500 mt-2">
            Drop, click, or connect
          </span>
        </div>
      )}
    </NodeShell>
  );
}
