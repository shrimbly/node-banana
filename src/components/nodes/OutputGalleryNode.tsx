"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { NodeProps, Node, useReactFlow, type NodeChange } from "@xyflow/react";
import { MediaViewer, type MediaViewerAction, type MediaViewerItem } from "@/components/MediaViewer";
import { NodeShell } from "./NodeShell";
import { ControlsCard, CornerGrip, EmptyState, type SocketSpec, HeightGrip } from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { useAssetStore } from "@/store/assetStore";
import { historyViewerItem } from "@/components/GlobalImageHistory";
import { OutputGalleryNodeData, type ImageHistoryItem, type WorkflowNode } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { useAddMediaNode } from "@/hooks/useAddMediaNode";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import { downloadMedia as downloadMediaUtil } from "@/utils/downloadMedia";
import { Check, Download, ImagePlus, LibraryBig, Menu, Play, Trash2 } from "lucide-react";
import { PaintPending, useHoldLive, useUpdateNodeData } from "./paintMode";
import { rememberVideoPoster, videoPoster } from "@/utils/videoPosterCache";

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "image", type: "image", label: "Image" },
  { id: "video", type: "video", label: "Video" },
];
const EMPTY_HEIGHT = 150;
/** The grid's height until the user drags its grip. */
const GRID_HEIGHT = 240;
const MIN_GRID_HEIGHT = 120;

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

type OutputGalleryNodeType = Node<OutputGalleryNodeData, "outputGallery">;

export function OutputGalleryNode({ id, data, selected }: NodeProps<OutputGalleryNodeType>) {
  const nodeData = data;
  const updateNodeData = useUpdateNodeData();
  const addNode = useWorkflowStore((state) => state.addNode);
  const { getNodes } = useReactFlow();
  const addMediaNode = useAddMediaNode();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  useHoldLive(lightboxIndex !== null);
  // "Add to graph" reads "Added" for the item it just added, as in the history viewer
  const [addedId, setAddedId] = useState<string | null>(null);
  const setAppView = useAssetStore((state) => state.setAppView);
  // The gallery holds bare data URLs; the generation history knows what made
  // each one, so a gallery item that is in the history gets the same prompt
  // and details the history viewer shows for it.
  const globalImageHistory = useWorkflowStore((state) => state.globalImageHistory);
  const historyBySrc = useMemo(() => {
    const map = new Map<string, ImageHistoryItem>();
    for (const entry of globalImageHistory ?? []) if (!map.has(entry.image)) map.set(entry.image, entry);
    return map;
  }, [globalImageHistory]);

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
  // The sources the last extraction finished for: until then a painted copy is not ready (PaintPending).
  const [extractedFor, setExtractedFor] = useState<string[] | null>(null);
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
        const known = videoThumbnailsRef.current.get(src) ?? videoPoster(src)?.thumbnail;
        if (known) {
          newThumbnails.set(src, known);
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
          rememberVideoPoster(src, { thumbnail, duration: video.duration });
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
        setExtractedFor(videoSrcs);
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
    setAddedId(null);
  }, []);

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

    // The new nodes become the selection. Written to the store, which holds every node: on the GPU canvas
    // React Flow holds only the live ones, and the new nodes are not among them.
    if (newNodeIds.length > 0) {
      const store = useWorkflowStore.getState();
      const changes: NodeChange<WorkflowNode>[] = [];
      for (const n of store.nodes) {
        const selected = newNodeIds.includes(n.id);
        if (!!n.selected !== selected) changes.push({ type: "select", id: n.id, selected });
      }
      if (changes.length) store.onNodesChange(changes);
    }
  }, [id, nodeData.images, nodeData.videos, getNodes, addNode]);

  const currentItem = lightboxIndex !== null ? displayMedia[lightboxIndex] : null;
  const gridHeight = nodeData.mediaHeight ?? GRID_HEIGHT;
  // A poster extracted before (by this node mounted earlier, or another) shows in the first render.
  const videoThumbnailOf = (src: string) => videoThumbnails.get(src) ?? videoPoster(src)?.thumbnail;
  const postersPending = extractedFor !== videoSrcs && videoSrcs.some((src) => !videoThumbnailOf(src));

  // The viewer's items: images then videos, as the grid shows them. An item
  // the history knows is described the way the history viewer describes it.
  const viewerItems = useMemo<MediaViewerItem[]>(
    () =>
      displayMedia.map((item, idx) => {
        const id = `${item.type}-${idx}`;
        const known = historyBySrc.get(item.src);
        if (known && (known.kind ?? "image") === item.type) {
          const viewed = historyViewerItem(known);
          return { ...viewed, id, thumb: viewed.thumb ?? videoThumbnails.get(item.src) };
        }
        return {
          id,
          src: item.src,
          kind: item.type,
          thumb: item.type === "video" ? videoThumbnails.get(item.src) : undefined,
          title: `${item.type === "video" ? "Video" : "Image"} ${idx + 1}`,
          details: [["Type", item.type === "video" ? "Video" : "Image"], ["Node", "Output gallery"]],
        };
      }),
    [displayMedia, videoThumbnails, historyBySrc],
  );
  // The same actions, order and tones as the recent-generations viewer, plus
  // the one only a gallery has: taking an item out of it.
  const viewerActions = useMemo<MediaViewerAction[]>(() => {
    if (lightboxIndex === null || !currentItem) return [];
    const itemId = `${currentItem.type}-${lightboxIndex}`;
    const added = addedId === itemId;
    return [
      {
        label: added ? "Added" : "Add to graph",
        icon: added ? Check : ImagePlus,
        tone: added ? "success" : "primary",
        shortcut: "Enter",
        onClick: () => {
          addMediaNode({
            kind: currentItem.type,
            src: currentItem.src,
            filename: currentItem.type === "video" ? `gallery-video-${lightboxIndex + 1}.mp4` : `gallery-image-${lightboxIndex + 1}.png`,
          });
          setAddedId(itemId);
        },
      },
      { label: "Download", icon: Download, shortcut: "d", onClick: downloadMedia },
      { label: "Remove from gallery", icon: Trash2, tone: "danger", onClick: () => removeMedia(lightboxIndex) },
    ];
  }, [lightboxIndex, currentItem, addedId, downloadMedia, addMediaNode, removeMedia]);

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        media={{ kind: "fixed", height: displayMedia.length === 0 ? EMPTY_HEIGHT : gridHeight }}
        inputs={INPUT_SOCKETS}
        minWidth={240}
        // On the card, not in the clipped media, so the corner target can hang past the edge.
        cardChildren={
          displayMedia.length > 0 ? (
            <CornerGrip
              nodeId={id}
              height={gridHeight}
              minHeight={MIN_GRID_HEIGHT}
              minWidth={240}
              label="Resize gallery"
              onHeightChange={(h) => updateNodeData(id, { mediaHeight: h })}
            />
          ) : undefined
        }
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
                    <Menu size={12} strokeWidth={2} />
                    Extract
                  </button>
                ),
              }}
            />
          ) : undefined
        }
      >
        <PaintPending pending={postersPending} />
        {displayMedia.length === 0 ? (
          <EmptyState message="Connect image or video nodes to view gallery" />
        ) : (
          <div className="absolute inset-0 overflow-y-auto nodrag nopan nowheel bg-neutral-900/40">
            {/* Bottom padding keeps the last row clear of the grip. */}
            <div className="grid grid-cols-3 gap-1 p-1 pb-4">
              {displayMedia.map((item, idx) => (
                <button
                  key={idx}
                  onClick={() => openLightbox(idx)}
                  aria-label={item.type === "video" ? `Open video ${idx + 1}` : `Open image ${idx + 1}`}
                  className="aspect-square rounded-[6px] squircle border border-neutral-700 hover:border-neutral-500 overflow-hidden transition-colors relative"
                >
                  {item.type === "video" ? (
                    <>
                      {videoThumbnailOf(item.src) ? (
                        <img
                          src={videoThumbnailOf(item.src)}
                          alt={`Video ${idx + 1}`}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-neutral-800" />
                      )}
                      {/* Video play icon overlay */}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                        <Play size={20} strokeWidth={0} fill="currentColor" className="text-white drop-shadow" />
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
        {displayMedia.length > 0 && (
          <HeightGrip
            height={gridHeight}
            min={MIN_GRID_HEIGHT}
            label="Resize gallery height"
            onChange={(h) => updateNodeData(id, { mediaHeight: h })}
          />
        )}
      </NodeShell>

      {/* Full-screen viewer, shared with the recent-generations drop-down */}
      <MediaViewer
        open={lightboxIndex !== null && currentItem !== null}
        items={viewerItems}
        index={lightboxIndex ?? 0}
        onIndexChange={(index) => {
          setAddedId(null);
          setLightboxIndex(index);
        }}
        onClose={closeLightbox}
        actions={viewerActions}
        label="Gallery"
        footer={
          <button
            type="button"
            onClick={() => {
              closeLightbox();
              setAppView("assets");
            }}
            className="flex h-7 cursor-pointer items-center justify-center gap-2 rounded-md text-[11px] font-medium text-neutral-400 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
          >
            <LibraryBig size={14} strokeWidth={1.75} />
            <span>Open in Assets</span>
          </button>
        }
      />
    </>
  );
}
