"use client";

import type { CSSProperties } from "react";
import { SparklesIcon } from "lucide-react";

export interface AgentButtonProps {
  open: boolean;
  /** A turn is running; shown as a dot so it is visible with the window closed. */
  busy?: boolean;
  disabled?: boolean;
  /** Dimmed like the other canvas chrome while the tutorial locks features. */
  dimmed?: boolean;
  style?: CSSProperties;
  onClick: () => void;
}

/** Opens the agent window. Sits directly above the minimap, styled like the minimap toggle. */
export function AgentButton({ open, busy = false, disabled = false, dimmed = false, style, onClick }: AgentButtonProps) {
  return (
    <button
      type="button"
      aria-label="Open agent"
      aria-pressed={open}
      title={busy ? "Agent — working" : "Agent"}
      disabled={disabled}
      onClick={onClick}
      style={style}
      className={`nodrag nopan nowheel absolute z-[5] flex h-10 w-10 items-center justify-center rounded-lg border shadow-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-not-allowed ${
        open
          ? "border-blue-500/60 bg-neutral-700 text-blue-300 hover:bg-neutral-600"
          : "border-neutral-700 bg-neutral-800 text-neutral-400 hover:border-neutral-600 hover:bg-neutral-700 hover:text-neutral-100"
      } ${dimmed ? "opacity-30 pointer-events-none" : ""}`}
    >
      <SparklesIcon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.75} />
      {busy && (
        <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-neutral-900" />
        </span>
      )}
    </button>
  );
}
