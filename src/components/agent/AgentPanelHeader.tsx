"use client";

import type { KeyboardEvent } from "react";
import { SquarePenIcon, XIcon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/agent/ui/tooltip";
import { HARNESS_LABELS, readinessTone, type AgentReadiness } from "@/lib/agent/client/readiness";
import { AGENT_HARNESS_IDS, type AgentHarnessId } from "@/lib/agent/types";
import { AGENT_ICON, AGENT_POPOVER_LAYER, PanelIconButton, StatusDot } from "./AgentChrome";
import { HarnessIcon } from "./HarnessIcon";

export interface AgentPanelHeaderProps {
  harness: AgentHarnessId;
  readiness: Record<AgentHarnessId, AgentReadiness>;
  /** Switching is locked while a turn runs. */
  switchDisabled: boolean;
  onHarnessChange: (harness: AgentHarnessId) => void;
  canStartNewChat: boolean;
  onNewChat: () => void;
  onClose: () => void;
}

const ARROW_STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** One line under each harness in the switch's tooltip. */
function describeReadiness(readiness: AgentReadiness): string {
  switch (readiness.kind) {
    case "loading":
      return "Checking…";
    case "unavailable":
      return "Status unavailable";
    case "ready": {
      const { account } = readiness.status;
      const who = [account?.email, account?.plan].filter(Boolean).join(" · ");
      return who ? `Ready — ${who}` : "Ready";
    }
    case "signing_in":
      return "Signing in…";
    case "signed_out":
    case "sign_in_failed":
      return "Not signed in";
    case "wrong_billing":
      return "Signed in with an API account — won't run";
    case "unconfirmed_billing":
      return "Subscription not confirmed — won't run";
    case "not_installed":
      return "Not available";
  }
}

export function AgentPanelHeader({
  harness,
  readiness,
  switchDisabled,
  onHarnessChange,
  canStartNewChat,
  onNewChat,
  onClose,
}: AgentPanelHeaderProps) {
  // Radio-group keyboard behaviour: arrows move the choice (and focus) between harnesses.
  const handleArrowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEPS[event.key];
    if (!step || switchDisabled) return;
    event.preventDefault();
    const index = AGENT_HARNESS_IDS.indexOf(harness);
    const next = AGENT_HARNESS_IDS[(index + step + AGENT_HARNESS_IDS.length) % AGENT_HARNESS_IDS.length];
    onHarnessChange(next);
    const radios = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    radios[AGENT_HARNESS_IDS.indexOf(next)]?.focus();
  };

  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] pl-4 pr-2">
      <h2 data-agent-eyebrow className="font-mono text-[11px] leading-4 uppercase tracking-eyebrow text-ink-3">
        Agent
      </h2>

      {/* The dialogs' ink segmented control, at the compact size: each harness by its logo, with a status dot. */}
      <div
        role="radiogroup"
        aria-label="Run the agent with"
        onKeyDown={handleArrowKeys}
        className="flex items-center gap-0.5 rounded-lg bg-white/[0.06] p-0.5"
      >
        {AGENT_HARNESS_IDS.map((id) => {
          const selected = id === harness;
          const locked = switchDisabled && !selected;
          return (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={HARNESS_LABELS[id]}
                  // aria-disabled rather than disabled, so the tooltip still explains why.
                  aria-disabled={locked || undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    if (!locked && !selected) onHarnessChange(id);
                  }}
                  className={cn(
                    "relative flex h-6 w-9 items-center justify-center rounded-md transition-[background-color,opacity]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
                    "aria-disabled:cursor-not-allowed",
                    selected
                      ? "bg-neutral-200"
                      : "opacity-55 hover:bg-white/[0.06] hover:opacity-100 aria-disabled:opacity-30 aria-disabled:hover:bg-transparent aria-disabled:hover:opacity-30",
                  )}
                >
                  <HarnessIcon harness={id} />
                  {/* Readiness, as a badge on the logo's corner. */}
                  <StatusDot
                    tone={readinessTone(readiness[id])}
                    className={cn("absolute right-0.5 top-0.5 ring-2", selected ? "ring-neutral-200" : "ring-neutral-800")}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent className={AGENT_POPOVER_LAYER} side="bottom">
                {`${HARNESS_LABELS[id]} — ${
                  switchDisabled && !selected ? "stop the current reply to switch" : describeReadiness(readiness[id])
                }`}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <PanelIconButton label="New chat" onClick={onNewChat} disabled={!canStartNewChat}>
          <SquarePenIcon {...AGENT_ICON} />
        </PanelIconButton>
        <PanelIconButton label="Close" onClick={onClose} tooltipAlign="end">
          <XIcon {...AGENT_ICON} />
        </PanelIconButton>
      </div>
    </div>
  );
}
