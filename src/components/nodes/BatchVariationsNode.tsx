"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore, saveNanoBananaDefaults } from "@/store/workflowStore";
import { BatchVariationsNodeData, BatchVariationItem, AspectRatio, Resolution, ModelType } from "@/types";
import { useToast } from "@/components/Toast";

// All 10 aspect ratios
const ASPECT_RATIOS: AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Resolutions for Pro model
const RESOLUTIONS: Resolution[] = ["1K", "2K", "4K"];

// Model options
const MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

// Variation count options
const VARIATION_COUNTS = [2, 3, 4, 5, 6, 8];

type BatchVariationsNodeType = Node<BatchVariationsNodeData, "batchVariations">;

export function BatchVariationsNode({ id, data, selected }: NodeProps<BatchVariationsNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);

  // Track previous status for error toast
  const prevStatusRef = useRef(nodeData.status);

  // Show toast when error occurs
  useEffect(() => {
    if (nodeData.status === "error" && prevStatusRef.current !== "error" && nodeData.error) {
      useToast.getState().show("Batch generation failed", "error", true, nodeData.error);
    }
    prevStatusRef.current = nodeData.status;
  }, [nodeData.status, nodeData.error]);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleVariationCountChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const variationCount = parseInt(e.target.value, 10);
      updateNodeData(id, { variationCount });
    },
    [id, updateNodeData]
  );

  const handleAspectRatioChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const aspectRatio = e.target.value as AspectRatio;
      updateNodeData(id, { aspectRatio });
      saveNanoBananaDefaults({ aspectRatio });
    },
    [id, updateNodeData]
  );

  const handleResolutionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const resolution = e.target.value as Resolution;
      updateNodeData(id, { resolution });
      saveNanoBananaDefaults({ resolution });
    },
    [id, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = e.target.value as ModelType;
      updateNodeData(id, { model });
      saveNanoBananaDefaults({ model });
    },
    [id, updateNodeData]
  );

  const handleGoogleSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useGoogleSearch = e.target.checked;
      updateNodeData(id, { useGoogleSearch });
      saveNanoBananaDefaults({ useGoogleSearch });
    },
    [id, updateNodeData]
  );

  // Toggle favorite status for a variation
  const handleToggleFavorite = useCallback(
    (variationIndex: number) => {
      const variations = [...(nodeData.variations || [])];
      if (variations[variationIndex]) {
        variations[variationIndex] = {
          ...variations[variationIndex],
          isFavorite: !variations[variationIndex].isFavorite,
        };
        updateNodeData(id, { variations });
      }
    },
    [id, nodeData.variations, updateNodeData]
  );

  // Select a variation as the output
  const handleSelectVariation = useCallback(
    (variationIndex: number) => {
      const variation = nodeData.variations?.[variationIndex];
      if (variation) {
        updateNodeData(id, {
          selectedVariationIndex: variationIndex,
          outputImage: variation.image,
        });
      }
    },
    [id, nodeData.variations, updateNodeData]
  );

  // Clear all variations
  const handleClearVariations = useCallback(() => {
    updateNodeData(id, {
      variations: [],
      outputImage: null,
      selectedVariationIndex: 0,
      generationProgress: 0,
      status: "idle",
      error: null,
    });
  }, [id, updateNodeData]);

  const isNanoBananaPro = nodeData.model === "nano-banana-pro";
  const hasVariations = (nodeData.variations || []).length > 0;
  const variationCount = nodeData.variationCount || 4;

  // Calculate grid layout based on variation count
  const gridCols = useMemo(() => {
    if (variationCount <= 2) return 2;
    if (variationCount <= 4) return 2;
    if (variationCount <= 6) return 3;
    return 4;
  }, [variationCount]);

  // Get favorited variations
  const favoritedCount = useMemo(() => {
    return (nodeData.variations || []).filter((v) => v.isFavorite).length;
  }, [nodeData.variations]);

  return (
    <BaseNode
      id={id}
      title="Batch Variations"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      onRun={handleRegenerate}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
    >
      {/* Image input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "35%" }}
        data-handletype="image"
        isConnectable={true}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{
          right: `calc(100% + 8px)`,
          top: "calc(35% - 18px)",
          color: "var(--handle-color-image)",
        }}
      >
        Image
      </div>

      {/* Text/prompt input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "65%" }}
        data-handletype="text"
        isConnectable={true}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{
          right: `calc(100% + 8px)`,
          top: "calc(65% - 18px)",
          color: "var(--handle-color-text)",
        }}
      >
        Prompt
      </div>

      {/* Image output handle - outputs selected variation */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "50%" }}
        data-handletype="image"
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-image)",
        }}
      >
        Selected
      </div>

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Variations grid */}
        {hasVariations ? (
          <div className="relative w-full flex-1 min-h-0">
            {/* Grid of variations */}
            <div
              className="w-full h-full grid gap-1 overflow-auto nowheel"
              style={{
                gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
              }}
            >
              {nodeData.variations.map((variation, index) => (
                <div
                  key={variation.id}
                  className={`relative aspect-square rounded overflow-hidden cursor-pointer transition-all ${
                    index === nodeData.selectedVariationIndex
                      ? "ring-2 ring-green-500"
                      : "hover:ring-1 hover:ring-neutral-400"
                  }`}
                  onClick={() => handleSelectVariation(index)}
                >
                  <img
                    src={variation.image}
                    alt={`Variation ${index + 1}`}
                    className="w-full h-full object-cover"
                  />
                  {/* Favorite button */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleFavorite(index);
                    }}
                    className={`absolute top-0.5 right-0.5 w-5 h-5 rounded flex items-center justify-center transition-colors ${
                      variation.isFavorite
                        ? "bg-yellow-500 text-white"
                        : "bg-neutral-900/60 text-neutral-400 hover:text-yellow-400"
                    }`}
                    title={variation.isFavorite ? "Unfavorite" : "Favorite"}
                  >
                    <svg
                      className="w-3 h-3"
                      fill={variation.isFavorite ? "currentColor" : "none"}
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                      />
                    </svg>
                  </button>
                  {/* Selection indicator */}
                  {index === nodeData.selectedVariationIndex && (
                    <div className="absolute bottom-0.5 left-0.5 w-5 h-5 rounded bg-green-500 flex items-center justify-center">
                      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Loading overlay for generation */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 rounded flex flex-col items-center justify-center gap-2">
                <svg
                  className="w-6 h-6 animate-spin text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span className="text-white text-xs font-medium">
                  Generating {nodeData.variations.length}/{variationCount}...
                </span>
                {/* Progress bar */}
                <div className="w-24 h-1 bg-neutral-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-green-500 transition-all"
                    style={{ width: `${nodeData.generationProgress || 0}%` }}
                  />
                </div>
              </div>
            )}

            {/* Clear button */}
            <div className="absolute top-1 right-1">
              <button
                onClick={handleClearVariations}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear all variations"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          /* Empty state */
          <div className="w-full flex-1 min-h-[140px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center gap-2">
            {nodeData.status === "loading" ? (
              <>
                <svg
                  className="w-6 h-6 animate-spin text-neutral-400"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="3"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                <span className="text-neutral-400 text-xs">
                  Generating {nodeData.generationProgress || 0}%...
                </span>
              </>
            ) : nodeData.status === "error" ? (
              <span className="text-[10px] text-red-400 text-center px-2">
                {nodeData.error || "Failed"}
              </span>
            ) : (
              <>
                <svg className="w-6 h-6 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                </svg>
                <span className="text-neutral-500 text-[10px] text-center px-2">
                  Run to generate {variationCount} variations
                </span>
              </>
            )}
          </div>
        )}

        {/* Stats row */}
        {hasVariations && (
          <div className="flex items-center justify-between text-[10px] text-neutral-400 shrink-0">
            <span>{nodeData.variations.length} variations</span>
            {favoritedCount > 0 && (
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3 text-yellow-500" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                </svg>
                {favoritedCount} favorited
              </span>
            )}
          </div>
        )}

        {/* Controls */}
        <div className="flex gap-1.5 shrink-0">
          {/* Variation count selector */}
          <select
            value={variationCount}
            onChange={handleVariationCountChange}
            className="w-14 text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
            title="Number of variations"
          >
            {VARIATION_COUNTS.map((count) => (
              <option key={count} value={count}>
                {count}x
              </option>
            ))}
          </select>

          {/* Model selector */}
          <select
            value={nodeData.model}
            onChange={handleModelChange}
            className="flex-1 text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
          >
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>

        {/* Aspect ratio and resolution row */}
        <div className="flex gap-1.5 shrink-0">
          <select
            value={nodeData.aspectRatio}
            onChange={handleAspectRatioChange}
            className="flex-1 text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
          >
            {ASPECT_RATIOS.map((ratio) => (
              <option key={ratio} value={ratio}>
                {ratio}
              </option>
            ))}
          </select>
          {isNanoBananaPro && (
            <select
              value={nodeData.resolution}
              onChange={handleResolutionChange}
              className="w-12 text-[10px] py-1 px-1.5 border border-neutral-700 rounded bg-neutral-900/50 focus:outline-none focus:ring-1 focus:ring-neutral-600 text-neutral-300"
            >
              {RESOLUTIONS.map((res) => (
                <option key={res} value={res}>
                  {res}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Google Search toggle - only for Nano Banana Pro */}
        {isNanoBananaPro && (
          <label className="flex items-center gap-1.5 text-[10px] text-neutral-300 shrink-0 cursor-pointer">
            <input
              type="checkbox"
              checked={nodeData.useGoogleSearch}
              onChange={handleGoogleSearchToggle}
              className="w-3 h-3 rounded border-neutral-700 bg-neutral-900/50 text-neutral-600 focus:ring-1 focus:ring-neutral-600 focus:ring-offset-0"
            />
            <span>Google Search</span>
          </label>
        )}
      </div>
    </BaseNode>
  );
}
