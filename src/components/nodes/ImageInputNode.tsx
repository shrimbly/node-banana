"use client";

import { useCallback, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { ImageInputNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { useNodeMediaRequest } from "@/hooks/useNodeMediaRequest";
import { downloadMedia } from "@/utils/downloadMedia";
import { ControlsCard, SummaryValues, type SocketSpec } from "./ui";
import { ChevronLeft, ChevronRight, Download, FolderOpen, ImagePlus, Upload, X } from "lucide-react";
import { MAX_BATCH_IMAGES, addToBatch, batchLength, compareFilenames, removeFromBatch, showBatchItem, type ImageBatchItem } from "@/lib/imageBatch";

type ImageInputNodeType = Node<ImageInputNodeData, "imageInput">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "reference", type: "reference", label: "Ref", dataTutorial: "node-input-handle" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image", dataTutorial: "node-output-handle" }];

export function ImageInputNode({ id, data, selected }: NodeProps<ImageInputNodeType>) {
  const nodeData = data;
  const adaptiveImage = useAdaptiveImageSrc(nodeData.image, id);
  useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { beginRequest, cancelRequest } = useNodeMediaRequest();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const setFolderInput = useCallback((input: HTMLInputElement | null) => {
    folderInputRef.current = input;
    // Not in React's typings: lets the picker choose a folder
    input?.setAttribute("webkitdirectory", "");
  }, []);

  const latestData = useRef(nodeData);
  latestData.current = nodeData;
  const batchCount = batchLength(nodeData);
  const batchIndex = nodeData.batchIndex ?? 0;

  /** Read files into the node: the first image of an empty node, or more for its batch. */
  const addFiles = useCallback(
    (fileList: FileList | File[]) => {
      const all = Array.from(fileList);
      const files = all
        .filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type))
        .sort((a, b) => compareFilenames(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
      const tooLarge = files.filter((file) => file.size > 10 * 1024 * 1024);
      const usable = files.filter((file) => file.size <= 10 * 1024 * 1024);
      if (usable.length === 0) {
        alert(all.length > 0 && files.length === 0 ? "Unsupported format. Use PNG, JPG, or WebP." : "Image too large. Maximum size is 10MB.");
        return;
      }

      const isCurrent = beginRequest();
      const read: (ImageBatchItem | null)[] = new Array(usable.length).fill(null);
      let pending = usable.length;
      const commit = () => {
        // The node as it is now: it may have changed while the files were read
        const { data: next, dropped } = addToBatch(latestData.current, read.filter((item): item is ImageBatchItem => item !== null));
        updateNodeData(id, next);
        const skipped = [
          all.length - files.length > 0 ? `${all.length - files.length} not PNG, JPG or WebP` : null,
          tooLarge.length > 0 ? `${tooLarge.length} over 10MB` : null,
          dropped > 0 ? `${dropped} past the limit of ${MAX_BATCH_IMAGES} images` : null,
        ].filter(Boolean);
        if (skipped.length > 0 && all.length > 1) alert(`Some files were skipped: ${skipped.join(", ")}.`);
      };
      usable.forEach((file, index) =>
        readImageFile(file, isCurrent, (item) => {
          read[index] = item;
          pending -= 1;
          if (pending === 0 && isCurrent()) commit();
        })
      );
    },
    [id, updateNodeData, beginRequest]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) addFiles(files);
      e.target.value = "";
    },
    [addFiles]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const showItem = useCallback(
    (index: number) => {
      const shown = showBatchItem(nodeData, index);
      if (shown) updateNodeData(id, shown);
    },
    [id, nodeData, updateNodeData]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRemove = useCallback(() => {
    cancelRequest();
    // In a batch, the shown image leaves it; otherwise the node empties
    updateNodeData(id, removeFromBatch(nodeData, nodeData.batchIndex ?? 0));
  }, [id, nodeData, updateNodeData, cancelRequest]);

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
              values: (
                <SummaryValues
                  items={[
                    batchCount > 1 ? `${batchIndex + 1} of ${batchCount}` : null,
                    dims ? `${dims.width}×${dims.height}` : null,
                    nodeData.isOptional ? "optional" : null,
                  ]}
                />
              ),
            }}
          />
        ) : undefined
      }
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />
      <input ref={setFolderInput} type="file" multiple onChange={handleFileChange} className="hidden" />

      {nodeData.image ? (
        <div className="absolute inset-0" onDrop={handleDrop} onDragOver={handleDragOver}>
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
          {batchCount > 1 && (
            <>
              <span className="absolute bottom-2 right-2 text-[10px] font-medium text-neutral-200 bg-black/60 px-1.5 py-0.5 rounded tabular-nums" title="A run goes through the flow once per image">
                {batchIndex + 1} / {batchCount}
              </span>
              <button
                onClick={() => showItem(batchIndex - 1)}
                aria-label="Previous image"
                className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
              >
                <ChevronLeft size={14} strokeWidth={2} />
              </button>
              <button
                onClick={() => showItem(batchIndex + 1)}
                aria-label="Next image"
                className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
              >
                <ChevronRight size={14} strokeWidth={2} />
              </button>
            </>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            aria-label="Add images to the batch"
            title="Add images: the flow runs once per image"
            className="absolute top-2 right-[72px] w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all flex items-center justify-center"
          >
            <ImagePlus size={14} strokeWidth={2} />
          </button>
          <button
            onClick={() => folderInputRef.current?.click()}
            aria-label="Add a folder of images to the batch"
            title="Add a folder of images"
            className="absolute top-2 right-[104px] w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all flex items-center justify-center"
          >
            <FolderOpen size={14} strokeWidth={2} />
          </button>
          <button
            onClick={() => downloadMedia(nodeData.image!, "image")}
            aria-label="Download image"
            className="absolute top-2 right-10 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all flex items-center justify-center"
          >
            <Download size={14} strokeWidth={2} />
          </button>
          <button
            onClick={handleRemove}
            aria-label={batchCount > 1 ? "Remove this image from the batch" : "Remove image"}
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 focus:ring-1 focus:ring-red-400 transition-all flex items-center justify-center"
          >
            <X size={14} strokeWidth={2} />
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
          className="absolute inset-0 bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-900/60 transition-colors"
        >
          <div className={`absolute inset-2 rounded-[6px] squircle border border-dashed pointer-events-none ${nodeData.isOptional ? "border-neutral-600" : "border-neutral-700/70"}`} />
          <Upload size={32} strokeWidth={1.5} className="text-neutral-600" />
          <span className="text-xs text-neutral-500 mt-2">{nodeData.isOptional ? "Optional" : "Drop image"}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              folderInputRef.current?.click();
            }}
            className="mt-1 text-[11px] text-neutral-500 hover:text-neutral-300 underline-offset-2 hover:underline"
          >
            or choose a folder
          </button>
        </div>
      )}
    </NodeShell>
  );
}

/**
 * Read a picked or dropped image file with its size, then call `done` (null
 * when it cannot be decoded). Stops quietly once `isCurrent` says a newer
 * pick replaced this one.
 */
function readImageFile(file: File, isCurrent: () => boolean, done: (item: ImageBatchItem | null) => void): void {
  const reader = new FileReader();
  reader.onerror = () => done(null);
  reader.onload = (event) => {
    if (!isCurrent()) return;
    const image = event.target?.result as string;
    const img = new Image();
    img.onload = () => {
      if (!isCurrent()) return;
      done({ image, filename: file.name, dimensions: { width: img.width, height: img.height } });
    };
    img.onerror = () => done(null);
    img.src = image;
  };
  reader.readAsDataURL(file);
}
