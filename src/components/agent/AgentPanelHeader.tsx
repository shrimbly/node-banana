"use client";

import type { KeyboardEvent } from "react";
import { SparklesIcon, SquarePenIcon, XIcon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/agent/ui/tooltip";
import { HARNESS_LABELS, readinessTone, type AgentReadiness } from "@/lib/agent/client/readiness";
import { AGENT_HARNESS_IDS, type AgentHarnessId } from "@/lib/agent/types";
import { AGENT_POPOVER_LAYER, PanelIconButton, StatusDot } from "./AgentChrome";

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
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-neutral-700 pl-3.5 pr-2">
      <SparklesIcon className="size-4 shrink-0 text-blue-400" aria-hidden="true" />
      <h2 className="text-sm font-medium text-neutral-100">Agent</h2>

      <div
        role="radiogroup"
        aria-label="Run the agent with"
        onKeyDown={handleArrowKeys}
        className="ml-1.5 flex items-center rounded-lg border border-neutral-700 bg-neutral-900/70 p-0.5"
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
                  // aria-disabled rather than disabled, so the tooltip still explains why.
                  aria-disabled={locked || undefined}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    if (!locked && !selected) onHarnessChange(id);
                  }}
                  className={cn(
                    "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
                    selected
                      ? "bg-neutral-700 text-neutral-100 shadow-sm"
                      : "text-neutral-400 hover:text-neutral-200 aria-disabled:hover:text-neutral-400",
                  )}
                >
                  <StatusDot tone={readinessTone(readiness[id])} />
                  {HARNESS_LABELS[id]}
                </button>
              </TooltipTrigger>
              <TooltipContent className={AGENT_POPOVER_LAYER} side="bottom">
                {switchDisabled && !selected ? "Stop the current reply to switch" : describeReadiness(readiness[id])}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      <div className="ml-auto flex items-center gap-0.5">
        <PanelIconButton label="New chat" onClick={onNewChat} disabled={!canStartNewChat}>
          <SquarePenIcon />
        </PanelIconButton>
        <PanelIconButton label="Close" onClick={onClose}>
          <XIcon />
        </PanelIconButton>
      </div>
    </div>
  );
}
