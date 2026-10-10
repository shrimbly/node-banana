"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Ref } from "react";

/**
 * The label a hidden connection leaves at a handle. Hovering it ghosts the
 * noodle back; clicking it selects the connection so its toolbar (with the
 * Show action) appears above the label, and double-clicking it renames the
 * connection, or every connection in a collapsed stack, in place. Rendered
 * inside EdgeLabelRenderer by the edge itself, so it follows the handle.
 */

/** How long a click waits to see whether it is the first half of a double-click. */
export const STUB_DOUBLE_CLICK_MS = 250;

export interface HiddenEdgeStubRename {
  /** The text the input starts with: the connections' own label, empty when they have none. */
  value: string;
  ariaLabel: string;
  onCommit: (label: string) => void;
}

interface HiddenEdgeStubProps {
  /** Which end of the connection this stub marks. */
  side: "source" | "target";
  /** Anchor in flow coordinates: just outside the handle. */
  x: number;
  y: number;
  /** Which way the stub extends from the handle: +1 right, -1 left. */
  direction: 1 | -1;
  label: string;
  /** Tooltip; defaults to "Hidden connection". */
  title?: string;
  color: string;
  selected: boolean;
  onHoverChange: (hovering: boolean) => void;
  onSelect: () => void;
  /** Reports the pill's width (flow px) so the edge can draw to its outer edge. */
  onMeasure?: (width: number) => void;
  /** Double-click renames in place. */
  rename?: HiddenEdgeStubRename;
  /**
   * Hold a click until a double-click is ruled out. A collapsed pill's click
   * expands its stack, which replaces the pill, so the second click of a
   * rename would otherwise land on a member's pill.
   */
  waitForDoubleClick?: boolean;
}

export function HiddenEdgeStub({
  side,
  x,
  y,
  direction,
  label,
  title = "Hidden connection",
  color,
  selected,
  onHoverChange,
  onSelect,
  onMeasure,
  rename,
  waitForDoubleClick = false,
}: HiddenEdgeStubProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const pillRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    onMeasure?.(pillRef.current?.offsetWidth ?? 0);
  }, [label, onMeasure, draft]);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);
  const discardingRef = useRef(false);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (!discardingRef.current) rename?.onCommit(draft);
  };

  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = null;
  };
  useEffect(() => cancelClick, []);

  // A pill can vanish under the pointer (a collapsed group expands on click),
  // so a hover it reported must be taken back when it unmounts
  const hoveredRef = useRef(false);
  const onHoverChangeRef = useRef(onHoverChange);
  onHoverChangeRef.current = onHoverChange;
  const setHovered = (hovering: boolean) => {
    hoveredRef.current = hovering;
    onHoverChangeRef.current(hovering);
  };
  useEffect(() => () => {
    if (hoveredRef.current) onHoverChangeRef.current(false);
  }, []);

  const pillClass = "inline-flex items-center gap-1.5 h-5 px-2 rounded-full text-[10px] font-medium leading-none text-neutral-100 whitespace-nowrap border";
  const anchor = direction === 1 ? "translate(0, -50%)" : "translate(-100%, -50%)";
  return (
    <div
      className="nodrag nopan edge-overlay"
      data-testid={`hidden-edge-stub-${side}`}
      // Flex, so the wrapper is exactly the pill's height and -50% centres it on
      // the handle. A selected node or edge lifts edge SVGs above the label
      // layer, so the pill keeps a z-index above any elevated edge or a noodle
      // would be drawn across it.
      style={{ position: "absolute", display: "flex", transform: `translate(${x}px, ${y}px) ${anchor}`, pointerEvents: "all", zIndex: 2001 }}
    >
      {editing ? (
        <div
          ref={pillRef as Ref<HTMLDivElement>}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className={`${pillClass} bg-neutral-700`}
          style={{ borderColor: color }}
        >
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
          <input
            ref={inputRef}
            type="text"
            value={draft}
            placeholder={label}
            aria-label={rename?.ariaLabel}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              // Typing must not reach the canvas's shortcuts (delete, add node, pan)
              e.stopPropagation();
              if (e.key === "Enter") {
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                discardingRef.current = true;
                e.currentTarget.blur();
                discardingRef.current = false;
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className="nodrag nopan nokey p-0 bg-transparent border-none outline-none text-[10px] font-medium leading-none text-neutral-100 placeholder:text-neutral-500"
            style={{ width: `${Math.max(draft.length, label.length, 2) + 1}ch` }}
          />
        </div>
      ) : (
        <button
          ref={pillRef as Ref<HTMLButtonElement>}
          type="button"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (!waitForDoubleClick || !rename) {
              onSelect();
              return;
            }
            cancelClick();
            if (e.detail > 1) return;
            clickTimer.current = setTimeout(() => {
              clickTimer.current = null;
              onSelect();
            }, STUB_DOUBLE_CLICK_MS);
          }}
          onDoubleClick={(e) => {
            // The canvas opens its node search on a double-click
            e.stopPropagation();
            if (!rename) return;
            cancelClick();
            setDraft(rename.value);
          }}
          title={title}
          className={`${pillClass} transition-colors ${selected ? "bg-neutral-700" : "bg-neutral-800/90 hover:bg-neutral-700"}`}
          style={{ borderColor: `${color}${selected ? "" : "99"}` }}
        >
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
          {/* Optical centring: the system font sits low in its line box at this size */}
          <span className="leading-none relative -top-px">{label}</span>
        </button>
      )}
    </div>
  );
}
