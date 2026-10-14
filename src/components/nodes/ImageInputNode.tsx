"use client";

import { useCallback, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { ImageInputNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { useNodeMediaRequest } from "@/hooks/useNodeMediaRequest";
import { downloadMedia } from "@/utils/downloadMedia";
import { ControlsCard, SummaryValues, type SocketSpec } from "./ui";
import { Download, Upload, X } from "lucide-react";
import { useUpdateNodeData } from "./paintMode";

type ImageInputNodeType = Node<ImageInputNodeData, "imageInput">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "reference", type: "reference", label: "Ref", dataTutorial: "node-input-handle" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image", dataTutorial: "node-output-handle" }];

export function ImageInputNode({ id, data, selected }: NodeProps<ImageInputNodeType>) {
  const nodeData = data;
  const adaptiveImage = useAdaptiveImageSrc(nodeData.image, id);
  useCommentNavigation(id);
  const updateNodeData = useUpdateNodeData();
  const { beginRequest, cancelRequest } = useNodeMediaRequest(id);
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

      const isCurrent = beginRequest();
      const reader = new FileReader();
      reader.onload = (event) => {
        if (!isCurrent()) return;
        const base64 = event.target?.result as string;
        const img = new Image();
        img.onload = () => {
          if (!isCurrent()) return;
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
    [id, updateNodeData, beginRequest]
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
    cancelRequest();
    updateNodeData(id, {
      image: null,
      imageRef: undefined,
      filename: null,
      dimensions: null,
    });
  }, [id, updateNodeData, cancelRequest]);

  // The clip follows the image: stored dimensions first, then whatever loads.
  const dims = nodeData.dimensions;
  const storedAspect = dims && dims.width > 0 && dims.height > 0 ? dims.width / dims.height : null;
  const aspect = nodeData.image
    ? loadedAspect?.src === nodeData.image
      ? loadedAspect.aspect
      : storedAspect ?? 1
    : 1;

  return (
    <NodeShell
      id={id}
      selected={selected}
      media={{ kind: "aspect", aspect }}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
      controls={
        nodeData.image ? (
          <ControlsCard
            id={id}
            summary={{
              title: nodeData.filename || "Image",
              values: <SummaryValues items={[dims ? `${dims.width}×${dims.height}` : null, nodeData.isOptional ? "optional" : null]} />,
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

      {nodeData.image ? (
        <>
          <img
            src={adaptiveImage ?? undefined}
            alt={nodeData.filename || "Uploaded image"}
            className="absolute inset-0 w-full h-full object-cover"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0 && nodeData.image) {
                setLoadedAspect({ src: nodeData.image, aspect: img.naturalWidth / img.naturalHeight });
              }
            }}
          />
          {nodeData.isOptional && (
            <span className="absolute bottom-2 left-2 text-[9px] font-medium text-neutral-300 bg-black/50 px-1.5 py-0.5 rounded">
              Optional
            </span>
          )}
          <button
            onClick={() => downloadMedia(nodeData.image!, "image")}
            aria-label="Download image"
            className="absolute top-2 right-10 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all flex items-center justify-center"
          >
            <Download size={14} strokeWidth={2} />
          </button>
          <button
            onClick={handleRemove}
            aria-label="Remove image"
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 focus:ring-1 focus:ring-red-400 transition-all flex items-center justify-center"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </>
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
          className="absolute inset-0 bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-900/60 transition-colors"
        >
          <div className={`absolute inset-2 rounded-[6px] squircle border border-dashed pointer-events-none ${nodeData.isOptional ? "border-neutral-600" : "border-neutral-700/70"}`} />
          <Upload size={32} strokeWidth={1.5} className="text-neutral-600" />
          <span className="text-xs text-neutral-500 mt-2">{nodeData.isOptional ? "Optional" : "Drop image"}</span>
        </div>
      )}
    </NodeShell>
  );
}
