"use client";

import React, { ReactNode } from "react";
import { cn } from "./cn";
import { ellipsisClass } from "./Field";

export interface SummaryRowProps {
  /** 16px provider icon or similar. */
  icon?: ReactNode;
  /** Model name or the node's headline. Truncates with an ellipsis. */
  title: ReactNode;
  /** Right-aligned values ("16:9 · 1K"). */
  values?: ReactNode;
  className?: string;
}

/** Right-aligned summary values, separated by middle dots. */
export function SummaryValues({ items }: { items: ReadonlyArray<ReactNode> }) {
  const shown = items.filter((v) => v !== undefined && v !== null && v !== "");
  if (shown.length === 0) return null;
  return (
    <span className="flex items-center gap-1 text-node text-neutral-500 tabular-nums whitespace-nowrap">
      {shown.map((v, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span aria-hidden>·</span>}
          <span>{v}</span>
        </React.Fragment>
      ))}
    </span>
  );
}

export interface ControlsCardProps {
  /** Node id; used for aria-controls. */
  id: string;
  summary: SummaryRowProps;
  /** Settings panel content. Without it the card is just the summary row. */
  children?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  className?: string;
  /** Extra classes on the panel body. */
  panelClassName?: string;
}

/**
 * The detached controls card beneath the media: a 28px summary row, and an
 * animated settings panel that opens under it.
 */
export function ControlsCard({
  id,
  summary,
  children,
  expanded = false,
  onToggle,
  className,
  panelClassName,
}: ControlsCardProps) {
  const toggleable = Boolean(children && onToggle);
  const panelId = `params-${id}`;

  return (
    <div
      className={cn(
        "w-[calc(100%-24px)] max-w-[360px] rounded-controls squircle overflow-hidden",
        "bg-card border border-card-border",
        className
      )}
      data-controls-card
    >
      <div
        className={cn(
          "grid items-center gap-1.5 px-2 h-[28px] min-w-0",
          summary.icon ? "grid-cols-[16px_minmax(0,1fr)_auto_auto]" : "grid-cols-[minmax(0,1fr)_auto_auto]",
          toggleable && "cursor-pointer",
          summary.className
        )}
        onClick={toggleable ? onToggle : undefined}
      >
        {summary.icon && <span className="flex items-center justify-center w-4 h-4 text-neutral-500">{summary.icon}</span>}
        <span className={cn("text-node text-neutral-200 min-w-0", ellipsisClass)}>{summary.title}</span>
        <span className="flex items-center min-w-0">{summary.values}</span>
        {toggleable ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
            className="nodrag nopan w-4 h-4 flex items-center justify-center text-neutral-500 hover:text-neutral-300 transition-colors"
            aria-label={expanded ? "Collapse settings" : "Expand settings"}
            aria-expanded={expanded}
            aria-controls={panelId}
          >
            <svg
              className="w-3 h-3 transition-transform duration-200"
              style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        ) : (
          <span className="w-0" />
        )}
      </div>

      {children && (
        <div
          className="grid transition-[grid-template-rows] duration-150 ease-out"
          style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
          aria-hidden={!expanded}
          inert={!expanded}
        >
          <div className="min-h-0 overflow-hidden">
            <div
              id={panelId}
              className={cn("nodrag nopan nowheel bg-panel px-2 pt-1.5 pb-2 flex flex-col gap-1", panelClassName)}
            >
              {children}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
