"use client";

import { useCallback, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { VideoInputNodeData } from "@/types";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useNodeMediaRequest } from "@/hooks/useNodeMediaRequest";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import { downloadMedia } from "@/utils/downloadMedia";
import { ControlsCard, ScrubRow, SummaryValues, formatTime, type SocketSpec } from "./ui";
import { Download, Video, X } from "lucide-react";
import { useUpdateNodeData } from "./paintMode";

type VideoInputNodeType = Node<VideoInputNodeData, "videoInput">;

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const ACCEPTED_FORMATS = "video/mp4,video/webm,video/quicktime";
const ACCEPTED_MIME_TYPES = ACCEPTED_FORMATS.split(",");

const INPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video" }];

export function VideoInputNode({ id, data, selected }: NodeProps<VideoInputNodeType>) {
  const nodeData = data;
  const updateNodeData = useUpdateNodeData();
  const { beginRequest, cancelRequest } = useNodeMediaRequest(id);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Use blob URL for efficient playback of large base64 videos
  const playbackUrl = useVideoBlobUrl(nodeData.video ?? null);
  const videoRef = useVideoAutoplay(id, playbackUrl);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
        alert("Unsupported format. Use MP4, WebM, or QuickTime video files.");
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        alert("Video file too large. Maximum size is 200MB.");
        return;
      }

      // Extract metadata using a temporary video element pointing at the original file
      const isCurrent = beginRequest();
      const metadataUrl = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";

      const reader = new FileReader();
      reader.onerror = reader.onabort = () => URL.revokeObjectURL(metadataUrl);
      reader.onload = (event) => {
        if (!isCurrent()) {
          URL.revokeObjectURL(metadataUrl);
          return;
        }
        const base64 = event.target?.result as string;

        video.onloadedmetadata = () => {
          URL.revokeObjectURL(metadataUrl);
          if (!isCurrent()) return;
          updateNodeData(id, {
            video: base64,
            videoRef: undefined,
            filename: file.name,
            format: file.type,
            duration: video.duration,
            dimensions: { width: video.videoWidth, height: video.videoHeight },
          });
        };
        video.onerror = () => {
          URL.revokeObjectURL(metadataUrl);
          if (!isCurrent()) return;
          // Still load the file even if metadata extraction fails
          updateNodeData(id, {
            video: base64,
            videoRef: undefined,
            filename: file.name,
            format: file.type,
            duration: null,
            dimensions: null,
          });
        };
        video.src = metadataUrl;
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
      video: null,
      videoRef: undefined,
      filename: null,
      duration: null,
      dimensions: null,
      format: null,
    });
  }, [id, updateNodeData, cancelRequest]);

  const dims = nodeData.dimensions;
  const storedAspect = dims && dims.width > 0 && dims.height > 0 ? dims.width / dims.height : null;
  const aspect = nodeData.video
    ? loadedAspect?.src === nodeData.video
      ? loadedAspect.aspect
      : storedAspect ?? 16 / 9
    : 16 / 9;

  return (
    <NodeShell
      id={id}
      selected={selected}
      media={{ kind: "aspect", aspect }}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
      gap={nodeData.video ? <ScrubRow videoRef={videoRef} src={playbackUrl} className="w-full" /> : undefined}
      controls={
        nodeData.video ? (
          <ControlsCard
            id={id}
            summary={{
              title: nodeData.filename || "Video",
              values: (
                <SummaryValues
                  items={[
                    dims ? `${dims.width}×${dims.height}` : null,
                    nodeData.duration ? formatTime(nodeData.duration) : null,
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
        accept={ACCEPTED_FORMATS}
        onChange={handleFileChange}
        className="hidden"
      />

      {nodeData.video ? (
        <>
          <video
            ref={videoRef}
            src={playbackUrl ?? undefined}
            className="absolute inset-0 w-full h-full object-cover"
            preload="metadata"
            loop
            muted
            playsInline
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth > 0 && v.videoHeight > 0 && nodeData.video) {
                setLoadedAspect({ src: nodeData.video, aspect: v.videoWidth / v.videoHeight });
              }
            }}
          />
          {nodeData.isOptional && (
            <span className="absolute bottom-2 left-2 text-[9px] font-medium text-neutral-300 bg-black/50 px-1.5 py-0.5 rounded">
              Optional
            </span>
          )}
          <button
            onClick={() => downloadMedia(nodeData.video!, "video")}
            aria-label="Download video"
            className="absolute top-2 right-10 w-6 h-6 bg-black/60 hover:bg-black/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all flex items-center justify-center"
          >
            <Download size={14} strokeWidth={2} />
          </button>
          <button
            onClick={handleRemove}
            aria-label="Remove video"
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 focus:ring-1 focus:ring-red-400 transition-all flex items-center justify-center"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </>
      ) : (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload video file"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="absolute inset-0 bg-neutral-900/40 flex flex-col items-center justify-center cursor-pointer hover:bg-neutral-900/60 transition-colors"
        >
          <div className={`absolute inset-2 rounded-[6px] squircle border border-dashed pointer-events-none ${nodeData.isOptional ? "border-neutral-600" : "border-neutral-700/70"}`} />
          <Video size={32} strokeWidth={1.5} className="text-neutral-600" />
          <span className="text-xs text-neutral-500 mt-2">{nodeData.isOptional ? "Optional" : "Drop video or click"}</span>
        </div>
      )}
    </NodeShell>
  );
}
