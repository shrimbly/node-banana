"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, saveNanoBananaDefaults, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { NanoBananaNodeData, AspectRatio, Resolution, ModelType, MODEL_DISPLAY_NAMES, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useToast } from "@/components/Toast";
import { getImageDimensions, calculateNodeSizePreservingHeight } from "@/utils/nodeDimensions";
import { ProviderBadge } from "./ProviderBadge";
import { getModelPageUrl, getProviderDisplayName } from "@/utils/providerUrls";

// Base 10 aspect ratios (all Gemini image models)
const BASE_ASPECT_RATIOS: AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Extended 14 aspect ratios (Nano Banana 2 adds extreme ratios)
const EXTENDED_ASPECT_RATIOS: AspectRatio[] = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

// Resolutions per model (nano-banana-pro: 1K-4K, nano-banana-2: 512-4K)
const RESOLUTIONS_PRO: Resolution[] = ["1K", "2K", "4K"];
const RESOLUTIONS_NB2: Resolution[] = ["512", "1K", "2K", "4K"];

// Hardcoded Gemini image models (always available)
const GEMINI_IMAGE_MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

// Image generation capabilities
const IMAGE_CAPABILITIES: ModelCapability[] = ["text-to-image", "image-to-image"];

type NanoBananaNodeType = Node<NanoBananaNodeData, "nanoBanana">;

export function GenerateImageNode({ id, data, selected }: NodeProps<NanoBananaNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const generationsPath = useWorkflowStore((state) => state.generationsPath);
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { replicateApiKey, falApiKey, kieApiKey, replicateEnabled, kieEnabled } = useProviderApiKeys();
  const [isLoadingCarouselImage, setIsLoadingCarouselImage] = useState(false);
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  // Get the current selected provider (default to gemini)
  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "gemini";

  // Get enabled providers
  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [];
    // Gemini is always available
    providers.push({ id: "gemini", name: "Gemini" });
    // fal.ai is always available (works without key but rate limited)
    providers.push({ id: "fal", name: "fal.ai" });
    // Add Replicate if configured
    if (replicateEnabled && replicateApiKey) {
      providers.push({ id: "replicate", name: "Replicate" });
    }
    // Add Kie.ai if configured
    if (kieEnabled && kieApiKey) {
      providers.push({ id: "kie", name: "Kie.ai" });
    }
    return providers;
  }, [replicateEnabled, replicateApiKey, kieEnabled, kieApiKey]);

  // Check if external providers (Replicate/Fal) are enabled
  // fal.ai is always available (works without key but rate limited)
  const hasExternalProviders = useMemo(() => {
    const hasReplicate = replicateEnabled && replicateApiKey;
    // fal.ai is always available
    return !!(hasReplicate || true);
  }, [replicateEnabled, replicateApiKey]);

  const isGeminiOnly = !hasExternalProviders;

  // Migrate legacy data: derive selectedModel from model field if missing
  useEffect(() => {
    if (nodeData.model && !nodeData.selectedModel) {
      const displayName = MODEL_DISPLAY_NAMES[nodeData.model] || nodeData.model;
      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: nodeData.model,
        displayName,
      };
      updateNodeData(id, { selectedModel: newSelectedModel });
    }
  }, [id, nodeData.model, nodeData.selectedModel, updateNodeData]);

  // Fetch models from external providers when provider changes
  const fetchModels = useCallback(async () => {
    if (currentProvider === "gemini") {
      setExternalModels([]);
      setModelsFetchError(null);
      return;
    }

    setIsLoadingModels(true);
    setModelsFetchError(null);
    try {
      const capabilities = IMAGE_CAPABILITIES.join(",");
      const headers: HeadersInit = {};
      if (replicateApiKey) {
        headers["X-Replicate-Key"] = replicateApiKey;
      }
      if (falApiKey) {
        headers["X-Fal-Key"] = falApiKey;
      }
      if (kieApiKey) {
        headers["X-Kie-Key"] = kieApiKey;
      }
      const response = await deduplicatedFetch(`/api/models?provider=${currentProvider}&capabilities=${capabilities}`, { headers });
      if (response.ok) {
        const data = await response.json();
        setExternalModels(data.models || []);
        setModelsFetchError(null);
      } else {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || `Failed to load models (${response.status})`;
        setExternalModels([]);
        setModelsFetchError(
          currentProvider === "replicate" && response.status === 401
            ? "Invalid Replicate API key. Check your settings."
            : errorMsg
        );
      }
    } catch (error) {
      console.error("Failed to fetch models:", error);
      setExternalModels([]);
      setModelsFetchError("Failed to load models. Check your connection.");
    } finally {
      setIsLoadingModels(false);
    }
  }, [currentProvider, replicateApiKey, falApiKey, kieApiKey]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Handle provider change
  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as ProviderType;

      if (provider === "gemini") {
        // Reset to Gemini default
        const newSelectedModel: SelectedModel = {
          provider: "gemini",
          modelId: nodeData.model || "nano-banana-pro",
          displayName: GEMINI_IMAGE_MODELS.find(m => m.value === (nodeData.model || "nano-banana-pro"))?.label || "Nano Banana Pro",
        };
        // Clear parameters when switching providers (different providers have different schemas)
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
      } else {
        // Set placeholder for external provider
        const newSelectedModel: SelectedModel = {
          provider,
          modelId: "",
          displayName: "Select model...",
        };
        // Clear parameters when switching providers
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [id, nodeData.model, updateNodeData]
  );

  // Handle model change for external providers
  const handleExternalModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const modelId = e.target.value;
      const model = externalModels.find(m => m.id === modelId);
      if (model) {
        const newSelectedModel: SelectedModel = {
          provider: currentProvider,
          modelId: model.id,
          displayName: model.name,
          capabilities: model.capabilities,
        };
        // Clear parameters when changing models (different models have different schemas)
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [id, currentProvider, externalModels, updateNodeData]
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

      // Also update selectedModel for consistency
      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: model,
        displayName: GEMINI_IMAGE_MODELS.find(m => m.value === model)?.label || model,
      };
      updateNodeData(id, { selectedModel: newSelectedModel });
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

  const handleImageSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useImageSearch = e.target.checked;
      updateNodeData(id, { useImageSearch });
      saveNanoBananaDefaults({ useImageSearch });
    },
    [id, updateNodeData]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(id, { parameters });
    },
    [id, updateNodeData]
  );

  // Handle inputs loaded from schema
  const handleInputsLoaded = useCallback(
    (inputs: ModelInputDef[]) => {
      updateNodeData(id, { inputSchema: inputs });
    },
    [id, updateNodeData]
  );

  // Handle parameters expand/collapse - resize node height
  const { setNodes } = useReactFlow();
  const handleParametersExpandChange = useCallback(
    (expanded: boolean, parameterCount: number) => {
      // Each parameter row is ~24px, plus some padding
      const parameterHeight = expanded ? Math.max(parameterCount * 28 + 16, 60) : 0;
      const baseHeight = 300; // Default node height
      const newHeight = baseHeight + parameterHeight;

      setNodes((nodes) =>
        nodes.map((node) =>
          node.id === id
            ? { ...node, style: { ...node.style, height: newHeight } }
            : node
        )
      );
    },
    [id, setNodes]
  );

  const handleClearImage = useCallback(() => {
    updateNodeData(id, { outputImage: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const loadImageById = useCallback(async (imageId: string) => {
    if (!generationsPath) {
      console.error("Generations path not configured");
      return null;
    }

    try {
      const response = await fetch("/api/load-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directoryPath: generationsPath,
          imageId,
        }),
      });

      const result = await response.json();
      if (!result.success) {
        // Missing images are expected when refs point to deleted/moved files
        console.log(`Image not found: ${imageId}`);
        return null;
      }
      return result.image;
    } catch (error) {
      console.warn("Error loading image:", error);
      return null;
    }
  }, [generationsPath]);

  const handleCarouselPrevious = useCallback(async () => {
    const history = nodeData.imageHistory || [];
    if (history.length === 0 || isLoadingCarouselImage) return;

    const currentIndex = nodeData.selectedHistoryIndex || 0;
    const newIndex = currentIndex === 0 ? history.length - 1 : currentIndex - 1;
    const imageItem = history[newIndex];

    setIsLoadingCarouselImage(true);
    const image = await loadImageById(imageItem.id);
    setIsLoadingCarouselImage(false);

    if (image) {
      updateNodeData(id, {
        outputImage: image,
        selectedHistoryIndex: newIndex,
      });
    }
  }, [id, nodeData.imageHistory, nodeData.selectedHistoryIndex, isLoadingCarouselImage, loadImageById, updateNodeData]);

  const handleCarouselNext = useCallback(async () => {
    const history = nodeData.imageHistory || [];
    if (history.length === 0 || isLoadingCarouselImage) return;

    const currentIndex = nodeData.selectedHistoryIndex || 0;
    const newIndex = (currentIndex + 1) % history.length;
    const imageItem = history[newIndex];

    setIsLoadingCarouselImage(true);
    const image = await loadImageById(imageItem.id);
    setIsLoadingCarouselImage(false);

    if (image) {
      updateNodeData(id, {
        outputImage: image,
        selectedHistoryIndex: newIndex,
      });
    }
  }, [id, nodeData.imageHistory, nodeData.selectedHistoryIndex, isLoadingCarouselImage, loadImageById, updateNodeData]);

  // Handle model selection from browse dialog
  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
      capabilities: model.capabilities,
    };
    updateNodeData(id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [id, updateNodeData]);

  const isGeminiProvider = currentProvider === "gemini";

  // Dynamic title based on selected model - just the model name
  const displayTitle = useMemo(() => {
    if (nodeData.selectedModel?.displayName && nodeData.selectedModel.modelId) {
      return nodeData.selectedModel.displayName;
    }
    // Fallback for legacy data or no model selected
    if (nodeData.model) {
      return GEMINI_IMAGE_MODELS.find(m => m.value === nodeData.model)?.label || nodeData.model;
    }
    return "Select model...";
  }, [nodeData.selectedModel?.displayName, nodeData.selectedModel?.modelId, nodeData.model]);

  // Provider badge as title prefix
  const titlePrefix = useMemo(() => (
    <ProviderBadge provider={currentProvider} />
  ), [currentProvider]);

  // Compute model page URL for external link
  const modelPageUrl = useMemo(() => {
    if (!nodeData.selectedModel?.modelId) return null;
    return getModelPageUrl(currentProvider, nodeData.selectedModel.modelId);
  }, [currentProvider, nodeData.selectedModel?.modelId]);

  // Header action element based on provider mode
  const headerAction = useMemo(() => {
    const linkIcon = modelPageUrl && nodeData.selectedModel?.modelId ? (
      <a
        href={modelPageUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="nodrag nopan text-neutral-500 hover:text-neutral-300 transition-colors"
        title={`View on ${getProviderDisplayName(currentProvider)}`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
    ) : null;

    if (!isGeminiOnly) {
      return (
        <>
          {linkIcon}
          <button
            onClick={() => setIsBrowseDialogOpen(true)}
            className="nodrag nopan text-[10px] py-0.5 px-1.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
          >
            Browse
          </button>
        </>
      );
    }
    return linkIcon;
  }, [isGeminiOnly, modelPageUrl, nodeData.selectedModel?.modelId, currentProvider]);
  // Use selectedModel.modelId for Gemini models, fallback to legacy model field
  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const supportsResolution = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const aspectRatios = currentModelId === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = currentModelId === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;
  const hasCarouselImages = (nodeData.imageHistory || []).length > 1;

  // Track previous status to detect error transitions
  const prevStatusRef = useRef(nodeData.status);

  // Show toast when error occurs
  useEffect(() => {
    if (nodeData.status === "error" && prevStatusRef.current !== "error" && nodeData.error) {
      useToast.getState().show("Generation failed", "error", true, nodeData.error);
    }
    prevStatusRef.current = nodeData.status;
  }, [nodeData.status, nodeData.error]);

  // Auto-resize node when output image changes
  const prevOutputImageRef = useRef<string | null>(null);
  useEffect(() => {
    // Only resize when outputImage transitions from null/different to a new value
    if (!nodeData.outputImage || nodeData.outputImage === prevOutputImageRef.current) {
      prevOutputImageRef.current = nodeData.outputImage ?? null;
      return;
    }
    prevOutputImageRef.current = nodeData.outputImage;

    // Use requestAnimationFrame to avoid React Flow update conflicts
    requestAnimationFrame(() => {
      getImageDimensions(nodeData.outputImage!).then((dims) => {
        if (!dims) return;

        const aspectRatio = dims.width / dims.height;

        setNodes((nodes) =>
          nodes.map((node) => {
            if (node.id !== id) return node;

            // Preserve user's manually set height if present
            const currentHeight = typeof node.style?.height === 'number'
              ? node.style.height
              : undefined;

            const newSize = calculateNodeSizePreservingHeight(aspectRatio, currentHeight);

            return { ...node, style: { ...node.style, width: newSize.width, height: newSize.height } };
          })
        );
      });
    });
  }, [id, nodeData.outputImage, setNodes]);

  return (
    <>
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      fullBleed
    >
      {/* Input handles - ALWAYS use same IDs and positions for connection stability */}
      {/* Image input at 35%, Text input at 65% - never changes regardless of model */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "35%", zIndex: 10 }}
        data-handletype="image"
        isConnectable={true}
      />
      {/* Image label */}
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{
          right: `calc(100% + 8px)`,
          top: "calc(35% - 18px)",
          color: "var(--handle-color-image)",
          zIndex: 10,
        }}
      >
        Image
      </div>
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "65%", zIndex: 10 }}
        data-handletype="text"
        isConnectable={true}
      />
      {/* Prompt label */}
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{
          right: `calc(100% + 8px)`,
          top: "calc(65% - 18px)",
          color: "var(--handle-color-text)",
          zIndex: 10,
        }}
      >
        Prompt
      </div>
      {/* Output handle */}
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        style={{ top: "50%", zIndex: 10 }}
        data-handletype="image"
      />
      {/* Output label */}
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: "var(--handle-color-image)",
          zIndex: 10,
        }}
      >
        Image
      </div>

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        {/* Preview area */}
        {nodeData.outputImage ? (
          <>
            <img
              src={nodeData.outputImage}
              alt="Generated"
              className="w-full h-full object-cover"
            />
            {/* Loading overlay for generation */}
            {nodeData.status === "loading" && (
              <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center">
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
              </div>
            )}
            {/* Error overlay when generation failed */}
            {nodeData.status === "error" && (
              <div className="absolute inset-0 bg-red-900/40 flex flex-col items-center justify-center gap-1">
                <svg
                  className="w-6 h-6 text-white"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-white text-xs font-medium">Generation failed</span>
                <span className="text-white/70 text-[10px]">See toast for details</span>
              </div>
            )}
            {/* Loading overlay for carousel navigation */}
            {isLoadingCarouselImage && (
              <div className="absolute inset-0 bg-neutral-900/50 flex items-center justify-center">
                <svg
                  className="w-4 h-4 animate-spin text-white"
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
              </div>
            )}
            {/* Clear button */}
            <div className="absolute top-1 right-1">
              <button
                onClick={handleClearImage}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear image"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Carousel controls - overlaid on image bottom */}
            {hasCarouselImages && (
              <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-1.5 bg-neutral-900/60 backdrop-blur-sm">
                <button
                  onClick={handleCarouselPrevious}
                  disabled={isLoadingCarouselImage}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
                  title="Previous image"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-[10px] text-white/70 min-w-[32px] text-center">
                  {(nodeData.selectedHistoryIndex || 0) + 1} / {(nodeData.imageHistory || []).length}
                </span>
                <button
                  onClick={handleCarouselNext}
                  disabled={isLoadingCarouselImage}
                  className="w-5 h-5 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-white/70 hover:text-white transition-colors"
                  title="Next image"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="w-full h-full min-h-[112px] bg-neutral-900/40 flex flex-col items-center justify-center">
            {nodeData.status === "loading" ? (
              <svg
                className="w-4 h-4 animate-spin text-neutral-400"
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
            ) : nodeData.status === "error" ? (
              <span className="text-[10px] text-red-400 text-center px-2">
                {nodeData.error || "Failed"}
              </span>
            ) : (
              <span className="text-neutral-500 text-[10px]">
                Run to generate
              </span>
            )}
          </div>
        )}
      </div>
    </BaseNode>
    </>
  );
}

/**
 * @deprecated Use `GenerateImageNode` instead. This alias is kept for backward compatibility
 * with existing workflows but will be removed in a future version.
 */
export { GenerateImageNode as NanoBananaNode };
