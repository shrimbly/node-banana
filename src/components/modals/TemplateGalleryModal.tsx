"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { WorkflowFile, useWorkflowStore } from "@/store/workflowStore";
import { getAllPresets } from "@/lib/quickstart/templates";
import { CommunityWorkflowMeta } from "@/types/quickstart";

interface TemplateGalleryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTemplateSelected: (workflow: WorkflowFile) => void;
}

type TemplateCategory = "all" | "quick-start" | "community";

interface TemplateItem {
  id: string;
  name: string;
  description: string;
  icon?: string;
  author?: string;
  category: "quick-start" | "community";
  nodeCount?: number;
}

export function TemplateGalleryModal({
  isOpen,
  onClose,
  onTemplateSelected,
}: TemplateGalleryModalProps) {
  const { incrementModalCount, decrementModalCount } =
    useWorkflowStore();

  const [communityWorkflows, setCommunityWorkflows] = useState<
    CommunityWorkflowMeta[]
  >([]);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [loadingTemplateId, setLoadingTemplateId] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] =
    useState<TemplateCategory>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [previewTemplate, setPreviewTemplate] = useState<TemplateItem | null>(
    null
  );

  const presets = getAllPresets();

  // Register modal with store
  useEffect(() => {
    if (isOpen) {
      incrementModalCount();
      return () => decrementModalCount();
    }
  }, [isOpen, incrementModalCount, decrementModalCount]);

  // Fetch community workflows on mount
  useEffect(() => {
    if (!isOpen) return;

    async function fetchCommunityWorkflows() {
      setIsLoadingList(true);
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
  }, [isOpen]);

  // Combine presets and community workflows into a unified list
  const allTemplates: TemplateItem[] = useMemo(() => {
    const presetItems: TemplateItem[] = presets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      description: preset.description,
      icon: preset.icon,
      category: "quick-start" as const,
    }));

    const communityItems: TemplateItem[] = communityWorkflows.map((wf) => ({
      id: wf.id,
      name: wf.name,
      description: `By ${wf.author}`,
      author: wf.author,
      category: "community" as const,
    }));

    return [...presetItems, ...communityItems];
  }, [presets, communityWorkflows]);

  // Filter templates based on category and search
  const filteredTemplates = useMemo(() => {
    return allTemplates.filter((template) => {
      // Category filter
      if (
        selectedCategory !== "all" &&
        template.category !== selectedCategory
      ) {
        return false;
      }

      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return (
          template.name.toLowerCase().includes(query) ||
          template.description.toLowerCase().includes(query) ||
          (template.author && template.author.toLowerCase().includes(query))
        );
      }

      return true;
    });
  }, [allTemplates, selectedCategory, searchQuery]);

  const handleImportTemplate = useCallback(
    async (template: TemplateItem) => {
      setLoadingTemplateId(template.id);
      setError(null);

      try {
        let workflow: WorkflowFile;

        if (template.category === "quick-start") {
          const response = await fetch("/api/quickstart", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              templateId: template.id,
              contentLevel: "full",
            }),
          });

          const result = await response.json();

          if (!result.success) {
            throw new Error(result.error || "Failed to load template");
          }

          workflow = result.workflow;
        } else {
          const response = await fetch(
            `/api/community-workflows/${template.id}`
          );
          const result = await response.json();

          if (!result.success) {
            throw new Error(result.error || "Failed to load workflow");
          }

          workflow = result.workflow;
        }

        onTemplateSelected(workflow);
      } catch (err) {
        console.error("Error loading template:", err);
        setError(err instanceof Error ? err.message : "Failed to load template");
      } finally {
        setLoadingTemplateId(null);
      }
    },
    [onTemplateSelected]
  );

  const handlePreview = useCallback((template: TemplateItem) => {
    setPreviewTemplate(template);
  }, []);

  const handleClosePreview = useCallback(() => {
    setPreviewTemplate(null);
  }, []);

  const isLoading = loadingTemplateId !== null;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-700 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-yellow-500 to-orange-500 flex items-center justify-center">
              <svg
                className="w-6 h-6 text-white"
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
            </div>
            <div>
              <h2 className="text-lg font-semibold text-neutral-100">
                Template Gallery
              </h2>
              <p className="text-sm text-neutral-400">
                Browse and import workflow templates
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-5 h-5"
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

        {/* Filters */}
        <div className="px-6 py-3 border-b border-neutral-800 flex items-center gap-4 shrink-0">
          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500"
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
              placeholder="Search templates..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg text-sm text-neutral-200 placeholder-neutral-500 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500/50"
            />
          </div>

          {/* Category Pills */}
          <div className="flex items-center gap-1">
            {(
              [
                { key: "all", label: "All" },
                { key: "quick-start", label: "Quick Start" },
                { key: "community", label: "Community" },
              ] as const
            ).map((cat) => (
              <button
                key={cat.key}
                onClick={() => setSelectedCategory(cat.key)}
                className={`
                  px-3 py-1.5 rounded-full text-xs font-medium transition-colors
                  ${
                    selectedCategory === cat.key
                      ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                      : "bg-neutral-800 text-neutral-400 border border-neutral-700 hover:text-neutral-300 hover:border-neutral-600"
                  }
                `}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {isLoadingList && selectedCategory !== "quick-start" ? (
            <div className="flex items-center justify-center py-12">
              <svg
                className="w-6 h-6 text-neutral-500 animate-spin"
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
          ) : filteredTemplates.length === 0 ? (
            <div className="text-center py-12">
              <svg
                className="w-12 h-12 text-neutral-600 mx-auto mb-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M12 12h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <p className="text-neutral-400">No templates found</p>
              <p className="text-sm text-neutral-500 mt-1">
                Try adjusting your search or filters
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {filteredTemplates.map((template) => (
                <div
                  key={`${template.category}-${template.id}`}
                  className={`
                    group relative flex flex-col p-4 rounded-lg border transition-all
                    ${
                      loadingTemplateId === template.id
                        ? "bg-yellow-600/10 border-yellow-500/50"
                        : "bg-neutral-800/50 border-neutral-700 hover:border-neutral-600 hover:bg-neutral-800"
                    }
                    ${isLoading && loadingTemplateId !== template.id ? "opacity-50" : ""}
                  `}
                >
                  {/* Header */}
                  <div className="flex items-start gap-3 mb-3">
                    <div
                      className={`
                        w-10 h-10 rounded-lg flex items-center justify-center shrink-0
                        ${
                          template.category === "quick-start"
                            ? "bg-blue-500/20"
                            : "bg-purple-500/20"
                        }
                      `}
                    >
                      {loadingTemplateId === template.id ? (
                        <svg
                          className="w-5 h-5 text-yellow-400 animate-spin"
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
                      ) : template.icon ? (
                        <svg
                          className={`w-5 h-5 ${
                            template.category === "quick-start"
                              ? "text-blue-400"
                              : "text-purple-400"
                          }`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={1.5}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d={template.icon}
                          />
                        </svg>
                      ) : (
                        <svg
                          className="w-5 h-5 text-purple-400"
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
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium text-neutral-200 truncate">
                        {template.name}
                      </h3>
                      <p className="text-xs text-neutral-500 truncate mt-0.5">
                        {template.category === "community" && template.author
                          ? `@${template.author}`
                          : template.description}
                      </p>
                    </div>
                  </div>

                  {/* Category Badge */}
                  <div className="mb-3">
                    <span
                      className={`
                        inline-block px-2 py-0.5 rounded-full text-[10px] font-medium
                        ${
                          template.category === "quick-start"
                            ? "bg-blue-500/10 text-blue-400"
                            : "bg-purple-500/10 text-purple-400"
                        }
                      `}
                    >
                      {template.category === "quick-start"
                        ? "Quick Start"
                        : "Community"}
                    </span>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 mt-auto">
                    <button
                      onClick={() => handlePreview(template)}
                      disabled={isLoading}
                      className={`
                        flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
                        bg-neutral-700 text-neutral-300 hover:bg-neutral-600
                        ${isLoading ? "cursor-not-allowed opacity-50" : ""}
                      `}
                    >
                      Preview
                    </button>
                    <button
                      onClick={() => handleImportTemplate(template)}
                      disabled={isLoading}
                      className={`
                        flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors
                        bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 border border-yellow-500/30
                        ${isLoading ? "cursor-not-allowed opacity-50" : ""}
                      `}
                    >
                      {loadingTemplateId === template.id ? "Loading..." : "Import"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
              <svg
                className="w-4 h-4 text-red-400 mt-0.5 shrink-0"
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

        {/* Footer */}
        <div className="px-6 py-3 border-t border-neutral-800 flex items-center justify-between shrink-0 bg-neutral-900/50">
          <p className="text-xs text-neutral-500">
            {filteredTemplates.length} template
            {filteredTemplates.length !== 1 ? "s" : ""} available
          </p>
          <a
            href="https://discord.com/invite/89Nr6EKkTf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-purple-400 hover:text-purple-300"
          >
            Submit your workflow →
          </a>
        </div>
      </div>

      {/* Preview Modal */}
      {previewTemplate && (
        <TemplatePreviewModal
          template={previewTemplate}
          onClose={handleClosePreview}
          onImport={() => {
            handleClosePreview();
            handleImportTemplate(previewTemplate);
          }}
          isLoading={loadingTemplateId === previewTemplate.id}
        />
      )}
    </div>
  );
}

interface TemplatePreviewModalProps {
  template: TemplateItem;
  onClose: () => void;
  onImport: () => void;
  isLoading: boolean;
}

function TemplatePreviewModal({
  template,
  onClose,
  onImport,
  isLoading,
}: TemplatePreviewModalProps) {
  const [previewData, setPreviewData] = useState<{
    nodeCount: number;
    edgeCount: number;
    nodeTypes: string[];
    description?: string;
  } | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(true);

  useEffect(() => {
    async function fetchPreview() {
      setIsLoadingPreview(true);
      try {
        if (template.category === "quick-start") {
          // Fetch minimal version for preview
          const response = await fetch("/api/quickstart", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              templateId: template.id,
              contentLevel: "empty",
            }),
          });
          const result = await response.json();
          if (result.success && result.workflow) {
            const nodeTypes: string[] = [
              ...new Set(
                result.workflow.nodes.map((n: { type: string }) => n.type)
              ),
            ] as string[];
            setPreviewData({
              nodeCount: result.workflow.nodes.length,
              edgeCount: result.workflow.edges.length,
              nodeTypes,
              description: template.description,
            });
          }
        } else {
          const response = await fetch(
            `/api/community-workflows/${template.id}`
          );
          const result = await response.json();
          if (result.success && result.workflow) {
            const nodeTypes: string[] = [
              ...new Set(
                result.workflow.nodes.map((n: { type: string }) => n.type)
              ),
            ] as string[];
            setPreviewData({
              nodeCount: result.workflow.nodes.length,
              edgeCount: result.workflow.edges.length,
              nodeTypes,
            });
          }
        }
      } catch (err) {
        console.error("Error fetching preview:", err);
      } finally {
        setIsLoadingPreview(false);
      }
    }

    fetchPreview();
  }, [template]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div className="relative bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl w-full max-w-md overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-neutral-700 flex items-center justify-between">
          <h3 className="text-base font-semibold text-neutral-100">
            Template Preview
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700 rounded transition-colors"
          >
            <svg
              className="w-4 h-4"
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

        {/* Content */}
        <div className="p-5">
          {isLoadingPreview ? (
            <div className="flex items-center justify-center py-8">
              <svg
                className="w-6 h-6 text-neutral-500 animate-spin"
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
            <div className="space-y-4">
              {/* Template Info */}
              <div className="flex items-start gap-3">
                <div
                  className={`
                    w-12 h-12 rounded-lg flex items-center justify-center shrink-0
                    ${
                      template.category === "quick-start"
                        ? "bg-blue-500/20"
                        : "bg-purple-500/20"
                    }
                  `}
                >
                  {template.icon ? (
                    <svg
                      className={`w-6 h-6 ${
                        template.category === "quick-start"
                          ? "text-blue-400"
                          : "text-purple-400"
                      }`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d={template.icon}
                      />
                    </svg>
                  ) : (
                    <svg
                      className="w-6 h-6 text-purple-400"
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
                <div>
                  <h4 className="text-lg font-medium text-neutral-100">
                    {template.name}
                  </h4>
                  {template.author && (
                    <p className="text-sm text-purple-400">@{template.author}</p>
                  )}
                  {previewData?.description && (
                    <p className="text-sm text-neutral-400 mt-1">
                      {previewData.description}
                    </p>
                  )}
                </div>
              </div>

              {/* Stats */}
              {previewData && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-neutral-900/50 rounded-lg">
                    <div className="text-2xl font-semibold text-neutral-100">
                      {previewData.nodeCount}
                    </div>
                    <div className="text-xs text-neutral-500">Nodes</div>
                  </div>
                  <div className="p-3 bg-neutral-900/50 rounded-lg">
                    <div className="text-2xl font-semibold text-neutral-100">
                      {previewData.edgeCount}
                    </div>
                    <div className="text-xs text-neutral-500">Connections</div>
                  </div>
                </div>
              )}

              {/* Node Types */}
              {previewData?.nodeTypes && previewData.nodeTypes.length > 0 && (
                <div>
                  <div className="text-xs text-neutral-500 mb-2">
                    Node Types
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {previewData.nodeTypes.map((type) => (
                      <span
                        key={type}
                        className="px-2 py-1 bg-neutral-700/50 text-neutral-300 text-xs rounded"
                      >
                        {type}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-neutral-700 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-neutral-400 hover:text-neutral-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onImport}
            disabled={isLoading || isLoadingPreview}
            className={`
              px-4 py-2 text-sm font-medium rounded-lg transition-colors
              bg-yellow-500 text-neutral-900 hover:bg-yellow-400
              ${isLoading || isLoadingPreview ? "opacity-50 cursor-not-allowed" : ""}
            `}
          >
            {isLoading ? "Importing..." : "Import Template"}
          </button>
        </div>
      </div>
    </div>
  );
}
