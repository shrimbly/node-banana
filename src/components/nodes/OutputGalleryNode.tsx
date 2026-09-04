"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { NodeProps, Node, useReactFlow } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ControlsCard, EmptyState, type SocketSpec } from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { OutputGalleryNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { downloadMedia as downloadMediaUtil } from "@/utils/downloadMedia";

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "image", type: "image", label: "Image" },
  { id: "video", type: "video", label: "Video" },
];
const EMPTY_HEIGHT = 150;
const GRID_HEIGHT = 240;

type MediaItem = { type: "image" | "video"; src: string };

function AdaptiveGalleryThumbnail({ src, alt, nodeId }: { src: string; alt: string; nodeId: string }) {
  const adaptiveSrc = useAdaptiveImageSrc(src, nodeId);
  return (
    <img
      src={adaptiveSrc ?? undefined}
      alt={alt}
      className="w-full h-full object-cover"
    />
  );
}

function LightboxVideo({ src }: { src: string }) {
  const blobUrl = useVideoBlobUrl(src);
  return (
    <video
      src={blobUrl ?? undefined}
      className="max-w-full max-h-[90vh] object-contain rounded"
      controls
      autoPlay
      playsInline
    />
  );
}

type OutputGalleryNodeType = Node<OutputGalleryNodeData, "outputGallery">;

export function OutputGalleryNode({ id, data, selected }: NodeProps<OutputGalleryNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const { getNodes, setNodes } = useReactFlow();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Display stored media only — items are accumulated during workflow execution
  const displayMedia = useMemo(() => {
    const media: MediaItem[] = [
      ...(nodeData.images || []).map((src): MediaItem => ({ type: "image", src })),
      ...(nodeData.videos || []).map((src): MediaItem => ({ type: "video", src })),
    ];
    return media;
  }, [nodeData.images, nodeData.videos]);

  // Extract poster-frame thumbnails for video tiles once, instead of mounting N
  // live <video> decoders. Data-URL video sources force Chrome to continuously
  // re-parse base64; a static <img> poster keeps the grid cheap. Mirrors
  // VideoStitchNode's extraction approach, keyed by the video's data URL.
  const videoSrcs = useMemo(() => nodeData.videos || [], [nodeData.videos]);
  const [videoThumbnails, setVideoThumbnails] = useState<Map<string, string>>(new Map());
  // Ref-based cache so the effect doesn't read stale `videoThumbnails` state
  const videoThumbnailsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    let activeVideo: HTMLVideoElement | null = null;
    let activeBlobUrl: string | null = null;

    const cleanupVideo = (video: HTMLVideoElement, blobUrl?: string | null) => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.onseeked = null;
      video.src = "";
      video.load();
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };

    const extractThumbnails = async () => {
      const newThumbnails = new Map<string, string>();

      for (const src of videoSrcs) {
        if (cancelled) return;

        // Reuse cached thumbnail if we already have one for this exact source
        if (videoThumbnailsRef.current.has(src)) {
          newThumbnails.set(src, videoThumbnailsRef.current.get(src)!);
          continue;
        }

        const video = document.createElement("video");
        activeVideo = video;
        activeBlobUrl = null;
        // Convert data URLs to blob URLs for metadata loading efficiency
        // (avoids re-parsing the full base64 payload into the element).
        let blobUrl: string | null = null;
        if (src.startsWith("data:")) {
          try {
            const blob = await (await fetch(src)).blob();
            if (cancelled) return;
            blobUrl = URL.createObjectURL(blob);
            activeBlobUrl = blobUrl;
          } catch {
            blobUrl = null;
          }
        }
        try {
          video.src = blobUrl ?? src;
          video.crossOrigin = "anonymous";
          video.muted = true;
          video.preload = "metadata";

          await new Promise<void>((resolve, reject) => {
            video.onloadedmetadata = () => resolve();
            video.onerror = () => reject(new Error("Failed to load video"));
          });

          if (cancelled) { cleanupVideo(video, blobUrl); return; }

          const seekTime = video.duration * 0.25;
          video.currentTime = seekTime;

          await Promise.race([
            new Promise<void>((resolve) => {
              video.onseeked = () => resolve();
            }),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error("Seek timeout")), 10_000)
            ),
          ]);

          if (cancelled) { cleanupVideo(video, blobUrl); return; }

          const canvas = document.createElement("canvas");
          const thumbWidth = 160;
          const rawAspectRatio = video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 0;
          const aspectRatio = Number.isFinite(rawAspectRatio) && rawAspectRatio > 0 ? rawAspectRatio : 16 / 9;
          canvas.width = thumbWidth;
          canvas.height = Math.round(thumbWidth / aspectRatio);
          const ctx = canvas.getContext("2d");
          if (!ctx) { cleanupVideo(video, blobUrl); continue; }

          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const thumbnail = canvas.toDataURL("image/jpeg", 0.7);
          newThumbnails.set(src, thumbnail);
        } catch (error) {
          console.warn("Failed to extract gallery video thumbnail:", error);
        }
        cleanupVideo(video, blobUrl);
        activeVideo = null;
        activeBlobUrl = null;
      }

      if (!cancelled) {
        videoThumbnailsRef.current = newThumbnails;
        setVideoThumbnails(newThumbnails);
      }
    };

    extractThumbnails();
    return () => {
      cancelled = true;
      if (activeVideo) {
        cleanupVideo(activeVideo, activeBlobUrl);
        activeVideo = null;
        activeBlobUrl = null;
      }
    };
  }, [videoSrcs]);

  const openLightbox = useCallback((index: number) => {
    setLightboxIndex(index);
  }, []);

  const closeLightbox = useCallback(() => {
    setLightboxIndex(null);
  }, []);

  const navigateLightbox = useCallback(
    (direction: "prev" | "next") => {
      if (lightboxIndex === null) return;

      if (direction === "prev" && lightboxIndex > 0) {
        setLightboxIndex(lightboxIndex - 1);
      } else if (direction === "next" && lightboxIndex < displayMedia.length - 1) {
        setLightboxIndex(lightboxIndex + 1);
      }
    },
    [lightboxIndex, displayMedia.length]
  );

  const downloadMedia = useCallback(() => {
    if (lightboxIndex === null) return;

    const item = displayMedia[lightboxIndex];
    if (!item) return;

    downloadMediaUtil(item.src, item.type).catch((err) =>
      console.error("Gallery download failed:", err)
    );
  }, [lightboxIndex, displayMedia]);

  const removeMedia = useCallback((index: number) => {
    const item = displayMedia[index];
    if (!item) return;

    // displayMedia concatenates images then videos, so the flat lightbox index
    // maps directly to an array index. Deriving it (rather than
    // images.indexOf(item.src)) makes removal exact even when two items share a
    // src — duplicate outputs or empty-string placeholders — and keeps the
    // images/imageRefs (and videos/videoRefs) arrays positionally aligned.
    const imageCount = nodeData.images?.length || 0;

    if (item.type === "image") {
      const images = [...(nodeData.images || [])];
      const imageRefs = [...(nodeData.imageRefs || [])];
      const imgIndex = index;
      if (imgIndex >= 0 && imgIndex < images.length) {
        images.splice(imgIndex, 1);
        if (imgIndex < imageRefs.length) imageRefs.splice(imgIndex, 1);
      }
      updateNodeData(id, { images, imageRefs });
    } else {
      const videos = [...(nodeData.videos || [])];
      const videoRefs = [...(nodeData.videoRefs || [])];
      const vidIndex = index - imageCount;
      if (vidIndex >= 0 && vidIndex < videos.length) {
        videos.splice(vidIndex, 1);
        if (vidIndex < videoRefs.length) videoRefs.splice(vidIndex, 1);
      }
      updateNodeData(id, { videos, videoRefs });
    }

    // Adjust lightbox after removal
    if (lightboxIndex !== null) {
      const newLength = displayMedia.length - 1;
      if (newLength <= 0) {
        setLightboxIndex(null);
      } else if (lightboxIndex >= newLength) {
        setLightboxIndex(newLength - 1);
      }
    }
  }, [displayMedia, nodeData.images, nodeData.imageRefs, nodeData.videos, nodeData.videoRefs, updateNodeData, id, lightboxIndex]);

  const handleExtractToInputNodes = useCallback(() => {
    const galleryNode = getNodes().find((n) => n.id === id);
    if (!galleryNode) return;

    const galleryWidth = galleryNode.measured?.width ?? defaultNodeDimensions.outputGallery.width;
    const startX = galleryNode.position.x + galleryWidth + 100;
    let currentY = galleryNode.position.y;
    const gap = 20;

    const newNodeIds: string[] = [];
    const images = nodeData.images || [];
    const videos = nodeData.videos || [];

    // Reverse so oldest items (end of array) appear at top, newest at bottom
    const reversedImages = [...images].reverse();
    const reversedVideos = [...videos].reverse();

    for (let i = 0; i < reversedImages.length; i++) {
      const nodeId = addNode("imageInput", { x: startX, y: currentY }, { image: reversedImages[i], filename: `gallery-image-${i + 1}.png` });
      newNodeIds.push(nodeId);
      currentY += defaultNodeDimensions.imageInput.height + gap;
    }

    for (let i = 0; i < reversedVideos.length; i++) {
      const nodeId = addNode("videoInput", { x: startX, y: currentY }, { video: reversedVideos[i], filename: `gallery-video-${i + 1}.mp4` });
      newNodeIds.push(nodeId);
      currentY += defaultNodeDimensions.videoInput.height + gap;
    }

    if (newNodeIds.length > 0) {
      setNodes((nodes) =>
        nodes.map((n) => ({
          ...n,
          selected: newNodeIds.includes(n.id),
        }))
      );
    }
  }, [id, nodeData.images, nodeData.videos, getNodes, addNode, setNodes]);

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (lightboxIndex === null) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          closeLightbox();
          break;
        case "ArrowLeft":
          navigateLightbox("prev");
          break;
        case "ArrowRight":
          navigateLightbox("next");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxIndex, closeLightbox, navigateLightbox]);

  const currentItem = lightboxIndex !== null ? displayMedia[lightboxIndex] : null;

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        media={{ kind: "fixed", height: displayMedia.length === 0 ? EMPTY_HEIGHT : GRID_HEIGHT }}
        inputs={INPUT_SOCKETS}
        minWidth={240}
        controls={
          displayMedia.length > 0 ? (
            <ControlsCard
              id={id}
              summary={{
                title: `${displayMedia.length} ${displayMedia.length === 1 ? "item" : "items"}`,
                values: (
                  <button
                    onClick={handleExtractToInputNodes}
                    className="nodrag nopan flex items-center gap-1 h-5 px-1.5 text-node text-neutral-400 hover:text-white hover:bg-neutral-700 rounded-[6px] squircle transition-colors"
                    title="Extract each item as an input node"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                    </svg>
                    Extract
                  </button>
                ),
              }}
            />
          ) : undefined
        }
      >
        {displayMedia.length === 0 ? (
          <EmptyState message="Connect image or video nodes to view gallery" />
        ) : (
          <div className="absolute inset-0 overflow-y-auto nodrag nopan nowheel bg-neutral-900/40">
            <div className="grid grid-cols-3 gap-1 p-1">
              {displayMedia.map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => openLightbox(idx)}
                  aria-label={item.type === "video" ? `Open video ${idx + 1}` : `Open image ${idx + 1}`}
                  className="aspect-square rounded-[6px] squircle border border-neutral-700 hover:border-neutral-500 overflow-hidden transition-colors relative"
                >
                  {item.type === "video" ? (
                    <>
                      {videoThumbnails.get(item.src) ? (
                        <img
                          src={videoThumbnails.get(item.src)}
                          alt={`Video ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-neutral-800" />
                      )}
                      {/* Video play icon overlay */}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                        <svg className="w-5 h-5 text-white drop-shadow" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    </>
                  ) : (
                    <AdaptiveGalleryThumbnail src={item.src} alt={`Image ${idx + 1}`} nodeId={id} />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </NodeShell>

      {/* Lightbox Portal */}
      {lightboxIndex !== null && currentItem && typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
            onClick={closeLightbox}
          >
            <div className="relative max-w-full max-h-full" onClick={(e) => e.stopPropagation()}>
              {currentItem.type === "video" ? (
                <LightboxVideo src={currentItem.src} />
              ) : (
                <img
                  src={currentItem.src}
                  alt={`Gallery image ${lightboxIndex + 1}`}
                  className="max-w-full max-h-[90vh] object-contain rounded"
                />
              )}

              {/* Close button */}
              <button
                onClick={closeLightbox}
                className="absolute top-4 right-4 w-8 h-8 bg-white/10 hover:bg-white/20 rounded text-white text-sm transition-colors flex items-center justify-center"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              {/* Download + Remove buttons */}
              <div className="absolute top-4 left-4 flex gap-1.5">
                <button
                  onClick={downloadMedia}
                  className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-white text-xs font-medium transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download
                </button>
                <button
                  onClick={() => removeMedia(lightboxIndex)}
                  className="px-3 py-1.5 bg-white/10 hover:bg-red-600/80 rounded text-white text-xs font-medium transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                  Remove
                </button>
              </div>

              {/* Left arrow */}
              {lightboxIndex > 0 && (
                <button
                  onClick={() => navigateLightbox("prev")}
                  className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors flex items-center justify-center"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
              )}

              {/* Right arrow */}
              {lightboxIndex < displayMedia.length - 1 && (
                <button
                  onClick={() => navigateLightbox("next")}
                  className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors flex items-center justify-center"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              )}

              {/* Media counter */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-black/50 rounded text-white text-xs font-medium">
                {lightboxIndex + 1} / {displayMedia.length}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
