"use client";

import { useCallback, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { VideoInputNodeData } from "@/types";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { downloadMedia } from "@/utils/downloadMedia";
import { ControlsCard, ScrubRow, SummaryValues, formatTime, type SocketSpec } from "./ui";

type VideoInputNodeType = Node<VideoInputNodeData, "videoInput">;

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
const ACCEPTED_FORMATS = "video/mp4,video/webm,video/quicktime";
const ACCEPTED_MIME_TYPES = ACCEPTED_FORMATS.split(",");

const INPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video" }];

export function VideoInputNode({ id, data, selected }: NodeProps<VideoInputNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Use blob URL for efficient playback of large base64 videos
  const playbackUrl = useVideoBlobUrl(nodeData.video ?? null);

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
      const metadataUrl = URL.createObjectURL(file);
      const video = document.createElement("video");
      video.preload = "metadata";

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;

        video.onloadedmetadata = () => {
          updateNodeData(id, {
            video: base64,
            videoRef: undefined,
            filename: file.name,
            format: file.type,
            duration: video.duration,
            dimensions: { width: video.videoWidth, height: video.videoHeight },
          });
          URL.revokeObjectURL(metadataUrl);
        };
        video.onerror = () => {
          // Still load the file even if metadata extraction fails
          updateNodeData(id, {
            video: base64,
            videoRef: undefined,
            filename: file.name,
            format: file.type,
            duration: null,
            dimensions: null,
          });
          URL.revokeObjectURL(metadataUrl);
        };
        video.src = metadataUrl;
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
      video: null,
      videoRef: undefined,
      filename: null,
      duration: null,
      dimensions: null,
      format: null,
    });
  }, [id, updateNodeData]);

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
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>
          <button
            onClick={handleRemove}
            aria-label="Remove video"
            className="absolute top-2 right-2 w-6 h-6 bg-black/60 hover:bg-red-600/80 text-white rounded text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 focus:ring-1 focus:ring-red-400 transition-all flex items-center justify-center"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
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
          <svg className="w-8 h-8 text-neutral-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
          </svg>
          <span className="text-xs text-neutral-500 mt-2">{nodeData.isOptional ? "Optional" : "Drop video or click"}</span>
        </div>
      )}
    </NodeShell>
  );
}
