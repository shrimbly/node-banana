"use client";

import type { CSSProperties } from "react";
import { SparklesIcon } from "lucide-react";
import { ChromeIconButton } from "@/components/ChromeIconButton";
import { CHROME_SURFACE } from "@/components/chromeStyles";
import { cn } from "@/components/agent/lib/utils";

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

/**
 * Opens the agent window. Sits directly above the navigator as one slot of its
 * control row: the same glass card, the same 32px icon button and hover label.
 */
export function AgentButton({ open, busy = false, disabled = false, dimmed = false, style, onClick }: AgentButtonProps) {
  return (
    <div
      data-testid="agent-button"
      style={style}
      className={cn(
        CHROME_SURFACE,
        "nodrag nopan nowheel absolute z-[5] flex h-10 w-10 items-center justify-center rounded-xl",
        dimmed && "pointer-events-none opacity-30",
      )}
    >
      <ChromeIconButton
        label={busy ? "Agent — working" : "Agent"}
        aria-label="Open agent"
        aria-pressed={open}
        open={open}
        // The window covers the label while it is open.
        silent={open}
        tooltipAlign="end"
        disabled={disabled}
        onClick={onClick}
        badge={
          busy && (
            <span aria-hidden="true" className="pointer-events-none absolute -right-0.5 -top-0.5 flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-neutral-200 opacity-50 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-neutral-200 ring-2 ring-neutral-800" />
            </span>
          )
        }
      >
        <SparklesIcon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </ChromeIconButton>
    </div>
  );
}
