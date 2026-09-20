"use client";

import { DialogChip, DialogRowTitle } from "@/components/ui/Dialog";
import { cn } from "@/components/nodes/ui/cn";
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

/**
 * One template in the explorer grid. The whole card is the button: a
 * 72px thumbnail (cross-fading to the workflow screenshot on hover), the
 * name with its category chip, the description and a mono meta line.
 */
export function TemplateCard({
  template,
  nodeCount,
  previewImage,
  hoverImage,
  isLoading = false,
  onUseWorkflow,
  disabled = false,
}: TemplateCardProps) {
  const meta = [...template.tags, `${nodeCount} nodes`].join(" · ");

  return (
    <button
      type="button"
      onClick={onUseWorkflow}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      className={cn(
        "group flex items-center gap-3 w-full p-2.5 rounded-[10px] border text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-bg",
        isLoading ? "border-neutral-500" : "border-card-border hover:border-neutral-600",
        disabled && !isLoading && "opacity-50 cursor-not-allowed"
      )}
    >
      {/* Thumbnail */}
      <span className="relative w-[72px] h-[72px] shrink-0 rounded-md overflow-hidden bg-card">
        {previewImage ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewImage}
              alt={`${template.name} preview`}
              className={cn(
                "absolute inset-0 w-full h-full object-cover transition-opacity duration-300",
                hoverImage && "group-hover:opacity-0"
              )}
              style={{ imageRendering: "auto" }}
            />
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
          <span className="absolute inset-0 flex items-center justify-center">
            <svg
              className="w-7 h-7 text-neutral-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d={template.icon} />
            </svg>
          </span>
        )}
      </span>

      {/* Copy */}
      <span className="flex-1 min-w-0 flex flex-col gap-[3px]">
        <span className="flex items-center justify-between gap-2">
          <DialogRowTitle className="truncate">{template.name}</DialogRowTitle>
          <DialogChip>{CATEGORY_LABELS[template.category] ?? template.category}</DialogChip>
        </span>
        <span className="text-xs leading-4 text-ink-3 line-clamp-2">{template.description}</span>
        <span className="mt-1 font-mono text-[10px] leading-4 tracking-eyebrow uppercase text-neutral-500 truncate">
          {isLoading ? "Loading..." : meta}
        </span>
      </span>

      {/* Arrow, or the spinner while this template loads */}
      <span className="shrink-0 flex items-center justify-center w-4 h-4 text-neutral-500 group-hover:text-neutral-300 transition-colors">
        {isLoading ? (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        ) : (
          <svg
            className="w-4 h-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        )}
      </span>
    </button>
  );
}
