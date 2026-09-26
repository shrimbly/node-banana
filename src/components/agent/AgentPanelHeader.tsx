"use client";

import { CheckIcon, ChevronDownIcon, HistoryIcon, SquarePenIcon, XIcon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/agent/ui/dropdown-menu";
import { MenuDivider, MenuSectionLabel, menuItemClass, menuSurfaceClass } from "@/components/ui/Menu";
import { HARNESS_LABELS, readinessTone, type AgentReadiness } from "@/lib/agent/client/readiness";
import { AGENT_HARNESS_IDS, type AgentHarnessId, type AgentModelOption } from "@/lib/agent/types";
import { AGENT_ICON, AGENT_POPOVER_LAYER, PanelIconButton, StatusDot } from "./AgentChrome";
import { HarnessIcon } from "./HarnessIcon";

export interface AgentPanelHeaderProps {
  harness: AgentHarnessId;
  readiness: Record<AgentHarnessId, AgentReadiness>;
  /** Switching harness or model is locked while a turn runs. */
  switchDisabled: boolean;
  onHarnessChange: (harness: AgentHarnessId) => void;
  models: AgentModelOption[];
  model?: string;
  onModelChange: (model: string) => void;
  canStartNewChat: boolean;
  onNewChat: () => void;
  /** The history list is showing in place of the conversation. */
  historyOpen: boolean;
  onToggleHistory: () => void;
  onClose: () => void;
}

/** Something is wrong with the harness: the only state the header marks (ready and still-checking show nothing). */
function hasIssue(readiness: AgentReadiness): boolean {
  const tone = readinessTone(readiness);
  return tone === "attention" || tone === "blocked";
}

/** The right-hand note on each harness row: its plan when ready, otherwise what's wrong. */
function describeReadiness(readiness: AgentReadiness): string {
  switch (readiness.kind) {
    case "loading":
      return "Checking…";
    case "unavailable":
      return "Status unavailable";
    case "ready":
      return readiness.status.account?.plan ?? "";
    case "signing_in":
      return "Signing in…";
    case "signed_out":
    case "sign_in_failed":
      return "Not signed in";
    case "wrong_billing":
      return "API account";
    case "unconfirmed_billing":
      return "Unconfirmed";
    case "not_installed":
      return "Not available";
  }
}

/** Rows of the harness menu: the Instrument menu's 28px items, with a check on the chosen one. */
const MENU_ROW = cn(
  menuItemClass,
  "relative cursor-default rounded-sm outline-none select-none",
  "focus:bg-neutral-700 focus:text-neutral-100 data-highlighted:bg-neutral-700 data-highlighted:text-neutral-100",
  "data-disabled:pointer-events-none data-disabled:opacity-30",
  // Radix renders its own indicator slot; this row draws the check itself.
  "[&>span[data-slot=dropdown-menu-radio-item-indicator]]:hidden",
);

function RowCheck({ checked }: { checked: boolean }) {
  return checked ? (
    <CheckIcon className="size-3.5 shrink-0 text-neutral-200" strokeWidth={2} aria-hidden="true" />
  ) : (
    <span className="size-3.5 shrink-0" aria-hidden="true" />
  );
}

export function AgentPanelHeader({
  harness,
  readiness,
  switchDisabled,
  onHarnessChange,
  models,
  model,
  onModelChange,
  canStartNewChat,
  onNewChat,
  historyOpen,
  onToggleHistory,
  onClose,
}: AgentPanelHeaderProps) {
  const modelLabel = models.find((option) => option.id === model)?.label;
  const issue = hasIssue(readiness[harness]);
  const triggerLabel = [HARNESS_LABELS[harness], modelLabel].filter(Boolean).join(", ");

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b fade-rule px-1.5">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label={`${triggerLabel}${issue ? ` (${describeReadiness(readiness[harness])})` : ""}. Change agent or model`}
          className={cn(
            "flex h-7 min-w-0 items-center gap-1.5 rounded-lg squircle px-1.5 text-[13px] leading-4 outline-none",
            "transition-colors duration-[120ms] hover:bg-white/[0.06] data-[state=open]:bg-white/[0.08]",
            "focus-visible:ring-2 focus-visible:ring-selection",
          )}
        >
          <HarnessIcon harness={harness} />
          <span className="shrink-0 font-semibold text-neutral-100">{HARNESS_LABELS[harness]}</span>
          {issue && <StatusDot tone="blocked" />}
          {modelLabel && <span className="truncate text-neutral-400">{modelLabel}</span>}
          <ChevronDownIcon className="size-4 shrink-0 text-neutral-400" {...AGENT_ICON} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className={cn(
            menuSurfaceClass,
            AGENT_POPOVER_LAYER,
            "w-64 bg-card p-1 text-neutral-300 shadow-menu ring-0",
          )}
        >
          <MenuSectionLabel className="px-2.5 pb-1 pt-1.5">Run with</MenuSectionLabel>
          <DropdownMenuRadioGroup
            value={harness}
            onValueChange={(next) => onHarnessChange(next as AgentHarnessId)}
          >
            {AGENT_HARNESS_IDS.map((id) => {
              const note = switchDisabled && id !== harness ? "Stop the reply first" : describeReadiness(readiness[id]);
              return (
                <DropdownMenuRadioItem
                  key={id}
                  value={id}
                  disabled={switchDisabled && id !== harness}
                  aria-label={HARNESS_LABELS[id]}
                  className={MENU_ROW}
                >
                  <HarnessIcon harness={id} className="size-3.5" />
                  <span className="flex-1 truncate">{HARNESS_LABELS[id]}</span>
                  {hasIssue(readiness[id]) && <StatusDot tone="blocked" />}
                  {note && (
                    <span className="font-mono text-[10px] uppercase tracking-eyebrow text-ink-3">{note}</span>
                  )}
                  <RowCheck checked={id === harness} />
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
          {models.length > 0 && (
            <>
              <MenuDivider className="my-1 border-white/[0.08]" />
              <MenuSectionLabel className="px-2.5 pb-1 pt-1">Model</MenuSectionLabel>
              <DropdownMenuRadioGroup value={model} onValueChange={onModelChange}>
                {models.map((option) => (
                  <DropdownMenuRadioItem
                    key={option.id}
                    value={option.id}
                    disabled={switchDisabled}
                    title={option.description}
                    className={MENU_ROW}
                  >
                    <span className="flex-1 truncate">{option.label}</span>
                    <RowCheck checked={option.id === model} />
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex items-center gap-0.5">
        <PanelIconButton label={historyOpen ? "Back to chat" : "History"} onClick={onToggleHistory} open={historyOpen}>
          <HistoryIcon {...AGENT_ICON} />
        </PanelIconButton>
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
