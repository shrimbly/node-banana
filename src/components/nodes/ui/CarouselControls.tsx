"use client";

import React from "react";
import { cn } from "./cn";

interface CarouselControlsProps {
  index: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  /** Disables the arrows while an item loads. */
  loading?: boolean;
  /** Used in the button titles: "Previous image" / "Next image". */
  noun?: string;
  /** Show the dots between the arrows (default true). */
  dots?: boolean;
  /** Tighter spacing, no dots: for sharing the gap row with a scrubber. */
  compact?: boolean;
  className?: string;
}

const MAX_DOTS = 7;

/** Which dots to draw for `count` items around `index`, at most MAX_DOTS. */
export function dotWindow(index: number, count: number): number[] {
  if (count <= MAX_DOTS) return Array.from({ length: count }, (_, i) => i);
  const half = Math.floor(MAX_DOTS / 2);
  let start = Math.max(0, index - half);
  start = Math.min(start, count - MAX_DOTS);
  return Array.from({ length: MAX_DOTS }, (_, i) => start + i);
}

/**
 * Prev / dots / `3 / 5` / next. Lives in the gap row between the media card
 * and the controls card.
 */
export function CarouselControls({
  index,
  count,
  onPrev,
  onNext,
  loading,
  noun = "image",
  dots = true,
  compact = false,
  className,
}: CarouselControlsProps) {
  if (count <= 1) return null;
  const safeIndex = Math.min(Math.max(index, 0), count - 1);
  const window = dotWindow(safeIndex, count);

  return (
    <div className={cn("nodrag nopan flex items-center justify-center h-full select-none", compact ? "gap-0.5" : "gap-1.5", className)}>
      <NavButton title={`Previous ${noun}`} onClick={onPrev} disabled={loading} dir="prev" />
      {dots && !compact && (
        <div className="flex items-center gap-[3px]" aria-hidden>
          {window.map((i) => (
            <span
              key={i}
              className={cn(
                "block rounded-full transition-colors",
                i === safeIndex ? "w-[5px] h-[5px] bg-neutral-300" : "w-1 h-1 bg-neutral-600"
              )}
            />
          ))}
        </div>
      )}
      <span className={cn("text-node text-neutral-400 tabular-nums text-center", compact ? "min-w-[28px]" : "min-w-[32px]")}>
        {`${safeIndex + 1} / ${count}`}
      </span>
      <NavButton title={`Next ${noun}`} onClick={onNext} disabled={loading} dir="next" />
    </div>
  );
}

function NavButton({
  title,
  onClick,
  disabled,
  dir,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  dir: "prev" | "next";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="w-5 h-5 rounded-[6px] squircle flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d={dir === "prev" ? "M15 19l-7-7 7-7" : "M9 5l7 7-7 7"} />
      </svg>
    </button>
  );
}
