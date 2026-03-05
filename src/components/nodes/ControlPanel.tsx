"use client";

import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Node } from "@xyflow/react";
import { useWorkflowStore, saveNanoBananaDefaults, useProviderApiKeys } from "@/store/workflowStore";
import { NodeType, NanoBananaNodeData, LLMGenerateNodeData, GenerateVideoNodeData, Generate3DNodeData, GenerateAudioNodeData, EaseCurveNodeData, ConditionalSwitchNodeData, AspectRatio, Resolution, ModelType, MODEL_DISPLAY_NAMES, ProviderType, SelectedModel, LLMProvider, LLMModelType, MatchMode, ConditionalSwitchRule } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { ModelSearchDialog } from "@/components/modals/ModelSearchDialog";
import { ModelParameters } from "./ModelParameters";
import { CubicBezierEditor } from "@/components/CubicBezierEditor";
import { deduplicatedFetch } from "@/utils/deduplicatedFetch";
import { evaluateRule } from "@/store/utils/ruleEvaluation";
import { EASING_PRESETS, getPresetBezier, getEasingBezier } from "@/lib/easing-presets";
import { getAllEasingNames, getEasingFunction } from "@/lib/easing-functions";
import { getModelPageUrl, getProviderDisplayName } from "@/utils/providerUrls";

// List of node types that have configurable parameters
const CONFIGURABLE_NODE_TYPES: NodeType[] = [
  "nanoBanana",
  "generateVideo",
  "generate3d",
  "generateAudio",
  "llmGenerate",
  "easeCurve",
  "conditionalSwitch",
];

// Base 10 aspect ratios (all Gemini image models)
const BASE_ASPECT_RATIOS: AspectRatio[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Extended 14 aspect ratios (Nano Banana 2 adds extreme ratios)
const EXTENDED_ASPECT_RATIOS: AspectRatio[] = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

// Resolutions per model
const RESOLUTIONS_PRO: Resolution[] = ["1K", "2K", "4K"];
const RESOLUTIONS_NB2: Resolution[] = ["512", "1K", "2K", "4K"];

// Hardcoded Gemini image models
const GEMINI_IMAGE_MODELS: { value: ModelType; label: string }[] = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

// LLM providers and models
const LLM_PROVIDERS: { value: LLMProvider; label: string }[] = [
  { value: "google", label: "Google" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

const LLM_MODELS: Record<LLMProvider, { value: LLMModelType; label: string }[]> = {
  google: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-3-pro-preview", label: "Gemini 3.0 Pro" },
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
  ],
  openai: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    { value: "gpt-4.1-nano", label: "GPT-4.1 Nano" },
  ],
  anthropic: [
    { value: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { value: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { value: "claude-opus-4.6", label: "Claude Opus 4.6" },
  ],
};

// Image/video/audio/3d generation capabilities
const IMAGE_CAPABILITIES: ModelCapability[] = ["text-to-image", "image-to-image"];
const VIDEO_CAPABILITIES: ModelCapability[] = ["text-to-video", "image-to-video"];
const AUDIO_CAPABILITIES: ModelCapability[] = ["text-to-audio"];
const MODEL_3D_CAPABILITIES: ModelCapability[] = ["text-to-3d", "image-to-3d"];

// Easing names
const ALL_EASING_NAMES = getAllEasingNames();
const PRESET_NAMES = new Set(EASING_PRESETS);

// Generate SVG polyline for easing preview
function generateEasingPolyline(
  easingName: string,
  width: number,
  height: number,
  samples: number = 20
): string {
  const fn = getEasingFunction(easingName);
  return Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    const y = fn(t);
    return `${(t * width).toFixed(1)},${((1 - y) * height).toFixed(1)}`;
  }).join(" ");
}

/**
 * Fixed-position control panel on the right side of viewport
 * Displays controls for the currently selected node
 */
export function ControlPanel() {
  const nodes = useWorkflowStore((state) => state.nodes);

  // Get the single selected node
  const selectedNode = useMemo(() => {
    const selected = nodes.filter((n) => n.selected);
    if (selected.length !== 1) return null;
    return selected[0];
  }, [nodes]);

  // Check if the selected node is configurable
  const isConfigurable = selectedNode && CONFIGURABLE_NODE_TYPES.includes(selectedNode.type as NodeType);

  // If no single node selected or not configurable, hide panel
  if (!selectedNode || !isConfigurable) {
    return null;
  }

  return (
    <div className="fixed top-0 right-6 h-screen z-[90] flex items-center pointer-events-none">
      <div
        className="w-80 bg-neutral-800 border border-neutral-700 rounded-xl max-h-[80vh] overflow-y-auto pointer-events-auto transition-opacity duration-200 nowheel"
        style={{
          boxShadow: [
            '-1px 0 2px rgba(0,0,0,0.18)',
            '-2px 0 4px rgba(0,0,0,0.15)',
            '-4px 0 8px rgba(0,0,0,0.12)',
            '-8px 0 16px rgba(0,0,0,0.10)',
            '-16px 0 32px rgba(0,0,0,0.08)',
            '-32px 0 64px rgba(0,0,0,0.06)',
          ].join(', '),
        }}
      >
        <div className="p-4">
          {/* Header */}
          <h3 className="text-sm font-medium text-neutral-200">
            {getNodeTypeTitle(selectedNode.type as NodeType)}
          </h3>

          {/* Node-specific controls */}
          <div className="space-y-4 mt-4">
            {selectedNode.type === "nanoBanana" && (
              <GenerateImageControls node={selectedNode} />
            )}
            {selectedNode.type === "generateVideo" && (
              <GenerateVideoControls node={selectedNode} />
            )}
            {selectedNode.type === "generate3d" && (
              <Generate3DControls node={selectedNode} />
            )}
            {selectedNode.type === "generateAudio" && (
              <GenerateAudioControls node={selectedNode} />
            )}
            {selectedNode.type === "llmGenerate" && (
              <LLMControls node={selectedNode} />
            )}
            {selectedNode.type === "easeCurve" && (
              <EaseCurveControls node={selectedNode} />
            )}
            {selectedNode.type === "conditionalSwitch" && (
              <ConditionalSwitchControls node={selectedNode} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function getNodeTypeTitle(type: NodeType): string {
  const titles: Record<string, string> = {
    nanoBanana: "Generate Image Settings",
    generateVideo: "Generate Video Settings",
    generate3d: "Generate 3D Settings",
    generateAudio: "Generate Audio Settings",
    llmGenerate: "LLM Settings",
    easeCurve: "Ease Curve Settings",
    conditionalSwitch: "Conditional Switch Settings",
  };
  return titles[type] || "Settings";
}

// Generate Image Controls
function GenerateImageControls({ node }: { node: Node }) {
  const nodeData = node.data as NanoBananaNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { replicateApiKey, falApiKey, kieApiKey, replicateEnabled, kieEnabled } = useProviderApiKeys();
  const [externalModels, setExternalModels] = useState<ProviderModel[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelsFetchError, setModelsFetchError] = useState<string | null>(null);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "gemini";

  // Get enabled providers
  const enabledProviders = useMemo(() => {
    const providers: { id: ProviderType; name: string }[] = [];
    providers.push({ id: "gemini", name: "Gemini" });
    providers.push({ id: "fal", name: "fal.ai" });
    if (replicateEnabled && replicateApiKey) {
      providers.push({ id: "replicate", name: "Replicate" });
    }
    if (kieEnabled && kieApiKey) {
      providers.push({ id: "kie", name: "Kie.ai" });
    }
    return providers;
  }, [replicateEnabled, replicateApiKey, kieEnabled, kieApiKey]);

  // Fetch models from external providers
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
      if (replicateApiKey) headers["X-Replicate-Key"] = replicateApiKey;
      if (falApiKey) headers["X-Fal-Key"] = falApiKey;
      if (kieApiKey) headers["X-Kie-Key"] = kieApiKey;

      const response = await deduplicatedFetch(`/api/models?provider=${currentProvider}&capabilities=${capabilities}`, { headers });
      if (response.ok) {
        const data = await response.json();
        setExternalModels(data.models || []);
        setModelsFetchError(null);
      } else {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || `Failed to load models (${response.status})`;
        setExternalModels([]);
        setModelsFetchError(errorMsg);
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

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const provider = e.target.value as ProviderType;

      if (provider === "gemini") {
        const newSelectedModel: SelectedModel = {
          provider: "gemini",
          modelId: nodeData.model || "nano-banana-pro",
          displayName: GEMINI_IMAGE_MODELS.find(m => m.value === (nodeData.model || "nano-banana-pro"))?.label || "Nano Banana Pro",
        };
        updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
      } else {
        const newSelectedModel: SelectedModel = {
          provider,
          modelId: "",
          displayName: "Select model...",
        };
        updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [node.id, nodeData.model, updateNodeData]
  );

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
        updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
      }
    },
    [node.id, currentProvider, externalModels, updateNodeData]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const model = e.target.value as ModelType;
      updateNodeData(node.id, { model });
      saveNanoBananaDefaults({ model });

      const newSelectedModel: SelectedModel = {
        provider: "gemini",
        modelId: model,
        displayName: GEMINI_IMAGE_MODELS.find(m => m.value === model)?.label || model,
      };
      updateNodeData(node.id, { selectedModel: newSelectedModel });
    },
    [node.id, updateNodeData]
  );

  const handleAspectRatioChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const aspectRatio = e.target.value as AspectRatio;
      updateNodeData(node.id, { aspectRatio });
      saveNanoBananaDefaults({ aspectRatio });
    },
    [node.id, updateNodeData]
  );

  const handleResolutionChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const resolution = e.target.value as Resolution;
      updateNodeData(node.id, { resolution });
      saveNanoBananaDefaults({ resolution });
    },
    [node.id, updateNodeData]
  );

  const handleGoogleSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useGoogleSearch = e.target.checked;
      updateNodeData(node.id, { useGoogleSearch });
      saveNanoBananaDefaults({ useGoogleSearch });
    },
    [node.id, updateNodeData]
  );

  const handleImageSearchToggle = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const useImageSearch = e.target.checked;
      updateNodeData(node.id, { useImageSearch });
      saveNanoBananaDefaults({ useImageSearch });
    },
    [node.id, updateNodeData]
  );

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(node.id, { parameters });
    },
    [node.id, updateNodeData]
  );

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
      capabilities: model.capabilities,
    };
    updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [node.id, updateNodeData]);

  const isGeminiProvider = currentProvider === "gemini";
  const currentModelId = isGeminiProvider ? (nodeData.selectedModel?.modelId || nodeData.model) : null;
  const supportsResolution = currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2";
  const aspectRatios = currentModelId === "nano-banana-2" ? EXTENDED_ASPECT_RATIOS : BASE_ASPECT_RATIOS;
  const resolutions = currentModelId === "nano-banana-2" ? RESOLUTIONS_NB2 : RESOLUTIONS_PRO;
  const hasExternalProviders = !!(replicateEnabled && replicateApiKey) || true;

  return (
    <>
      <div className="space-y-3">
        {/* Model name + provider with link — sits directly under title divider */}
        <div className="border-t border-neutral-700 pt-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">
                {nodeData.selectedModel?.displayName || GEMINI_IMAGE_MODELS.find(m => m.value === nodeData.model)?.label || "Select model..."}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-neutral-500 truncate">
                  {enabledProviders.find(p => p.id === currentProvider)?.name || currentProvider}
                </span>
                {nodeData.selectedModel?.modelId && (
                  <a
                    href={getModelPageUrl(currentProvider, nodeData.selectedModel.modelId) || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title={`View on ${getProviderDisplayName(currentProvider)}`}
                    onClick={(e) => {
                      if (!getModelPageUrl(currentProvider, nodeData.selectedModel?.modelId || "")) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {/* Gemini-specific controls */}
        {isGeminiProvider && (
          <>
            <div>
              <label className="block text-xs font-medium text-neutral-300 mb-1">Aspect Ratio</label>
              <select
                value={nodeData.aspectRatio || "1:1"}
                onChange={handleAspectRatioChange}
                className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {aspectRatios.map(ar => (
                  <option key={ar} value={ar}>{ar}</option>
                ))}
              </select>
            </div>

            {supportsResolution && (
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-1">Resolution</label>
                <select
                  value={nodeData.resolution || "1K"}
                  onChange={handleResolutionChange}
                  className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  {resolutions.map(res => (
                    <option key={res} value={res}>{res}</option>
                  ))}
                </select>
              </div>
            )}

            {(currentModelId === "nano-banana-pro" || currentModelId === "nano-banana-2") && (
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id={`google-search-${node.id}`}
                  checked={nodeData.useGoogleSearch || false}
                  onChange={handleGoogleSearchToggle}
                  className="nodrag nopan w-3 h-3 text-blue-600 bg-neutral-700 border-neutral-600 rounded focus:ring-blue-500"
                />
                <label htmlFor={`google-search-${node.id}`} className="ml-2 text-xs text-neutral-300">
                  Google Search
                </label>
              </div>
            )}

            {currentModelId === "nano-banana-2" && (
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id={`image-search-${node.id}`}
                  checked={nodeData.useImageSearch || false}
                  onChange={handleImageSearchToggle}
                  className="nodrag nopan w-3 h-3 text-blue-600 bg-neutral-700 border-neutral-600 rounded focus:ring-blue-500"
                />
                <label htmlFor={`image-search-${node.id}`} className="ml-2 text-xs text-neutral-300">
                  Image Search
                </label>
              </div>
            )}
          </>
        )}

        {/* External provider parameters */}
        {!isGeminiProvider && nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
          />
        )}
      </div>

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

// Generate Video Controls
function GenerateVideoControls({ node }: { node: Node }) {
  const nodeData = node.data as GenerateVideoNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(node.id, { parameters });
    },
    [node.id, updateNodeData]
  );

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    const newSelectedModel: SelectedModel = {
      provider: model.provider,
      modelId: model.id,
      displayName: model.name,
      capabilities: model.capabilities,
    };
    updateNodeData(node.id, { selectedModel: newSelectedModel, parameters: {} });
    setIsBrowseDialogOpen(false);
  }, [node.id, updateNodeData]);

  return (
    <>
      <div className="space-y-3">
        {/* Model name + provider with link */}
        <div className="border-t border-neutral-700 pt-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">
                {nodeData.selectedModel?.displayName || "Select model..."}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-neutral-500 truncate">
                  {getProviderDisplayName(currentProvider)}
                </span>
                {nodeData.selectedModel?.modelId && (
                  <a
                    href={getModelPageUrl(currentProvider, nodeData.selectedModel.modelId) || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title={`View on ${getProviderDisplayName(currentProvider)}`}
                    onClick={(e) => {
                      if (!getModelPageUrl(currentProvider, nodeData.selectedModel?.modelId || "")) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
          />
        )}
      </div>

      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="video"
        />
      )}
    </>
  );
}

// Generate 3D Controls
function Generate3DControls({ node }: { node: Node }) {
  const nodeData = node.data as Generate3DNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [isBrowseDialogOpen, setIsBrowseDialogOpen] = useState(false);

  const currentProvider: ProviderType = nodeData.selectedModel?.provider || "fal";

  const handleParametersChange = useCallback(
    (parameters: Record<string, unknown>) => {
      updateNodeData(node.id, { parameters });
    },
    [node.id, updateNodeData]
  );

  const handleBrowseModelSelect = useCallback((model: ProviderModel) => {
    updateNodeData(node.id, {
      selectedModel: {
        provider: model.provider,
        modelId: model.id,
        displayName: model.name,
        capabilities: model.capabilities,
      },
      parameters: {}
    });
    setIsBrowseDialogOpen(false);
  }, [node.id, updateNodeData]);

  return (
    <>
      <div className="space-y-3">
        {/* Model name + provider with link */}
        <div className="border-t border-neutral-700 pt-3">
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <div className="text-sm text-neutral-100 truncate">
                {nodeData.selectedModel?.displayName || "Select model..."}
              </div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] text-neutral-500 truncate">
                  {getProviderDisplayName(currentProvider)}
                </span>
                {nodeData.selectedModel?.modelId && (
                  <a
                    href={getModelPageUrl(currentProvider, nodeData.selectedModel.modelId) || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-neutral-500 hover:text-neutral-300 transition-colors"
                    title={`View on ${getProviderDisplayName(currentProvider)}`}
                    onClick={(e) => {
                      if (!getModelPageUrl(currentProvider, nodeData.selectedModel?.modelId || "")) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                )}
              </div>
            </div>
            <button
              onClick={() => setIsBrowseDialogOpen(true)}
              className="nodrag nopan shrink-0 px-3 py-1.5 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {nodeData.selectedModel?.modelId && (
          <ModelParameters
            modelId={nodeData.selectedModel.modelId}
            provider={currentProvider}
            parameters={nodeData.parameters || {}}
            onParametersChange={handleParametersChange}
          />
        )}
      </div>

      {isBrowseDialogOpen && (
        <ModelSearchDialog
          isOpen={isBrowseDialogOpen}
          onClose={() => setIsBrowseDialogOpen(false)}
          onModelSelected={handleBrowseModelSelect}
          initialCapabilityFilter="3d"
        />
      )}
    </>
  );
}

// Generate Audio Controls (simplified placeholder - similar pattern to video/3d)
function GenerateAudioControls({ node }: { node: Node }) {
  return (
    <div className="text-xs text-neutral-400">
      Audio controls coming in full implementation
    </div>
  );
}

// LLM Controls
function LLMControls({ node }: { node: Node }) {
  const nodeData = node.data as LLMGenerateNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const handleProviderChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newProvider = e.target.value as LLMProvider;
      const firstModelForProvider = LLM_MODELS[newProvider][0].value;
      const updates: Partial<LLMGenerateNodeData> = {
        provider: newProvider,
        model: firstModelForProvider,
      };
      if (newProvider === "anthropic" && nodeData.temperature > 1) {
        updates.temperature = 1;
      }
      updateNodeData(node.id, updates);
    },
    [node.id, updateNodeData, nodeData.temperature]
  );

  const handleModelChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(node.id, { model: e.target.value as LLMModelType });
    },
    [node.id, updateNodeData]
  );

  const handleTemperatureChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(node.id, { temperature: parseFloat(e.target.value) });
    },
    [node.id, updateNodeData]
  );

  const handleMaxTokensChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(node.id, { maxTokens: parseInt(e.target.value, 10) });
    },
    [node.id, updateNodeData]
  );

  const provider = nodeData.provider || "google";
  const availableModels = LLM_MODELS[provider] || LLM_MODELS.google;

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">Provider</label>
        <select
          value={provider}
          onChange={handleProviderChange}
          className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {LLM_PROVIDERS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">Model</label>
        <select
          value={nodeData.model || availableModels[0].value}
          onChange={handleModelChange}
          className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {availableModels.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">
          Temperature: {nodeData.temperature?.toFixed(2) || "0.70"}
        </label>
        <input
          type="range"
          min="0"
          max={provider === "anthropic" ? "1" : "2"}
          step="0.01"
          value={nodeData.temperature || 0.7}
          onChange={handleTemperatureChange}
          className="nodrag nopan w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">
          Max Tokens: {(nodeData.maxTokens || 2048).toLocaleString()}
        </label>
        <input
          type="range"
          min="256"
          max="16384"
          step="256"
          value={nodeData.maxTokens || 2048}
          onChange={handleMaxTokensChange}
          className="nodrag nopan w-full h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
      </div>
    </div>
  );
}

// Ease Curve Controls
function EaseCurveControls({ node }: { node: Node }) {
  const nodeData = node.data as EaseCurveNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [showPresets, setShowPresets] = useState(false);
  const presetsButtonRef = useRef<HTMLButtonElement>(null);

  const handleBezierChange = useCallback(
    (value: [number, number, number, number]) => {
      updateNodeData(node.id, { bezierHandles: value, easingPreset: null });
    },
    [node.id, updateNodeData]
  );

  const handleSelectEasing = useCallback(
    (name: string) => {
      updateNodeData(node.id, {
        easingPreset: name,
        bezierHandles: getEasingBezier(name),
      });
      setShowPresets(false);
    },
    [node.id, updateNodeData]
  );

  const handleDurationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      updateNodeData(node.id, { outputDuration: isNaN(val) ? 1.5 : Math.max(0.1, Math.min(30, val)) });
    },
    [node.id, updateNodeData]
  );

  const presetThumbnails = useMemo(() => {
    return ALL_EASING_NAMES.map((name) => ({
      name,
      polyline: generateEasingPolyline(name, 36, 36),
      isPreset: PRESET_NAMES.has(name as any),
    }));
  }, []);

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="block text-xs font-medium text-neutral-300">Easing Function</label>
          <button
            ref={presetsButtonRef}
            onClick={() => setShowPresets(!showPresets)}
            className="nodrag nopan text-xs px-2 py-0.5 bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
          >
            Presets
          </button>
        </div>
        <CubicBezierEditor
          value={nodeData.bezierHandles || [0.42, 0, 0.58, 1]}
          onChange={handleBezierChange}
          onCommit={handleBezierChange}
        />
        {nodeData.easingPreset && (
          <div className="text-xs text-neutral-400 mt-1">
            Current: {nodeData.easingPreset}
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-300 mb-1">
          Output Duration: {nodeData.outputDuration?.toFixed(1) || "1.5"}s
        </label>
        <input
          type="number"
          min="0.1"
          max="30"
          step="0.1"
          value={nodeData.outputDuration || 1.5}
          onChange={handleDurationChange}
          className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {showPresets && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed z-[100] bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-2 max-h-96 overflow-y-auto nowheel"
          style={{
            top: presetsButtonRef.current?.getBoundingClientRect().bottom || 0,
            left: presetsButtonRef.current?.getBoundingClientRect().left || 0,
            width: 240,
          }}
        >
          <div className="grid grid-cols-3 gap-1">
            {presetThumbnails.map(({ name, polyline }) => (
              <button
                key={name}
                onClick={() => handleSelectEasing(name)}
                className="nodrag nopan p-1 bg-neutral-900 hover:bg-neutral-700 rounded flex flex-col items-center gap-1 transition-colors"
                title={name}
              >
                <svg width="36" height="36" viewBox="0 0 36 36" className="flex-shrink-0">
                  <polyline
                    points={polyline}
                    fill="none"
                    stroke="#a3a3a3"
                    strokeWidth="1.5"
                  />
                </svg>
                <span className="text-[8px] text-neutral-400 text-center break-words w-full">
                  {name}
                </span>
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Conditional Switch Controls
function ConditionalSwitchControls({ node }: { node: Node }) {
  const nodeData = node.data as ConditionalSwitchNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [editingId, setEditingId] = useState<string | null>(null);

  const handleRuleValueChange = useCallback(
    (ruleId: string, newValue: string) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, value: newValue } : rule
      );
      updateNodeData(node.id, { rules: updatedRules, evaluationPaused: false });
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleModeChange = useCallback(
    (ruleId: string, newMode: MatchMode) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, mode: newMode } : rule
      );
      updateNodeData(node.id, { rules: updatedRules, evaluationPaused: false });
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleLabelEdit = useCallback(
    (ruleId: string, newLabel: string) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, label: newLabel } : rule
      );
      updateNodeData(node.id, { rules: updatedRules });
      setEditingId(null);
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleDelete = useCallback(
    (ruleId: string) => {
      if (nodeData.rules.length <= 1) return;
      const updatedRules = nodeData.rules.filter((rule) => rule.id !== ruleId);
      updateNodeData(node.id, { rules: updatedRules });
    },
    [node.id, nodeData.rules, updateNodeData]
  );

  const handleAddRule = useCallback(() => {
    const newRule: ConditionalSwitchRule = {
      id: "rule-" + Math.random().toString(36).slice(2, 9),
      value: "",
      mode: "contains",
      label: `Rule ${nodeData.rules.length + 1}`,
      isMatched: false,
    };
    updateNodeData(node.id, { rules: [...nodeData.rules, newRule] });
  }, [node.id, nodeData.rules, updateNodeData]);

  return (
    <div className="space-y-2">
      {nodeData.rules.map((rule, index) => (
        <div key={rule.id} className="border border-neutral-600 rounded p-2 space-y-2">
          <div className="flex items-center justify-between">
            <input
              type="text"
              value={editingId === rule.id ? rule.label : rule.label || `Rule ${index + 1}`}
              onChange={(e) => handleLabelEdit(rule.id, e.target.value)}
              onFocus={() => setEditingId(rule.id)}
              onBlur={() => setEditingId(null)}
              className="nodrag nopan flex-1 px-1 py-0.5 text-xs bg-transparent border-none text-neutral-200 focus:outline-none"
            />
            {nodeData.rules.length > 1 && (
              <button
                onClick={() => handleDelete(rule.id)}
                className="nodrag nopan text-neutral-500 hover:text-red-400"
                title="Delete rule"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <select
            value={rule.mode}
            onChange={(e) => handleModeChange(rule.id, e.target.value as MatchMode)}
            className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="exact">Exact match</option>
            <option value="contains">Contains</option>
            <option value="starts-with">Starts with</option>
            <option value="ends-with">Ends with</option>
          </select>

          <input
            type="text"
            value={rule.value}
            onChange={(e) => handleRuleValueChange(rule.id, e.target.value)}
            placeholder="Enter match value"
            className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 border border-neutral-600 rounded text-neutral-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />

          {rule.isMatched !== undefined && (
            <div className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${rule.isMatched ? 'bg-green-500' : 'bg-neutral-600'}`} />
              <span className="text-xs text-neutral-400">
                {rule.isMatched ? 'Matched' : 'Not matched'}
              </span>
            </div>
          )}
        </div>
      ))}

      <button
        onClick={handleAddRule}
        className="nodrag nopan w-full px-2 py-1 text-xs bg-neutral-700 hover:bg-neutral-600 border border-neutral-600 rounded text-neutral-300 transition-colors"
      >
        + Add Rule
      </button>
    </div>
  );
}
