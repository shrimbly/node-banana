"use client";

import { useCallback, useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { ColorPaletteNodeData, PaletteColor } from "@/types";
import { extractPalette, applyPalette } from "@/utils/colorPalette";

type ColorPaletteNodeType = Node<ColorPaletteNodeData, "colorPalette">;

export function ColorPaletteNode({ id, data, selected }: NodeProps<ColorPaletteNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [isExtracting, setIsExtracting] = useState(false);

  // Extract palette when source image changes (in extract mode)
  const handleExtract = useCallback(async () => {
    if (!nodeData.sourceImage || isExtracting) return;

    setIsExtracting(true);
    updateNodeData(id, { status: "loading", error: null });

    try {
      const palette = await extractPalette(nodeData.sourceImage, nodeData.colorCount);
      updateNodeData(id, {
        extractedPalette: palette,
        status: "complete",
        error: null,
      });
    } catch (error) {
      updateNodeData(id, {
        status: "error",
        error: error instanceof Error ? error.message : "Failed to extract palette",
      });
    } finally {
      setIsExtracting(false);
    }
  }, [id, nodeData.sourceImage, nodeData.colorCount, updateNodeData, isExtracting]);

  // Apply palette when in apply mode and both images + palette are available
  const handleApply = useCallback(async () => {
    if (!nodeData.targetImage || nodeData.extractedPalette.length === 0) return;

    updateNodeData(id, { status: "loading", error: null });

    try {
      const result = await applyPalette(
        nodeData.targetImage,
        nodeData.extractedPalette,
        nodeData.mappingMethod
      );
      updateNodeData(id, {
        outputImage: result,
        status: "complete",
        error: null,
      });
    } catch (error) {
      updateNodeData(id, {
        status: "error",
        error: error instanceof Error ? error.message : "Failed to apply palette",
      });
    }
  }, [id, nodeData.targetImage, nodeData.extractedPalette, nodeData.mappingMethod, updateNodeData]);

  // Auto-extract when source image is set in extract mode
  useEffect(() => {
    if (nodeData.mode === "extract" && nodeData.sourceImage && nodeData.extractedPalette.length === 0) {
      handleExtract();
    }
  }, [nodeData.mode, nodeData.sourceImage, nodeData.extractedPalette.length, handleExtract]);

  const handleModeChange = useCallback((mode: "extract" | "apply") => {
    updateNodeData(id, { mode, outputImage: null });
  }, [id, updateNodeData]);

  const handleColorCountChange = useCallback((count: number) => {
    updateNodeData(id, { colorCount: count, extractedPalette: [] });
  }, [id, updateNodeData]);

  const handleMappingMethodChange = useCallback((method: "closest" | "histogram" | "luminance") => {
    updateNodeData(id, { mappingMethod: method, outputImage: null });
  }, [id, updateNodeData]);

  // Render color swatch
  const renderSwatch = (color: PaletteColor, index: number) => {
    const tooltipText = (color.name || "Color") + ": " + color.hex + " (" + color.percentage.toFixed(1) + "%)";
    return (
      <div
        key={index}
        className="group relative flex-1 h-8 min-w-[20px] cursor-pointer transition-transform hover:scale-105"
        style={{ backgroundColor: color.hex }}
        title={tooltipText}
      >
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 bg-neutral-900 text-[9px] text-white rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none z-10">
          {color.hex}
        </div>
      </div>
    );
  };

  return (
    <BaseNode
      id={id}
      title="Color Palette"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      isExecuting={nodeData.status === "loading"}
      hasError={nodeData.status === "error"}
    >
      {/* Input handles */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
        className="!bg-blue-500"
        style={{ top: "30%" }}
      />
      {nodeData.mode === "apply" && (
        <Handle
          type="target"
          position={Position.Left}
          id="target"
          data-handletype="image"
          className="!bg-purple-500"
          style={{ top: "70%" }}
        />
      )}

      <div className="flex flex-col gap-2 flex-1 min-h-0">
        {/* Mode toggle */}
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => handleModeChange("extract")}
            className={`flex-1 px-2 py-1 text-[10px] rounded transition-colors ${
              nodeData.mode === "extract"
                ? "bg-blue-600 text-white"
                : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
            }`}
          >
            Extract
          </button>
          <button
            onClick={() => handleModeChange("apply")}
            className={`flex-1 px-2 py-1 text-[10px] rounded transition-colors ${
              nodeData.mode === "apply"
                ? "bg-blue-600 text-white"
                : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
            }`}
          >
            Apply
          </button>
        </div>

        {/* Source image preview */}
        <div className="flex-1 min-h-0 relative">
          {nodeData.mode === "extract" ? (
            // Extract mode: show source image large
            nodeData.sourceImage ? (
              <img
                src={nodeData.sourceImage}
                alt="Source"
                className="w-full h-full object-contain rounded"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center border border-dashed border-neutral-600 rounded text-neutral-500 text-xs">
                Connect image
              </div>
            )
          ) : (
            // Apply mode: show source and target side by side, or output
            <div className="flex gap-1 h-full">
              <div className="flex-1 min-w-0">
                {nodeData.outputImage ? (
                  <img
                    src={nodeData.outputImage}
                    alt="Output"
                    className="w-full h-full object-contain rounded"
                  />
                ) : nodeData.targetImage ? (
                  <img
                    src={nodeData.targetImage}
                    alt="Target"
                    className="w-full h-full object-contain rounded opacity-50"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center border border-dashed border-purple-600/50 rounded text-neutral-500 text-[10px]">
                    Target
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Loading overlay */}
          {nodeData.status === "loading" && (
            <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* Extracted palette display */}
        {nodeData.extractedPalette.length > 0 && (
          <div className="flex gap-0.5 rounded overflow-hidden shrink-0">
            {nodeData.extractedPalette.map((color, i) => renderSwatch(color, i))}
          </div>
        )}

        {/* Controls */}
        <div className="flex flex-col gap-1.5 shrink-0">
          {/* Color count slider */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-neutral-400 w-12">Colors:</span>
            <input
              type="range"
              min="5"
              max="10"
              value={nodeData.colorCount}
              onChange={(e) => handleColorCountChange(parseInt(e.target.value))}
              className="flex-1 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer nodrag"
            />
            <span className="text-[10px] text-neutral-300 w-4">{nodeData.colorCount}</span>
          </div>

          {/* Mapping method (only in apply mode) */}
          {nodeData.mode === "apply" && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-400 w-12">Method:</span>
              <select
                value={nodeData.mappingMethod}
                onChange={(e) => handleMappingMethodChange(e.target.value as "closest" | "histogram" | "luminance")}
                className="flex-1 bg-neutral-700 text-neutral-200 text-[10px] px-1.5 py-0.5 rounded border-none outline-none nodrag"
              >
                <option value="closest">Closest Color</option>
                <option value="luminance">By Luminance</option>
                <option value="histogram">Histogram</option>
              </select>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-1">
            <button
              onClick={handleExtract}
              disabled={!nodeData.sourceImage || nodeData.status === "loading"}
              className="flex-1 px-2 py-1 text-[10px] bg-neutral-700 text-neutral-200 rounded hover:bg-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors nodrag"
            >
              Re-extract
            </button>
            {nodeData.mode === "apply" && (
              <button
                onClick={handleApply}
                disabled={!nodeData.targetImage || nodeData.extractedPalette.length === 0 || nodeData.status === "loading"}
                className="flex-1 px-2 py-1 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors nodrag"
              >
                Apply Palette
              </button>
            )}
          </div>
        </div>

        {/* Error message */}
        {nodeData.error && (
          <div className="text-[10px] text-red-400 truncate" title={nodeData.error}>
            {nodeData.error}
          </div>
        )}
      </div>

      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
        className="!bg-blue-500"
      />
    </BaseNode>
  );
}
