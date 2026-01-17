"use client";

import { useCallback, useRef, useMemo, useEffect, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  ImageFilterNodeData,
  ImageFilterSettings,
  FilterPreset,
} from "@/types";

type ImageFilterNodeType = Node<ImageFilterNodeData, "imageFilter">;

/**
 * Filter preset configurations - predefined combinations of filter settings
 */
const FILTER_PRESETS: Record<FilterPreset, Partial<ImageFilterSettings>> = {
  none: {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hueRotate: 0,
    blur: 0,
    sharpen: 0,
    opacity: 100,
    invert: 0,
    grayscale: 0,
  },
  vintage: {
    brightness: 5,
    contrast: 10,
    saturation: -30,
    hueRotate: 15,
    blur: 0,
    sharpen: 0,
    opacity: 100,
    invert: 0,
    grayscale: 0,
  },
  noir: {
    brightness: 0,
    contrast: 20,
    saturation: -100,
    hueRotate: 0,
    blur: 0,
    sharpen: 10,
    opacity: 100,
    invert: 0,
    grayscale: 100,
  },
  vivid: {
    brightness: 10,
    contrast: 20,
    saturation: 40,
    hueRotate: 0,
    blur: 0,
    sharpen: 15,
    opacity: 100,
    invert: 0,
    grayscale: 0,
  },
  warm: {
    brightness: 5,
    contrast: 5,
    saturation: 15,
    hueRotate: -10,
    blur: 0,
    sharpen: 0,
    opacity: 100,
    invert: 0,
    grayscale: 0,
  },
  cool: {
    brightness: 0,
    contrast: 5,
    saturation: 10,
    hueRotate: 10,
    blur: 0,
    sharpen: 0,
    opacity: 100,
    invert: 0,
    grayscale: 0,
  },
  sepia: {
    brightness: 5,
    contrast: 5,
    saturation: -20,
    hueRotate: 30,
    blur: 0,
    sharpen: 0,
    opacity: 100,
    invert: 0,
    grayscale: 0,
  },
  dramatic: {
    brightness: -10,
    contrast: 40,
    saturation: 20,
    hueRotate: 0,
    blur: 0,
    sharpen: 20,
    opacity: 100,
    invert: 0,
    grayscale: 0,
  },
};

/**
 * Slider configuration for each filter parameter
 */
interface SliderConfig {
  key: keyof ImageFilterSettings;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const SLIDER_CONFIGS: SliderConfig[] = [
  { key: "brightness", label: "Brightness", min: -100, max: 100, step: 1, unit: "" },
  { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, unit: "" },
  { key: "saturation", label: "Saturation", min: -100, max: 100, step: 1, unit: "" },
  { key: "hueRotate", label: "Hue", min: 0, max: 360, step: 1, unit: "°" },
  { key: "blur", label: "Blur", min: 0, max: 20, step: 0.5, unit: "px" },
  { key: "sharpen", label: "Sharpen", min: 0, max: 100, step: 1, unit: "" },
];

/**
 * Convert filter settings to CSS filter string for preview
 */
function settingsToFilterString(settings: ImageFilterSettings): string {
  const filters: string[] = [];

  // Brightness: CSS brightness(1) = no change, 0 = black, 2 = 200%
  // Map -100 to 100 → 0 to 2
  const brightness = 1 + settings.brightness / 100;
  filters.push(`brightness(${brightness})`);

  // Contrast: CSS contrast(1) = no change, 0 = gray, 2 = 200%
  // Map -100 to 100 → 0 to 2
  const contrast = 1 + settings.contrast / 100;
  filters.push(`contrast(${contrast})`);

  // Saturation: CSS saturate(1) = no change, 0 = grayscale, 2 = 200%
  // Map -100 to 100 → 0 to 2
  const saturation = 1 + settings.saturation / 100;
  filters.push(`saturate(${saturation})`);

  // Hue rotation in degrees
  if (settings.hueRotate !== 0) {
    filters.push(`hue-rotate(${settings.hueRotate}deg)`);
  }

  // Blur in pixels
  if (settings.blur > 0) {
    filters.push(`blur(${settings.blur}px)`);
  }

  // Opacity
  if (settings.opacity < 100) {
    filters.push(`opacity(${settings.opacity / 100})`);
  }

  // Invert
  if (settings.invert > 0) {
    filters.push(`invert(${settings.invert / 100})`);
  }

  // Grayscale
  if (settings.grayscale > 0) {
    filters.push(`grayscale(${settings.grayscale / 100})`);
  }

  return filters.join(" ");
}

/**
 * Apply filter settings to an image and return the filtered result as base64
 */
async function applyFiltersToImage(
  sourceImage: string,
  settings: ImageFilterSettings
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      canvas.width = img.width;
      canvas.height = img.height;

      // Apply CSS filters via canvas filter property
      ctx.filter = settingsToFilterString(settings);
      ctx.drawImage(img, 0, 0);

      // For sharpen effect, apply unsharp mask technique (simplified)
      if (settings.sharpen > 0) {
        const sharpAmount = settings.sharpen / 100;
        const tempCanvas = document.createElement("canvas");
        const tempCtx = tempCanvas.getContext("2d");
        if (tempCtx) {
          tempCanvas.width = img.width;
          tempCanvas.height = img.height;

          // Get the filtered image data
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;

          // Simple sharpening kernel convolution (3x3)
          const kernel = [
            0, -sharpAmount, 0,
            -sharpAmount, 1 + 4 * sharpAmount, -sharpAmount,
            0, -sharpAmount, 0,
          ];

          const origData = new Uint8ClampedArray(data);
          const width = canvas.width;
          const height = canvas.height;

          for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
              for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                  for (let kx = -1; kx <= 1; kx++) {
                    const idx = ((y + ky) * width + (x + kx)) * 4 + c;
                    sum += origData[idx] * kernel[(ky + 1) * 3 + (kx + 1)];
                  }
                }
                const idx = (y * width + x) * 4 + c;
                data[idx] = Math.max(0, Math.min(255, sum));
              }
            }
          }

          ctx.putImageData(imageData, 0, 0);
        }
      }

      resolve(canvas.toDataURL("image/png"));
    };

    img.onerror = () => {
      reject(new Error("Failed to load image"));
    };

    img.src = sourceImage;
  });
}

export function ImageFilterNode({
  id,
  data,
  selected,
}: NodeProps<ImageFilterNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isApplying, setIsApplying] = useState(false);

  // CSS filter string for real-time preview
  const previewFilterStyle = useMemo(
    () => settingsToFilterString(nodeData.filterSettings),
    [nodeData.filterSettings]
  );

  const displayImage = nodeData.sourceImage;

  // Handle file upload
  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (!file.type.match(/^image\/(png|jpeg|webp)$/)) {
        alert("Unsupported format. Use PNG, JPG, or WebP.");
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        alert("Image too large. Maximum size is 10MB.");
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        const base64 = event.target?.result as string;
        updateNodeData(id, {
          sourceImage: base64,
          outputImage: null,
          status: "idle",
          error: null,
        });
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData]
  );

  // Handle drop
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const file = e.dataTransfer.files?.[0];
      if (!file) return;

      const dt = new DataTransfer();
      dt.items.add(file);
      if (fileInputRef.current) {
        fileInputRef.current.files = dt.files;
        fileInputRef.current.dispatchEvent(
          new Event("change", { bubbles: true })
        );
      }
    },
    []
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleRemove = useCallback(() => {
    updateNodeData(id, {
      sourceImage: null,
      outputImage: null,
      status: "idle",
      error: null,
    });
  }, [id, updateNodeData]);

  // Update a single filter setting
  const updateFilterSetting = useCallback(
    (key: keyof ImageFilterSettings, value: number) => {
      updateNodeData(id, {
        filterSettings: {
          ...nodeData.filterSettings,
          [key]: value,
        },
        activePreset: "none", // Reset preset when manually adjusting
      });
    },
    [id, nodeData.filterSettings, updateNodeData]
  );

  // Apply a preset
  const applyPreset = useCallback(
    (preset: FilterPreset) => {
      const presetSettings = FILTER_PRESETS[preset];
      updateNodeData(id, {
        filterSettings: {
          ...nodeData.filterSettings,
          ...presetSettings,
        },
        activePreset: preset,
      });
    },
    [id, nodeData.filterSettings, updateNodeData]
  );

  // Reset all filters
  const resetFilters = useCallback(() => {
    applyPreset("none");
  }, [applyPreset]);

  // Apply filters and generate output image
  const applyFilters = useCallback(async () => {
    if (!nodeData.sourceImage) return;

    setIsApplying(true);
    updateNodeData(id, { status: "loading", error: null });

    try {
      const filteredImage = await applyFiltersToImage(
        nodeData.sourceImage,
        nodeData.filterSettings
      );
      updateNodeData(id, {
        outputImage: filteredImage,
        status: "complete",
        error: null,
      });
    } catch (error) {
      updateNodeData(id, {
        status: "error",
        error: error instanceof Error ? error.message : "Failed to apply filters",
      });
    } finally {
      setIsApplying(false);
    }
  }, [id, nodeData.sourceImage, nodeData.filterSettings, updateNodeData]);

  return (
    <BaseNode
      id={id}
      title="Filter"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) =>
        updateNodeData(id, { customTitle: title || undefined })
      }
      onCommentChange={(comment) =>
        updateNodeData(id, { comment: comment || undefined })
      }
      selected={selected}
      isExecuting={nodeData.status === "loading"}
      hasError={nodeData.status === "error"}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        data-handletype="image"
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className="flex flex-col gap-2 flex-1 min-h-0 overflow-hidden">
        {/* Image Preview */}
        {displayImage ? (
          <div className="relative group h-28 shrink-0">
            <img
              src={displayImage}
              alt="Source"
              className="w-full h-full object-contain rounded"
              style={{ filter: previewFilterStyle }}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleRemove();
              }}
              className="absolute top-1 right-1 w-5 h-5 bg-black/60 text-white rounded text-xs opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
            >
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            className="w-full h-20 shrink-0 border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center cursor-pointer hover:border-neutral-500 hover:bg-neutral-700/50 transition-colors"
          >
            <svg
              className="w-5 h-5 text-neutral-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4.5v15m7.5-7.5h-15"
              />
            </svg>
            <span className="text-[10px] text-neutral-400 mt-1">
              Drop, click, or connect
            </span>
          </div>
        )}

        {/* Preset Buttons */}
        <div className="shrink-0">
          <div className="text-[10px] text-neutral-400 mb-1">Presets</div>
          <div className="flex flex-wrap gap-1">
            {(Object.keys(FILTER_PRESETS) as FilterPreset[]).map((preset) => (
              <button
                key={preset}
                onClick={() => applyPreset(preset)}
                className={`px-2 py-0.5 text-[9px] rounded transition-colors ${
                  nodeData.activePreset === preset
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-700 text-neutral-300 hover:bg-neutral-600"
                }`}
              >
                {preset.charAt(0).toUpperCase() + preset.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Filter Sliders */}
        <div className="flex-1 overflow-y-auto nowheel pr-1 space-y-1.5">
          {SLIDER_CONFIGS.map((config) => (
            <div key={config.key} className="flex items-center gap-2">
              <span className="text-[9px] text-neutral-400 w-16 shrink-0">
                {config.label}
              </span>
              <input
                type="range"
                min={config.min}
                max={config.max}
                step={config.step}
                value={nodeData.filterSettings[config.key]}
                onChange={(e) =>
                  updateFilterSetting(config.key, parseFloat(e.target.value))
                }
                className="nodrag nopan flex-1 h-1 bg-neutral-700 rounded appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:bg-blue-500 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer"
              />
              <span className="text-[9px] text-neutral-500 w-8 text-right shrink-0">
                {nodeData.filterSettings[config.key]}
                {config.unit}
              </span>
            </div>
          ))}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 shrink-0">
          <button
            onClick={resetFilters}
            className="flex-1 px-2 py-1 text-[10px] bg-neutral-700 text-neutral-300 rounded hover:bg-neutral-600 transition-colors"
          >
            Reset
          </button>
          <button
            onClick={applyFilters}
            disabled={!displayImage || isApplying}
            className="flex-1 px-2 py-1 text-[10px] bg-blue-600 text-white rounded hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isApplying ? "Applying..." : "Apply"}
          </button>
        </div>

        {/* Error Display */}
        {nodeData.error && (
          <div className="text-[9px] text-red-400 truncate shrink-0">
            {nodeData.error}
          </div>
        )}
      </div>
    </BaseNode>
  );
}
