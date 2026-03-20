"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Line } from "react-konva";
import Konva from "konva";

interface InpaintMaskModalProps {
  isOpen: boolean;
  sourceImage: string;
  existingMask: string | null;
  brushSize: number;
  onClose: () => void;
  onSave: (maskDataUrl: string, brushSize: number) => void;
}

const BRUSH_SIZES = [10, 20, 40, 60, 100];

export function InpaintMaskModal({
  isOpen,
  sourceImage,
  existingMask,
  brushSize: initialBrushSize,
  onClose,
  onSave,
}: InpaintMaskModalProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [maskImage, setMaskImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const isDrawingRef = useRef(false);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [brushSize, setBrushSize] = useState(initialBrushSize);
  const [lines, setLines] = useState<{ points: number[]; stroke: string; strokeWidth: number }[]>([]);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);

  // Load source image
  useEffect(() => {
    if (!sourceImage) return;
    const img = new window.Image();
    img.onload = () => {
      setImage(img);
      if (containerRef.current) {
        const cw = containerRef.current.clientWidth - 40;
        const ch = containerRef.current.clientHeight - 40;
        const s = Math.min(cw / img.width, ch / img.height, 1);
        setScale(s);
        setStageSize({ width: Math.round(img.width * s), height: Math.round(img.height * s) });
      }
    };
    img.src = sourceImage;
  }, [sourceImage]);

  // Load existing mask
  useEffect(() => {
    if (!existingMask) {
      setMaskImage(null);
      setLines([]);
      return;
    }
    const img = new window.Image();
    img.onload = () => setMaskImage(img);
    img.src = existingMask;
  }, [existingMask]);

  const getPointerPos = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return null;
    const pos = stage.getPointerPosition();
    if (!pos) return null;
    return { x: pos.x / scale, y: pos.y / scale };
  }, [scale]);

  const handleMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    // Only draw with left mouse button (button 0) or touch
    if (e.evt instanceof MouseEvent && e.evt.button !== 0) return;
    const pos = getPointerPos();
    if (!pos) return;
    isDrawingRef.current = true;
    const stroke = tool === "brush" ? "#ffffff" : "#000000";
    setLines((prev) => [...prev, { points: [pos.x, pos.y], stroke, strokeWidth: brushSize }]);
  }, [getPointerPos, tool, brushSize]);

  const handleMouseMove = useCallback(() => {
    const pos = getPointerPos();
    if (!pos) return;
    setCursorPos({ x: pos.x * scale, y: pos.y * scale });
    if (!isDrawingRef.current) return;
    setLines((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last) {
        updated[updated.length - 1] = { ...last, points: [...last.points, pos.x, pos.y] };
      }
      return updated;
    });
  }, [getPointerPos, scale]);

  const handleMouseUp = useCallback(() => {
    isDrawingRef.current = false;
  }, []);

  const handleClear = useCallback(() => {
    setLines([]);
    setMaskImage(null);
  }, []);

  const handleSave = useCallback(() => {
    if (!image) return;

    // Render mask to a separate canvas (black background with white brush strokes)
    const tempStage = new Konva.Stage({
      container: document.createElement("div"),
      width: image.width,
      height: image.height,
    });
    const tempLayer = new Konva.Layer();
    tempStage.add(tempLayer);

    // Black background
    tempLayer.add(
      new Konva.Rect({
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
        fill: "#000000",
      })
    );

    // Draw existing mask if present
    if (maskImage) {
      tempLayer.add(
        new Konva.Image({
          image: maskImage,
          x: 0,
          y: 0,
          width: image.width,
          height: image.height,
        })
      );
    }

    // Draw brush strokes
    for (const line of lines) {
      tempLayer.add(
        new Konva.Line({
          points: line.points,
          stroke: line.stroke,
          strokeWidth: line.strokeWidth,
          lineCap: "round",
          lineJoin: "round",
          globalCompositeOperation: line.stroke === "#000000" ? "destination-out" : "source-over",
        })
      );
    }

    tempLayer.draw();
    const maskDataUrl = tempStage.toDataURL({ mimeType: "image/png" });
    tempStage.destroy();

    onSave(maskDataUrl, brushSize);
  }, [image, maskImage, lines, brushSize, onSave]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "b") setTool("brush");
      if (e.key === "e") setTool("eraser");
      if (e.key === "[") setBrushSize((prev) => BRUSH_SIZES[Math.max(0, BRUSH_SIZES.indexOf(prev) - 1)] ?? prev);
      if (e.key === "]") setBrushSize((prev) => BRUSH_SIZES[Math.min(BRUSH_SIZES.length - 1, BRUSH_SIZES.indexOf(prev) + 1)] ?? prev);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  if (!isOpen) return null;

  const hasStrokes = lines.length > 0 || maskImage !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div
        className="bg-neutral-900 rounded-lg border border-neutral-700 flex flex-col max-w-[90vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-neutral-700">
          <span className="text-sm text-neutral-300 font-medium">Inpaint Mask</span>
          <div className="w-px h-5 bg-neutral-700" />

          {/* Tool selection */}
          <button
            className={`px-2 py-1 rounded text-xs ${tool === "brush" ? "bg-white text-black" : "bg-neutral-700 text-neutral-300"}`}
            onClick={() => setTool("brush")}
          >
            Brush (B)
          </button>
          <button
            className={`px-2 py-1 rounded text-xs ${tool === "eraser" ? "bg-white text-black" : "bg-neutral-700 text-neutral-300"}`}
            onClick={() => setTool("eraser")}
          >
            Eraser (E)
          </button>

          <div className="w-px h-5 bg-neutral-700" />

          {/* Brush size */}
          <span className="text-xs text-neutral-400">Size [ ]:</span>
          {BRUSH_SIZES.map((s) => (
            <button
              key={s}
              className={`w-7 h-7 rounded flex items-center justify-center ${brushSize === s ? "bg-white text-black" : "bg-neutral-700 text-neutral-300"}`}
              onClick={() => setBrushSize(s)}
            >
              <span className="text-xs">{s}</span>
            </button>
          ))}

          <div className="flex-1" />

          <button className="px-2 py-1 rounded text-xs bg-neutral-700 text-neutral-300 hover:bg-neutral-600" onClick={handleClear}>
            Clear
          </button>
          <button
            className={`px-3 py-1 rounded text-xs ${hasStrokes ? "bg-blue-600 text-white hover:bg-blue-500" : "bg-neutral-700 text-neutral-400 cursor-not-allowed"}`}
            onClick={handleSave}
            disabled={!hasStrokes}
          >
            Save Mask
          </button>
          <button className="px-2 py-1 rounded text-xs bg-neutral-700 text-neutral-300 hover:bg-neutral-600" onClick={onClose}>
            Cancel
          </button>
        </div>

        {/* Canvas */}
        <div ref={containerRef} className="relative overflow-hidden p-5" style={{ minWidth: 400, minHeight: 300 }}>
          <Stage
            ref={stageRef}
            width={stageSize.width}
            height={stageSize.height}
            scaleX={scale}
            scaleY={scale}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { isDrawingRef.current = false; setCursorPos(null); }}
            onTouchStart={handleMouseDown}
            onTouchMove={handleMouseMove}
            onTouchEnd={handleMouseUp}
            style={{ cursor: "none" }}
          >
            <Layer>
              {/* Source image at lower opacity */}
              {image && <KonvaImage image={image} x={0} y={0} opacity={0.5} />}

              {/* Existing mask overlay */}
              {maskImage && <KonvaImage image={maskImage} x={0} y={0} opacity={0.4} />}

              {/* Drawn lines */}
              {lines.map((line, i) => (
                <Line
                  key={i}
                  points={line.points}
                  stroke={line.stroke}
                  strokeWidth={line.strokeWidth}
                  lineCap="round"
                  lineJoin="round"
                  opacity={0.6}
                  globalCompositeOperation={line.stroke === "#000000" ? "destination-out" : "source-over"}
                />
              ))}
            </Layer>
          </Stage>

          {/* Custom cursor */}
          {cursorPos && (
            <div
              className="pointer-events-none absolute rounded-full border-2 border-white/80"
              style={{
                left: cursorPos.x - (brushSize * scale) / 2 + 20,
                top: cursorPos.y - (brushSize * scale) / 2 + 20,
                width: brushSize * scale,
                height: brushSize * scale,
              }}
            />
          )}
        </div>

        <div className="px-4 py-2 border-t border-neutral-700 text-xs text-neutral-500">
          Hold mouse button to paint. White = area to regenerate. Shortcuts: B=brush, E=eraser, [/]=brush size, Esc=cancel
        </div>
      </div>
    </div>
  );
}
