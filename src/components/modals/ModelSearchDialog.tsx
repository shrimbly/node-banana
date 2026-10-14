"use client";

import { ArrowUpRight, CircleAlert, Image, RefreshCw, Search, X } from "lucide-react";
import {
  Dialog,
  DialogButton,
  DialogChip,
  DialogEyebrow,
  DialogFilterGroup,
  DialogFilterItem,
  DialogPage,
  DialogPageBody,
  DialogPageHead,
  DialogPane,
  DialogPaneRule,
  DialogPaneTitle,
  DialogRowTitle,
  DialogSearchField,
  DialogSearchGlyph,
  DialogSpinner,
  DialogStatus,
  DialogTextButton,
  dialogCardClass,
  filterPaneClass,
  splitPanelClass,
} from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useWorkflowStore, useProviderApiKeys } from "@/store/workflowStore";
import { deduplicatedFetch, clearFetchCache } from "@/utils/deduplicatedFetch";
import { useReactFlow } from "@xyflow/react";
import { ProviderType, RecentModel } from "@/types";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import type { ProviderListResult } from "@/lib/providers/registry";
import { ComfyMark } from "@/components/icons/ComfyMark";
import { getPaneCenter } from "@/utils/canvasPaneCenter";

// localStorage cache: the whole list, one entry per set of configured
// providers, so the dialog opens on it while the server answers. Filters and
// search are applied locally, so there is nothing else to key on.
const MODELS_CACHE_KEY = "node-banana-models-cache";
// Bump when the built-in OpenAI catalogue changes so existing users see new models.
const OPENAI_CATALOGUE_VERSION = 1;
const GEMINI_CATALOGUE_VERSION = 1;
const MODELS_CACHE_TTL = 48 * 60 * 60 * 1000; // 48 hours
// A few provider sets at most; the lists are big.
const MODELS_CACHE_MAX_ENTRIES = 3;
/** Provider notices the user closed, by provider: the error text they closed. A different error shows again. */
const NOTICES_DISMISSED_KEY = "node-banana-models-notices-dismissed";

function readDismissedNotices(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTICES_DISMISSED_KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function writeDismissedNotices(value: Record<string, string>) {
  try {
    if (Object.keys(value).length === 0) localStorage.removeItem(NOTICES_DISMISSED_KEY);
    else localStorage.setItem(NOTICES_DISMISSED_KEY, JSON.stringify(value));
  } catch {
    // Ignore storage errors
  }
}

/** While a provider refreshes behind the server's answer, ask again this often. */
const REFRESH_POLL_MS = 3000;
const REFRESH_POLL_LIMIT = 12;

interface ModelsCacheEntry {
  geminiCatalogueVersion?: number;
  openaiCatalogueVersion?: number;
  models: ProviderModel[];
  availableProviders?: string[];
  providers?: Record<string, ProviderListResult>;
  timestamp: number;
}

function getCachedModels(cacheKey: string): ModelsCacheEntry | null {
  try {
    const cache = JSON.parse(localStorage.getItem(MODELS_CACHE_KEY) || "{}");
    const entry = cache[cacheKey];
    const provider = "all";
    const includesOpenAI = provider === "all" || provider === "openai";
    if (includesOpenAI && entry?.openaiCatalogueVersion !== OPENAI_CATALOGUE_VERSION) return null;
    // Gemini models are included in the combined catalogue and the Gemini filter.
    if ((provider === "all" || provider === "gemini") && entry?.geminiCatalogueVersion !== GEMINI_CATALOGUE_VERSION) return null;
    if (entry && Date.now() - entry.timestamp < MODELS_CACHE_TTL) {
      return entry;
    }
  } catch {
    // Ignore cache errors
  }
  return null;
}

function setCachedModels(cacheKey: string, models: ProviderModel[], availableProviders?: string[], providers?: Record<string, ProviderListResult>) {
  try {
    const cache: Record<string, ModelsCacheEntry> = JSON.parse(
      localStorage.getItem(MODELS_CACHE_KEY) || "{}"
    );
    const now = Date.now();

    // Prune expired entries so the cache doesn't accumulate stale data forever.
    for (const key of Object.keys(cache)) {
      const entry = cache[key];
      if (!entry || now - entry.timestamp >= MODELS_CACHE_TTL) {
        delete cache[key];
      }
    }

    cache[cacheKey] = { models, availableProviders, providers, timestamp: now, openaiCatalogueVersion: OPENAI_CATALOGUE_VERSION, geminiCatalogueVersion: GEMINI_CATALOGUE_VERSION };

    // Cap total entries (LRU): drop oldest by timestamp until under the limit.
    const keys = Object.keys(cache);
    if (keys.length > MODELS_CACHE_MAX_ENTRIES) {
      keys
        .sort((a, b) => cache[a].timestamp - cache[b].timestamp)
        .slice(0, keys.length - MODELS_CACHE_MAX_ENTRIES)
        .forEach((key) => delete cache[key]);
    }

    localStorage.setItem(MODELS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore cache errors
  }
}

// Build a short, stable hash of the configured providers so the cache key
// changes when API keys are added/removed (otherwise the "all" view keeps
// serving a stale list that omits a newly-configured provider).
function getProvidersHash(providers: {
  replicate: boolean;
  fal: boolean;
  kie: boolean;
  wavespeed: boolean;
  openai: boolean;
  comfy: boolean;
}): string {
  // Fixed order keeps the hash deterministic across renders.
  return [
    providers.replicate ? "r" : "",
    providers.fal ? "f" : "",
    providers.kie ? "k" : "",
    providers.wavespeed ? "w" : "",
    providers.openai ? "o" : "",
    providers.comfy ? "c" : "",
  ].join("");
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

const OpenAIIcon = () => (
  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
    <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.896zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
  </svg>
);

const ComfyIcon = () => <ComfyMark className="w-3.5 h-3.5" />;

/** Provider rail order, names and marks. Monochrome: the chrome keeps colour for status. */
const PROVIDER_OPTIONS: { id: ProviderType; label: string; Icon: () => React.ReactElement }[] = [
  { id: "gemini", label: "Gemini", Icon: GeminiIcon },
  { id: "replicate", label: "Replicate", Icon: ReplicateIcon },
  { id: "fal", label: "fal.ai", Icon: FalIcon },
  { id: "kie", label: "Kie.ai", Icon: KieIcon },
  { id: "wavespeed", label: "WaveSpeed", Icon: WaveSpeedIcon },
  { id: "openai", label: "OpenAI", Icon: OpenAIIcon },
  { id: "comfy", label: "ComfyUI", Icon: ComfyIcon },
];


// Capability filter options
type CapabilityFilter = "all" | "image" | "video" | "3d" | "audio";

const CAPABILITY_OPTIONS: { id: CapabilityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "image", label: "Image" },
  { id: "video", label: "Video" },
  { id: "3d", label: "3D" },
  { id: "audio", label: "Audio" },
];

/** Short input→output chip per capability, so similar models can be told apart. */
const CAPABILITY_LABELS: Partial<Record<ModelCapability, string>> = {
  "text-to-image": "txt\u2192img",
  "image-to-image": "img\u2192img",
  "text-to-video": "txt\u2192vid",
  "image-to-video": "img\u2192vid",
  "audio-to-video": "audio\u2192vid",
  "video-to-video": "vid\u2192vid",
  "text-to-3d": "txt\u21923d",
  "image-to-3d": "img\u21923d",
  "text-to-audio": "txt\u2192audio",
};

// API response type
interface ModelsResponse {
  success: boolean;
  models?: ProviderModel[];
  /** Providers with API keys configured (env or client header) */
  availableProviders?: string[];
  /** Per provider: count, when it was fetched, stale, refreshing, error */
  providers?: Record<string, ProviderListResult>;
  error?: string;
}

/** The capabilities behind each Type filter. */
const CAPABILITY_FILTER_SETS: Record<Exclude<CapabilityFilter, "all">, ModelCapability[]> = {
  image: ["text-to-image", "image-to-image"],
  video: ["text-to-video", "image-to-video", "audio-to-video", "video-to-video"],
  "3d": ["text-to-3d", "image-to-3d"],
  audio: ["text-to-audio"],
};

function matchesCapabilityFilter(model: ProviderModel, filter: CapabilityFilter): boolean {
  if (filter === "all") return true;
  const wanted = CAPABILITY_FILTER_SETS[filter];
  return model.capabilities.some((cap) => wanted.includes(cap));
}

function matchesSearch(model: ProviderModel, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q) || (model.description?.toLowerCase().includes(q) ?? false);
}

/** "2h ago" for a provider's fetched-at time. */
function formatAge(fetchedAt: number): string {
  const minutes = Math.round((Date.now() - fetchedAt) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** What to do about a provider's error, in a few words. */
function providerErrorHint(error: string): string {
  if (/\b40[13]\b/.test(error)) return "The key was rejected. Check it in Settings.";
  if (/timed out/i.test(error)) return "It did not answer in time.";
  if (/\b429\b/.test(error)) return "It is rate limiting requests.";
  return "";
}

interface ModelSearchDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialProvider?: ProviderType | null;
  /** When provided, calls this callback instead of creating a new node */
  onModelSelected?: (model: ProviderModel) => void;
  /** Initial capability filter - 'image' for image nodes, 'video' for video nodes */
  initialCapabilityFilter?: CapabilityFilter;
  /** Show a "Remove fallback" row above the results list (fallback-selection mode) */
  showClearOption?: boolean;
  /** Callback when the "Remove fallback" row is clicked */
  onClearSelection?: () => void;
  /** Custom dialog title (defaults to "Browse models") */
  title?: string;
}

export function ModelSearchDialog({
  isOpen,
  onClose,
  initialProvider,
  onModelSelected,
  initialCapabilityFilter,
  showClearOption,
  onClearSelection,
  title = "Browse models",
}: ModelSearchDialogProps) {
  const {
    addNode,
    recentModels,
    trackModelUsage,
  } = useWorkflowStore();
  // Use stable selector for API keys to prevent unnecessary re-fetches
  const { replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey, openaiApiKey, comfyApiKey, comfyEnabled } = useProviderApiKeys();
  const { screenToFlowPosition } = useReactFlow();

  // State
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderType | "all">(
    initialProvider || "all"
  );
  const [capabilityFilter, setCapabilityFilter] =
    useState<CapabilityFilter>(initialCapabilityFilter || "all");
  /** Every model the server lists; the filters and the search narrow it here. */
  const [catalog, setCatalog] = useState<ProviderModel[]>([]);
  const [providerStatus, setProviderStatus] = useState<Record<string, ProviderListResult>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverAvailableProviders, setServerAvailableProviders] = useState<string[]>([]);
  /** The providers' own search, run on request for one query. */
  const [deep, setDeep] = useState<{ query: string; models: ProviderModel[]; state: "searching" | "done" | "failed" } | null>(null);
  const [dismissedNotices, setDismissedNotices] = useState<Record<string, string>>(readDismissedNotices);

  // Refs
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Track request version to ignore stale responses
  const requestVersionRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The search is local, so the debounce only smooths typing
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 120);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Update provider filter when initialProvider changes
  useEffect(() => {
    if (initialProvider) {
      setProviderFilter(initialProvider);
    }
  }, [initialProvider]);

  // Headers with the client-side keys; the server falls back to its env
  const buildHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (replicateApiKey) headers["X-Replicate-Key"] = replicateApiKey;
    if (falApiKey) headers["X-Fal-Key"] = falApiKey;
    if (kieApiKey) headers["X-Kie-Key"] = kieApiKey;
    if (wavespeedApiKey) headers["X-WaveSpeed-Key"] = wavespeedApiKey;
    if (openaiApiKey) headers["X-OpenAI-API-Key"] = openaiApiKey;
    if (comfyApiKey) headers["X-Comfy-Router-Key"] = comfyApiKey;
    return headers;
  }, [replicateApiKey, falApiKey, kieApiKey, wavespeedApiKey, openaiApiKey, comfyApiKey]);

  const providersHash = getProvidersHash({
    replicate: !!replicateApiKey,
    fal: !!falApiKey,
    kie: !!kieApiKey,
    wavespeed: !!wavespeedApiKey,
    openai: !!openaiApiKey,
    comfy: !!comfyApiKey,
  });

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  /**
   * The whole list, once. `mode`:
   * - "open": the cached list first, then the server's;
   * - "refresh": wait for every provider to be fetched anew;
   * - "poll": ask again while a provider refreshes behind the last answer.
   */
  const fetchModels = useCallback(async (mode: "open" | "refresh" | "poll" = "open", polls = 0) => {
    const thisVersion = ++requestVersionRef.current;
    stopPolling();

    if (mode === "open") {
      const cached = getCachedModels(providersHash);
      if (cached) {
        setCatalog(cached.models);
        if (cached.availableProviders) setServerAvailableProviders(cached.availableProviders);
        if (cached.providers) setProviderStatus(cached.providers);
      } else {
        setIsLoading(true);
      }
      setError(null);
    } else if (mode === "refresh") {
      setIsLoading(catalog.length === 0);
      setError(null);
    }

    try {
      const params = new URLSearchParams();
      if (mode === "refresh") params.set("refresh", "true");
      const query = params.toString();
      const response = await deduplicatedFetch(`/api/models${query ? `?${query}` : ""}`, { headers: buildHeaders() });
      if (thisVersion !== requestVersionRef.current) return;
      const data: ModelsResponse = await response.json();
      if (thisVersion !== requestVersionRef.current) return;

      if (data.success && data.models) {
        setCatalog(data.models);
        setProviderStatus(data.providers ?? {});
        if (data.availableProviders) setServerAvailableProviders(data.availableProviders);
        setCachedModels(providersHash, data.models, data.availableProviders, data.providers);
        // A provider still refreshing behind this answer: ask again shortly
        const refreshing = Object.values(data.providers ?? {}).some((p) => p.refreshing);
        if (refreshing && polls < REFRESH_POLL_LIMIT) {
          pollTimerRef.current = setTimeout(() => {
            pollTimerRef.current = null;
            void fetchModels("poll", polls + 1);
          }, REFRESH_POLL_MS);
        }
      } else {
        setError(data.error || "Failed to fetch models");
        if (mode !== "poll") setCatalog([]);
      }
    } catch (err) {
      if (thisVersion !== requestVersionRef.current) return;
      if (mode !== "poll") {
        setError(err instanceof Error ? err.message : "Failed to fetch models");
        setCatalog([]);
      }
    } finally {
      if (thisVersion === requestVersionRef.current) setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providersHash, buildHeaders, stopPolling]);

  // Load on open; stop asking again on close
  useEffect(() => {
    if (isOpen) {
      void fetchModels("open");
    }
    return stopPolling;
  }, [isOpen, fetchModels, stopPolling]);

  // The list a new query is typed into is not the one a past deep search found
  useEffect(() => {
    setDeep((current) => (current && current.query !== debouncedSearch ? null : current));
  }, [debouncedSearch]);

  // Clear all caches and re-fetch models from scratch
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      // Clear localStorage model cache
      localStorage.removeItem(MODELS_CACHE_KEY);
      // Clear localStorage schema cache (keep in sync with ModelParameters.tsx)
      localStorage.removeItem("node-banana-schema-cache");
      // Clear in-memory deduplicatedFetch cache
      clearFetchCache();
      setDeep(null);
      // Asking again is asking to see how it went
      setDismissedNotices({});
      writeDismissedNotices({});
      await fetchModels("refresh");
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchModels]);

  /** Ask Replicate's and fal.ai's own search for models the stored lists lack. */
  const handleDeepSearch = useCallback(async () => {
    const query = debouncedSearch;
    if (!query) return;
    setDeep({ query, models: [], state: "searching" });
    try {
      const params = new URLSearchParams({ search: query, deep: "true" });
      const response = await deduplicatedFetch(`/api/models?${params.toString()}`, { headers: buildHeaders() });
      const data: ModelsResponse = await response.json();
      setDeep((current) => (current?.query === query ? { query, models: data.success && data.models ? data.models : [], state: data.success ? "done" : "failed" } : current));
    } catch {
      setDeep((current) => (current?.query === query ? { query, models: [], state: "failed" } : current));
    }
  }, [debouncedSearch, buildHeaders]);

  // Everything the filters and the search apply to: the catalog plus what a deep search found
  const models = useMemo(() => {
    const seen = new Set(catalog.map((m) => `${m.provider}:${m.id}`));
    const extra = deep && deep.query === debouncedSearch ? deep.models.filter((m) => !seen.has(`${m.provider}:${m.id}`)) : [];
    return [...catalog, ...extra].filter(
      (model) =>
        (providerFilter === "all" || model.provider === providerFilter) &&
        matchesCapabilityFilter(model, capabilityFilter) &&
        matchesSearch(model, debouncedSearch),
    );
  }, [catalog, deep, providerFilter, capabilityFilter, debouncedSearch]);

  // Providers that failed outright, or whose last refresh failed; shown above the list until closed
  const providerNotices = useMemo(
    () =>
      Object.entries(providerStatus)
        .filter(([provider, status]) => status.error && dismissedNotices[provider] !== status.error && (providerFilter === "all" || providerFilter === provider))
        .map(([provider, status]) => ({ provider: provider as ProviderType, status })),
    [providerStatus, providerFilter, dismissedNotices],
  );
  const dismissNotice = useCallback((provider: ProviderType, error: string) => {
    setDismissedNotices((current) => {
      const next = { ...current, [provider]: error };
      writeDismissedNotices(next);
      return next;
    });
  }, []);
  const refreshingProviders = useMemo(
    () => Object.entries(providerStatus).filter(([, status]) => status.refreshing).map(([provider]) => getProviderDisplayName(provider as ProviderType)),
    [providerStatus],
  );

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
        (cap) => cap === "text-to-video" || cap === "image-to-video" || cap === "audio-to-video" || cap === "video-to-video"
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
        },
      });

      onClose();
    },
    [screenToFlowPosition, addNode, onClose, onModelSelected, trackModelUsage]
  );

  // Compute which providers are available based on client API keys + server env vars
  const availableProviders = useMemo(() => {
    const providers = new Set<ProviderType>(["gemini", "fal"]); // Always available
    // Client-side keys (from localStorage/provider settings)
    if (replicateApiKey) providers.add("replicate");
    if (kieApiKey) providers.add("kie");
    if (wavespeedApiKey) providers.add("wavespeed");
    if (openaiApiKey) providers.add("openai");
    if (comfyEnabled && comfyApiKey) providers.add("comfy");
    // Server-side keys (from env vars, reported by /api/models)
    for (const p of serverAvailableProviders) {
      providers.add(p as ProviderType);
    }
    return providers;
  }, [replicateApiKey, kieApiKey, wavespeedApiKey, openaiApiKey, comfyApiKey, comfyEnabled, serverAvailableProviders]);

  // Reset provider filter if current selection becomes unavailable
  useEffect(() => {
    if (providerFilter !== "all" && !availableProviders.has(providerFilter as ProviderType)) {
      setProviderFilter("all");
    }
  }, [providerFilter, availableProviders]);

  // Recent models, kept to the Type filter (and the provider tab) by what the catalog says of them
  const filteredRecentModels = useMemo(() => {
    return recentModels
      .filter((recent) => {
        if (providerFilter !== "all" && recent.provider !== providerFilter) return false;
        if (capabilityFilter === "all") return true;
        const matchingModel = catalog.find((m) => m.id === recent.modelId);
        // Not in the catalog: nothing to check it against, so it is left out of a narrowed view
        return matchingModel ? matchesCapabilityFilter(matchingModel, capabilityFilter) : false;
      })
      .slice(0, 4); // Show max 4
  }, [recentModels, catalog, capabilityFilter, providerFilter]);

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
      case "comfy":
        return "https://docs.comfy.org/development/comfy-router/models";
      default:
        return null;
    }
  };

  const hasActiveFilters = searchQuery !== "" || providerFilter !== "all" || capabilityFilter !== "all";

  const clearFilters = () => {
    setSearchQuery("");
    setProviderFilter("all");
    setCapabilityFilter("all");
    searchInputRef.current?.focus();
  };

  // Enter in the search box takes the top result, once the list matches what was typed.
  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || isLoading) return;
    const first = models[0];
    if (!first) return;
    event.preventDefault();
    handleSelectModel(first);
  };

  const countLabel = isLoading
    ? "Loading"
    : error
      ? "Unavailable"
      : `${models.length} model${models.length !== 1 ? "s" : ""}${refreshingProviders.length > 0 ? ` · updating ${refreshingProviders.join(", ")}…` : ""}`;

  // The providers' own search is worth offering once there is a real query and a provider that has one
  const canDeepSearch =
    debouncedSearch.trim().length >= 2 &&
    (availableProviders.has("replicate") || availableProviders.has("fal")) &&
    (providerFilter === "all" || providerFilter === "replicate" || providerFilter === "fal");
  const deepSearchTargets = [providerFilter !== "fal" && availableProviders.has("replicate") ? "Replicate" : null, providerFilter !== "replicate" && availableProviders.has("fal") ? "fal.ai" : null]
    .filter(Boolean)
    .join(" and ");
  const deepSearchRow =
    canDeepSearch && (
      <div className="flex items-center justify-between gap-3 rounded-[10px] border border-card-border px-3.5 py-2.5" data-testid="deep-search">
        <span className="text-xs text-ink-3">
          {deep?.state === "searching"
            ? `Searching ${deepSearchTargets}…`
            : deep?.state === "done"
              ? `${deepSearchTargets} found nothing more for “${deep.query}”`
              : deep?.state === "failed"
                ? `${deepSearchTargets} could not be searched`
                : `Not here? ${deepSearchTargets} may have more.`}
        </span>
        {deep?.state !== "searching" && deep?.state !== "done" && (
          <DialogTextButton onClick={handleDeepSearch} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Search size={13} strokeWidth={1.75} />
            Search {deepSearchTargets}
          </DialogTextButton>
        )}
      </div>
    );

  const providerNoticeRows = providerNotices.length > 0 && (
    <div className="flex flex-col gap-2" data-testid="provider-notices">
      {providerNotices.map(({ provider, status }) => (
        <div key={provider} role="status" className="flex items-center gap-3 rounded-[10px] border border-error/30 bg-error/5 px-3.5 py-2.5 text-xs">
          <CircleAlert size={15} strokeWidth={1.75} className="shrink-0 text-error" />
          <span className="min-w-0 flex-1 text-neutral-300">
            <span className="font-medium text-neutral-100">{getProviderDisplayName(provider)}</span>
            {status.success ? " could not be refreshed" : " is unavailable"}: {status.error}
            {providerErrorHint(status.error ?? "") && <span className="text-ink-3"> {providerErrorHint(status.error ?? "")}</span>}
            {status.success && status.fetchedAt && <span className="text-ink-3"> Showing the list from {formatAge(status.fetchedAt)}.</span>}
          </span>
          <DialogTextButton onClick={handleRefresh} disabled={isRefreshing} className="whitespace-nowrap">
            Retry
          </DialogTextButton>
          <button
            type="button"
            onClick={() => dismissNotice(provider, status.error ?? "")}
            aria-label={`Dismiss ${getProviderDisplayName(provider)} notice`}
            title="Dismiss"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-white/[0.06] hover:text-neutral-100"
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </div>
      ))}
    </div>
  );

  if (!isOpen) return null;

  const clearSelectionRow = showClearOption && onClearSelection && (
    <button
      type="button"
      onClick={() => onClearSelection()}
      className={cn(
        "group w-full flex items-center justify-between gap-3 h-11 px-3.5 rounded-[10px] border border-card-border text-left transition-colors hover:border-error/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-bg"
      )}
    >
      <span className="flex items-center gap-2.5">
        <X size={16} strokeWidth={1.75} className="text-neutral-500 group-hover:text-error transition-colors" />
        <DialogRowTitle>Remove fallback</DialogRowTitle>
      </span>
      <span className="text-xs text-ink-3">Clear current selection</span>
    </button>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      portal
      initialFocusRef={searchInputRef}
      className={cn(splitPanelClass, "w-[1200px] h-[720px] max-w-[92vw] max-h-[85vh]")}
    >
      <DialogPane width={232} className={filterPaneClass}>
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col">
          <DialogPaneTitle>{title}</DialogPaneTitle>

          <DialogSearchField
            ref={searchInputRef}
            aria-label="Search models"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search models..."
            className="mt-3"
          />

          <div className="mt-[18px] flex flex-col gap-3.5">
            <DialogFilterGroup label="Type">
              {CAPABILITY_OPTIONS.map((option) => (
                <DialogFilterItem
                  key={option.id}
                  active={capabilityFilter === option.id}
                  onClick={() => setCapabilityFilter(option.id)}
                >
                  {option.label}
                </DialogFilterItem>
              ))}
            </DialogFilterGroup>

            <DialogPaneRule />

            <DialogFilterGroup label="Provider">
              <DialogFilterItem active={providerFilter === "all"} title="All Providers" onClick={() => setProviderFilter("all")}>
                All providers
              </DialogFilterItem>
              {PROVIDER_OPTIONS.filter((option) => availableProviders.has(option.id)).map(({ id, label, Icon }) => (
                <DialogFilterItem
                  key={id}
                  active={providerFilter === id}
                  title={label}
                  onClick={() => setProviderFilter(id)}
                  icon={<Icon />}
                >
                  {label}
                </DialogFilterItem>
              ))}
            </DialogFilterGroup>
          </div>
        </div>

        <div className="flex items-center pt-2 border-t border-white/[0.06]">
          <DialogTextButton
            onClick={handleRefresh}
            disabled={isRefreshing || isLoading}
            title="Refresh models & schemas"
            className="inline-flex items-center gap-[7px] px-[11px] text-xs whitespace-nowrap"
          >
            <RefreshCw size={14} strokeWidth={1.75} className={cn(isRefreshing && "animate-spin")} />
            Refresh catalog
          </DialogTextButton>
        </div>
      </DialogPane>

      <DialogPage>
        <DialogPageHead
          eyebrow={<span aria-live="polite">{countLabel}</span>}
          actions={hasActiveFilters && <DialogTextButton onClick={clearFilters}>Clear filters</DialogTextButton>}
        />

        <DialogPageBody className="overscroll-contain pt-3 pb-6 flex flex-col gap-5">
          {/* The spinner is for a first load only; a new search keeps the old results, dimmed. */}
          {isLoading && models.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <DialogSpinner />
              <span className="text-xs text-ink-3">Loading models...</span>
            </div>
          ) : error ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
              <DialogStatus tone="error" className="normal-case tracking-normal text-neutral-300 max-w-sm">
                {error}
              </DialogStatus>
              <DialogButton variant="outline" onClick={handleRefresh}>
                Try again
              </DialogButton>
            </div>
          ) : models.length === 0 && !isLoading ? (
            <>
              {clearSelectionRow}
              {providerNoticeRows}
              {deepSearchRow}
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <DialogSearchGlyph className="w-10 h-10 text-neutral-600 mb-4" strokeWidth={1.25} />
                <h3 className="font-display text-sm leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100">
                  No models found
                </h3>
                <p className="mt-1 text-xs leading-4 text-ink-3">Try adjusting your search or filters</p>
                {hasActiveFilters && (
                  <DialogTextButton onClick={clearFilters} className="mt-3">
                    Clear all filters
                  </DialogTextButton>
                )}
              </div>
            </>
          ) : (
            <div className={cn("flex flex-col gap-5 transition-opacity", isLoading && "opacity-50 pointer-events-none")} aria-busy={isLoading || undefined}>
              {clearSelectionRow}
              {providerNoticeRows}

              {filteredRecentModels.length > 0 && !searchQuery && (
                <section className="flex flex-col gap-2.5">
                  <DialogEyebrow>Recently used</DialogEyebrow>
                  <div className="grid grid-cols-2 gap-2">
                    {filteredRecentModels.map((recent) => {
                      const matchingModel = catalog.find((m) => m.id === recent.modelId);
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
                          type="button"
                          onClick={() => handleSelectModel(model)}
                          className={cn(dialogCardClass, "flex items-center gap-3 p-2")}
                        >
                          <Thumb src={matchingModel?.coverImage} className="w-10 h-10 rounded-md" />
                          <span className="flex-1 min-w-0">
                            <DialogRowTitle className="text-[13px] truncate">{recent.displayName}</DialogRowTitle>
                            <ProviderLabel provider={recent.provider} className="mt-0.5" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}

              <section
                className={cn(
                  "flex flex-col gap-2.5",
                  filteredRecentModels.length > 0 && !searchQuery && "pt-4 border-t border-card"
                )}
              >
                {filteredRecentModels.length > 0 && !searchQuery && <DialogEyebrow>All models</DialogEyebrow>}
                <div className="grid grid-cols-2 gap-3">
                  {models.map((model) => {
                    const url = getModelUrl(model);
                    return (
                      <div key={`${model.provider}-${model.id}`} className="relative group/card">
                        <button
                          type="button"
                          onClick={() => handleSelectModel(model)}
                          className={cn(dialogCardClass, "flex items-stretch w-full h-[124px] overflow-hidden")}
                        >
                          {/* Full-height cover image */}
                          <Thumb src={model.coverImage} alt={model.name} className="w-[122px] self-stretch" large />

                          {/* Fixed height: title, id line, one row of chips and two lines of description. */}
                          <span className="flex-1 min-w-0 px-3.5 py-3 flex flex-col gap-1.5 overflow-hidden">
                            <span className={cn("min-w-0", url && "pr-[26px]")}>
                              <DialogRowTitle className="truncate">{getDisplayName(model)}</DialogRowTitle>
                              <span className="flex items-center gap-1.5 mt-0.5 min-w-0 font-mono text-[11px] leading-4">
                                <span className="flex items-center gap-[5px] shrink-0 text-neutral-400 [&_svg]:w-[11px] [&_svg]:h-[11px]">
                                  <ProviderIcon provider={model.provider} />
                                  {getProviderDisplayName(model.provider)}
                                </span>
                                <span aria-hidden="true" className="shrink-0 text-neutral-600">·</span>
                                <span className="text-ink-3 truncate">{model.id}</span>
                              </span>
                            </span>
                            <span className="flex items-center gap-1 overflow-hidden">
                              {model.capabilities.map((cap) =>
                                CAPABILITY_LABELS[cap] ? <DialogChip key={cap} className="shrink-0">{CAPABILITY_LABELS[cap]}</DialogChip> : null
                              )}
                            </span>
                            <span className="h-8 shrink-0 text-xs leading-4 text-ink-3 line-clamp-2">{model.description}</span>
                          </span>
                        </button>

                        {/* A sibling of the card, not inside it: a link cannot live in a button. */}
                        {url && (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`View on ${getProviderDisplayName(model.provider)}`}
                            aria-label={`View ${model.name} on ${getProviderDisplayName(model.provider)}`}
                            className={cn(
                              "absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-md text-neutral-600 group-hover/card:text-neutral-400 transition-colors",
                              "hover:text-neutral-100 hover:bg-white/[0.06]",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection"
                            )}
                          >
                            <ArrowUpRight size={14} strokeWidth={1.75} />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
                {deepSearchRow}
              </section>
            </div>
          )}
        </DialogPageBody>
      </DialogPage>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ parts */

function getProviderDisplayName(provider: ProviderType): string {
  return PROVIDER_OPTIONS.find((option) => option.id === provider)?.label ?? provider;
}

function ProviderIcon({ provider }: { provider: ProviderType }) {
  const Icon = PROVIDER_OPTIONS.find((option) => option.id === provider)?.Icon;
  return Icon ? <Icon /> : null;
}

/** Provider icon and name as a mono label: the meta line of a recent entry. */
function ProviderLabel({ provider, className }: { provider: ProviderType; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1.5 font-mono text-[10px] leading-4 tracking-eyebrow uppercase text-ink-3 [&_svg]:w-3 [&_svg]:h-3", className)}>
      <ProviderIcon provider={provider} />
      {getProviderDisplayName(provider)}
    </span>
  );
}

/** Cover image, or a quiet placeholder when the model has none or it fails to load. */
function Thumb({ src, alt = "", className, large = false }: { src?: string; alt?: string; className?: string; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn("relative shrink-0 overflow-hidden bg-card flex items-center justify-center", className)}>
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className="absolute inset-0 w-full h-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <Image size={large ? 28 : 16} strokeWidth={1.25} className="text-neutral-600" />
      )}
    </span>
  );
}
