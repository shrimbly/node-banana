"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Line, Text, Transformer } from "react-konva";
import Konva from "konva";
import { useCropperStore, extractRegions, CropRegion } from "@/store/cropperStore";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  detectGrid,
  detectGridWithDimensions,
  splitImage,
  GridDetectionResult,
  GridCell,
  getGridCandidates,
} from "@/utils/gridSplitter";
import { downloadImage, downloadImages, downloadImagesAsZip } from "@/utils/downloadImage";

const GRID_PRESETS = [
  { rows: 2, cols: 2, label: "2×2" },
  { rows: 2, cols: 3, label: "2×3" },
  { rows: 3, cols: 2, label: "3×2" },
  { rows: 3, cols: 3, label: "3×3" },
  { rows: 4, cols: 4, label: "4×4" },
];

const CELL_COLORS = {
  default: "rgba(59, 130, 246, 0.3)",      // blue with transparency
  hover: "rgba(59, 130, 246, 0.5)",
  selected: "rgba(34, 197, 94, 0.4)",       // green for selected
  stroke: "rgba(255, 255, 255, 0.8)",
  strokeSelected: "rgba(34, 197, 94, 1)",
};

export function CropperModal() {
  const {
    isOpen,
    sourceImage,
    sourceNodeId,
    gridResult,
    selectedCells,
    customRows,
    customCols,
    cropMode,
    cropRegions,
    currentRegion,
    selectedRegionId,
    closeModal,
    setImageDimensions,
    setGridResult,
    setCustomGrid,
    toggleCellSelection,
    selectAllCells,
    clearCellSelection,
    setCropMode,
    startRegion,
    updateRegion,
    finishRegion,
    deleteRegion,
    selectRegion,
    clearRegions,
    reset,
  } = useCropperStore();

  const addNode = useWorkflowStore((state) => state.addNode);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addToGlobalHistory = useWorkflowStore((state) => state.addToGlobalHistory);

  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 800, height: 600 });
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [hoveredCell, setHoveredCell] = useState<number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [isAutoDetecting, setIsAutoDetecting] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [suggestedGrids, setSuggestedGrids] = useState<{ rows: number; cols: number; score: number }[]>([]);

  // Load image when modal opens
  useEffect(() => {
    if (sourceImage && isOpen) {
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        setImage(img);
        setImageDimensions({ width: img.width, height: img.height });

        if (containerRef.current) {
          const containerWidth = containerRef.current.clientWidth - 48;
          const containerHeight = containerRef.current.clientHeight - 48;
          const scaleX = containerWidth / img.width;
          const scaleY = containerHeight / img.height;
          const newScale = Math.min(scaleX, scaleY, 1);
          setScale(newScale);
          setStageSize({ width: img.width, height: img.height });
          setPosition({
            x: (containerWidth - img.width * newScale) / 2 + 24,
            y: (containerHeight - img.height * newScale) / 2 + 24,
          });
        }

        // Get grid candidates for suggestions
        const candidates = getGridCandidates(img.width, img.height);
        setSuggestedGrids(
          candidates.slice(0, 5).map((c) => ({
            rows: c.rows,
            cols: c.cols,
            score: c.score,
          }))
        );
      };
      img.src = sourceImage;
    }
  }, [sourceImage, isOpen, setImageDimensions]);

  // Update transformer when selection changes in freeform mode
  useEffect(() => {
    if (transformerRef.current && stageRef.current && cropMode === "freeform") {
      const selectedNode = stageRef.current.findOne(`#${selectedRegionId}`);
      if (selectedNode) {
        transformerRef.current.nodes([selectedNode]);
      } else {
        transformerRef.current.nodes([]);
      }
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [selectedRegionId, cropMode]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      if (e.key === "Escape") {
        closeModal();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedRegionId) {
          deleteRegion(selectedRegionId);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        if (cropMode === "grid" && gridResult) {
          selectAllCells();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, selectedRegionId, cropMode, gridResult, closeModal, deleteRegion, selectAllCells]);

  const getRelativePointerPosition = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const transform = stage.getAbsoluteTransform().copy().invert();
    const pos = stage.getPointerPosition();
    if (!pos) return { x: 0, y: 0 };
    return transform.point(pos);
  }, []);

  const handleAutoDetect = useCallback(async () => {
    if (!sourceImage) return;

    setIsAutoDetecting(true);
    try {
      const result = await detectGrid(sourceImage);
      setGridResult(result);
    } catch (error) {
      console.error("Grid detection failed:", error);
    } finally {
      setIsAutoDetecting(false);
    }
  }, [sourceImage, setGridResult]);

  const handleApplyGrid = useCallback(async (rows: number, cols: number) => {
    if (!sourceImage) return;

    try {
      const result = await detectGridWithDimensions(sourceImage, rows, cols);
      setGridResult(result);
      setCustomGrid(rows, cols);
    } catch (error) {
      console.error("Grid creation failed:", error);
    }
  }, [sourceImage, setGridResult, setCustomGrid]);

  const handleMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (cropMode !== "freeform") return;

      const clickedOnEmpty =
        e.target === e.target.getStage() || e.target.getClassName() === "Image";

      if (clickedOnEmpty) {
        selectRegion(null);
        const pos = getRelativePointerPosition();
        startRegion(pos.x, pos.y);
        setIsDrawing(true);
      }
    },
    [cropMode, getRelativePointerPosition, startRegion, selectRegion]
  );

  const handleMouseMove = useCallback(() => {
    if (!isDrawing || cropMode !== "freeform") return;
    const pos = getRelativePointerPosition();
    updateRegion(pos.x, pos.y);
  }, [isDrawing, cropMode, getRelativePointerPosition, updateRegion]);

  const handleMouseUp = useCallback(() => {
    if (!isDrawing || cropMode !== "freeform") return;
    finishRegion();
    setIsDrawing(false);
  }, [isDrawing, cropMode, finishRegion]);

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

  const handleExtract = useCallback(async (action: "download" | "download-zip" | "add-nodes" | "add-history") => {
    if (!sourceImage) return;

    let imagesToExtract: string[] = [];

    if (cropMode === "grid" && gridResult) {
      // Get selected cells
      const selectedCellList: GridCell[] = [];
      gridResult.cells.forEach((cell, index) => {
        if (selectedCells.has(index)) {
          selectedCellList.push(cell);
        }
      });

      if (selectedCellList.length === 0) {
        alert("Please select at least one cell");
        return;
      }

      // Split the image
      const splitResult = await splitImage(sourceImage, {
        ...gridResult,
        cells: selectedCellList,
      });
      imagesToExtract = splitResult;
    } else if (cropMode === "freeform") {
      if (cropRegions.length === 0) {
        alert("Please draw at least one crop region");
        return;
      }

      imagesToExtract = await extractRegions(sourceImage, cropRegions);
    }

    // Perform the action
    switch (action) {
      case "download":
        downloadImages(imagesToExtract, "cropped");
        break;
      case "download-zip":
        await downloadImagesAsZip(imagesToExtract, "cropped-images.zip");
        break;
      case "add-nodes":
        // Create ImageInput nodes for each extracted image
        imagesToExtract.forEach((img, index) => {
          const nodeId = addNode("imageInput", {
            x: 100 + index * 50,
            y: 100 + index * 50,
          });
          // Load the image to get dimensions
          const tempImg = new Image();
          tempImg.onload = () => {
            updateNodeData(nodeId, {
              image: img,
              filename: `cropped-${index + 1}.png`,
              dimensions: { width: tempImg.width, height: tempImg.height },
            });
          };
          tempImg.src = img;
        });
        closeModal();
        break;
      case "add-history":
        imagesToExtract.forEach((img) => {
          addToGlobalHistory({
            image: img,
            timestamp: Date.now(),
            prompt: "Cropped from grid",
            aspectRatio: "1:1",
            model: "nano-banana",
          });
        });
        closeModal();
        break;
    }

    setShowExportMenu(false);
  }, [
    sourceImage,
    cropMode,
    gridResult,
    selectedCells,
    cropRegions,
    addNode,
    updateNodeData,
    addToGlobalHistory,
    closeModal,
  ]);

  const handleDownloadOriginal = useCallback(() => {
    if (!sourceImage) return;
    downloadImage(sourceImage, { filename: `original-${Date.now()}.png` });
  }, [sourceImage]);

  const renderGridCells = () => {
    if (!gridResult) return null;

    return gridResult.cells.map((cell, index) => {
      const isSelected = selectedCells.has(index);
      const isHovered = hoveredCell === index;

      return (
        <Rect
          key={`cell-${index}`}
          x={cell.x}
          y={cell.y}
          width={cell.width}
          height={cell.height}
          fill={isSelected ? CELL_COLORS.selected : isHovered ? CELL_COLORS.hover : CELL_COLORS.default}
          stroke={isSelected ? CELL_COLORS.strokeSelected : CELL_COLORS.stroke}
          strokeWidth={isSelected ? 2 : 1}
          onClick={() => toggleCellSelection(index)}
          onMouseEnter={() => setHoveredCell(index)}
          onMouseLeave={() => setHoveredCell(null)}
        />
      );
    });
  };

  const renderGridLabels = () => {
    if (!gridResult) return null;

    return gridResult.cells.map((cell, index) => {
      const isSelected = selectedCells.has(index);

      return (
        <Text
          key={`label-${index}`}
          x={cell.x + cell.width / 2 - 8}
          y={cell.y + cell.height / 2 - 8}
          text={String(index + 1)}
          fontSize={16}
          fill={isSelected ? "#22c55e" : "#fff"}
          fontStyle="bold"
          shadowColor="#000"
          shadowBlur={4}
          shadowOffset={{ x: 1, y: 1 }}
          listening={false}
        />
      );
    });
  };

  const renderCropRegions = () => {
    return cropRegions.map((region) => {
      const isSelected = selectedRegionId === region.id;

      return (
        <Rect
          key={region.id}
          id={region.id}
          x={region.x}
          y={region.y}
          width={region.width}
          height={region.height}
          fill="rgba(59, 130, 246, 0.3)"
          stroke={isSelected ? "#22c55e" : "#3b82f6"}
          strokeWidth={isSelected ? 2 : 1}
          draggable
          onClick={() => selectRegion(region.id)}
          onDragEnd={(e) => {
            const { cropRegions } = useCropperStore.getState();
            const updated = cropRegions.map((r) =>
              r.id === region.id ? { ...r, x: e.target.x(), y: e.target.y() } : r
            );
            useCropperStore.setState({ cropRegions: updated });
          }}
        />
      );
    });
  };

  const renderCurrentRegion = () => {
    if (!currentRegion) return null;

    return (
      <Rect
        x={currentRegion.x}
        y={currentRegion.y}
        width={currentRegion.width}
        height={currentRegion.height}
        fill="rgba(59, 130, 246, 0.3)"
        stroke="#3b82f6"
        strokeWidth={1}
        dash={[4, 4]}
        listening={false}
      />
    );
  };

  if (!isOpen) return null;

  const selectedCount = cropMode === "grid" ? selectedCells.size : cropRegions.length;

  return (
    <div className="fixed inset-0 z-[100] bg-neutral-950 flex flex-col">
      {/* Top Bar */}
      <div className="h-14 bg-neutral-900 flex items-center justify-between px-4 border-b border-neutral-800">
        <div className="flex items-center gap-4">
          {/* Mode Toggle */}
          <div className="flex items-center gap-1 bg-neutral-800 rounded-lg p-0.5">
            <button
              onClick={() => setCropMode("grid")}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                cropMode === "grid"
                  ? "bg-white text-neutral-900"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              Grid Split
            </button>
            <button
              onClick={() => setCropMode("freeform")}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                cropMode === "freeform"
                  ? "bg-white text-neutral-900"
                  : "text-neutral-400 hover:text-white"
              }`}
            >
              Freeform Crop
            </button>
          </div>

          <div className="w-px h-6 bg-neutral-700" />

          {/* Grid Controls */}
          {cropMode === "grid" && (
            <>
              <button
                onClick={handleAutoDetect}
                disabled={isAutoDetecting}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded transition-colors"
              >
                {isAutoDetecting ? "Detecting..." : "Auto-detect"}
              </button>

              {GRID_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  onClick={() => handleApplyGrid(preset.rows, preset.cols)}
                  className={`px-2.5 py-1.5 text-xs font-medium rounded transition-colors ${
                    gridResult?.rows === preset.rows && gridResult?.cols === preset.cols
                      ? "bg-neutral-700 text-white"
                      : "text-neutral-400 hover:text-white hover:bg-neutral-800"
                  }`}
                >
                  {preset.label}
                </button>
              ))}

              {/* Custom Grid Input */}
              <div className="flex items-center gap-1.5 text-xs text-neutral-400">
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={customRows}
                  onChange={(e) => setCustomGrid(parseInt(e.target.value) || 1, customCols)}
                  className="w-10 px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-center text-neutral-200"
                />
                <span>×</span>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={customCols}
                  onChange={(e) => setCustomGrid(customRows, parseInt(e.target.value) || 1)}
                  className="w-10 px-1.5 py-1 bg-neutral-800 border border-neutral-700 rounded text-center text-neutral-200"
                />
                <button
                  onClick={() => handleApplyGrid(customRows, customCols)}
                  className="px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 text-white rounded"
                >
                  Apply
                </button>
              </div>

              {gridResult && (
                <>
                  <div className="w-px h-6 bg-neutral-700" />
                  <button
                    onClick={selectAllCells}
                    className="px-2.5 py-1.5 text-xs text-neutral-400 hover:text-white"
                  >
                    Select All
                  </button>
                  <button
                    onClick={clearCellSelection}
                    className="px-2.5 py-1.5 text-xs text-neutral-400 hover:text-white"
                  >
                    Clear
                  </button>
                </>
              )}
            </>
          )}

          {/* Freeform Controls */}
          {cropMode === "freeform" && (
            <>
              <span className="text-xs text-neutral-500">
                Click and drag to create crop regions
              </span>
              {cropRegions.length > 0 && (
                <>
                  <div className="w-px h-6 bg-neutral-700" />
                  <button
                    onClick={clearRegions}
                    className="px-2.5 py-1.5 text-xs text-neutral-400 hover:text-red-400"
                  >
                    Clear All
                  </button>
                </>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Selection info */}
          {selectedCount > 0 && (
            <span className="text-xs text-neutral-400">
              {selectedCount} {cropMode === "grid" ? "cell" : "region"}{selectedCount !== 1 ? "s" : ""} selected
            </span>
          )}

          {/* Download Original */}
          <button
            onClick={handleDownloadOriginal}
            className="px-3 py-1.5 text-xs text-neutral-400 hover:text-white"
          >
            Download Original
          </button>

          <button
            onClick={closeModal}
            className="px-4 py-1.5 text-xs font-medium text-neutral-400 hover:text-white"
          >
            Cancel
          </button>

          {/* Export Menu */}
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={selectedCount === 0}
              className="px-4 py-1.5 text-xs font-medium bg-white hover:bg-neutral-200 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-900 rounded transition-colors flex items-center gap-1.5"
            >
              Extract ({selectedCount})
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showExportMenu && selectedCount > 0 && (
              <div className="absolute right-0 top-full mt-1 bg-neutral-800 border border-neutral-700 rounded-lg shadow-xl py-1 min-w-[180px] z-10">
                <button
                  onClick={() => handleExtract("download")}
                  className="w-full px-3 py-2 text-xs text-left text-neutral-300 hover:bg-neutral-700 hover:text-white flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download Individual Files
                </button>
                <button
                  onClick={() => handleExtract("download-zip")}
                  className="w-full px-3 py-2 text-xs text-left text-neutral-300 hover:bg-neutral-700 hover:text-white flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                  </svg>
                  Download as ZIP
                </button>
                <div className="border-t border-neutral-700 my-1" />
                <button
                  onClick={() => handleExtract("add-nodes")}
                  className="w-full px-3 py-2 text-xs text-left text-neutral-300 hover:bg-neutral-700 hover:text-white flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Add as Image Nodes
                </button>
                <button
                  onClick={() => handleExtract("add-history")}
                  className="w-full px-3 py-2 text-xs text-left text-neutral-300 hover:bg-neutral-700 hover:text-white flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Add to History
                </button>
              </div>
            )}
          </div>
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
          draggable={cropMode !== "freeform" || !isDrawing}
          onDragEnd={(e) => {
            if (e.target === stageRef.current) {
              setPosition({ x: e.target.x(), y: e.target.y() });
            }
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          onWheel={handleWheel}
        >
          <Layer>
            {image && (
              <KonvaImage image={image} width={stageSize.width} height={stageSize.height} />
            )}

            {/* Grid overlay */}
            {cropMode === "grid" && renderGridCells()}
            {cropMode === "grid" && renderGridLabels()}

            {/* Freeform crop regions */}
            {cropMode === "freeform" && renderCropRegions()}
            {cropMode === "freeform" && renderCurrentRegion()}

            {/* Transformer for freeform mode */}
            {cropMode === "freeform" && <Transformer ref={transformerRef} />}
          </Layer>
        </Stage>
      </div>

      {/* Bottom Bar */}
      <div className="h-12 bg-neutral-900 flex items-center justify-between px-4 border-t border-neutral-800">
        <div className="flex items-center gap-4">
          {/* Suggested grids */}
          {cropMode === "grid" && suggestedGrids.length > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-500 uppercase tracking-wide">Suggested:</span>
              {suggestedGrids.slice(0, 3).map((sg, index) => (
                <button
                  key={index}
                  onClick={() => handleApplyGrid(sg.rows, sg.cols)}
                  className="px-2 py-1 text-[10px] text-neutral-400 hover:text-white hover:bg-neutral-800 rounded"
                  title={`Confidence: ${(sg.score * 100).toFixed(0)}%`}
                >
                  {sg.rows}×{sg.cols}
                </button>
              ))}
            </div>
          )}

          {/* Grid info */}
          {cropMode === "grid" && gridResult && (
            <span className="text-[10px] text-neutral-500">
              {gridResult.rows}×{gridResult.cols} grid • {gridResult.cells.length} cells • {(gridResult.confidence * 100).toFixed(0)}% confidence
            </span>
          )}

          {/* Freeform info */}
          {cropMode === "freeform" && (
            <span className="text-[10px] text-neutral-500">
              {cropRegions.length} region{cropRegions.length !== 1 ? "s" : ""} • Press Delete to remove selected
            </span>
          )}
        </div>

        {/* Zoom controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale(Math.max(scale - 0.1, 0.1))}
            className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm"
          >
            -
          </button>
          <span className="text-[10px] text-neutral-400 w-12 text-center">{Math.round(scale * 100)}%</span>
          <button
            onClick={() => setScale(Math.min(scale + 0.1, 5))}
            className="w-7 h-7 rounded text-neutral-400 hover:text-white text-sm"
          >
            +
          </button>
          <button
            onClick={() => {
              if (image && containerRef.current) {
                const containerWidth = containerRef.current.clientWidth - 48;
                const containerHeight = containerRef.current.clientHeight - 48;
                const scaleX = containerWidth / image.width;
                const scaleY = containerHeight / image.height;
                const fitScale = Math.min(scaleX, scaleY, 1);
                setScale(fitScale);
                setPosition({
                  x: (containerWidth - image.width * fitScale) / 2 + 24,
                  y: (containerHeight - image.height * fitScale) / 2 + 24,
                });
              }
            }}
            className="px-2 py-1 text-[10px] text-neutral-400 hover:text-white"
          >
            Fit
          </button>
        </div>
      </div>

      {/* Click outside to close export menu */}
      {showExportMenu && (
        <div
          className="fixed inset-0 z-[99]"
          onClick={() => setShowExportMenu(false)}
        />
      )}
    </div>
  );
}
