"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { WorkflowFile } from "@/store/workflowStore";
import { getAllPresets, PRESET_TEMPLATES } from "@/lib/quickstart/templates";
import { QuickstartBackButton } from "./QuickstartBackButton";
import { TemplateCard } from "./TemplateCard";
import { CommunityWorkflowMeta, TemplateCategory, TemplateMetadata } from "@/types/quickstart";

interface TemplateExplorerViewProps {
  onBack: () => void;
  onWorkflowSelected: (workflow: WorkflowFile) => void;
}

type CategoryFilter = "all" | TemplateCategory;

const CATEGORY_OPTIONS: { id: CategoryFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "simple", label: "Simple" },
  { id: "advanced", label: "Advanced" },
  { id: "community", label: "Community" },
];

export function TemplateExplorerView({
  onBack,
  onWorkflowSelected,
}: TemplateExplorerViewProps) {
  const [communityWorkflows, setCommunityWorkflows] = useState<CommunityWorkflowMeta[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [loadingWorkflowId, setLoadingWorkflowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const presets = getAllPresets();

  // Debounce search query
  useEffect(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 200);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery]);

  // Calculate node counts for each preset
  const presetMetadata = useMemo(() => {
    const metadata: Record<string, TemplateMetadata> = {};
    PRESET_TEMPLATES.forEach((template) => {
      metadata[template.id] = {
        nodeCount: template.workflow.nodes.length,
        category: template.category,
        tags: template.tags,
      };
    });
    return metadata;
  }, []);

  // Primary thumbnails (resized content images - 288px for 2x retina)
  const primaryThumbnails: Record<string, string> = {
    "product-shot": "/template-thumbnails/primary/product-shot.jpg",
    "model-product": "/template-thumbnails/primary/model-product.jpg",
    "color-variations": "/template-thumbnails/primary/color-variations.jpg",
    "background-swap": "/template-thumbnails/primary/background-swap.jpg",
    "style-transfer": "/template-thumbnails/primary/style-transfer.jpg",
    "scene-composite": "/template-thumbnails/primary/scene-composite.jpg",
  };

  // Hover thumbnails (workflow screenshots - 288px)
  const hoverThumbnails: Record<string, string> = {
    "product-shot": "/template-thumbnails/product-shot.png",
    "model-product": "/template-thumbnails/model-product.png",
    "color-variations": "/template-thumbnails/color-variations.png",
    "background-swap": "/template-thumbnails/background-swap.png",
    "style-transfer": "/template-thumbnails/style-transfer.png",
    "scene-composite": "/template-thumbnails/scene-composite.png",
  };

  // Filter presets based on search, category, and tags
  const filteredPresets = useMemo(() => {
    return presets.filter((preset) => {
      // Search filter: match name or description
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        const matchesSearch =
          preset.name.toLowerCase().includes(searchLower) ||
          preset.description.toLowerCase().includes(searchLower);
        if (!matchesSearch) return false;
      }

      // Category filter
      if (categoryFilter !== "all" && categoryFilter !== "community") {
        if (preset.category !== categoryFilter) return false;
      }

      // If "community" is selected, hide preset templates (they're not community)
      if (categoryFilter === "community") {
        return false;
      }

      // Tags filter (OR logic - match ANY selected tag)
      if (selectedTags.size > 0) {
        const hasMatchingTag = preset.tags.some((tag) => selectedTags.has(tag));
        if (!hasMatchingTag) return false;
      }

      return true;
    });
  }, [presets, debouncedSearch, categoryFilter, selectedTags]);

  // Filter community workflows
  const filteredCommunity = useMemo(() => {
    // Only show community workflows if "all" or "community" category selected
    if (categoryFilter !== "all" && categoryFilter !== "community") {
      return [];
    }

    return communityWorkflows.filter((workflow) => {
      // Search filter
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        const matchesSearch =
          workflow.name.toLowerCase().includes(searchLower) ||
          workflow.author.toLowerCase().includes(searchLower);
        if (!matchesSearch) return false;
      }

      return true;
    });
  }, [communityWorkflows, debouncedSearch, categoryFilter]);

  // Collect all unique tags from presets
  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    presets.forEach((preset) => {
      preset.tags.forEach((tag) => tags.add(tag));
    });
    return Array.from(tags).sort();
  }, [presets]);

  // Toggle tag selection
  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  }, []);

  // Clear all filters
  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setDebouncedSearch("");
    setCategoryFilter("all");
    setSelectedTags(new Set());
  }, []);

  // Check if any filters are active
  const hasActiveFilters = searchQuery || categoryFilter !== "all" || selectedTags.size > 0;

  // Check if results are empty
  const hasNoResults =
    filteredPresets.length === 0 &&
    (categoryFilter === "community" ? filteredCommunity.length === 0 : true) &&
    !isLoadingList;

  // Fetch community workflows on mount
  useEffect(() => {
    async function fetchCommunityWorkflows() {
      try {
        const response = await fetch("/api/community-workflows");
        const result = await response.json();

        if (result.success) {
          setCommunityWorkflows(result.workflows);
        } else {
          console.error("Failed to fetch community workflows:", result.error);
        }
      } catch (err) {
        console.error("Error fetching community workflows:", err);
      } finally {
        setIsLoadingList(false);
      }
    }

    fetchCommunityWorkflows();
  }, []);

  const handlePresetSelect = useCallback(
    async (templateId: string) => {
      setLoadingWorkflowId(templateId);
      setError(null);

      try {
        const response = await fetch("/api/quickstart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateId,
            contentLevel: "full",
          }),
        });

        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Failed to load template");
        }

        if (result.workflow) {
          onWorkflowSelected(result.workflow);
        }
      } catch (err) {
        console.error("Error loading preset:", err);
        setError(err instanceof Error ? err.message : "Failed to load template");
      } finally {
        setLoadingWorkflowId(null);
      }
    },
    [onWorkflowSelected]
  );

  const handleCommunitySelect = useCallback(
    async (workflowId: string) => {
      setLoadingWorkflowId(workflowId);
      setError(null);

      try {
        const response = await fetch(`/api/community-workflows/${workflowId}`);
        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Failed to load workflow");
        }

        if (result.workflow) {
          onWorkflowSelected(result.workflow);
        }
      } catch (err) {
        console.error("Error loading community workflow:", err);
        setError(err instanceof Error ? err.message : "Failed to load workflow");
      } finally {
        setLoadingWorkflowId(null);
      }
    },
    [onWorkflowSelected]
  );

  const isLoading = loadingWorkflowId !== null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-neutral-700 flex items-center gap-4">
        <QuickstartBackButton onClick={onBack} disabled={isLoading} />
        <h2 className="text-lg font-semibold text-neutral-100">
          Template Explorer
        </h2>
      </div>

      {/* Content - Sidebar + Main Grid */}
      <div className="flex-1 flex min-h-0 overflow-clip">
        {/* Sidebar */}
        <div className="w-48 flex-shrink-0 bg-neutral-900/80 border-r border-neutral-700 p-4 space-y-5 overflow-y-auto">
          {/* Search Input */}
          <div className="relative">
            <svg
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
              />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search templates..."
              className="w-full pl-8 pr-3 py-2 text-sm bg-neutral-700/50 border border-neutral-600 rounded-lg text-neutral-200 placeholder-neutral-500 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Category Filters */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Category
            </h3>
            <div className="flex flex-col gap-1">
              {CATEGORY_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => setCategoryFilter(option.id)}
                  className={`
                    px-3 py-1.5 text-xs font-medium rounded-md text-left transition-colors
                    ${
                      categoryFilter === option.id
                        ? "bg-blue-500/20 border border-blue-500/50 text-blue-300"
                        : "bg-neutral-700/30 border border-transparent text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-300"
                    }
                  `}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Provider Tags */}
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
              Provider
            </h3>
            <div className="flex flex-col gap-1">
              {availableTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`
                    px-3 py-1.5 text-xs font-medium rounded-md text-left transition-colors
                    ${
                      selectedTags.has(tag)
                        ? "bg-blue-500/20 border border-blue-500/50 text-blue-300"
                        : "bg-neutral-700/30 border border-transparent text-neutral-400 hover:bg-neutral-700/50 hover:text-neutral-300"
                    }
                  `}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {/* Clear Filters */}
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="w-full px-3 py-1.5 text-xs font-medium text-neutral-400 hover:text-neutral-300 bg-neutral-700/30 hover:bg-neutral-700/50 rounded-md transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* Main Content Area */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-6 space-y-6">
          {/* Empty State */}
          {hasNoResults && hasActiveFilters && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <svg
                className="w-12 h-12 text-neutral-600 mb-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              <h3 className="text-sm font-medium text-neutral-300 mb-1">
                No templates match your filters
              </h3>
              <p className="text-xs text-neutral-500 mb-4">
                Try adjusting your search or filters
              </p>
              <button
                onClick={clearFilters}
                className="px-4 py-2 text-sm font-medium text-blue-400 hover:text-blue-300 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg transition-colors"
              >
                Clear all filters
              </button>
            </div>
          )}

          {/* Quick Start Templates */}
          {filteredPresets.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Quick Start
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {filteredPresets.map((preset) => (
                  <TemplateCard
                    key={preset.id}
                    template={preset}
                    nodeCount={presetMetadata[preset.id]?.nodeCount ?? 0}
                    previewImage={primaryThumbnails[preset.id]}
                    hoverImage={hoverThumbnails[preset.id]}
                    isLoading={loadingWorkflowId === preset.id}
                    onUseWorkflow={() => handlePresetSelect(preset.id)}
                    disabled={isLoading && loadingWorkflowId !== preset.id}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Divider */}
          {filteredPresets.length > 0 && (filteredCommunity.length > 0 || (isLoadingList && categoryFilter !== "community")) && (
            <div className="border-t border-neutral-700" />
          )}

          {/* Community Workflows */}
          {(filteredCommunity.length > 0 || (isLoadingList && (categoryFilter === "all" || categoryFilter === "community"))) && (
            <div className="space-y-3">
              <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Community Workflows
              </h3>

              {isLoadingList ? (
                <div className="flex items-center justify-center py-8">
                  <svg
                    className="w-5 h-5 text-neutral-500 animate-spin"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-4">
                  {filteredCommunity.map((workflow) => (
                    <button
                      key={workflow.id}
                      onClick={() => handleCommunitySelect(workflow.id)}
                      disabled={isLoading}
                      className={`
                        group w-full text-left rounded-lg border p-4 transition-all
                        ${
                          loadingWorkflowId === workflow.id
                            ? "bg-purple-600/20 border-purple-500/50"
                            : "bg-neutral-900/50 border-neutral-700 hover:border-neutral-500 hover:bg-neutral-900/70"
                        }
                        ${isLoading && loadingWorkflowId !== workflow.id ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                      `}
                    >
                      {/* Icon */}
                      <div
                        className={`
                          w-12 h-12 rounded-lg flex items-center justify-center mb-3
                          ${
                            loadingWorkflowId === workflow.id
                              ? "bg-purple-500/30"
                              : "bg-neutral-700/50 group-hover:bg-neutral-700"
                          }
                        `}
                      >
                        {loadingWorkflowId === workflow.id ? (
                          <svg
                            className="w-5 h-5 text-purple-400 animate-spin"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <circle
                              className="opacity-25"
                              cx="12"
                              cy="12"
                              r="10"
                              stroke="currentColor"
                              strokeWidth="4"
                            />
                            <path
                              className="opacity-75"
                              fill="currentColor"
                              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                            />
                          </svg>
                        ) : (
                          <svg
                            className="w-6 h-6 text-neutral-400 group-hover:text-neutral-300 transition-colors"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={1.5}
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                            />
                          </svg>
                        )}
                      </div>

                      {/* Name */}
                      <h3 className="text-sm font-medium text-neutral-200 mb-1">
                        {workflow.name}
                      </h3>

                      {/* Author */}
                      <p className="text-xs text-purple-400/80">
                        @{workflow.author}
                      </p>

                      {/* Community badge */}
                      <div className="mt-3">
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/20 text-amber-300">
                          Community
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Discord CTA */}
              <p className="text-xs text-neutral-500 mt-3">
                Want to share your workflow?{" "}
                <a
                  href="https://discord.com/invite/89Nr6EKkTf"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-400 hover:text-purple-300 underline"
                >
                  Join our Discord
                </a>{" "}
                to submit it to the community templates.
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <svg
                className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <div className="flex-1">
                <p className="text-sm text-red-400">{error}</p>
                <button
                  onClick={() => setError(null)}
                  className="text-xs text-red-400/70 hover:text-red-400 mt-1"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
