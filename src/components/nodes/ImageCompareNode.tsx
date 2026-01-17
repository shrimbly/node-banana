"use client";

import { useCallback, useRef, useState, useEffect, MouseEvent as ReactMouseEvent } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { ImageCompareNodeData } from "@/types";

type ImageCompareNodeType = Node<ImageCompareNodeData, "imageCompare">;

export function ImageCompareNode({ id, data, selected }: NodeProps<ImageCompareNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPosition, setLastPanPosition] = useState({ x: 0, y: 0 });
  const [showLightbox, setShowLightbox] = useState(false);

  const { imageA, imageB, sliderPosition, zoomLevel, panPosition } = nodeData;

  // Handle slider drag
  const handleSliderDrag = useCallback(
    (e: ReactMouseEvent | globalThis.MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const percentage = (x / rect.width) * 100;
      updateNodeData(id, { sliderPosition: percentage });
    },
    [id, updateNodeData]
  );

  // Mouse handlers for slider
  const handleMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      handleSliderDrag(e);
    },
    [handleSliderDrag]
  );

  // Handle panning when zoomed
  const handlePanStart = useCallback(
    (e: ReactMouseEvent) => {
      if (zoomLevel <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      setIsPanning(true);
      setLastPanPosition({ x: e.clientX, y: e.clientY });
    },
    [zoomLevel]
  );

  // Global mouse move and up handlers
  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (isDragging) {
        handleSliderDrag(e);
      }
      if (isPanning) {
        const deltaX = e.clientX - lastPanPosition.x;
        const deltaY = e.clientY - lastPanPosition.y;
        updateNodeData(id, {
          panPosition: {
            x: panPosition.x + deltaX,
            y: panPosition.y + deltaY,
          },
        });
        setLastPanPosition({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsPanning(false);
    };

    if (isDragging || isPanning) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isPanning, handleSliderDrag, lastPanPosition, panPosition, id, updateNodeData]);

  // Handle zoom with mouse wheel
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      const newZoom = Math.max(1, Math.min(4, zoomLevel + delta));

      // Reset pan when zooming back to 1x
      if (newZoom === 1) {
        updateNodeData(id, { zoomLevel: newZoom, panPosition: { x: 0, y: 0 } });
      } else {
        updateNodeData(id, { zoomLevel: newZoom });
      }
    },
    [id, zoomLevel, updateNodeData]
  );

  // Swap images
  const handleSwap = useCallback(() => {
    updateNodeData(id, {
      imageA: imageB,
      imageB: imageA,
    });
  }, [id, imageA, imageB, updateNodeData]);

  // Reset zoom
  const handleResetZoom = useCallback(() => {
    updateNodeData(id, {
      zoomLevel: 1,
      panPosition: { x: 0, y: 0 },
    });
  }, [id, updateNodeData]);

  const hasImages = imageA && imageB;
  const hasOneImage = imageA || imageB;

  // Image transform style for zoom and pan
  const imageTransform = {
    transform: `scale(${zoomLevel}) translate(${panPosition.x / zoomLevel}px, ${panPosition.y / zoomLevel}px)`,
    transformOrigin: "center center",
  };

  return (
    <>
      <BaseNode
        id={id}
        title="Compare"
        customTitle={nodeData.customTitle}
        comment={nodeData.comment}
        onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
        onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
        onExpand={() => setShowLightbox(true)}
        selected={selected}
        className="min-w-[280px]"
        minWidth={280}
        minHeight={200}
      >
        {/* Input handles for two images */}
        <Handle
          type="target"
          position={Position.Left}
          id="imageA"
          data-handletype="image"
          style={{ top: "35%" }}
          title="Image A (Before)"
        />
        <Handle
          type="target"
          position={Position.Left}
          id="imageB"
          data-handletype="image"
          style={{ top: "65%" }}
          title="Image B (After)"
        />

        <div className="flex-1 flex flex-col min-h-0 gap-2">
          {/* Comparison container */}
          <div
            ref={containerRef}
            className={`relative flex-1 min-h-[160px] overflow-hidden rounded border border-neutral-700 ${
              zoomLevel > 1 ? "cursor-grab" : ""
            } ${isPanning ? "cursor-grabbing" : ""}`}
            onWheel={handleWheel}
            onMouseDown={hasImages ? handlePanStart : undefined}
          >
            {hasImages ? (
              <>
                {/* Image A (full width, underneath) */}
                <div
                  className="absolute inset-0 overflow-hidden"
                  style={imageTransform}
                >
                  <img
                    src={imageA}
                    alt="Image A"
                    className="w-full h-full object-contain pointer-events-none"
                    draggable={false}
                  />
                </div>

                {/* Image B (clipped by slider) */}
                <div
                  className="absolute inset-0 overflow-hidden"
                  style={{
                    clipPath: `inset(0 0 0 ${sliderPosition}%)`,
                    ...imageTransform,
                  }}
                >
                  <img
                    src={imageB}
                    alt="Image B"
                    className="w-full h-full object-contain pointer-events-none"
                    draggable={false}
                  />
                </div>

                {/* Slider line and handle */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-white shadow-lg cursor-ew-resize z-10"
                  style={{ left: `${sliderPosition}%`, transform: "translateX(-50%)" }}
                  onMouseDown={handleMouseDown}
                >
                  {/* Slider handle */}
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-6 h-6 bg-white rounded-full shadow-lg flex items-center justify-center">
                    <svg className="w-4 h-4 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
                    </svg>
                  </div>
                </div>

                {/* Labels */}
                <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[9px] text-white font-medium">
                  A
                </div>
                <div className="absolute top-1 right-1 px-1.5 py-0.5 bg-black/60 rounded text-[9px] text-white font-medium">
                  B
                </div>

                {/* Zoom indicator */}
                {zoomLevel > 1 && (
                  <div className="absolute bottom-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[9px] text-white font-medium">
                    {Math.round(zoomLevel * 100)}%
                  </div>
                )}
              </>
            ) : hasOneImage ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-center p-4">
                  <img
                    src={imageA || imageB || ""}
                    alt="Single image"
                    className="max-h-32 mx-auto mb-2 rounded"
                  />
                  <span className="text-neutral-500 text-[10px]">
                    Connect {imageA ? "Image B" : "Image A"} to compare
                  </span>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <span className="text-neutral-500 text-[10px]">Connect two images to compare</span>
              </div>
            )}
          </div>

          {/* Controls */}
          {hasImages && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleSwap}
                className="flex-1 py-1 px-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-[10px] font-medium rounded transition-colors flex items-center justify-center gap-1"
                title="Swap images"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                </svg>
                Swap
              </button>
              {zoomLevel > 1 && (
                <button
                  onClick={handleResetZoom}
                  className="py-1 px-2 bg-neutral-700 hover:bg-neutral-600 text-neutral-200 text-[10px] font-medium rounded transition-colors"
                  title="Reset zoom"
                >
                  Reset
                </button>
              )}
            </div>
          )}

          {/* Slider position indicator */}
          {hasImages && (
            <div className="text-[9px] text-neutral-500 text-center">
              Slider: {Math.round(sliderPosition)}% • Scroll to zoom
            </div>
          )}
        </div>
      </BaseNode>

      {/* Lightbox Modal for expanded view */}
      {showLightbox && hasImages && (
        <LightboxCompare
          imageA={imageA}
          imageB={imageB}
          sliderPosition={sliderPosition}
          onSliderChange={(pos) => updateNodeData(id, { sliderPosition: pos })}
          onSwap={handleSwap}
          onClose={() => setShowLightbox(false)}
        />
      )}
    </>
  );
}

// Lightbox component for full-screen comparison
function LightboxCompare({
  imageA,
  imageB,
  sliderPosition,
  onSliderChange,
  onSwap,
  onClose,
}: {
  imageA: string;
  imageB: string;
  sliderPosition: number;
  onSliderChange: (pos: number) => void;
  onSwap: () => void;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localSliderPosition, setLocalSliderPosition] = useState(sliderPosition);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [panPosition, setPanPosition] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [lastPanPos, setLastPanPos] = useState({ x: 0, y: 0 });

  // Sync local slider with prop
  useEffect(() => {
    setLocalSliderPosition(sliderPosition);
  }, [sliderPosition]);

  const handleSliderDrag = useCallback((e: globalThis.MouseEvent | ReactMouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const percentage = (x / rect.width) * 100;
    setLocalSliderPosition(percentage);
    onSliderChange(percentage);
  }, [onSliderChange]);

  const handleMouseDown = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    handleSliderDrag(e);
  }, [handleSliderDrag]);

  const handlePanStart = useCallback((e: ReactMouseEvent) => {
    if (zoomLevel <= 1) return;
    e.preventDefault();
    setIsPanning(true);
    setLastPanPos({ x: e.clientX, y: e.clientY });
  }, [zoomLevel]);

  useEffect(() => {
    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (isDragging) {
        handleSliderDrag(e);
      }
      if (isPanning) {
        const deltaX = e.clientX - lastPanPos.x;
        const deltaY = e.clientY - lastPanPos.y;
        setPanPosition(prev => ({
          x: prev.x + deltaX,
          y: prev.y + deltaY,
        }));
        setLastPanPos({ x: e.clientX, y: e.clientY });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsPanning(false);
    };

    if (isDragging || isPanning) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isPanning, handleSliderDrag, lastPanPos]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    const newZoom = Math.max(1, Math.min(4, zoomLevel + delta));
    if (newZoom === 1) {
      setPanPosition({ x: 0, y: 0 });
    }
    setZoomLevel(newZoom);
  }, [zoomLevel]);

  // Keyboard handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "s") {
        onSwap();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, onSwap]);

  const imageTransform = {
    transform: `scale(${zoomLevel}) translate(${panPosition.x / zoomLevel}px, ${panPosition.y / zoomLevel}px)`,
    transformOrigin: "center center",
  };

  return (
    <div
      className="fixed inset-0 bg-black/95 z-[100] flex flex-col"
      onClick={onClose}
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 text-white" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium">Image Comparison</span>
          <span className="text-xs text-neutral-400">
            Slider: {Math.round(localSliderPosition)}% • Zoom: {Math.round(zoomLevel * 100)}%
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onSwap}
            className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-sm transition-colors"
          >
            Swap (S)
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded text-sm transition-colors"
          >
            Close (Esc)
          </button>
        </div>
      </div>

      {/* Comparison area */}
      <div
        ref={containerRef}
        className={`flex-1 relative overflow-hidden ${zoomLevel > 1 ? "cursor-grab" : ""} ${isPanning ? "cursor-grabbing" : ""}`}
        onClick={e => e.stopPropagation()}
        onWheel={handleWheel}
        onMouseDown={handlePanStart}
      >
        {/* Image A */}
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden" style={imageTransform}>
          <img
            src={imageA}
            alt="Image A"
            className="max-w-full max-h-full object-contain pointer-events-none"
            draggable={false}
          />
        </div>

        {/* Image B (clipped) */}
        <div
          className="absolute inset-0 flex items-center justify-center overflow-hidden"
          style={{
            clipPath: `inset(0 0 0 ${localSliderPosition}%)`,
            ...imageTransform,
          }}
        >
          <img
            src={imageB}
            alt="Image B"
            className="max-w-full max-h-full object-contain pointer-events-none"
            draggable={false}
          />
        </div>

        {/* Slider line and handle */}
        <div
          className="absolute top-0 bottom-0 w-1 bg-white shadow-lg cursor-ew-resize z-10"
          style={{ left: `${localSliderPosition}%`, transform: "translateX(-50%)" }}
          onMouseDown={handleMouseDown}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-white rounded-full shadow-lg flex items-center justify-center">
            <svg className="w-6 h-6 text-neutral-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4m0 6l-4 4-4-4" />
            </svg>
          </div>
        </div>

        {/* Labels */}
        <div className="absolute top-4 left-4 px-2 py-1 bg-black/60 rounded text-sm text-white font-medium">
          A (Before)
        </div>
        <div className="absolute top-4 right-4 px-2 py-1 bg-black/60 rounded text-sm text-white font-medium">
          B (After)
        </div>
      </div>

      {/* Footer hint */}
      <div className="p-2 text-center text-xs text-neutral-500">
        Drag slider to compare • Scroll to zoom • Drag to pan when zoomed
      </div>
    </div>
  );
}
