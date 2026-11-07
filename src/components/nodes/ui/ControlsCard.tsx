"use client";

import React, { ReactNode, createContext, useContext } from "react";
import { cn } from "./cn";
import { ellipsisClass } from "./Field";
import { WidthGrip } from "./WidthGrip";
import { CONTROLS_INSET, CONTROLS_MAX_W } from "./tokens";
import { ChevronDown } from "lucide-react";

export interface ControlsSizing {
  /** Node width, the base the card's automatic width is derived from. */
  nodeWidth: number;
  /** Explicit card width in flow px; unset means "follow the node". */
  width?: number;
  /** Persist a dragged width, or `undefined` to follow the node again. */
  onWidthChange: (width: number | undefined) => void;
}

/**
 * Provided by NodeShell so the card can offer edge grips without every node
 * wiring them up. Absent (template previews, tests), the card is not resizable.
 */
export const ControlsSizingContext = createContext<ControlsSizing | null>(null);

/** The width the card takes on its own: node width − inset, capped. */
export function autoControlsWidth(nodeWidth: number): number {
  return Math.min(CONTROLS_MAX_W, Math.max(0, nodeWidth - CONTROLS_INSET));
}

export interface SummaryRowProps {
  /** 16px provider icon or similar. */
  icon?: ReactNode;
  /** Model name or the node's headline. Truncates with an ellipsis. */
  title: ReactNode;
  /** Right-aligned values ("16:9 · 1K"). */
  values?: ReactNode;
  className?: string;
}

/**
 * Right-aligned summary values, separated by middle dots. `truncate`: the values give way first, cut at the end with
 * an ellipsis (their whole text on hover), for a summary whose title must stay whole; pair it with a title column
 * that keeps its width (`summary.className`).
 */
export function SummaryValues({ items, truncate = false }: { items: ReadonlyArray<ReactNode>; truncate?: boolean }) {
  const shown = items.filter((v) => v !== undefined && v !== null && v !== "");
  if (shown.length === 0) return null;
  if (truncate) {
    const text = shown.every((v) => typeof v === "string" || typeof v === "number") ? shown.join(" · ") : undefined;
    return (
      <span className="ml-auto block min-w-0 truncate text-node text-neutral-500 tabular-nums" title={text}>
        {/* The dots sit between real spaces: the copied and the spoken text keep their word breaks */}
        {shown.map((v, i) => (
          <React.Fragment key={i}>
            {i > 0 && (
              <>
                {" "}
                <span aria-hidden>·</span>{" "}
              </>
            )}
            <span>{v}</span>
          </React.Fragment>
        ))}
      </span>
    );
  }
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
  /** Override the sizing the shell provides; `null` disables the grips. */
  sizing?: ControlsSizing | null;
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
  sizing: sizingProp,
}: ControlsCardProps) {
  const toggleable = Boolean(children && onToggle);
  const panelId = `params-${id}`;
  const contextSizing = useContext(ControlsSizingContext);
  const sizing = sizingProp === undefined ? contextSizing : sizingProp;
  const explicitWidth = sizing?.width;
  const gripWidth = sizing ? (explicitWidth ?? autoControlsWidth(sizing.nodeWidth)) : 0;

  return (
    <div
      className={cn(
        "relative w-[calc(100%-24px)] max-w-[360px] rounded-controls squircle overflow-hidden",
        "bg-card border border-card-border",
        className
      )}
      style={explicitWidth !== undefined ? { width: explicitWidth, maxWidth: "none" } : undefined}
      data-controls-card
      data-controls-width={explicitWidth}
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
            <ChevronDown
              size={12}
              strokeWidth={2}
              className="transition-transform duration-200"
              style={{ transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }}
            />
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

      {sizing && (
        <>
          <WidthGrip side="left" width={gripWidth} onChange={sizing.onWidthChange} />
          <WidthGrip side="right" width={gripWidth} onChange={sizing.onWidthChange} />
        </>
      )}
    </div>
  );
}
