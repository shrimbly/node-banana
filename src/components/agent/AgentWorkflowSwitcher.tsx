"use client";

import { ChevronDownIcon, PlusIcon, WorkflowIcon } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useToast } from "@/components/Toast";
import { cn } from "@/components/agent/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/agent/ui/dropdown-menu";
import { MenuDivider, MenuSectionLabel, menuSurfaceClass } from "@/components/ui/Menu";
import { useWorkflowStore } from "@/store/workflowStore";
import { AGENT_ICON, AGENT_POPOVER_LAYER } from "./AgentChrome";
import { MENU_ROW, RowCheck } from "./AgentPanelHeader";

/** One open workflow, as the switcher lists it. */
export interface SwitcherTab {
  id: string;
  name: string | null;
  live: boolean;
  nodeCount: number;
  unsaved: boolean;
  saved: boolean;
}

/** "3 nodes · Unsaved", "1 node · Saved", "Empty". */
export function describeSwitcherTab(tab: Pick<SwitcherTab, "nodeCount" | "unsaved" | "saved">): string {
  const state = tab.unsaved ? "Unsaved" : tab.saved ? "Saved" : tab.nodeCount === 0 ? null : "Not saved";
  if (tab.nodeCount === 0 && !state) return "Empty";
  const count = tab.nodeCount === 1 ? "1 node" : `${tab.nodeCount} nodes`;
  return state ? `${count} · ${state}` : count;
}

/** Why the tabs can't change right now: a turn runs (a switch would stop it), or a run, save or media write holds them. */
function useTabsRefusal(busy: boolean): string | null {
  const held = useWorkflowStore((state) => state.isRunning || state.isSaving || state.pendingMediaSaves > 0);
  if (busy) return "Wait for the agent to finish";
  return held ? useWorkflowStore.getState().tabsBusyReason() : null;
}

/**
 * The chat view's workflow pill: the live tab's name (with the strip's unsaved
 * dot), opening every open workflow with its node count and saved state, and
 * "New workflow". The chat stays up; the agent's next turn works in the tab
 * picked here. Refused, with the reason, while a turn runs or the tabs are held.
 */
export function AgentWorkflowSwitcher({ busy }: { busy: boolean }) {
  const { tabs, activeTabId, workflowName, hasUnsavedChanges, saveDirectoryPath, nodeCount } = useWorkflowStore(
    useShallow((state) => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      workflowName: state.workflowName,
      hasUnsavedChanges: state.hasUnsavedChanges,
      saveDirectoryPath: state.saveDirectoryPath,
      nodeCount: state.nodes.length,
    })),
  );
  const refusal = useTabsRefusal(busy);

  const rows: SwitcherTab[] = tabs.map((tab) => {
    const live = tab.id === activeTabId;
    const parked = live ? null : tab.snapshot;
    return parked
      ? {
          id: tab.id,
          name: parked.workflowName,
          live,
          nodeCount: parked.nodes.length,
          unsaved: parked.hasUnsavedChanges,
          saved: parked.saveDirectoryPath !== null,
        }
      : { id: tab.id, name: workflowName, live, nodeCount, unsaved: hasUnsavedChanges, saved: saveDirectoryPath !== null };
  });

  // Checked again on the pick: the menu may have been open while a run started.
  const refuseNow = () => {
    const reason = busy ? "Wait for the agent to finish" : useWorkflowStore.getState().tabsBusyReason();
    if (reason) useToast.getState().show(reason, "warning");
    return reason !== null;
  };
  const pick = (id: string) => {
    if (id === useWorkflowStore.getState().activeTabId || refuseNow()) return;
    useWorkflowStore.getState().switchTab(id);
  };
  const openNew = () => {
    if (refuseNow()) return;
    useWorkflowStore.getState().newTab();
  };

  const name = workflowName ?? "Untitled";
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={`${name}${hasUnsavedChanges ? " (unsaved)" : ""}. Switch workflow`}
        className={cn(
          "flex h-8 min-w-0 max-w-[320px] items-center gap-2 rounded-lg squircle pl-2.5 pr-2 text-[13px] leading-4 outline-none",
          "transition-colors duration-[120ms] hover:bg-white/[0.06] data-[state=open]:bg-white/[0.08]",
          "focus-visible:ring-2 focus-visible:ring-selection",
        )}
      >
        <WorkflowIcon className="size-4 shrink-0 text-neutral-400" {...AGENT_ICON} />
        <span className={cn("truncate font-medium", workflowName ? "text-neutral-100" : "italic text-neutral-400")}>{name}</span>
        {hasUnsavedChanges && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-red-500" />}
        <ChevronDownIcon className="size-4 shrink-0 text-neutral-400" {...AGENT_ICON} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={6}
        className={cn(menuSurfaceClass, AGENT_POPOVER_LAYER, "w-72 bg-card p-1 text-neutral-300 shadow-menu ring-0")}
      >
        <MenuSectionLabel className="px-2.5 pb-1 pt-1.5">Open workflows</MenuSectionLabel>
        {refusal && <p className="px-2.5 pb-1 text-[11px] leading-4 text-ink-3">{refusal}</p>}
        <div className="max-h-[min(60vh,420px)] overflow-y-auto">
          {rows.map((row) => (
            <DropdownMenuItem
              key={row.id}
              disabled={!row.live && refusal !== null}
              aria-current={row.live || undefined}
              onSelect={() => pick(row.id)}
              className={cn(MENU_ROW, "py-1.5")}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={cn("truncate text-[13px] leading-5", row.name ? "text-neutral-100" : "italic text-neutral-400")}>
                  {row.name ?? "Untitled"}
                </span>
                <span className="truncate text-[11px] leading-4 text-ink-3">{describeSwitcherTab(row)}</span>
              </span>
              <RowCheck checked={row.live} />
            </DropdownMenuItem>
          ))}
        </div>
        <MenuDivider className="my-1 border-white/[0.08]" />
        <DropdownMenuItem disabled={refusal !== null} onSelect={openNew} className={MENU_ROW}>
          <PlusIcon className="size-3.5 shrink-0" {...AGENT_ICON} />
          <span className="flex-1">New workflow</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
