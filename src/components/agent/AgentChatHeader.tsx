"use client";

import { memo } from "react";
import { WaypointsIcon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { Tooltip } from "@/components/ui/Tooltip";
import { AGENT_ICON } from "./AgentChrome";
import { AgentModelMenu, type AgentModelMenuProps } from "./AgentPanelHeader";
import { AgentWorkflowSwitcher } from "./AgentWorkflowSwitcher";

export interface AgentChatHeaderProps {
  /** The transcript has scrolled under the header: a hairline separates them. */
  scrolled: boolean;
  /** A turn is running: the workflow can't change under it. */
  busy: boolean;
  /** The harness and model picker, as the window's header has it. */
  menu: Omit<AgentModelMenuProps, "align">;
  onOpenCanvas: () => void;
}

/**
 * The chat view's top bar: which workflow the agent works in (and the switch
 * to another), who answers on which model, and the way to the canvas.
 */
export const AgentChatHeader = memo(function AgentChatHeader({ scrolled, busy, menu, onOpenCanvas }: AgentChatHeaderProps) {
  return (
    <header
      className={cn(
        "relative z-[2] flex h-[52px] shrink-0 items-center gap-2 border-b pl-3 pr-3 transition-[border-color] duration-150",
        scrolled ? "border-white/[0.06]" : "border-transparent",
      )}
    >
      <AgentWorkflowSwitcher busy={busy} />
      <div className="ml-auto flex min-w-0 items-center gap-1.5">
        <AgentModelMenu {...menu} align="end" />
        <span aria-hidden="true" className="mx-1 h-[18px] w-px shrink-0 bg-white/[0.08]" />
        <div className="group relative flex shrink-0">
          <button
            type="button"
            aria-label="Open canvas"
            onClick={onOpenCanvas}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg squircle border border-white/[0.09] bg-white/[0.03] pl-2.5 pr-3",
              "font-display text-[13px] font-medium tracking-[-0.01em] text-neutral-300",
              "transition-[border-color,color,transform] duration-[120ms] ease-out hover:border-white/[0.18] hover:text-neutral-100",
              "active:scale-[0.97] motion-reduce:active:scale-100",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
            )}
          >
            <WaypointsIcon className="size-4 shrink-0" {...AGENT_ICON} />
            Canvas
          </button>
          <Tooltip label="Show this workflow's canvas" shortcut="C" placement="bottom" align="end" />
        </div>
      </div>
    </header>
  );
});
