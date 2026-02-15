"use client";

import { useState, useCallback } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { SplitGridNodeData, AspectRatio, Resolution, ModelType } from "@/types";

interface SplitGridSettingsModalProps {
  nodeId: string;
  nodeData: SplitGridNodeData;
  onClose: () => void;
}

const LAYOUT_OPTIONS = [
  { rows: 2, cols: 2 },
  { rows: 1, cols: 5 },
  { rows: 2, cols: 3 },
  { rows: 3, cols: 2 },
  { rows: 2, cols: 4 },
  { rows: 3, cols: 3 },
  { rows: 2, cols: 5 },
] as const;

const ASPECT_RATIOS: AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const RESOLUTIONS: Resolution[] = ["1K", "2K", "4K"];
const MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

const findLayoutIndex = (rows: number, cols: number): number => {
  const idx = LAYOUT_OPTIONS.findIndex(l => l.rows === rows && l.cols === cols);
  return idx >= 0 ? idx : 2; // default to 2x3
};

export function SplitGridSettingsModal({
  nodeId,
  nodeData,
  onClose,
}: SplitGridSettingsModalProps) {
  const { updateNodeData, addNode, onConnect, addEdgeWithType, getNodeById } = useWorkflowStore();

  const [selectedLayoutIndex, setSelectedLayoutIndex] = useState(
    findLayoutIndex(nodeData.gridRows, nodeData.gridCols)
  );
  const [defaultPrompt, setDefaultPrompt] = useState(nodeData.defaultPrompt);
  const [aspectRatio, setAspectRatio] = useState(nodeData.generateSettings.aspectRatio);
  const [resolution, setResolution] = useState(nodeData.generateSettings.resolution);
  const [model, setModel] = useState(nodeData.generateSettings.model);
  const [useGoogleSearch, setUseGoogleSearch] = useState(nodeData.generateSettings.useGoogleSearch);

  const { rows, cols } = LAYOUT_OPTIONS[selectedLayoutIndex];
  const targetCount = rows * cols;
  const isNanoBananaPro = model === "nano-banana-pro";

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
      },
      childNodeIds,
      gridRows: rows,
      gridCols: cols,
      isConfigured: true,
    });

    onClose();
  }, [
    nodeId, targetCount, defaultPrompt, aspectRatio, resolution,
    model, useGoogleSearch, rows, cols, selectedLayoutIndex, getNodeById,
    addNode, updateNodeData, onConnect, addEdgeWithType, onClose
  ]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
    }
  };

  return (
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
            <div className="flex gap-2">
              {LAYOUT_OPTIONS.map((layout, index) => {
                const count = layout.rows * layout.cols;
                const isSelected = selectedLayoutIndex === index;
                return (
                  <button
                    key={`${layout.rows}x${layout.cols}`}
                    onClick={() => setSelectedLayoutIndex(index)}
                    className={`flex-1 p-2 rounded border transition-colors ${
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
                    <div className="text-[10px] text-neutral-500 text-center">{count}</div>
                  </button>
                );
              })}
            </div>
            <p className="text-xs text-neutral-500 mt-2">
              Grid will be split into {rows}x{cols} = {targetCount} images
            </p>
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
                  onChange={(e) => setModel(e.target.value as ModelType)}
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
                  {ASPECT_RATIOS.map((ar) => (
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
                      {RESOLUTIONS.map((res) => (
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
    </div>
  );
}
