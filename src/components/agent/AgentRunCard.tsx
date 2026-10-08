"use client";

import { useId, useMemo, useState } from "react";
import { ChevronDownIcon, PlayIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/agent/ui/dropdown-menu";
import { MenuSectionLabel, MenuStepper, menuItemClass, menuSurfaceClass } from "@/components/ui/Menu";
import { chatRunBlockedReason, startOfferRun, useLatestRun } from "@/lib/agent/client/runs";
import type { AgentRunOffer, AgentRunOption } from "@/lib/agent/types";
import { MAX_RUN_COUNT, clampRunCount, type RunScope } from "@/store/utils/runBatch";
import { useWorkflowStore, type WorkflowStore } from "@/store/workflowStore";
import type { NodeType, SelectedModel, WorkflowNode } from "@/types";
import { calculatePredictedCost, formatCost, getModelCost, type ModelPricing } from "@/utils/costCalculator";
import { AGENT_POPOVER_LAYER, StatusDot } from "./AgentChrome";
import { nodeOutputHandle, TypeDot } from "./AgentRunMedia";
import { AGENT_TURN_RUNNING, AgentRunResults, nodeDisplayTitle } from "./AgentRunResults";
import { useAgentTranscriptActions } from "./AgentSession";
import { useAgentSurface } from "./AgentSurface";

/**
 * The chat's Run button (a `data-run-offer` part): what the turn built or
 * changed, ready to run, with how many nodes and generators it touches and
 * what it should cost. Once run, the run's results show inside it.
 */

/** The node types that make something (the server's run offers count the same ones). */
const GENERATOR_TYPES: ReadonlySet<string> = new Set<NodeType>([
  "nanoBanana",
  "generateVideo",
  "generate3d",
  "generateAudio",
  "llmGenerate",
  "comfyApp",
]);

/** Chips shown before "+N". */
const MAX_CHIPS = 6;

/** What the offer would run, as the canvas has it now. */
export interface OfferTarget {
  /** Its tab is the live one. */
  live: boolean;
  /** Its tab is still open. */
  open: boolean;
  workflowName?: string;
  /** The option's nodes still on the canvas, in run order. */
  nodes: Array<{ id: string; title: string; handle: string }>;
  generators: number;
  /** One run's estimated cost, when the price of every generator in it is known. */
  cost: number | null;
}

/**
 * The estimate only counts image and video generators, and video priced per
 * second has no length yet: anything else in the run makes the sum a guess,
 * so there is none.
 */
export function estimateRunCost(nodes: WorkflowNode[], generators: number): number | null {
  if (generators === 0) return null;
  const pricing = new Map<string, ModelPricing>();
  for (const node of nodes) {
    const selected = (node.data as { selectedModel?: SelectedModel }).selectedModel;
    const price = getModelCost(selected?.pricing);
    if (selected && price) pricing.set(selected.modelId, price);
  }
  const estimate = calculatePredictedCost(nodes, pricing);
  if (estimate.nodeCount !== generators || estimate.unknownPricingCount > 0) return null;
  if (estimate.breakdown.some((item) => item.unit === "second")) return null;
  return estimate.totalCost > 0 ? estimate.totalCost : null;
}

export function describeOfferTarget(
  offer: AgentRunOffer,
  option: AgentRunOption,
  state: Pick<WorkflowStore, "activeTabId" | "tabs" | "nodes" | "workflowName">,
): OfferTarget {
  const live = !offer.tabId || offer.tabId === state.activeTabId;
  const source = live ? state : state.tabs.find((tab) => tab.id === offer.tabId)?.snapshot;
  if (!source) {
    return { live: false, open: false, ...(offer.workflowName ? { workflowName: offer.workflowName } : {}), nodes: [], generators: 0, cost: null };
  }
  const byId = new Map(source.nodes.map((node) => [node.id, node] as const));
  const present = option.nodeIds.map((id) => byId.get(id)).filter((node): node is WorkflowNode => node !== undefined);
  const generators = present.filter((node) => GENERATOR_TYPES.has(node.type ?? "")).length;
  const workflowName = source.workflowName ?? offer.workflowName;
  return {
    live,
    open: true,
    ...(workflowName ? { workflowName } : {}),
    nodes: present.map((node) => ({ id: node.id, title: nodeDisplayTitle(node), handle: nodeOutputHandle(node.type ?? "") })),
    generators,
    cost: estimateRunCost(present, generators),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function sameScope(a: RunScope, b: RunScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Rows of the alternatives menu: the Instrument menu's 28px items (as the header's harness menu). */
const MENU_ROW = cn(
  menuItemClass,
  "relative cursor-default rounded-sm outline-none select-none",
  "focus:bg-neutral-700 focus:text-neutral-100 data-highlighted:bg-neutral-700 data-highlighted:text-neutral-100",
  "data-disabled:pointer-events-none data-disabled:opacity-30",
);

/** The ink half of the split button, and the chevron beside it. */
const SPLIT_HALF = cn(
  "flex items-center transition-colors duration-[120ms] enabled:hover:bg-[#ededed] disabled:cursor-not-allowed",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selection",
);

export function AgentRunCard({ offer }: { offer: AgentRunOffer }) {
  const transcript = useAgentTranscriptActions();
  const surface = useAgentSurface();
  const titleId = useId();
  const record = useLatestRun({ offerId: offer.offerId });
  const options = useMemo(() => [offer.primary, ...offer.alternatives], [offer]);
  // After a run, the main button runs that option again; the menu has the rest.
  const current = (record && options.find((option) => option.label === record.label && sameScope(option.scope, record.scope))) || offer.primary;
  const others = options.filter((option) => option !== current);

  const targetKey = useWorkflowStore((state) => JSON.stringify(describeOfferTarget(offer, current, state)));
  const target = useMemo<OfferTarget>(() => JSON.parse(targetKey), [targetKey]);
  const storeBlocked = useWorkflowStore((state) =>
    chatRunBlockedReason(offer.tabId ? { tabId: offer.tabId, scope: current.scope } : { scope: current.scope }, state),
  );
  const blocked = storeBlocked ?? (!target.live && transcript?.busy ? AGENT_TURN_RUNNING : null);
  const [runs, setRuns] = useState(1);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (option: AgentRunOption) => {
    if (!transcript) return;
    const result = startOfferRun({ chatId: transcript.chatId, offer, option, runs });
    setFailure(result.ok ? null : result.reason);
  };

  const name = target.workflowName || "Untitled";
  const elsewhere = target.live ? "" : ` in ${name}`;
  const buttonLabel = `${record ? "Run again" : "Run"}${elsewhere}`;
  const nodeCount = target.open ? target.nodes.length : current.nodeIds.length;
  const meta = [
    plural(nodeCount, "node"),
    target.open ? plural(target.generators, "generator") : null,
    target.cost !== null ? `≈ ${formatCost(target.cost * runs)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // A run this card started is going: its results say so, and Stop is up there.
  const reason = blocked && record?.status !== "running" ? blocked : null;
  const page = surface === "page";
  const inset = page ? "px-4" : "px-3.5";

  return (
    <section
      role="group"
      aria-labelledby={titleId}
      data-run-offer={offer.offerId}
      className="flex flex-col rounded-card squircle border border-white/[0.08] bg-white/[0.02]"
    >
      <div className={cn(inset, page ? "pt-3.5 pb-3.5" : "pt-3 pb-3")}>
        <p className="truncate font-mono text-[10px] leading-4 uppercase tracking-eyebrow text-ink-3">
          Ready to run{target.live ? "" : ` · In ${name}`}
        </p>
        <h3
          id={titleId}
          className={cn(
            "mt-1 truncate font-display font-semibold tracking-[-0.01em] text-neutral-100",
            page ? "text-base leading-6" : "text-[15px] leading-5",
          )}
        >
          {current.label}
        </h3>
        <p className="mt-0.5 text-xs leading-4 tabular-nums text-ink-3">{meta}</p>
        {target.nodes.length > 0 && (
          <ul aria-label="Nodes it runs" className="mt-2.5 flex flex-wrap gap-1">
            {target.nodes.slice(0, MAX_CHIPS).map((node) => (
              <li
                key={node.id}
                title={node.title}
                className="flex h-6 max-w-44 items-center gap-1.5 rounded-md bg-white/[0.05] px-2 text-[11px] leading-4 text-neutral-300"
              >
                <TypeDot handle={node.handle} />
                <span className="truncate">{node.title}</span>
              </li>
            ))}
            {target.nodes.length > MAX_CHIPS && (
              <li
                aria-label={`and ${target.nodes.length - MAX_CHIPS} more`}
                title={target.nodes.slice(MAX_CHIPS).map((node) => node.title).join(", ")}
                className="flex h-6 items-center rounded-md bg-white/[0.05] px-2 text-[11px] leading-4 tabular-nums text-ink-3"
              >
                +{target.nodes.length - MAX_CHIPS}
              </li>
            )}
          </ul>
        )}
      </div>

      {record && (
        <div className="border-t border-white/[0.06]">
          <AgentRunResults record={record} embedded />
        </div>
      )}

      {transcript && (
        <div className={cn("flex flex-col gap-2 border-t border-white/[0.06] py-2.5", inset)}>
          <div className="flex items-center gap-3">
            <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
              <span aria-hidden="true">Runs</span>
              <MenuStepper
                label="Runs"
                value={runs}
                min={1}
                max={MAX_RUN_COUNT}
                onChange={(next) => setRuns(clampRunCount(next))}
                className="ml-0"
              />
            </div>
            <div
              className={cn(
                "ml-auto flex h-8 min-w-0 items-stretch overflow-hidden rounded-lg squircle font-display text-[13px] font-semibold tracking-[-0.01em]",
                blocked ? "bg-white/8 text-neutral-500" : "bg-neutral-200 text-neutral-900",
              )}
            >
              <button type="button" disabled={!!blocked} onClick={() => run(current)} className={cn(SPLIT_HALF, "min-w-0 gap-1.5 pr-3.5 pl-3")}>
                {record ? (
                  <RotateCcwIcon aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
                ) : (
                  <PlayIcon aria-hidden="true" strokeWidth={0} fill="currentColor" className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{buttonLabel}</span>
              </button>
              {others.length > 0 && (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger
                    disabled={!!blocked}
                    aria-label="Other ways to run"
                    className={cn(
                      SPLIT_HALF,
                      "w-7 shrink-0 justify-center border-l data-[state=open]:bg-[#e0e0e0]",
                      blocked ? "border-white/10" : "border-black/10",
                    )}
                  >
                    <ChevronDownIcon aria-hidden="true" strokeWidth={2.25} className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    sideOffset={6}
                    className={cn(
                      menuSurfaceClass,
                      AGENT_POPOVER_LAYER,
                      "w-auto min-w-56 max-w-[min(20rem,calc(100vw-2rem))] bg-card p-1 text-neutral-300 shadow-menu ring-0",
                    )}
                  >
                    <MenuSectionLabel className="px-2.5 pt-1.5 pb-1">Run instead</MenuSectionLabel>
                    {others.map((option) => (
                      <DropdownMenuItem key={`${option.label}:${JSON.stringify(option.scope)}`} className={MENU_ROW} onSelect={() => run(option)}>
                        <PlayIcon aria-hidden="true" strokeWidth={0} fill="currentColor" className="size-3 shrink-0 text-neutral-400" />
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        <span className="shrink-0 pl-3 font-mono text-[11px] tabular-nums text-ink-3">{plural(option.nodeIds.length, "node")}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          </div>
          {failure ? (
            <p role="alert" className="flex items-center gap-2 text-[11px] leading-4 text-neutral-300">
              <StatusDot tone="blocked" />
              {failure}
            </p>
          ) : reason ? (
            <p className="text-right text-[11px] leading-4 text-ink-3">{reason}</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
