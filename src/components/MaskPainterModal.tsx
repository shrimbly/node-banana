"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Line, Rect, Ellipse } from "react-konva";
import { useMaskPainterStore } from "@/store/maskPainterStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { MaskElement, MaskStroke, MaskRect, MaskCircle, MaskPainterNodeData } from "@/types";
import Konva from "konva";

/**
 * Full-screen mask painting modal.
 *
 * Users paint brush strokes and draw shapes on a source image.
 * Output is a white-on-black mask (white = area to inpaint).
 * Tools: brush, eraser, rectangle, circle. All shapes are filled by default.
 */
export function MaskPainterModal() {
  const {
    isModalOpen,
    sourceNodeId,
    sourceImage,
    strokes,
    currentTool,
    brushSize,
    closeModal,
    addStroke,
    clear,
    undo,
    redo,
    setTool,
    setBrushSize,
  } = useMaskPainterStore();

  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const nodes = useWorkflowStore((state) => state.nodes);

  const stageRef = useRef<Konva.Stage>(null);
  const overlayLayerRef = useRef<Konva.Layer>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDrawing, setIsDrawing] = useState(false);
  const [currentElement, setCurrentElement] = useState<MaskElement | null>(null);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Determine if the current tool is a freehand tool (brush/eraser) or a shape tool
  const isFreehandTool = currentTool === "brush" || currentTool === "eraser";

  // Load source image
  useEffect(() => {
    if (sourceImage) {
      const img = new window.Image();
      img.onload = () => {
        setImage(img);
        if (containerRef.current) {
          const containerWidth = containerRef.current.clientWidth - 100;
          const containerHeight = containerRef.current.clientHeight - 100;
          const scaleX = containerWidth / img.width;
          const scaleY = containerHeight / img.height;
          const newScale = Math.min(scaleX, scaleY, 1);
          setScale(newScale);
          setStageSize({ width: img.width, height: img.height });
          setPosition({
            x: (containerWidth - img.width * newScale) / 2 + 50,
            y: (containerHeight - img.height * newScale) / 2 + 50,
          });
        }
      };
      img.src = sourceImage;
    }
  }, [sourceImage]);

  // Apply real-time CSS blur to the overlay layer for instant preview
  const currentBlurRadius = sourceNodeId
    ? (nodes.find((n) => n.id === sourceNodeId)?.data as MaskPainterNodeData)?.blurRadius ?? 0
    : 0;

  useEffect(() => {
    const layer = overlayLayerRef.current;
    if (!layer) return;
    const canvas = layer.getCanvas()._canvas;
    if (canvas) {
      canvas.style.filter = currentBlurRadius > 0 ? `blur(${currentBlurRadius * scale}px)` : "";
    }
  }, [currentBlurRadius, scale, strokes, currentElement]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isModalOpen) return;
      if (e.key === "Escape") {
        closeModal();
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key === "z") {
          e.preventDefault();
          if (e.shiftKey) {
            redo();
          } else {
            undo();
          }
        }
      }
      // B for brush, E for eraser, R for rectangle, C for circle
      if (e.key === "b" || e.key === "B") setTool("brush");
      if (e.key === "e" || e.key === "E") setTool("eraser");
      if (e.key === "r" || e.key === "R") setTool("rectangle");
      if (e.key === "c" || e.key === "C") setTool("circle");
      // [ and ] for brush size
      if (e.key === "[") setBrushSize(Math.max(10, brushSize - 10));
      if (e.key === "]") setBrushSize(Math.min(200, brushSize + 10));
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen, brushSize, closeModal, undo, redo, setTool, setBrushSize]);

  const getRelativePointerPosition = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return { x: 0, y: 0 };
    return transform.point(pos);
  }, []);

  const handleMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      // Right-click or middle-click: allow panning
      if (e.evt.button !== 0) return;

      const pos = getRelativePointerPosition();
      setIsDrawing(true);
      setDrawStart(pos);

      // Determine if this is a brush or eraser action
      const tool: "brush" | "eraser" = currentTool === "eraser" ? "eraser" : "brush";

      if (isFreehandTool) {
        // Freehand stroke
        const stroke: MaskStroke = {
          id: `stroke-${Date.now()}`,
          type: "stroke",
          points: [pos.x, pos.y],
          strokeWidth: brushSize,
          tool: currentTool === "eraser" ? "eraser" : "brush",
        };
        setCurrentElement(stroke);
      } else if (currentTool === "rectangle") {
        const rect: MaskRect = {
          id: `rect-${Date.now()}`,
          type: "rectangle",
          x: pos.x,
          y: pos.y,
          width: 0,
          height: 0,
          tool,
        };
        setCurrentElement(rect);
      } else if (currentTool === "circle") {
        const circle: MaskCircle = {
          id: `circle-${Date.now()}`,
          type: "circle",
          x: pos.x,
          y: pos.y,
          radiusX: 0,
          radiusY: 0,
          tool,
        };
        setCurrentElement(circle);
      }
    },
    [currentTool, brushSize, isFreehandTool, getRelativePointerPosition]
  );

  const handleMouseMove = useCallback(() => {
    if (!isDrawing || !currentElement) return;
    const pos = getRelativePointerPosition();

    if (currentElement.type === "stroke") {
      setCurrentElement({
        ...currentElement,
        points: [...currentElement.points, pos.x, pos.y],
      });
    } else if (currentElement.type === "rectangle") {
      const width = pos.x - drawStart.x;
      const height = pos.y - drawStart.y;
      setCurrentElement({
        ...currentElement,
        x: width < 0 ? pos.x : drawStart.x,
        y: height < 0 ? pos.y : drawStart.y,
        width: Math.abs(width),
        height: Math.abs(height),
      });
    } else if (currentElement.type === "circle") {
      const radiusX = Math.abs(pos.x - drawStart.x) / 2;
      const radiusY = Math.abs(pos.y - drawStart.y) / 2;
      setCurrentElement({
        ...currentElement,
        x: (drawStart.x + pos.x) / 2,
        y: (drawStart.y + pos.y) / 2,
        radiusX,
        radiusY,
      });
    }
  }, [isDrawing, currentElement, drawStart, getRelativePointerPosition]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || !currentElement) return;
    setIsDrawing(false);

    let shouldAdd = true;

    if (currentElement.type === "stroke") {
      shouldAdd = currentElement.points.length >= 4;
    } else if (currentElement.type === "rectangle") {
      shouldAdd = currentElement.width > 5 && currentElement.height > 5;
    } else if (currentElement.type === "circle") {
      shouldAdd = currentElement.radiusX > 5 && currentElement.radiusY > 5;
    }

    if (shouldAdd) {
      addStroke(currentElement);
    }
    setCurrentElement(null);
  }, [isDrawing, currentElement, addStroke]);

  const handleWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const scaleBy = 1.1;
      const oldScale = scale;
      const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
      setScale(Math.min(Math.max(newScale, 0.1), 5));
    },
    [scale]
  );

  /**
   * Flatten all elements into a white-on-black mask at source image resolution.
   * Uses a hidden canvas to render strokes and shapes:
   * 1. Fill canvas with black (= keep everything)
   * 2. Draw brush strokes/shapes in white (= area to inpaint)
   * 3. Eraser strokes/shapes drawn in black (= undo paint)
   */
  const flattenMask = useCallback((): string => {
    if (!image) return "";

    const nodeData = sourceNodeId
      ? (nodes.find((n) => n.id === sourceNodeId)?.data as MaskPainterNodeData)
      : null;
    const blurRadius = nodeData?.blurRadius ?? 0;
    const invertMask = nodeData?.invertMask ?? false;

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    // Start with black background (= keep everything)
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw each element
    strokes.forEach((element) => {
      const color = element.tool === "brush" ? "#ffffff" : "#000000";

      if (element.type === "stroke") {
        ctx.beginPath();
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.lineWidth = element.strokeWidth;
        ctx.strokeStyle = color;

        if (element.points.length >= 2) {
          ctx.moveTo(element.points[0], element.points[1]);
          for (let i = 2; i < element.points.length; i += 2) {
            ctx.lineTo(element.points[i], element.points[i + 1]);
          }
        }
        ctx.stroke();
      } else if (element.type === "rectangle") {
        ctx.fillStyle = color;
        ctx.fillRect(element.x, element.y, element.width, element.height);
      } else if (element.type === "circle") {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(
          element.x,
          element.y,
          element.radiusX,
          element.radiusY,
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    });

    // Apply blur if configured
    if (blurRadius > 0) {
      const blurCanvas = document.createElement("canvas");
      blurCanvas.width = canvas.width;
      blurCanvas.height = canvas.height;
      const blurCtx = blurCanvas.getContext("2d");
      if (blurCtx) {
        blurCtx.filter = `blur(${blurRadius}px)`;
        blurCtx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(blurCanvas, 0, 0);
      }
    }

    // Invert if configured
    if (invertMask) {
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 255 - data[i];       // R
        data[i + 1] = 255 - data[i + 1]; // G
        data[i + 2] = 255 - data[i + 2]; // B
        // Alpha stays at 255
      }
      ctx.putImageData(imageData, 0, 0);
    }

    return canvas.toDataURL("image/png");
  }, [image, strokes, sourceNodeId, nodes]);

  const handleDone = useCallback(() => {
    if (!sourceNodeId) return;
    const outputMask = flattenMask();
    updateNodeData(sourceNodeId, {
      strokes,
      outputMask,
    });
    closeModal();
  }, [sourceNodeId, strokes, flattenMask, updateNodeData, closeModal]);

  // Render a mask element as a Konva component.
  // Brush paints black at full opacity on the overlay layer.
  // Eraser uses destination-out to remove previous strokes from the overlay layer.
  const renderElement = (element: MaskElement) => {
    const isBrush = element.tool === "brush";
    const compositeOp = isBrush ? "source-over" : "destination-out";

    if (element.type === "stroke") {
      return (
        <Line
          key={element.id}
          points={element.points}
          stroke="#000000"
          strokeWidth={element.strokeWidth}
          lineCap="round"
          lineJoin="round"
          globalCompositeOperation={compositeOp}
        />
      );
    } else if (element.type === "rectangle") {
      return (
        <Rect
          key={element.id}
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          fill="#000000"
          globalCompositeOperation={compositeOp}
        />
      );
    } else if (element.type === "circle") {
      return (
        <Ellipse
          key={element.id}
          x={element.x}
          y={element.y}
          radiusX={element.radiusX}
          radiusY={element.radiusY}
          fill="#000000"
          globalCompositeOperation={compositeOp}
        />
      );
    }
    return null;
  };

  if (!isModalOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col">
      {/* Top Bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-between px-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5">
          {/* Tool buttons */}
          <button
            onClick={() => setTool("brush")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors ${
              currentTool === "brush"
                ? "bg-white text-neutral-900"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Brush
          </button>
          <button
            onClick={() => setTool("eraser")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors ${
              currentTool === "eraser"
                ? "bg-white text-neutral-900"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Eraser
          </button>
          <button
            onClick={() => setTool("rectangle")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors ${
              currentTool === "rectangle"
                ? "bg-white text-neutral-900"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Rect
          </button>
          <button
            onClick={() => setTool("circle")}
            className={`px-3.5 py-1.5 text-xs font-medium rounded transition-colors ${
              currentTool === "circle"
                ? "bg-white text-neutral-900"
                : "text-neutral-400 hover:text-white"
            }`}
          >
            Circle
          </button>

          <div className="w-px h-6 bg-neutral-700 mx-3" />

          <button
            onClick={undo}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            Undo
          </button>
          <button
            onClick={redo}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            Redo
          </button>

          <div className="w-px h-6 bg-neutral-700 mx-3" />

          <button
            onClick={clear}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-red-400"
          >
            Clear
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={closeModal}
            className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={handleDone}
            className="px-4 py-1.5 text-xs font-medium bg-white text-neutral-900 rounded hover:bg-neutral-200"
          >
            Done
          </button>
        </div>
      </div>

      {/* Canvas Container */}
      <div ref={containerRef} className="flex-1 overflow-hidden bg-neutral-900">
        <Stage
          ref={stageRef}
          width={containerRef.current?.clientWidth || 800}
          height={containerRef.current?.clientHeight || 600}
          scaleX={scale}
          scaleY={scale}
          x={position.x}
          y={position.y}
          draggable={false}
          onDragEnd={(e) => {
            if (e.target === stageRef.current)
              setPosition({ x: e.target.x(), y: e.target.y() });
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
          style={{ cursor: "crosshair" }}
        >
          {/* Layer 1: Source image background */}
          <Layer>
            {image && (
              <KonvaImage
                image={image}
                width={stageSize.width}
                height={stageSize.height}
              />
            )}
          </Layer>
          {/* Layer 2: Mask overlay — separate layer so eraser (destination-out) only affects strokes, not the image */}
          <Layer ref={overlayLayerRef}>
            {strokes.map(renderElement)}
            {currentElement && renderElement(currentElement)}
          </Layer>
        </Stage>
      </div>

      {/* Bottom Options Bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-center gap-6 px-4 border-t border-neutral-800">
        {/* Brush Size Slider (only for freehand tools) */}
        {isFreehandTool && (
          <>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-neutral-500 uppercase tracking-wide">
                Brush Size
              </span>
              <input
                type="range"
                min={10}
                max={200}
                value={brushSize}
                onChange={(e) => setBrushSize(Number(e.target.value))}
                className="w-40 accent-white"
              />
              <span className="text-xs text-neutral-400 w-10 text-right">
                {brushSize}px
              </span>
            </div>

            <div className="w-px h-6 bg-neutral-700" />
          </>
        )}

        {/* Blur Radius Slider */}
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide">
            Blur
          </span>
          <input
            type="range"
            min={0}
            max={200}
            value={
              sourceNodeId
                ? (nodes.find((n) => n.id === sourceNodeId)?.data as MaskPainterNodeData)?.blurRadius ?? 0
                : 0
            }
            onChange={(e) => {
              if (sourceNodeId) {
                updateNodeData(sourceNodeId, { blurRadius: Number(e.target.value) });
              }
            }}
            className="w-28 accent-white"
          />
          <span className="text-xs text-neutral-400 w-10 text-right">
            {sourceNodeId
              ? (nodes.find((n) => n.id === sourceNodeId)?.data as MaskPainterNodeData)?.blurRadius ?? 0
              : 0}px
          </span>
        </div>

        <div className="w-px h-6 bg-neutral-700" />

        {/* Invert Mask Checkbox */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={
              sourceNodeId
                ? (nodes.find((n) => n.id === sourceNodeId)?.data as MaskPainterNodeData)?.invertMask ?? false
                : false
            }
            onChange={(e) => {
              if (sourceNodeId) {
                updateNodeData(sourceNodeId, { invertMask: e.target.checked });
              }
            }}
            className="w-3 h-3 rounded border-neutral-600 accent-white"
          />
          <span className="text-[10px] text-neutral-400 uppercase tracking-wide">Invert</span>
        </label>

        {/* Zoom */}
        <div className="flex items-center gap-2 ml-auto">
          <button
            onClick={() => setScale(Math.max(scale - 0.1, 0.1))}
            className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm"
          >
            -
          </button>
          <span className="text-[10px] text-neutral-400 w-10 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale(Math.min(scale + 0.1, 5))}
            className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm"
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}
