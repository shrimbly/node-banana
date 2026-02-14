"use client";

import React, { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { ModelParameters } from "./ModelParameters";
import { useWorkflowStore, saveNanoBananaDefaults, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { NanoBananaNodeData, AspectRatio, Resolution, ModelType, ProviderType, SelectedModel, ModelInputDef } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { useToast } from "@/components/Toast";
import { getImageDimensions, calculateNodeSizePreservingHeight } from "@/utils/nodeDimensions";

// Provider badge component - shows provider icon for all providers
function ProviderBadge({ provider }: { provider: ProviderType }) {
  const providerName = provider === "gemini" ? "Gemini" : provider === "replicate" ? "Replicate" : provider === "kie" ? "Kie.ai" : provider === "wavespeed" ? "WaveSpeed" : "fal.ai";

  return (
    <span className="text-neutral-500 shrink-0" title={providerName}>
      {provider === "gemini" ? (
        <svg className="w-4 h-4" viewBox="0 0 65 65" fill="currentColor">
          <path d="M57.8647 29.0098C52.865 26.8576 48.4905 23.905 44.7393 20.1556C40.99 16.4063 38.0373 12.0299 35.8851 7.03022C35.0589 5.11406 34.395 3.14442 33.886 1.12498C33.72 0.464747 33.128 0 32.4475 0C31.7669 0 31.1749 0.464747 31.009 1.12498C30.4999 3.14442 29.836 5.11222 29.0098 7.03022C26.8576 12.0299 23.905 16.4063 20.1556 20.1556C16.4063 23.905 12.0299 26.8576 7.03022 29.0098C5.11406 29.836 3.14442 30.4999 1.12498 31.009C0.464747 31.1749 0 31.7669 0 32.4475C0 33.128 0.464747 33.72 1.12498 33.886C3.14442 34.395 5.11222 35.0589 7.03022 35.8851C12.0299 38.0373 16.4045 40.99 20.1556 44.7393C23.9068 48.4886 26.8576 52.865 29.0098 57.8647C29.836 59.7809 30.4999 61.7505 31.009 63.7699C31.1749 64.4302 31.7669 64.8949 32.4475 64.8949C33.128 64.8949 33.72 64.4302 33.886 63.7699C34.395 61.7505 35.0589 59.7827 35.8851 57.8647C38.0373 52.865 40.99 48.4905 44.7393 44.7393C48.4886 40.99 52.865 38.0373 57.8647 35.8851C59.7809 35.0589 61.7505 34.395 63.7699 33.886C64.4302 33.72 64.8949 33.128 64.8949 32.4475C64.8949 31.7669 64.4302 31.1749 63.7699 31.009C61.7505 30.4999 59.7827 29.836 57.8647 29.0098Z" />
        </svg>
      ) : provider === "replicate" ? (
        <svg className="w-4 h-4" viewBox="0 0 1000 1000" fill="currentColor">
          <polygon points="1000,427.6 1000,540.6 603.4,540.6 603.4,1000 477,1000 477,427.6" />
          <polygon points="1000,213.8 1000,327 364.8,327 364.8,1000 238.4,1000 238.4,213.8" />
          <polygon points="1000,0 1000,113.2 126.4,113.2 126.4,1000 0,1000 0,0" />
        </svg>
      ) : provider === "kie" ? (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6 3h3.5v7L17 3h4l-8 8.5L21 21h-4l-7.5-8.5V21H6V3z" />
        </svg>
      ) : provider === "wavespeed" ? (
        <svg className="w-4 h-4" viewBox="95 140 350 230" fill="currentColor">
          <path d="M308.946 153.758C314.185 153.758 318.268 158.321 317.516 163.506C306.856 237.02 270.334 302.155 217.471 349.386C211.398 354.812 203.458 357.586 195.315 357.586H127.562C117.863 357.586 110.001 349.724 110.001 340.025V333.552C110.001 326.82 113.882 320.731 119.792 317.505C176.087 286.779 217.883 232.832 232.32 168.537C234.216 160.09 241.509 153.758 250.167 153.758H308.946Z" />
          <path d="M183.573 153.758C188.576 153.758 192.592 157.94 192.069 162.916C187.11 210.12 160.549 250.886 122.45 275.151C116.916 278.676 110 274.489 110 267.928V171.318C110 161.62 117.862 153.758 127.56 153.758H183.573Z" />
          <path d="M414.815 153.758C425.503 153.758 433.734 163.232 431.799 173.743C420.697 234.038 398.943 290.601 368.564 341.414C362.464 351.617 351.307 357.586 339.419 357.586H274.228C266.726 357.586 262.611 348.727 267.233 342.819C306.591 292.513 334.86 233.113 348.361 168.295C350.104 159.925 357.372 153.758 365.922 153.758H414.815Z" />
        </svg>
      ) : (
        <svg className="w-4 h-4" viewBox="0 0 1855 1855" fill="currentColor">
          <path fillRule="evenodd" clipRule="evenodd" d="M1181.65 78C1212.05 78 1236.42 101.947 1239.32 131.261C1265.25 392.744 1480.07 600.836 1750.02 625.948C1780.28 628.764 1805 652.366 1805 681.816V1174.18C1805 1203.63 1780.28 1227.24 1750.02 1230.05C1480.07 1255.16 1265.25 1463.26 1239.32 1724.74C1236.42 1754.05 1212.05 1778 1181.65 1778H673.354C642.951 1778 618.585 1754.05 615.678 1724.74C589.754 1463.26 374.927 1255.16 104.984 1230.05C74.7212 1227.24 50 1203.63 50 1174.18V681.816C50 652.366 74.7213 628.764 104.984 625.948C374.927 600.836 589.754 392.744 615.678 131.261C618.585 101.946 642.951 78 673.353 78H1181.65ZM402.377 926.561C402.377 1209.41 638.826 1438.71 930.501 1438.71C1222.18 1438.71 1458.63 1209.41 1458.63 926.561C1458.63 643.709 1222.18 414.412 930.501 414.412C638.826 414.412 402.377 643.709 402.377 926.561Z" />
        </svg>
      )}
    </span>
  );
}

// All 10 aspect ratios supported by both models
const ASPECT_RATIOS: AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Resolutions only for Nano Banana Pro (gemini-3-pro-image-preview)
const RESOLUTIONS: Resolution[] = ["1K", "2K", "4K"];

// Hardcoded Gemini image models (always available)
const GEMINI_IMAGE_MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

// Image generation capabilities
const IMAGE_CAPABILITIES: ModelCapability[] = ["text-to-image", "image-to-image", "text-to-3d", "image-to-3d"];

type NanoBananaNodeType = Node<NanoBananaNodeData, "nanoBanana">;

export function GenerateImageNode({ id, data, selected }: NodeProps<NanoBananaNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
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
      const displayName = nodeData.model === "nano-banana" ? "Nano Banana" : "Nano Banana Pro";
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
        // Clear parameters and 3D output when changing models (different models have different schemas)
        updateNodeData(id, { selectedModel: newSelectedModel, parameters: {}, output3dUrl: null });
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
    updateNodeData(id, { selectedModel: newSelectedModel, parameters: {}, output3dUrl: null });
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

  // Header action element based on provider mode
  const headerAction = useMemo(() => {
    if (!isGeminiOnly) {
      // External providers: browse button
      return (
        <button
          onClick={() => setIsBrowseDialogOpen(true)}
          className="nodrag nopan text-[10px] py-0.5 px-1.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
        >
          Browse
        </button>
      );
    }
    return null;
  }, [isGeminiOnly]);
  // Use selectedModel.modelId for Gemini models, fallback to legacy model field
  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const isNanoBananaPro = currentModelId === "nano-banana-pro";
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
      title={displayTitle}
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      onRun={handleRegenerate}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      headerAction={headerAction}
      titlePrefix={titlePrefix}
      commentNavigation={commentNavigation ?? undefined}
    >
      {/* Input handles - ALWAYS use same IDs and positions for connection stability */}
      {/* Image input at 35%, Text input at 65% - never changes regardless of model */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "35%" }}
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
        }}
      >
        Image
      </div>
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "65%" }}
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
        }}
      >
        Prompt
      </div>
      {/* Output handle — switches to 3d when a 3D model is selected */}
      <Handle
        type="source"
        position={Position.Right}
        id={nodeData.selectedModel?.capabilities?.some((c: string) => c.includes("3d")) ? "3d" : "image"}
        style={{ top: "50%" }}
        data-handletype={nodeData.selectedModel?.capabilities?.some((c: string) => c.includes("3d")) ? "3d" : "image"}
      />
      {/* Output label */}
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{
          left: `calc(100% + 8px)`,
          top: "calc(50% - 18px)",
          color: nodeData.selectedModel?.capabilities?.some((c: string) => c.includes("3d")) ? "var(--handle-color-3d)" : "var(--handle-color-image)",
        }}
      >
        {nodeData.selectedModel?.capabilities?.some((c: string) => c.includes("3d")) ? "3D" : "Image"}
      </div>

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Preview area */}
        {nodeData.output3dUrl ? (
          <div className="w-full flex-1 min-h-[80px] flex flex-col items-center justify-center gap-2 bg-neutral-800 rounded border border-neutral-700 p-3">
            <svg className="w-8 h-8 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-2.25-1.313M21 7.5v2.25m0-2.25l-2.25 1.313M3 7.5l2.25-1.313M3 7.5l2.25 1.313M3 7.5v2.25m9 3l2.25-1.313M12 12.75l-2.25-1.313M12 12.75V15m0 6.75l2.25-1.313M12 21.75V19.5m0 2.25l-2.25-1.313m0-16.875L12 2.25l2.25 1.313M21 14.25v2.25l-2.25 1.313m-13.5 0L3 16.5v-2.25" />
            </svg>
            <span className="text-[11px] text-orange-400 font-medium">3D Model Generated</span>
            <span className="text-[10px] text-neutral-500 truncate max-w-full">Connect to 3D Viewer</span>
          </div>
        ) : nodeData.outputImage ? (
          <>
            <div className="relative w-full flex-1 min-h-0">
              <img
                src={nodeData.outputImage}
                alt="Generated"
                className="w-full h-full object-contain rounded"
              />
              {/* Loading overlay for generation */}
              {nodeData.status === "loading" && (
                <div className="absolute inset-0 bg-neutral-900/70 rounded flex items-center justify-center">
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
                <div className="absolute inset-0 bg-red-900/40 rounded flex flex-col items-center justify-center gap-1">
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
                <div className="absolute inset-0 bg-neutral-900/50 rounded flex items-center justify-center">
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
            </div>

            {/* Carousel controls - only show if there are multiple images */}
            {hasCarouselImages && (
              <div className="flex items-center justify-center gap-2 shrink-0">
                <button
                  onClick={handleCarouselPrevious}
                  disabled={isLoadingCarouselImage}
                  className="w-5 h-5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                  title="Previous image"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                  </svg>
                </button>
                <span className="text-[10px] text-neutral-400 min-w-[32px] text-center">
                  {(nodeData.selectedHistoryIndex || 0) + 1} / {(nodeData.imageHistory || []).length}
                </span>
                <button
                  onClick={handleCarouselNext}
                  disabled={isLoadingCarouselImage}
                  className="w-5 h-5 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
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
          <div className="w-full flex-1 min-h-[112px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center">
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

        {/* Model-specific parameters for external providers */}
        {!isGeminiOnly && nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
            onExpandChange={handleParametersExpandChange}
            onInputsLoaded={handleInputsLoaded}
          />
        )}

        {/* Aspect ratio and resolution row - only for Gemini models */}
        {currentProvider === "gemini" && (
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
        )}

        {/* Google Search toggle - only for Nano Banana Pro */}
        {currentProvider === "gemini" && isNanoBananaPro && (
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

    {/* Model browser dialog for external providers */}
    {isBrowseDialogOpen && (
      <ModelSearchDialog
        isOpen={isBrowseDialogOpen}
        onClose={() => setIsBrowseDialogOpen(false)}
        onModelSelected={handleBrowseModelSelect}
        initialCapabilityFilter="image"
      />
    )}
    </>
  );
}

/**
 * @deprecated Use `GenerateImageNode` instead. This alias is kept for backward compatibility
 * with existing workflows but will be removed in a future version.
 */
export { GenerateImageNode as NanoBananaNode };
