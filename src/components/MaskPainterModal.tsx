"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Stage, Layer, Line, Image as KonvaImage } from "react-konva";
import Konva from "konva";
import { useMaskInpaintStore } from "@/store/maskInpaintStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { MaskStroke } from "@/types";

export function MaskPainterModal() {
  const {
    isModalOpen,
    sourceNodeId,
    sourceImage,
    strokes,
    brushSize,
    isEraser,
    maskFeather,
    maskExpansion,
    closeModal,
    addStroke,
    clearStrokes,
    undo,
    redo,
    setBrushSize,
    setIsEraser,
    setMaskFeather,
    setMaskExpansion,
    history,
    historyIndex,
  } = useMaskInpaintStore();

  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const incrementModalCount = useWorkflowStore((state) => state.incrementModalCount);
  const decrementModalCount = useWorkflowStore((state) => state.decrementModalCount);

  const stageRef = useRef<Konva.Stage>(null);
  const maskLayerRef = useRef<Konva.Layer>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentStroke, setCurrentStroke] = useState<number[]>([]);
  const [stageDimensions, setStageDimensions] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track modal count for global modal state
  useEffect(() => {
    if (isModalOpen) {
      incrementModalCount();
    }
    return () => {
      if (isModalOpen) {
        decrementModalCount();
      }
    };
  }, [isModalOpen, incrementModalCount, decrementModalCount]);

  // Load source image
  useEffect(() => {
    if (!sourceImage) {
      setImage(null);
      return;
    }

    const img = new window.Image();
    img.onload = () => {
      setImage(img);

      // Calculate stage dimensions to fit image while maintaining aspect ratio
      if (containerRef.current) {
        const containerWidth = containerRef.current.clientWidth - 48; // padding
        const containerHeight = containerRef.current.clientHeight - 200; // toolbar + footer

        const scaleX = containerWidth / img.width;
        const scaleY = containerHeight / img.height;
        const fitScale = Math.min(scaleX, scaleY, 1); // Don't scale up

        setStageDimensions({
          width: img.width * fitScale,
          height: img.height * fitScale,
        });
        setScale(fitScale);
      }
    };
    img.crossOrigin = "anonymous";
    img.src = sourceImage;
  }, [sourceImage]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isModalOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Undo: Ctrl/Cmd + Z
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      // Redo: Ctrl/Cmd + Shift + Z or Ctrl/Cmd + Y
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      // Toggle eraser: E
      if (e.key === "e" || e.key === "E") {
        setIsEraser(!isEraser);
      }
      // Brush size: [ and ]
      if (e.key === "[") {
        setBrushSize(Math.max(1, brushSize - 5));
      }
      if (e.key === "]") {
        setBrushSize(Math.min(100, brushSize + 5));
      }
      // Escape to close
      if (e.key === "Escape") {
        handleClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen, undo, redo, isEraser, setIsEraser, brushSize, setBrushSize]);

  const handleMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      setIsDrawing(true);
      const pos = e.target.getStage()?.getPointerPosition();
      if (pos) {
        // Scale position back to original image coordinates
        setCurrentStroke([pos.x / scale, pos.y / scale]);
      }
    },
    [scale]
  );

  const handleMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (!isDrawing) return;

      const pos = e.target.getStage()?.getPointerPosition();
      if (pos) {
        // Scale position back to original image coordinates
        setCurrentStroke((prev) => [...prev, pos.x / scale, pos.y / scale]);
      }
    },
    [isDrawing, scale]
  );

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || currentStroke.length < 4) {
      setIsDrawing(false);
      setCurrentStroke([]);
      return;
    }

    // Create new stroke
    const stroke: MaskStroke = {
      id: `stroke-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      points: currentStroke,
      brushSize: brushSize / scale, // Store in original image coordinates
      isEraser,
    };

    addStroke(stroke);
    setIsDrawing(false);
    setCurrentStroke([]);
  }, [isDrawing, currentStroke, brushSize, scale, isEraser, addStroke]);

  // Render mask to base64 image
  const renderMaskImage = useCallback((): string | null => {
    if (!image || strokes.length === 0) return null;

    // Create offscreen canvas at original image size
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // Fill with black (preserve areas)
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw strokes
    strokes.forEach((stroke) => {
      ctx.strokeStyle = stroke.isEraser ? "black" : "white";
      ctx.lineWidth = stroke.brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = stroke.isEraser ? "destination-out" : "source-over";

      ctx.beginPath();
      for (let i = 0; i < stroke.points.length; i += 2) {
        const x = stroke.points[i];
        const y = stroke.points[i + 1];
        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    });

    // Apply feathering with blur if needed
    if (maskFeather > 0) {
      ctx.filter = `blur(${maskFeather}px)`;
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext("2d");
      if (tempCtx) {
        tempCtx.filter = `blur(${maskFeather}px)`;
        tempCtx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.filter = "none";
        ctx.drawImage(tempCanvas, 0, 0);
      }
    }

    // Apply mask expansion/contraction
    if (maskExpansion !== 0) {
      // For expansion, we dilate the white areas; for contraction, we erode
      // This is a simplified version - proper morphological operations would be better
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const tempCtx = tempCanvas.getContext("2d");
      if (tempCtx) {
        tempCtx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw multiple times with slight offset to expand/contract
        const iterations = Math.abs(maskExpansion);
        const direction = maskExpansion > 0 ? 1 : -1;

        if (direction > 0) {
          // Expansion: draw multiple copies offset
          for (let dx = -iterations; dx <= iterations; dx++) {
            for (let dy = -iterations; dy <= iterations; dy++) {
              ctx.globalCompositeOperation = "lighter";
              ctx.drawImage(tempCanvas, dx, dy);
            }
          }
        } else {
          // Contraction: invert, expand, invert back
          ctx.filter = "invert(1)";
          ctx.drawImage(tempCanvas, 0, 0);
          ctx.filter = "none";
        }
      }
    }

    return canvas.toDataURL("image/png");
  }, [image, strokes, maskFeather, maskExpansion]);

  const handleSave = useCallback(() => {
    if (!sourceNodeId) return;

    const maskImage = renderMaskImage();

    updateNodeData(sourceNodeId, {
      maskStrokes: strokes,
      maskImage,
      brushSize,
      maskFeather,
      maskExpansion,
    });

    closeModal();
  }, [sourceNodeId, strokes, brushSize, maskFeather, maskExpansion, renderMaskImage, updateNodeData, closeModal]);

  const handleClose = useCallback(() => {
    closeModal();
  }, [closeModal]);

  if (!isModalOpen) return null;

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80">
      <div
        ref={containerRef}
        className="bg-neutral-900 rounded-lg shadow-2xl w-[90vw] h-[90vh] max-w-[1400px] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-700">
          <h2 className="text-sm font-semibold text-neutral-200">Paint Mask for Inpainting</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">
              Paint white areas to edit, black areas will be preserved
            </span>
            <button
              onClick={handleClose}
              className="p-1.5 text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-4 px-4 py-2 border-b border-neutral-800 bg-neutral-850">
          {/* Brush/Eraser toggle */}
          <div className="flex items-center gap-1 bg-neutral-800 rounded-lg p-0.5">
            <button
              onClick={() => setIsEraser(false)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                !isEraser ? "bg-purple-600 text-white" : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Brush
            </button>
            <button
              onClick={() => setIsEraser(true)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                isEraser ? "bg-purple-600 text-white" : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Eraser
            </button>
          </div>

          {/* Brush size */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Size:</span>
            <input
              type="range"
              min="1"
              max="100"
              value={brushSize}
              onChange={(e) => setBrushSize(parseInt(e.target.value))}
              className="w-24 accent-purple-500"
            />
            <span className="text-xs text-neutral-400 w-8">{brushSize}px</span>
          </div>

          {/* Feather */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Feather:</span>
            <input
              type="range"
              min="0"
              max="50"
              value={maskFeather}
              onChange={(e) => setMaskFeather(parseInt(e.target.value))}
              className="w-20 accent-purple-500"
            />
            <span className="text-xs text-neutral-400 w-8">{maskFeather}px</span>
          </div>

          {/* Expansion */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Expand:</span>
            <input
              type="range"
              min="-20"
              max="50"
              value={maskExpansion}
              onChange={(e) => setMaskExpansion(parseInt(e.target.value))}
              className="w-20 accent-purple-500"
            />
            <span className="text-xs text-neutral-400 w-8">{maskExpansion}px</span>
          </div>

          <div className="flex-1" />

          {/* History controls */}
          <button
            onClick={undo}
            disabled={!canUndo}
            className="p-1.5 text-neutral-400 hover:text-neutral-200 disabled:text-neutral-600 disabled:cursor-not-allowed transition-colors"
            title="Undo (Ctrl+Z)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="p-1.5 text-neutral-400 hover:text-neutral-200 disabled:text-neutral-600 disabled:cursor-not-allowed transition-colors"
            title="Redo (Ctrl+Shift+Z)"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6" />
            </svg>
          </button>
          <button
            onClick={clearStrokes}
            disabled={strokes.length === 0}
            className="px-2 py-1 text-xs text-neutral-400 hover:text-red-400 disabled:text-neutral-600 disabled:cursor-not-allowed transition-colors"
            title="Clear all strokes"
          >
            Clear All
          </button>
        </div>

        {/* Canvas area */}
        <div className="flex-1 flex items-center justify-center p-6 overflow-hidden bg-neutral-950/50">
          {image && (
            <Stage
              ref={stageRef}
              width={stageDimensions.width}
              height={stageDimensions.height}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onTouchStart={handleMouseDown}
              onTouchMove={handleMouseMove}
              onTouchEnd={handleMouseUp}
              style={{ cursor: isEraser ? "crosshair" : "crosshair" }}
              className="border border-neutral-700 rounded shadow-lg"
            >
              {/* Background image layer */}
              <Layer>
                <KonvaImage
                  image={image}
                  width={stageDimensions.width}
                  height={stageDimensions.height}
                />
              </Layer>

              {/* Mask layer with semi-transparent overlay */}
              <Layer ref={maskLayerRef} opacity={0.6}>
                {/* Existing strokes */}
                {strokes.map((stroke) => (
                  <Line
                    key={stroke.id}
                    points={stroke.points.map((p, i) => p * scale)}
                    stroke={stroke.isEraser ? "#000000" : "#ff00ff"}
                    strokeWidth={stroke.brushSize * scale}
                    lineCap="round"
                    lineJoin="round"
                    globalCompositeOperation={stroke.isEraser ? "destination-out" : "source-over"}
                  />
                ))}

                {/* Current stroke being drawn */}
                {isDrawing && currentStroke.length >= 2 && (
                  <Line
                    points={currentStroke.map((p) => p * scale)}
                    stroke={isEraser ? "#000000" : "#ff00ff"}
                    strokeWidth={brushSize}
                    lineCap="round"
                    lineJoin="round"
                    globalCompositeOperation={isEraser ? "destination-out" : "source-over"}
                  />
                )}
              </Layer>
            </Stage>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-neutral-700">
          <div className="text-xs text-neutral-500">
            <span className="font-mono bg-neutral-800 px-1.5 py-0.5 rounded mr-1">E</span> Toggle eraser
            <span className="mx-2">|</span>
            <span className="font-mono bg-neutral-800 px-1.5 py-0.5 rounded mr-1">[</span>
            <span className="font-mono bg-neutral-800 px-1.5 py-0.5 rounded mr-1">]</span> Brush size
            <span className="mx-2">|</span>
            <span className="font-mono bg-neutral-800 px-1.5 py-0.5 rounded mr-1">Ctrl+Z</span> Undo
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleClose}
              className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-medium text-white bg-purple-600 hover:bg-purple-500 rounded-lg transition-colors"
            >
              Apply Mask
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
