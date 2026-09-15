"use client";

import { DialogButton } from "@/components/ui/Dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Ellipse, Arrow, Line, Text, Transformer } from "react-konva";
import { useAnnotationStore } from "@/store/annotationStore";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  AnnotationShape,
  RectangleShape,
  CircleShape,
  ArrowShape,
  FreehandShape,
  TextShape,
  ToolType,
} from "@/types";
import Konva from "konva";

const COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#3b82f6",
  "#8b5cf6",
  "#000000",
  "#ffffff",
];

const STROKE_WIDTHS = [2, 4, 8];

export function AnnotationModal() {
  const {
    isModalOpen,
    sourceNodeId,
    sourceImage,
    annotations,
    selectedShapeId,
    currentTool,
    toolOptions,
    closeModal,
    addAnnotation,
    updateAnnotation,
    deleteAnnotation,
    clearAnnotations,
    selectShape,
    setCurrentTool,
    setToolOptions,
    undo,
    redo,
  } = useAnnotationStore();

  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const textInputRef = useRef<HTMLInputElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [currentShape, setCurrentShape] = useState<AnnotationShape | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textInputPosition, setTextInputPosition] = useState<{ x: number; y: number } | null>(null);
  const [pendingTextPosition, setPendingTextPosition] = useState<{ x: number; y: number } | null>(null);
  const textInputCreatedAt = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (transformerRef.current && stageRef.current) {
      const selectedNode = stageRef.current.findOne(`#${selectedShapeId}`);
      if (selectedNode && currentTool === "select") {
        transformerRef.current.nodes([selectedNode]);
      } else {
        transformerRef.current.nodes([]);
      }
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [selectedShapeId, currentTool]);

  useEffect(() => {
    // While the annotation modal is open, destructive shortcuts must NOT reach the canvas
    // (React Flow) behind it — the canvas reads a different isModalOpen flag, so its
    // deleteKeyCode/undo are still live. e.g. Delete would remove the selected NODE, making it
    // vanish on save. Intercept in the CAPTURE phase (fires before React Flow's document handler)
    // and stop propagation for the keys the modal owns. Text-editing keys are left alone — React
    // Flow already ignores key events whose target is a text input.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isModalOpen) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (editingTextId) return; // typing in the text input — let it handle the key
        e.preventDefault();
        e.stopImmediatePropagation();
        if (selectedShapeId) deleteAnnotation(selectedShapeId);
        return;
      }
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (editingTextId) {
          setEditingTextId(null);
          setTextInputPosition(null);
          setPendingTextPosition(null);
        } else {
          closeModal();
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isModalOpen, selectedShapeId, editingTextId, deleteAnnotation, closeModal, undo, redo]);

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
      if (currentTool === "select") {
        const clickedOnEmpty = e.target === e.target.getStage() || e.target.getClassName() === "Image";
        if (clickedOnEmpty) {
          selectShape(null);
        }
        return;
      }

      const pos = getRelativePointerPosition();
      setIsDrawing(true);
      setDrawStart(pos);

      const id = `shape-${Date.now()}`;
      const baseShape = {
        id,
        x: pos.x,
        y: pos.y,
        stroke: toolOptions.strokeColor,
        strokeWidth: toolOptions.strokeWidth,
        opacity: toolOptions.opacity,
      };

      let newShape: AnnotationShape | null = null;

      switch (currentTool) {
        case "rectangle":
          newShape = { ...baseShape, type: "rectangle", width: 0, height: 0, fill: toolOptions.fillColor } as RectangleShape;
          break;
        case "circle":
          newShape = { ...baseShape, type: "circle", radiusX: 0, radiusY: 0, fill: toolOptions.fillColor } as CircleShape;
          break;
        case "arrow":
          newShape = { ...baseShape, type: "arrow", points: [0, 0, 0, 0] } as ArrowShape;
          break;
        case "freehand":
          newShape = { ...baseShape, type: "freehand", points: [0, 0] } as FreehandShape;
          break;
        case "text": {
          // Calculate screen position for the input
          const stage = stageRef.current;
          if (stage) {
            const container = stage.container();
            const stageBox = container?.getBoundingClientRect();
            if (stageBox) {
              const screenX = stageBox.left + pos.x * scale + position.x;
              const screenY = stageBox.top + pos.y * scale + position.y;
              setTextInputPosition({ x: screenX, y: screenY });
              setPendingTextPosition({ x: pos.x, y: pos.y });
            }
          }
          textInputCreatedAt.current = Date.now();
          setEditingTextId("new");
          setIsDrawing(false);
          setTimeout(() => textInputRef.current?.focus(), 0);
          return;
        }
      }

      if (newShape) setCurrentShape(newShape);
    },
    [currentTool, toolOptions, getRelativePointerPosition, selectShape, addAnnotation, scale, position]
  );

  const handleMouseMove = useCallback(() => {
    if (!isDrawing || !currentShape) return;
    const pos = getRelativePointerPosition();

    switch (currentShape.type) {
      case "rectangle": {
        const width = pos.x - drawStart.x;
        const height = pos.y - drawStart.y;
        setCurrentShape({ ...currentShape, x: width < 0 ? pos.x : drawStart.x, y: height < 0 ? pos.y : drawStart.y, width: Math.abs(width), height: Math.abs(height) } as RectangleShape);
        break;
      }
      case "circle": {
        const radiusX = Math.abs(pos.x - drawStart.x) / 2;
        const radiusY = Math.abs(pos.y - drawStart.y) / 2;
        setCurrentShape({ ...currentShape, x: (drawStart.x + pos.x) / 2, y: (drawStart.y + pos.y) / 2, radiusX, radiusY } as CircleShape);
        break;
      }
      case "arrow":
        setCurrentShape({ ...currentShape, points: [0, 0, pos.x - drawStart.x, pos.y - drawStart.y] } as ArrowShape);
        break;
      case "freehand": {
        const freehand = currentShape as FreehandShape;
        setCurrentShape({ ...freehand, points: [...freehand.points, pos.x - drawStart.x, pos.y - drawStart.y] } as FreehandShape);
        break;
      }
    }
  }, [isDrawing, currentShape, drawStart, getRelativePointerPosition]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || !currentShape) return;
    setIsDrawing(false);

    let shouldAdd = true;
    if (currentShape.type === "rectangle") {
      const rect = currentShape as RectangleShape;
      shouldAdd = rect.width > 5 && rect.height > 5;
    } else if (currentShape.type === "circle") {
      const circle = currentShape as CircleShape;
      shouldAdd = circle.radiusX > 5 && circle.radiusY > 5;
    } else if (currentShape.type === "arrow") {
      const arrow = currentShape as ArrowShape;
      const dx = arrow.points[2];
      const dy = arrow.points[3];
      shouldAdd = Math.sqrt(dx * dx + dy * dy) > 10;
    }

    if (shouldAdd) addAnnotation(currentShape);
    setCurrentShape(null);
  }, [isDrawing, currentShape, addAnnotation]);

  const handleWheel = useCallback((e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const scaleBy = 1.1;
    const oldScale = scale;
    const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
    setScale(Math.min(Math.max(newScale, 0.1), 5));
  }, [scale]);

  const flattenImage = useCallback((): string => {
    const stage = stageRef.current;
    if (!stage || !image) return "";

    const tempStage = new Konva.Stage({
      container: document.createElement("div"),
      width: image.width,
      height: image.height,
    });

    const tempLayer = new Konva.Layer();
    tempStage.add(tempLayer);

    const konvaImage = new Konva.Image({ image, width: image.width, height: image.height });
    tempLayer.add(konvaImage);

    annotations.forEach((shape) => {
      let konvaShape: Konva.Shape | null = null;
      switch (shape.type) {
        case "rectangle": {
          const rect = shape as RectangleShape;
          konvaShape = new Konva.Rect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, stroke: rect.stroke, strokeWidth: rect.strokeWidth, fill: rect.fill || undefined, opacity: rect.opacity });
          break;
        }
        case "circle": {
          const circle = shape as CircleShape;
          konvaShape = new Konva.Ellipse({ x: circle.x, y: circle.y, radiusX: circle.radiusX, radiusY: circle.radiusY, stroke: circle.stroke, strokeWidth: circle.strokeWidth, fill: circle.fill || undefined, opacity: circle.opacity });
          break;
        }
        case "arrow": {
          const arrow = shape as ArrowShape;
          konvaShape = new Konva.Arrow({ x: arrow.x, y: arrow.y, points: arrow.points, stroke: arrow.stroke, strokeWidth: arrow.strokeWidth, fill: arrow.stroke, opacity: arrow.opacity });
          break;
        }
        case "freehand": {
          const freehand = shape as FreehandShape;
          konvaShape = new Konva.Line({ x: freehand.x, y: freehand.y, points: freehand.points, stroke: freehand.stroke, strokeWidth: freehand.strokeWidth, opacity: freehand.opacity, lineCap: "round", lineJoin: "round" });
          break;
        }
        case "text": {
          const text = shape as TextShape;
          konvaShape = new Konva.Text({ x: text.x, y: text.y, text: text.text, fontSize: text.fontSize, fill: text.fill, opacity: text.opacity });
          break;
        }
      }
      if (konvaShape) tempLayer.add(konvaShape);
    });

    tempLayer.draw();
    const dataUrl = tempStage.toDataURL({ pixelRatio: 1 });
    tempStage.destroy();
    return dataUrl;
  }, [image, annotations]);

  const handleDone = useCallback(() => {
    if (!sourceNodeId) return;
    const flattenedImage = flattenImage();
    updateNodeData(sourceNodeId, { annotations, outputImage: flattenedImage, outputImageRef: undefined });
    closeModal();
  }, [sourceNodeId, annotations, flattenImage, updateNodeData, closeModal]);

  const renderShape = (shape: AnnotationShape, isPreview = false) => {
    const commonProps = {
      id: shape.id,
      opacity: shape.opacity,
      onClick: () => { if (currentTool === "select") selectShape(shape.id); },
      draggable: currentTool === "select" && !isPreview,
      onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) => { updateAnnotation(shape.id, { x: e.target.x(), y: e.target.y() }); },
    };

    switch (shape.type) {
      case "rectangle": {
        const rect = shape as RectangleShape;
        return <Rect key={shape.id} {...commonProps} x={rect.x} y={rect.y} width={rect.width} height={rect.height} stroke={rect.stroke} strokeWidth={rect.strokeWidth} fill={rect.fill || undefined} />;
      }
      case "circle": {
        const circle = shape as CircleShape;
        return <Ellipse key={shape.id} {...commonProps} x={circle.x} y={circle.y} radiusX={circle.radiusX} radiusY={circle.radiusY} stroke={circle.stroke} strokeWidth={circle.strokeWidth} fill={circle.fill || undefined} />;
      }
      case "arrow": {
        const arrow = shape as ArrowShape;
        return <Arrow key={shape.id} {...commonProps} x={arrow.x} y={arrow.y} points={arrow.points} stroke={arrow.stroke} strokeWidth={arrow.strokeWidth} fill={arrow.stroke} />;
      }
      case "freehand": {
        const freehand = shape as FreehandShape;
        return <Line key={shape.id} {...commonProps} x={freehand.x} y={freehand.y} points={freehand.points} stroke={freehand.stroke} strokeWidth={freehand.strokeWidth} lineCap="round" lineJoin="round" />;
      }
      case "text": {
        const text = shape as TextShape;
        return (
          <Text
            key={shape.id}
            {...commonProps}
            x={text.x}
            y={text.y}
            text={text.text || " "}
            fontSize={text.fontSize}
            fill={text.fill}
            onTransformEnd={(e) => {
              const node = e.target;
              const scaleX = node.scaleX();
              const scaleY = node.scaleY();
              // Reset scale and apply it to fontSize instead
              node.scaleX(1);
              node.scaleY(1);
              const newFontSize = Math.round(text.fontSize * Math.max(scaleX, scaleY));
              updateAnnotation(shape.id, {
                x: node.x(),
                y: node.y(),
                fontSize: newFontSize,
              });
            }}
            onDblClick={() => {
              if (currentTool === "select") {
                const stage = stageRef.current;
                if (stage) {
                  const stageBox = stage.container().getBoundingClientRect();
                  const screenX = stageBox.left + text.x * scale + position.x;
                  const screenY = stageBox.top + text.y * scale + position.y;
                  setTextInputPosition({ x: screenX, y: screenY });
                }
                setEditingTextId(shape.id);
                setTimeout(() => textInputRef.current?.focus(), 0);
              }
            }}
          />
        );
      }
    }
  };

  if (!isModalOpen) return null;

  const tools: { type: ToolType; label: string }[] = [
    { type: "select", label: "Select" },
    { type: "rectangle", label: "Rect" },
    { type: "circle", label: "Circle" },
    { type: "arrow", label: "Arrow" },
    { type: "freehand", label: "Draw" },
    { type: "text", label: "Text" },
  ];

  return (
    <div role="dialog" aria-modal="true" aria-label="Annotate image" className="fixed inset-0 z-100 bg-canvas-bg flex flex-col">
      {/* Top Bar — the dialog header, laid flat across the screen */}
      <div className="h-12 bg-card flex items-center justify-between px-3 border-b border-chrome-border shrink-0">
        <div className="flex items-center gap-1">
          {tools.map((tool) => (
            <button
              key={tool.type}
              onClick={() => setCurrentTool(tool.type)}
              className={`h-7 px-3 text-xs font-medium rounded-md transition-colors ${
                currentTool === tool.type
                  ? "bg-white text-neutral-900"
                  : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700/50"
              }`}
            >
              {tool.label}
            </button>
          ))}

          <div className="w-px h-4 bg-neutral-600 mx-2" />

          <button onClick={undo} className="h-7 px-2.5 text-xs text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700/50 rounded-md transition-colors">Undo</button>
          <button onClick={redo} className="h-7 px-2.5 text-xs text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700/50 rounded-md transition-colors">Redo</button>

          <div className="w-px h-4 bg-neutral-600 mx-2" />

          <button onClick={clearAnnotations} className="h-7 px-2.5 text-xs text-neutral-400 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors">Clear</button>
        </div>

        <div className="flex items-center gap-2">
          <DialogButton variant="ghost" onClick={closeModal}>
            Cancel
          </DialogButton>
          <DialogButton variant="primary" onClick={handleDone}>
            Done
          </DialogButton>
        </div>
      </div>

      {/* Canvas Container */}
      <div ref={containerRef} className="flex-1 overflow-hidden bg-canvas-bg">
        <Stage
          ref={stageRef}
          width={containerRef.current?.clientWidth || 800}
          height={containerRef.current?.clientHeight || 600}
          scaleX={scale}
          scaleY={scale}
          x={position.x}
          y={position.y}
          draggable={currentTool === "select"}
          onDragEnd={(e) => { if (e.target === stageRef.current) setPosition({ x: e.target.x(), y: e.target.y() }); }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          <Layer>
            {image && <KonvaImage image={image} width={stageSize.width} height={stageSize.height} />}
            {annotations.map((shape) => renderShape(shape))}
            {currentShape && renderShape(currentShape, true)}
            <Transformer ref={transformerRef} />
          </Layer>
        </Stage>
      </div>

      {/* Bottom Options Bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-center gap-6 px-4 border-t border-neutral-800">
        {/* Colors */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide mr-1">Color</span>
          {COLORS.map((color) => (
            <button
              key={color}
              onClick={() => setToolOptions({ strokeColor: color })}
              className={`w-6 h-6 rounded-full transition-transform ${
                toolOptions.strokeColor === color ? "ring-2 ring-white ring-offset-2 ring-offset-neutral-900 scale-110" : "hover:scale-105"
              }`}
              style={{ backgroundColor: color }}
            />
          ))}
        </div>

        <div className="w-px h-6 bg-neutral-700" />

        {/* Stroke Width */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-neutral-500 uppercase tracking-wide mr-1">Size</span>
          {STROKE_WIDTHS.map((width) => (
            <button
              key={width}
              onClick={() => setToolOptions({ strokeWidth: width })}
              className={`w-8 h-8 rounded flex items-center justify-center transition-colors ${
                toolOptions.strokeWidth === width ? "bg-neutral-700" : "hover:bg-neutral-800"
              }`}
            >
              <div className="bg-white rounded-full" style={{ width: width * 1.5, height: width * 1.5 }} />
            </button>
          ))}
        </div>

        <div className="w-px h-6 bg-neutral-700" />

        {/* Fill Toggle */}
        <button
          onClick={() => setToolOptions({ fillColor: toolOptions.fillColor ? null : toolOptions.strokeColor })}
          className={`px-3 py-1.5 text-[10px] uppercase tracking-wide rounded transition-colors ${
            toolOptions.fillColor ? "bg-neutral-700 text-white" : "text-neutral-500 hover:text-white"
          }`}
        >
          Fill
        </button>

        {/* Zoom */}
        <div className="flex items-center gap-2 ml-auto">
          <button onClick={() => setScale(Math.max(scale - 0.1, 0.1))} className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm">-</button>
          <span className="text-[10px] text-neutral-400 w-10 text-center">{Math.round(scale * 100)}%</span>
          <button onClick={() => setScale(Math.min(scale + 0.1, 5))} className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm">+</button>
        </div>
      </div>

      {/* Inline Text Input */}
      {editingTextId && textInputPosition && (
        <input
          ref={textInputRef}
          type="text"
          autoFocus
          defaultValue={editingTextId === "new" ? "" : (annotations.find((a) => a.id === editingTextId) as TextShape)?.text || ""}
          className="fixed z-[110] bg-transparent border-none outline-none"
          style={{
            left: textInputPosition.x,
            top: textInputPosition.y,
            fontSize: `${toolOptions.fontSize * scale}px`,
            color: editingTextId === "new" ? toolOptions.strokeColor : ((annotations.find((a) => a.id === editingTextId) as TextShape)?.fill || toolOptions.strokeColor),
            minWidth: "100px",
            caretColor: "white",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const value = (e.target as HTMLInputElement).value;
              if (value.trim()) {
                if (editingTextId === "new" && pendingTextPosition) {
                  // Create new text annotation
                  const newShape: TextShape = {
                    id: `shape-${Date.now()}`,
                    type: "text",
                    x: pendingTextPosition.x,
                    y: pendingTextPosition.y,
                    text: value,
                    fontSize: toolOptions.fontSize,
                    fill: toolOptions.strokeColor,
                    stroke: toolOptions.strokeColor,
                    strokeWidth: toolOptions.strokeWidth,
                    opacity: toolOptions.opacity,
                  };
                  addAnnotation(newShape);
                } else {
                  updateAnnotation(editingTextId, { text: value });
                }
              } else if (editingTextId !== "new") {
                deleteAnnotation(editingTextId);
              }
              setEditingTextId(null);
              setTextInputPosition(null);
              setPendingTextPosition(null);
            }
            if (e.key === "Escape") {
              if (editingTextId !== "new") {
                const currentText = (annotations.find((a) => a.id === editingTextId) as TextShape)?.text;
                if (!currentText) {
                  deleteAnnotation(editingTextId);
                }
              }
              setEditingTextId(null);
              setTextInputPosition(null);
              setPendingTextPosition(null);
            }
          }}
          onBlur={(e) => {
            // Ignore blur events that happen immediately after creation (within 200ms)
            // This prevents the click that created the input from also triggering blur
            if (Date.now() - textInputCreatedAt.current < 200) {
              e.target.focus();
              return;
            }

            const value = e.target.value;
            if (value.trim()) {
              if (editingTextId === "new" && pendingTextPosition) {
                // Create new text annotation
                const newShape: TextShape = {
                  id: `shape-${Date.now()}`,
                  type: "text",
                  x: pendingTextPosition.x,
                  y: pendingTextPosition.y,
                  text: value,
                  fontSize: toolOptions.fontSize,
                  fill: toolOptions.strokeColor,
                  stroke: toolOptions.strokeColor,
                  strokeWidth: toolOptions.strokeWidth,
                  opacity: toolOptions.opacity,
                };
                addAnnotation(newShape);
              } else {
                updateAnnotation(editingTextId, { text: value });
              }
            } else if (editingTextId !== "new") {
              deleteAnnotation(editingTextId);
            }
            setEditingTextId(null);
            setTextInputPosition(null);
            setPendingTextPosition(null);
          }}
        />
      )}
    </div>
  );
}
