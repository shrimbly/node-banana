"use client";

import { TemplateCategory } from "@/types/quickstart";

interface TemplateCardProps {
  template: {
    id: string;
    name: string;
    description: string;
    icon: string;
    category: TemplateCategory;
    tags: string[];
  };
  nodeCount: number;
  previewImage?: string;
  hoverImage?: string;
  isLoading?: boolean;
  onUseWorkflow: () => void;
  disabled?: boolean;
}

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  simple: "Simple",
  advanced: "Advanced",
  community: "Community",
};

const CATEGORY_COLORS: Record<TemplateCategory, string> = {
  simple: "bg-blue-500/20 text-blue-300",
  advanced: "bg-purple-500/20 text-purple-300",
  community: "bg-amber-500/20 text-amber-300",
};

export function TemplateCard({
  template,
  nodeCount,
  previewImage,
  hoverImage,
  isLoading = false,
  onUseWorkflow,
  disabled = false,
}: TemplateCardProps) {
  return (
    <div
      className={`
        group w-full rounded-lg border p-4 transition-all flex gap-4
        ${
          isLoading
            ? "bg-blue-600/20 border-blue-500/50"
            : "bg-neutral-900/50 border-neutral-700"
        }
        ${disabled && !isLoading ? "opacity-50" : ""}
      `}
    >
      {/* Thumbnail - Left side (square) */}
      <div
        className={`
          w-36 h-36 flex-shrink-0 rounded-lg overflow-hidden relative
          ${
            isLoading
              ? "bg-blue-500/20"
              : "bg-neutral-800"
          }
        `}
      >
        {previewImage ? (
          <>
            {/* Primary image */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewImage}
              alt={`${template.name} preview`}
              className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-300 ${hoverImage ? "group-hover:opacity-0" : ""}`}
              style={{ imageRendering: "auto" }}
            />
            {/* Hover image (if provided) */}
            {hoverImage && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={hoverImage}
                alt={`${template.name} hover preview`}
                className="absolute inset-0 w-full h-full object-cover opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                style={{ imageRendering: "auto" }}
              />
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <svg
              className="w-8 h-8 text-neutral-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={template.icon} />
            </svg>
          </div>
        )}
      </div>

      {/* Content - Right side */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header row */}
        <div className="flex items-start justify-between gap-2 mb-1">
          <h3 className="text-sm font-medium text-neutral-200 truncate">
            {template.name}
          </h3>
          <span
            className={`
              inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0
              ${CATEGORY_COLORS[template.category]}
            `}
          >
            {CATEGORY_LABELS[template.category]}
          </span>
        </div>

        {/* Description */}
        <p className="text-xs text-neutral-400 line-clamp-2 flex-1">
          {template.description}
        </p>

        {/* Provider tags and node count */}
        <div className="flex flex-wrap gap-1 mt-2">
          {template.tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-neutral-700/30 text-neutral-400"
            >
              {tag}
            </span>
          ))}
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-neutral-700/50 text-neutral-400">
            {nodeCount} nodes
          </span>
        </div>

        {/* Action row */}
        <div className="flex justify-end mt-2">
          <button
            onClick={onUseWorkflow}
            disabled={disabled || isLoading}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {isLoading ? (
              <>
                <svg
                  className="w-3 h-3 animate-spin"
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
                Loading...
              </>
            ) : (
              <>
                Use workflow
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
                    d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3"
                  />
                </svg>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
