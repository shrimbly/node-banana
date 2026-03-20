"use client";

import { useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useWorkflowStore } from "@/store/workflowStore";
import { SplitGridNodeData, AspectRatio, Resolution, ModelType } from "@/types";

interface SplitGridSettingsModalProps {
  nodeId: string;
  nodeData: SplitGridNodeData;
  onClose: () => void;
}

const LAYOUT_OPTIONS = [
  { rows: 1, cols: 2 },
  { rows: 1, cols: 3 },
  { rows: 1, cols: 4 },
  { rows: 2, cols: 1 },
  { rows: 2, cols: 2 },
  { rows: 2, cols: 3 },
  { rows: 3, cols: 2 },
  { rows: 2, cols: 4 },
  { rows: 3, cols: 3 },
  { rows: 3, cols: 4 },
  { rows: 4, cols: 3 },
  { rows: 4, cols: 4 },
] as const;

// Cell aspect ratio options for splitting
const CELL_ASPECT_RATIOS = [
  { label: "Auto", value: 0 },
  { label: "1:1", value: 1 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "3:2", value: 3 / 2 },
  { label: "2:3", value: 2 / 3 },
  { label: "21:9", value: 21 / 9 },
];

/**
 * Given a source image aspect ratio and desired cell aspect ratio,
 * find the best rows x cols that produce cells closest to the target.
 */
function findBestGrid(
  sourceWidth: number,
  sourceHeight: number,
  cellAR: number,
  maxDim: number = 10
): { rows: number; cols: number } {
  const sourceAR = sourceWidth / sourceHeight;
  let bestRows = 1;
  let bestCols = 1;
  let bestError = Infinity;

  for (let r = 1; r <= maxDim; r++) {
    for (let c = 1; c <= maxDim; c++) {
      if (r === 1 && c === 1) continue;
      const actualCellAR = (sourceAR * r) / c;
      const error = Math.abs(actualCellAR / cellAR - 1);
      if (error < bestError) {
        bestError = error;
        bestRows = r;
        bestCols = c;
      }
    }
  }

  return { rows: bestRows, cols: bestCols };
}

const BASE_ASPECT_RATIOS: AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const EXTENDED_ASPECT_RATIOS: AspectRatio[] = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const RESOLUTIONS_PRO: Resolution[] = ["1K", "2K", "4K"];
const RESOLUTIONS_NB2: Resolution[] = ["512", "1K", "2K", "4K"];
const MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

const findLayoutIndex = (rows: number, cols: number): number => {
  return LAYOUT_OPTIONS.findIndex(l => l.rows === rows && l.cols === cols);
};

export function SplitGridSettingsModal({
  nodeId,
  nodeData,
  onClose,
}: SplitGridSettingsModalProps) {
  const { updateNodeData, addNode, onConnect, addEdgeWithType, getNodeById } = useWorkflowStore();

  const initialPresetIdx = findLayoutIndex(nodeData.gridRows, nodeData.gridCols);
  const [selectedLayoutIndex, setSelectedLayoutIndex] = useState(
    initialPresetIdx >= 0 ? initialPresetIdx : -1
  );
  const [customRows, setCustomRows] = useState(nodeData.gridRows);
  const [customCols, setCustomCols] = useState(nodeData.gridCols);
  const [cellAspectRatio, setCellAspectRatio] = useState(0); // 0 = auto
  const [sourceDims, setSourceDims] = useState<{ width: number; height: number } | null>(null);
  const [defaultPrompt, setDefaultPrompt] = useState(nodeData.defaultPrompt);

  // Load source image dimensions
  useEffect(() => {
    if (!nodeData.sourceImage) return;
    const img = new Image();
    img.onload = () => setSourceDims({ width: img.width, height: img.height });
    img.src = nodeData.sourceImage;
  }, [nodeData.sourceImage]);

  // Auto-calculate grid when cell aspect ratio changes
  const handleCellAspectRatioChange = useCallback((arValue: number) => {
    setCellAspectRatio(arValue);
    if (arValue === 0 || !sourceDims) return;
    const best = findBestGrid(sourceDims.width, sourceDims.height, arValue);
    setCustomRows(best.rows);
    setCustomCols(best.cols);
    setSelectedLayoutIndex(findLayoutIndex(best.rows, best.cols));
  }, [sourceDims]);
  const [aspectRatio, setAspectRatio] = useState(nodeData.generateSettings.aspectRatio);
  const [resolution, setResolution] = useState(nodeData.generateSettings.resolution);
  const [model, setModel] = useState(nodeData.generateSettings.model);
  const [useGoogleSearch, setUseGoogleSearch] = useState(nodeData.generateSettings.useGoogleSearch);
  const [useImageSearch, setUseImageSearch] = useState(nodeData.generateSettings.useImageSearch);

  const rows = selectedLayoutIndex >= 0 ? LAYOUT_OPTIONS[selectedLayoutIndex].rows : customRows;
  const cols = selectedLayoutIndex >= 0 ? LAYOUT_OPTIONS[selectedLayoutIndex].cols : customCols;
  const targetCount = rows * cols;
  const isNanoBananaPro = model === "nano-banana-pro" || model === "nano-banana-2";
  const aspectRatios = model === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = model === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;

  const handleCreate = useCallback(() => {
    const splitNode = getNodeById(nodeId);
    if (!splitNode) return;

    // Node dimensions
    const imageInputWidth = 300;
    const imageInputHeight = 280;
    const promptWidth = 320;
    const promptHeight = 220;
    const nanoBananaWidth = 300;
    const nanoBananaHeight = 300;
    const horizontalGap = 40;
    const verticalGap = 30;

    // Calculate cluster dimensions
    // Layout: imageInput on left, nanoBanana on right, prompt below imageInput
    const clusterWidth = imageInputWidth + horizontalGap + nanoBananaWidth;
    const clusterHeight = Math.max(imageInputHeight, nanoBananaHeight) + verticalGap + promptHeight;
    const clusterGap = 60;

    // Start position to the right of the split node
    const startX = splitNode.position.x + 350;
    const startY = splitNode.position.y;

    const childNodeIds: SplitGridNodeData["childNodeIds"] = [];

    // Create node clusters for each grid cell
    for (let i = 0; i < targetCount; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;

      // Position for this cluster
      const clusterX = startX + col * (clusterWidth + clusterGap);
      const clusterY = startY + row * (clusterHeight + clusterGap);

      // Create imageInput node
      const imageInputId = addNode("imageInput", {
        x: clusterX,
        y: clusterY,
      });

      // Create nanoBanana node (to the right of imageInput)
      const nanoBananaId = addNode("nanoBanana", {
        x: clusterX + imageInputWidth + horizontalGap,
        y: clusterY,
      });

      // Update nanoBanana settings
      updateNodeData(nanoBananaId, {
        aspectRatio,
        resolution,
        model,
        useGoogleSearch,
        useImageSearch,
      });

      // Create prompt node (below imageInput)
      const promptId = addNode("prompt", {
        x: clusterX,
        y: clusterY + Math.max(imageInputHeight, nanoBananaHeight) + verticalGap,
      });

      // Update prompt with default text
      updateNodeData(promptId, { prompt: defaultPrompt });

      // Create connections: imageInput -> nanoBanana, prompt -> nanoBanana
      onConnect({
        source: imageInputId,
        sourceHandle: "image",
        target: nanoBananaId,
        targetHandle: "image",
      });

      onConnect({
        source: promptId,
        sourceHandle: "text",
        target: nanoBananaId,
        targetHandle: "text",
      });

      // Create reference edge from split node to imageInput (grey dotted line)
      addEdgeWithType({
        source: nodeId,
        sourceHandle: "reference",
        target: imageInputId,
        targetHandle: "reference",
      }, "reference");

      childNodeIds.push({
        imageInput: imageInputId,
        prompt: promptId,
        nanoBanana: nanoBananaId,
      });
    }

    // Update split node with configuration
    updateNodeData(nodeId, {
      targetCount,
      defaultPrompt,
      generateSettings: {
        aspectRatio,
        resolution,
        model,
        useGoogleSearch,
        useImageSearch,
      },
      childNodeIds,
      gridRows: rows,
      gridCols: cols,
      isConfigured: true,
    });

    onClose();
  }, [
    nodeId, targetCount, defaultPrompt, aspectRatio, resolution,
    model, useGoogleSearch, useImageSearch, rows, cols, selectedLayoutIndex, getNodeById,
    addNode, updateNodeData, onConnect, addEdgeWithType, onClose
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div
        className="bg-neutral-800 rounded-lg p-6 w-[600px] border border-neutral-700 shadow-xl"
        onKeyDown={handleKeyDown}
      >
        <h2 className="text-lg font-semibold text-neutral-100 mb-4">
          Split Grid Settings
        </h2>

        <div className="space-y-4">
          {/* Layout selector with visual preview */}
          <div>
            <label className="block text-sm text-neutral-400 mb-2">
              Grid Layout
            </label>
            <div className="flex flex-wrap gap-2">
              {LAYOUT_OPTIONS.map((layout, index) => {
                const count = layout.rows * layout.cols;
                const isSelected = selectedLayoutIndex === index;
                return (
                  <button
                    key={`${layout.rows}x${layout.cols}`}
                    onClick={() => {
                      setSelectedLayoutIndex(index);
                      setCustomRows(layout.rows);
                      setCustomCols(layout.cols);
                    }}
                    className={`w-[68px] p-2 rounded border transition-colors ${
                      isSelected
                        ? "border-blue-500 bg-blue-500/20"
                        : "border-neutral-600 hover:border-neutral-500"
                    }`}
                  >
                    <div
                      className="aspect-video mx-auto w-12 grid gap-0.5"
                      style={{
                        gridTemplateColumns: `repeat(${layout.cols}, 1fr)`,
                        gridTemplateRows: `repeat(${layout.rows}, 1fr)`,
                      }}
                    >
                      {Array.from({ length: count }).map((_, i) => (
                        <div
                          key={i}
                          className={`rounded-sm ${
                            isSelected ? "bg-blue-400" : "bg-neutral-500"
                          }`}
                        />
                      ))}
                    </div>
                    <div className="text-xs text-neutral-300 mt-1 text-center">{layout.rows}x{layout.cols}</div>
                  </button>
                );
              })}
            </div>

            {/* Cell aspect ratio selector */}
            <div className="flex items-center gap-3 mt-3">
              <span className="text-xs text-neutral-500">Cell ratio:</span>
              <div className="flex gap-1.5">
                {CELL_ASPECT_RATIOS.map((ar) => (
                  <button
                    key={ar.label}
                    onClick={() => handleCellAspectRatioChange(ar.value)}
                    className={`px-2 py-0.5 text-xs rounded border transition-colors ${
                      cellAspectRatio === ar.value
                        ? "border-blue-500 bg-blue-500/20 text-blue-300"
                        : "border-neutral-600 text-neutral-400 hover:border-neutral-500"
                    }`}
                  >
                    {ar.label}
                  </button>
                ))}
              </div>
              {cellAspectRatio !== 0 && !sourceDims && (
                <span className="text-[10px] text-amber-400">Connect image for auto-grid</span>
              )}
            </div>

            {/* Custom rows/cols input */}
            <div className="flex items-center gap-3 mt-3">
              <span className="text-xs text-neutral-500">Custom:</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={customRows}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(10, parseInt(e.target.value) || 1));
                    setCustomRows(v);
                    setSelectedLayoutIndex(findLayoutIndex(v, customCols));
                  }}
                  className="w-14 px-2 py-1 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm text-center focus:outline-none focus:border-neutral-500"
                />
                <span className="text-neutral-500 text-sm">x</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={customCols}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(10, parseInt(e.target.value) || 1));
                    setCustomCols(v);
                    setSelectedLayoutIndex(findLayoutIndex(customRows, v));
                  }}
                  className="w-14 px-2 py-1 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm text-center focus:outline-none focus:border-neutral-500"
                />
              </div>
              <span className="text-xs text-neutral-500">
                = {targetCount} images
                {sourceDims && (
                  <span className="ml-2 text-neutral-600">
                    (cell: {Math.round(sourceDims.width / cols)}x{Math.round(sourceDims.height / rows)}px)
                  </span>
                )}
              </span>
            </div>
          </div>

          {/* Default prompt */}
          <div>
            <label className="block text-sm text-neutral-400 mb-1">
              Default Prompt
            </label>
            <textarea
              value={defaultPrompt}
              onChange={(e) => setDefaultPrompt(e.target.value)}
              placeholder="Enter prompt that will be applied to all generated images..."
              rows={3}
              className="w-full px-3 py-2 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm focus:outline-none focus:border-neutral-500 resize-none"
            />
            <p className="text-xs text-neutral-500 mt-1">
              Each prompt node can be edited individually after creation
            </p>
          </div>

          {/* Generate settings */}
          <div>
            <label className="block text-sm text-neutral-400 mb-2">
              Generate Node Settings
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-neutral-500 mb-1">
                  Model
                </label>
                <select
                  value={model}
                  onChange={(e) => {
                    const newModel = e.target.value as ModelType;
                    setModel(newModel);
                    // Normalize aspect ratio for the new model's allowed set
                    const newAspectRatios = newModel === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
                    if (!newAspectRatios.includes(aspectRatio)) {
                      setAspectRatio(newAspectRatios[0]);
                    }
                    // Normalize resolution for the new model's allowed set
                    const newResolutions = newModel === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;
                    if (!newResolutions.includes(resolution)) {
                      setResolution(newResolutions[0]);
                    }
                  }}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm focus:outline-none focus:border-neutral-500"
                >
                  {MODELS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-neutral-500 mb-1">
                  Aspect Ratio
                </label>
                <select
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value as AspectRatio)}
                  className="w-full px-3 py-2 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm focus:outline-none focus:border-neutral-500"
                >
                  {aspectRatios.map((ar) => (
                    <option key={ar} value={ar}>{ar}</option>
                  ))}
                </select>
              </div>

              {isNanoBananaPro && (
                <>
                  <div>
                    <label className="block text-xs text-neutral-500 mb-1">
                      Resolution
                    </label>
                    <select
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value as Resolution)}
                      className="w-full px-3 py-2 bg-neutral-900 border border-neutral-600 rounded text-neutral-100 text-sm focus:outline-none focus:border-neutral-500"
                    >
                      {resolutions.map((res) => (
                        <option key={res} value={res}>{res}</option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-end pb-2">
                    <label className="flex items-center gap-2 text-sm text-neutral-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useGoogleSearch}
                        onChange={(e) => setUseGoogleSearch(e.target.checked)}
                        className="w-4 h-4 rounded border-neutral-600 bg-neutral-900"
                      />
                      Google Search
                    </label>
                  </div>
                  {model === "nano-banana-2" && (
                    <div className="flex items-end pb-2">
                      <label className="flex items-center gap-2 text-sm text-neutral-300 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={useImageSearch}
                          onChange={(e) => setUseImageSearch(e.target.checked)}
                          className="w-4 h-4 rounded border-neutral-600 bg-neutral-900"
                        />
                        Image Search
                      </label>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-neutral-400 hover:text-neutral-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="px-4 py-2 text-sm bg-white text-neutral-900 rounded hover:bg-neutral-200 transition-colors"
          >
            Create {targetCount} Generate Sets
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
