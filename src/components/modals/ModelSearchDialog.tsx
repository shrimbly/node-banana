"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch, clearFetchCache } from "@/utils/deduplicatedFetch";
import { useReactFlow } from "@xyflow/react";
import { ProviderType, RecentModel } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";

// localStorage cache for models (persists across dev server restarts)
// Bump version when model data shape changes (e.g., adding pricing fields)
const MODELS_CACHE_KEY = "node-banana-models-cache";
const MODELS_CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours

interface ModelsCacheEntry {
  models: ProviderModel[];
  timestamp: number;
}

function getCachedModels(cacheKey: string): ModelsCacheEntry | null {
  try {
    const cache = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || "{}");
    const entry = cache[cacheKey];
    if (entry && Date.now() - entry.timestamp < MODELS_CACHE_TTL) {
      return entry;
    }
  } catch {
    // Ignore cache errors
  }
  return null;
}

function setCachedModels(cacheKey: string, models: ProviderModel[]) {
  try {
    const cache = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || "{}");
    cache[cacheKey] = { models, timestamp: Date.now() };
    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore cache errors
  }
}

// Provider icons — all normalized to w-3.5 h-3.5 with viewBoxes cropped to fill consistently
const ReplicateIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 1000 1000" fill="currentColor">
    <polygon points="1000,427.6 1000,540.6 603.4,540.6 603.4,1000 477,1000 477,427.6" />
    <polygon points="1000,213.8 1000,327 364.8,327 364.8,1000 238.4,1000 238.4,213.8" />
    <polygon points="1000,0 1000,113.2 126.4,113.2 126.4,1000 0,1000 0,0" />
  </svg>
);

const FalIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 1855 1855" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M1181.65 78C1212.05 78 1236.42 101.947 1239.32 131.261C1265.25 392.744 1480.07 600.836 1750.02 625.948C1780.28 628.764 1805 652.366 1805 681.816V1174.18C1805 1203.63 1780.28 1227.24 1750.02 1230.05C1480.07 1255.16 1265.25 1463.26 1239.32 1724.74C1236.42 1754.05 1212.05 1778 1181.65 1778H673.354C642.951 1778 618.585 1754.05 615.678 1724.74C589.754 1463.26 374.927 1255.16 104.984 1230.05C74.7212 1227.24 50 1203.63 50 1174.18V681.816C50 652.366 74.7213 628.764 104.984 625.948C374.927 600.836 589.754 392.744 615.678 131.261C618.585 101.946 642.951 78 673.353 78H1181.65ZM402.377 926.561C402.377 1209.41 638.826 1438.71 930.501 1438.71C1222.18 1438.71 1458.63 1209.41 1458.63 926.561C1458.63 643.709 1222.18 414.412 930.501 414.412C638.826 414.412 402.377 643.709 402.377 926.561Z" />
  </svg>
);

const GeminiIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z" />
  </svg>
);

const KieIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 3h3.5v7L17 3h4l-8 8.5L21 21h-4l-7.5-8.5V21H6V3z" />
  </svg>
);

const WaveSpeedIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="95 140 350 230" fill="currentColor">
    <path d="M308.946 153.758C314.185 153.758 318.268 158.321 317.516 163.506C306.856 237.02 270.334 302.155 217.471 349.386C211.398 354.812 203.458 357.586 195.315 357.586H127.562C117.863 357.586 110.001 349.724 110.001 340.025V333.552C110.001 326.82 113.882 320.731 119.792 317.505C176.087 286.779 217.883 232.832 232.32 168.537C234.216 160.09 241.509 153.758 250.167 153.758H308.946Z" />
    <path d="M183.573 153.758C188.576 153.758 192.592 157.94 192.069 162.916C187.11 210.12 160.549 250.886 122.45 275.151C116.916 278.676 110 274.489 110 267.928V171.318C110 161.62 117.862 153.758 127.56 153.758H183.573Z" />
    <path d="M414.815 153.758C425.503 153.758 433.734 163.232 431.799 173.743C420.697 234.038 398.943 290.601 368.564 341.414C362.464 351.617 351.307 357.586 339.419 357.586H274.228C266.726 357.586 262.611 348.727 267.233 342.819C306.591 292.513 334.86 233.113 348.361 168.295C350.104 159.925 357.372 153.758 365.922 153.758H414.815Z" />
  </svg>
);

// Get the center of the React Flow pane in screen coordinates
function getPaneCenter() {
  const pane = document.querySelector(".react-flow");
  if (pane) {
    const rect = pane.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

// Capability filter options
type CapabilityFilter = "all" | "image" | "video" | "3d" | "audio";

// API response type
interface ModelsResponse {
  success: boolean;
  models?: ProviderModel[];
  error?: string;
}

interface ModelSearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialProvider?: ProviderType | null;
  /** When provided, calls this callback instead of creating a new node */
  onModelSelected?: (model: ProviderModel) => void;
  /** Initial capability filter - 'image' for image nodes, 'video' for video nodes */
  initialCapabilityFilter?: CapabilityFilter;
}

export function ModelSearchDialog({
  isOpen,
  onClose,
  initialProvider,
  onModelSelected,
  initialCapabilityFilter,
}: ModelSearchDialogProps) {
  const {
    addNode,
    incrementModalCount,
    decrementModalCount,
    recentModels,
    trackModelUsage,
  } = useWorkflowStore();
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey } = useProviderApiKeys();
  const { screenToFlowPosition } = useReactFlow();

  // State
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderType | "all">(
    initialProvider || "all"
  );
  const [capabilityFilter, setCapabilityFilter] =
    useState<CapabilityFilter>(initialCapabilityFilter || "all");
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Track request version to ignore stale responses
  const requestVersionRef = useRef(0);

  // Register modal with store
  useEffect(() => {
    if (isOpen) {
      incrementModalCount();
      return () => decrementModalCount();
    }
  }, [isOpen, incrementModalCount, decrementModalCount]);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Update provider filter when initialProvider changes
  useEffect(() => {
    if (initialProvider) {
      setProviderFilter(initialProvider);
    }
  }, [initialProvider]);

  // Fetch models
  const fetchModels = useCallback(async (bypassCache = false) => {
    // Increment version to track this request
    const thisVersion = ++requestVersionRef.current;

    // Build cache key from filters
    const cacheKey = `${providerFilter}:${capabilityFilter}:${debouncedSearch}`;

    // Check localStorage cache first (skip when bypassing)
    if (!bypassCache) {
      const cached = getCachedModels(cacheKey);
      if (cached) {
        setModels(cached.models);
        return;
      }
    }

    setIsLoading(true);
    setError(null);

    try {
      // Build query params
      const params = new URLSearchParams();
      if (debouncedSearch) {
        params.set("search", debouncedSearch);
      }
      if (providerFilter !== "all") {
        params.set("provider", providerFilter);
      }
      if (capabilityFilter !== "all") {
        const capabilities =
          capabilityFilter === "image"
            ? "text-to-image,image-to-image"
            : capabilityFilter === "video"
            ? "text-to-video,image-to-video"
            : capabilityFilter === "3d"
            ? "text-to-3d,image-to-3d"
            : "text-to-audio";
        params.set("capabilities", capabilities);
      }
      if (bypassCache) {
        params.set("refresh", "true");
      }

      // Build headers with API keys
      const headers: Record<string, string> = {};
      if (replicateApiKey) {
        headers["X-Replicate-Key"] = replicateApiKey;
      }
      if (falApiKey) {
        headers["X-Fal-Key"] = falApiKey;
      }
      if (kieApiKey) {
        headers["X-Kie-Key"] = kieApiKey;
      }
      if (wavespeedApiKey) {
        headers["X-WaveSpeed-Key"] = wavespeedApiKey;
      }

      const response = await deduplicatedFetch(`/api/models?${params.toString()}`, {
        headers,
      });

      // Check if this request is still current
      if (thisVersion !== requestVersionRef.current) {
        return; // Ignore stale response
      }

      const data: ModelsResponse = await response.json();

      if (data.success && data.models) {
        setModels(data.models);
        // Cache the successful result
        setCachedModels(cacheKey, data.models);
      } else {
        setError(data.error || "Failed to fetch models");
        setModels([]);
      }
    } catch (err) {
      // Check if this request is still current
      if (thisVersion !== requestVersionRef.current) {
        return; // Ignore stale error
      }
      setError(err instanceof Error ? err.message : "Failed to fetch models");
      setModels([]);
    } finally {
      // Only update loading state if this is still the current request
      if (thisVersion === requestVersionRef.current) {
        setIsLoading(false);
      }
    }
  }, [debouncedSearch, providerFilter, capabilityFilter, replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey]);

  // Fetch models when filters change
  useEffect(() => {
    if (isOpen) {
      fetchModels();
    }
  }, [isOpen, fetchModels]);

  // Clear all caches and re-fetch models from scratch
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      // Clear localStorage model cache
      localStorage.removeItem(MODELS_CACHE_KEY);
      // Clear localStorage schema cache (keep in sync with SCHEMA_CACHE_KEY in ModelParameters.tsx)
      localStorage.removeItem("node-banana-schema-cache-v3");
      // Clear in-memory deduplicatedFetch cache
      clearFetchCache();
      // Re-fetch with cache bypass
      await fetchModels(true);
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchModels]);

  // Focus search input when dialog opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  // Handle model selection
  const handleSelectModel = useCallback(
    (model: ProviderModel) => {
      // Track model usage for "recently used" feature
      trackModelUsage({
        provider: model.provider,
        modelId: model.id,
        displayName: model.name,
      });

      // If onModelSelected is provided, use it to update an existing node
      if (onModelSelected) {
        onModelSelected(model);
        onClose();
        return;
      }

      // Otherwise, create a new node
      const center = getPaneCenter();
      const position = screenToFlowPosition({
        x: center.x + Math.random() * 100 - 50,
        y: center.y + Math.random() * 100 - 50,
      });

      // Determine node type based on model capabilities
      const isVideoModel = model.capabilities.some(
        (cap) => cap === "text-to-video" || cap === "image-to-video"
      );
      const is3DModel = model.capabilities.some(
        (cap) => cap === "text-to-3d" || cap === "image-to-3d"
      );
      const isAudioModel = model.capabilities.some(
        (cap) => cap === "text-to-audio"
      );

      const nodeType = isVideoModel ? "generateVideo" : is3DModel ? "generate3d" : isAudioModel ? "generateAudio" : "nanoBanana";

      addNode(nodeType, position, {
        selectedModel: {
          provider: model.provider,
          modelId: model.id,
          displayName: model.name,
          capabilities: model.capabilities,
          ...(model.pricing && {
            pricing: {
              type: model.pricing.type,
              amount: model.pricing.amount,
            },
          }),
        },
      });

      onClose();
    },
    [screenToFlowPosition, addNode, onClose, onModelSelected, trackModelUsage]
  );

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    if (isOpen) {
      window.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  // Handle backdrop click
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Get provider badge color
  const getProviderBadgeColor = (provider: ProviderType) => {
    switch (provider) {
      case "gemini":
        return "bg-green-500/20 text-green-300";
      case "replicate":
        return "bg-blue-500/20 text-blue-300";
      case "fal":
        return "bg-yellow-500/20 text-yellow-300";
      case "kie":
        return "bg-orange-500/20 text-orange-300";
      case "wavespeed":
        return "bg-purple-500/20 text-purple-300";
      default:
        return "bg-neutral-500/20 text-neutral-300";
    }
  };

  // Get provider display name
  const getProviderDisplayName = (provider: ProviderType) => {
    switch (provider) {
      case "gemini":
        return "Gemini";
      case "replicate":
        return "Replicate";
      case "fal":
        return "fal.ai";
      case "kie":
        return "Kie.ai";
      case "wavespeed":
        return "WaveSpeed";
      default:
        return provider;
    }
  };

  // Filter recent models by capability
  const filteredRecentModels = useMemo(() => {
    return recentModels
      .filter((recent) => {
        // Find matching model in current models list to check capabilities
        const matchingModel = models.find((m) => m.id === recent.modelId);
        if (!matchingModel && capabilityFilter !== "all") {
          // If model not loaded yet and filter is active, exclude it
          return false;
        }
        if (capabilityFilter === "all") return true;
        if (!matchingModel) return true; // Show if we can't verify capabilities

        const isImage = matchingModel.capabilities.some(
          (cap) => cap === "text-to-image" || cap === "image-to-image"
        );
        const isVideo = matchingModel.capabilities.some(
          (cap) => cap === "text-to-video" || cap === "image-to-video"
        );
        const is3D = matchingModel.capabilities.some(
          (cap) => cap === "text-to-3d" || cap === "image-to-3d"
        );
        const isAudio = matchingModel.capabilities.some(
          (cap) => cap === "text-to-audio"
        );

        if (capabilityFilter === "image") return isImage;
        if (capabilityFilter === "video") return isVideo;
        if (capabilityFilter === "3d") return is3D;
        if (capabilityFilter === "audio") return isAudio;
        return true;
      })
      .slice(0, 4); // Show max 4
  }, [recentModels, models, capabilityFilter]);

  // Get display name with suffix for fal.ai models to differentiate variants
  const getDisplayName = (model: ProviderModel): string => {
    if (model.provider === "fal") {
      // Extract the last segment of the ID (e.g., "effects" from "kling-video/v1.6/pro/effects")
      const segments = model.id.split("/");
      const lastSegment = segments[segments.length - 1];

      // Only add suffix if it's not already in the name (case-insensitive)
      if (lastSegment && !model.name.toLowerCase().includes(lastSegment.toLowerCase())) {
        return `${model.name} - ${lastSegment}`;
      }
    }
    return model.name;
  };

  // Get model page URL for the provider's website
  const getModelUrl = (model: ProviderModel): string | null => {
    if (model.pageUrl) return model.pageUrl;
    switch (model.provider) {
      case "replicate":
        return `https://replicate.com/${model.id}`;
      case "fal":
        return `https://fal.ai/models/${model.id}`;
      case "wavespeed":
        return `https://wavespeed.ai`;
      default:
        return null;
    }
  };

  // Get capability badges - show all capabilities to differentiate similar models
  const getCapabilityBadges = (capabilities: ModelCapability[]) => {
    const badges: React.ReactNode[] = [];

    capabilities.forEach((cap) => {
      let color = "";
      let label = "";

      switch (cap) {
        case "text-to-image":
          color = "bg-green-500/20 text-green-300";
          label = "txt→img";
          break;
        case "image-to-image":
          color = "bg-cyan-500/20 text-cyan-300";
          label = "img→img";
          break;
        case "text-to-video":
          color = "bg-purple-500/20 text-purple-300";
          label = "txt→vid";
          break;
        case "image-to-video":
          color = "bg-pink-500/20 text-pink-300";
          label = "img→vid";
          break;
        case "text-to-3d":
          color = "bg-orange-500/20 text-orange-300";
          label = "txt→3d";
          break;
        case "image-to-3d":
          color = "bg-amber-500/20 text-amber-300";
          label = "img→3d";
          break;
        case "text-to-audio":
          color = "bg-fuchsia-500/20 text-fuchsia-300";
          label = "txt→audio";
          break;
      }

      if (label) {
        badges.push(
          <span
            key={cap}
            className={`text-[10px] px-1.5 py-0.5 rounded ${color}`}
          >
            {label}
          </span>
        );
      }
    });

    return badges;
  };

  if (!isOpen) return null;

  const dialogContent = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onClick={handleBackdropClick}
    >
      <div className="relative bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-700">
          <h2 className="text-lg font-semibold text-neutral-100">
            Browse Models
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700 rounded transition-colors"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Filter Bar */}
        <div className="px-6 py-4 border-b border-neutral-700">
          <div className="flex flex-col sm:flex-row gap-3">
            {/* Search Input */}
            <div className="flex-1 relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models..."
                className="w-full pl-10 pr-4 py-2 text-sm bg-neutral-700 border border-neutral-600 rounded text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-500"
              />
            </div>

            {/* Provider Filter - Icon Buttons */}
            <div className="flex items-center gap-0.5 bg-neutral-700/50 rounded p-0.5">
              <button
                onClick={() => setProviderFilter("all")}
                title="All Providers"
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  providerFilter === "all"
                    ? "bg-neutral-600 text-neutral-100"
                    : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700"
                }`}
              >
                All
              </button>
              <button
                onClick={() => setProviderFilter("gemini")}
                title="Gemini"
                className={`p-2 rounded transition-colors ${
                  providerFilter === "gemini"
                    ? "bg-green-500/20 text-green-300"
                    : "text-neutral-400 hover:text-green-300 hover:bg-neutral-700"
                }`}
              >
                <GeminiIcon />
              </button>
              <button
                onClick={() => setProviderFilter("replicate")}
                title="Replicate"
                className={`p-2 rounded transition-colors ${
                  providerFilter === "replicate"
                    ? "bg-blue-500/20 text-blue-300"
                    : "text-neutral-400 hover:text-blue-300 hover:bg-neutral-700"
                }`}
              >
                <ReplicateIcon />
              </button>
              <button
                onClick={() => setProviderFilter("fal")}
                title="fal.ai"
                className={`p-2 rounded transition-colors ${
                  providerFilter === "fal"
                    ? "bg-yellow-500/20 text-yellow-300"
                    : "text-neutral-400 hover:text-yellow-300 hover:bg-neutral-700"
                }`}
              >
                <FalIcon />
              </button>
              <button
                onClick={() => setProviderFilter("kie")}
                title="Kie.ai"
                className={`p-2 rounded transition-colors ${
                  providerFilter === "kie"
                    ? "bg-orange-500/20 text-orange-300"
                    : "text-neutral-400 hover:text-orange-300 hover:bg-neutral-700"
                }`}
              >
                <KieIcon />
              </button>
              <button
                onClick={() => setProviderFilter("wavespeed")}
                title="WaveSpeed"
                className={`p-2 rounded transition-colors ${
                  providerFilter === "wavespeed"
                    ? "bg-orange-500/20 text-orange-300"
                    : "text-neutral-400 hover:text-orange-300 hover:bg-neutral-700"
                }`}
              >
                <WaveSpeedIcon />
              </button>
            </div>

            {/* Capability Filter */}
            <select
              value={capabilityFilter}
              onChange={(e) =>
                setCapabilityFilter(e.target.value as CapabilityFilter)
              }
              className="px-3 py-2 text-sm bg-neutral-700 border border-neutral-600 rounded text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-500"
            >
              <option value="all">All Types</option>
              <option value="image">Image</option>
              <option value="video">Video</option>
              <option value="3d">3D</option>
              <option value="audio">Audio</option>
            </select>

            {/* Refresh Cache */}
            <button
              onClick={handleRefresh}
              disabled={isRefreshing || isLoading}
              title="Refresh models & schemas"
              className="p-2 rounded text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <svg
                className={`w-4 h-4${isRefreshing ? " animate-spin" : ""}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 4v5h5M20 20v-5h-5M4 9a8 8 0 0113.292-6.036M20 15a8 8 0 01-13.292 6.036"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* Model List */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-48">
              <div className="flex flex-col items-center gap-3">
                <svg
                  className="w-8 h-8 animate-spin text-neutral-400"
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
                <span className="text-sm text-neutral-400">
                  Loading models...
                </span>
              </div>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-48 gap-3">
              <svg
                className="w-10 h-10 text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <p className="text-sm text-neutral-400 text-center max-w-xs">
                {error}
              </p>
              <button
                onClick={handleRefresh}
                className="px-3 py-1.5 text-sm bg-neutral-700 hover:bg-neutral-600 text-neutral-200 rounded transition-colors"
              >
                Try Again
              </button>
            </div>
          ) : models.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 gap-2">
              <svg
                className="w-10 h-10 text-neutral-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-sm text-neutral-400">No models found</p>
              <p className="text-xs text-neutral-500">
                Try adjusting your search or filters
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Recently Used Section */}
              {filteredRecentModels.length > 0 && !searchQuery && (
                <div className="bg-neutral-700/30 rounded-lg p-3">
                  <h3 className="text-xs font-medium text-neutral-500 mb-2">
                    Recently Used
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {filteredRecentModels.map((recent) => {
                      const matchingModel = models.find(
                        (m) => m.id === recent.modelId
                      );
                      // Create a ProviderModel from RecentModel for handleSelectModel
                      const model: ProviderModel = matchingModel || {
                        id: recent.modelId,
                        name: recent.displayName,
                        description: null,
                        provider: recent.provider,
                        capabilities: [],
                      };
                      return (
                        <button
                          key={`recent-${recent.modelId}`}
                          onClick={() => handleSelectModel(model)}
                          className="flex items-center gap-3 p-3 bg-neutral-700/50 hover:bg-neutral-700 border border-neutral-600/30 hover:border-neutral-500 rounded-lg transition-colors text-left cursor-pointer group"
                        >
                          {/* Small cover image */}
                          <div className="w-10 h-10 rounded bg-neutral-600 overflow-hidden flex-shrink-0">
                            {matchingModel?.coverImage ? (
                              <img
                                src={matchingModel.coverImage}
                                alt={recent.displayName}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <svg
                                  className="w-5 h-5 text-neutral-500"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={1.5}
                                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                                  />
                                </svg>
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-neutral-100 text-sm truncate">
                              {recent.displayName}
                            </div>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded ${getProviderBadgeColor(recent.provider)}`}
                            >
                              {getProviderDisplayName(recent.provider)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Main Model List */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {models.map((model) => (
                <button
                  key={`${model.provider}-${model.id}`}
                  onClick={() => handleSelectModel(model)}
                  className="flex items-start gap-3 p-4 bg-neutral-700/50 hover:bg-neutral-700 border border-neutral-600/50 hover:border-neutral-500 rounded-lg transition-colors text-left cursor-pointer group"
                >
                  {/* Cover Image - larger */}
                  <div className="w-20 h-20 rounded bg-neutral-600 overflow-hidden flex-shrink-0">
                    {model.coverImage ? (
                      <img
                        src={model.coverImage}
                        alt={model.name}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          // Hide broken images
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <svg
                          className="w-8 h-8 text-neutral-500"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                          />
                        </svg>
                      </div>
                    )}
                  </div>

                  {/* Model Info */}
                  <div className="flex-1 min-w-0">
                    {/* Model name with variant suffix for fal.ai */}
                    <div className="font-medium text-neutral-100 text-sm truncate">
                      {getDisplayName(model)}
                    </div>

                    {/* Model ID with link to provider page */}
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-xs text-neutral-500 truncate font-mono">
                        {model.id}
                      </span>
                      {getModelUrl(model) && (
                        <a
                          href={getModelUrl(model)!}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-neutral-500 hover:text-neutral-300 transition-colors flex-shrink-0"
                          title={`View on ${getProviderDisplayName(model.provider)}`}
                        >
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                            />
                          </svg>
                        </a>
                      )}
                    </div>

                    {/* Badges row */}
                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${getProviderBadgeColor(model.provider)}`}
                      >
                        {getProviderDisplayName(model.provider)}
                      </span>
                      {getCapabilityBadges(model.capabilities)}
                    </div>

                    {/* Description - more lines */}
                    {model.description && (
                      <p className="mt-1.5 text-xs text-neutral-400 line-clamp-3">
                        {model.description}
                      </p>
                    )}
                  </div>

                  {/* Hover indicator */}
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 self-center">
                    <svg
                      className="w-5 h-5 text-neutral-400"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                  </div>
                </button>
              ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer with model count */}
        {!isLoading && !error && models.length > 0 && (
          <div className="px-6 py-3 border-t border-neutral-700 text-xs text-neutral-400">
            {models.length} model{models.length !== 1 ? "s" : ""} found
          </div>
        )}
      </div>
    </div>
  );

  // Use portal to render outside React Flow stacking context
  return createPortal(dialogContent, document.body);
}
