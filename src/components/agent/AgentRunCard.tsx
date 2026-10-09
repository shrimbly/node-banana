"use client";

import { Fragment, useId, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronsRightIcon,
  FastForwardIcon,
  LocateFixedIcon,
  MinusIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  RotateCcwIcon,
  SquareIcon,
} from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/agent/ui/dropdown-menu";
import { MenuDivider, menuItemClass, menuSurfaceClass } from "@/components/ui/Menu";
import { chatRunBlockedReason, startOfferRun, stopChatRun, useLatestRun } from "@/lib/agent/client/runs";
import type { AgentRunOffer, AgentRunOption } from "@/lib/agent/types";
import { MAX_RUN_COUNT, clampRunCount, type RunScope } from "@/store/utils/runBatch";
import { useWorkflowStore, type WorkflowStore } from "@/store/workflowStore";
import type { NodeType, SelectedModel, WorkflowNode } from "@/types";
import { calculatePredictedCost, formatCost, getModelCost, type ModelPricing } from "@/utils/costCalculator";
import { AGENT_POPOVER_LAYER, StatusDot } from "./AgentChrome";
import { nodeOutputHandle, TypeDot } from "./AgentRunMedia";
import { AGENT_TURN_RUNNING, AgentRunResults, nodeDisplayTitle, pendingOutputs, RunHeaderLine, runStopLabel, useRunSummary } from "./AgentRunResults";
import { useAgentTranscriptActions } from "./AgentSession";

/**
 * The chat's Run button (a `data-run-offer` part): one frameless line naming
 * what it runs, its nodes (alike ones counted once) and the estimated cost,
 * beside a split Run button whose menu holds the run count, the other ways to
 * run and Show on canvas, as the canvas's Run menu does. Once run, the line
 * says how the run went, the button (now quiet) stops it or runs it again,
 * and the previews follow in a row under it.
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

/** The offer's nodes as the line names them: alike ones (same title and output) counted once, in run order. */
export function groupOfferNodes(nodes: OfferTarget["nodes"]): Array<{ title: string; handle: string; count: number }> {
  const groups = new Map<string, { title: string; handle: string; count: number }>();
  for (const node of nodes) {
    const key = `${node.handle}:${node.title}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { title: node.title, handle: node.handle, count: 1 });
  }
  return [...groups.values()];
}

/** What the offer would run, as the canvas has it now. */
export interface OfferTarget {
  /** Its tab is the live one. */
  live: boolean;
  /** Its tab is still open. */
  open: boolean;
  workflowName?: string;
  /** Its place in the tab strip (from 1), when another open tab goes by the same name. */
  tabNumber?: number;
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
  state: Pick<WorkflowStore, "activeTabId" | "tabs" | "nodes" | "groups" | "workflowName">,
): OfferTarget {
  const live = !offer.tabId || offer.tabId === state.activeTabId;
  const source = live ? state : state.tabs.find((tab) => tab.id === offer.tabId)?.snapshot;
  if (!source) {
    return { live: false, open: false, ...(offer.workflowName ? { workflowName: offer.workflowName } : {}), nodes: [], generators: 0, cost: null };
  }
  const byId = new Map(source.nodes.map((node) => [node.id, node] as const));
  let present = option.nodeIds.map((id) => byId.get(id)).filter((node): node is WorkflowNode => node !== undefined);
  // The whole workflow runs what the tab holds now, nodes added since the offer too (none of
  // the offered ones left: another workflow, which it won't run). A locked group's nodes don't run.
  if (option.scope.kind === "all" && present.length > 0) {
    const runs = (node: WorkflowNode) => !(node.groupId && source.groups[node.groupId]?.locked);
    const offered = new Set(option.nodeIds);
    present = [...present, ...source.nodes.filter((node) => !offered.has(node.id))].filter(runs);
  }
  const generators = present.filter((node) => GENERATOR_TYPES.has(node.type ?? "")).length;
  const workflowName = source.workflowName ?? offer.workflowName;
  // Every new tab is "Untitled": a name another open tab shares needs the tab's place to say which it is.
  const shown = (name: string | null | undefined) => name?.trim() || "Untitled";
  const index = state.tabs.findIndex((tab) => tab.id === offer.tabId);
  const shared =
    !live &&
    state.tabs.some((tab, at) => at !== index && shown(tab.id === state.activeTabId ? state.workflowName : tab.snapshot?.workflowName) === shown(workflowName));
  return {
    live,
    open: true,
    ...(workflowName ? { workflowName } : {}),
    ...(shared ? { tabNumber: index + 1 } : {}),
    nodes: present.map((node) => ({ id: node.id, title: nodeDisplayTitle(node), handle: nodeOutputHandle(node.type ?? "") })),
    generators,
    cost: estimateRunCost(present, generators),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Rows of the alternatives menu: the Instrument menu's 28px items (as the header's harness menu). */
const MENU_ROW = cn(
  menuItemClass,
  "relative cursor-default rounded-none outline-none select-none",
  "focus:bg-neutral-700 focus:text-neutral-100 data-highlighted:bg-neutral-700 data-highlighted:text-neutral-100",
  "data-disabled:pointer-events-none data-disabled:opacity-30",
);

/** The run count's steps: 22px squares in a well, as MenuStepper's. */
const STEP = cn(
  "flex size-[22px] cursor-default items-center justify-center rounded-[6px] p-0 text-neutral-400 outline-none",
  "data-highlighted:bg-white/8 data-highlighted:text-neutral-100 data-disabled:pointer-events-none data-disabled:opacity-30",
);

/**
 * The ink half of the split button, and the chevron beside it. Held, the
 * main half stays focusable (aria-disabled) so it can say why; the chevron
 * still opens its menu (the run count, Show on canvas), with the other ways
 * to run held there.
 */
/** Each way to run with the canvas Run menu's icon for it: the whole workflow, from a node, or a set of nodes. */
function OptionIcon({ scope }: { scope: RunScope }) {
  const Icon = scope.kind === "all" ? PlayIcon : scope.kind === "from" ? ChevronsRightIcon : FastForwardIcon;
  return <Icon aria-hidden="true" strokeWidth={2} className="size-3.5" />;
}

/** The quiet split button's halves, once the offer has run. */
const QUIET_HALF = cn(
  "flex items-center transition-colors duration-[120ms] hover:bg-white/[0.09] hover:text-neutral-100",
  "aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:bg-transparent",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selection",
);

const SPLIT_HALF = cn(
  "flex items-center transition-colors duration-[120ms] hover:bg-[#ededed]",
  "disabled:cursor-not-allowed disabled:hover:bg-transparent aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-selection",
);

export function AgentRunCard({ offer }: { offer: AgentRunOffer }) {
  const transcript = useAgentTranscriptActions();
  const titleId = useId();
  const reasonId = useId();
  const record = useLatestRun({ offerId: offer.offerId });
  const options = useMemo(() => [offer.primary, ...offer.alternatives], [offer]);
  // After a run, the main button runs that option again; the menu has the rest. By label: a run that found
  // some of its nodes gone ran (and recorded) a narrower scope than its option names.
  const current = (record && options.find((option) => option.label === record.label)) || offer.primary;
  const others = options.filter((option) => option !== current);

  const targetKey = useWorkflowStore((state) => JSON.stringify(describeOfferTarget(offer, current, state)));
  const target = useMemo<OfferTarget>(() => JSON.parse(targetKey), [targetKey]);
  // Each option on its own: one whose nodes are gone leaves the others runnable.
  const reasonsKey = useWorkflowStore((state) =>
    JSON.stringify(
      options.map((option) =>
        chatRunBlockedReason(
          {
            ...(offer.tabId ? { tabId: offer.tabId } : {}),
            scope: option.scope,
            plannedNodeIds: option.nodeIds,
            ...(offer.workflowId ? { workflowId: offer.workflowId } : {}),
          },
          state,
        ),
      ),
    ),
  );
  const reasons = useMemo<Array<string | null>>(() => JSON.parse(reasonsKey), [reasonsKey]);
  const blockedFor = (option: AgentRunOption) =>
    reasons[options.indexOf(option)] ?? (!target.live && transcript?.busy ? AGENT_TURN_RUNNING : null);
  const blocked = blockedFor(current);
  const [runs, setRuns] = useState(1);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (option: AgentRunOption) => {
    if (!transcript) return;
    const result = startOfferRun({ chatId: transcript.chatId, offer, option, runs });
    setFailure(result.ok ? null : result.reason);
  };

  const name = `${target.workflowName || "Untitled"}${target.tabNumber ? ` (tab ${target.tabNumber})` : ""}`;
  const runningHere = record?.status === "running";
  const stopLabel = useWorkflowStore(runStopLabel);
  const expected = useWorkflowStore((state) => (record && runningHere ? pendingOutputs(record, state).length : 0));
  const runSummary = useRunSummary(record, expected);
  const times = runs > 1 ? ` ×${runs}` : "";
  const buttonText = runningHere ? "Stop" : `${record ? "Run again" : "Run"}${times}`;
  // The button stays short; its name says where and how often.
  const buttonName = runningHere
    ? stopLabel
    : `${record ? "Run again" : "Run"}${target.live ? "" : ` in ${name}`}${runs > 1 ? `, ${runs} runs` : ""}`;
  const groups = groupOfferNodes(target.nodes);
  const nodeCount = target.open ? target.nodes.length : current.nodeIds.length;
  const cost = target.cost !== null ? `≈ ${formatCost(target.cost * runs)}` : null;
  // A run this card started is going: its status says so, and the button stops it.
  const reason = blocked && !runningHere ? blocked : null;
  // Before its first run the button is the call to action (ink); after, it is quiet.
  const ink = !record;
  const held = !!reason;
  const nodesForCanvas = record ? (record.ranNodeIds.length > 0 ? record.ranNodeIds : record.plannedNodeIds) : current.nodeIds;

  const offerSummary = (
    <span title={target.nodes.map((node) => node.title).join(", ") || undefined}>
      {!target.live && <>In {name} · </>}
      {groups.length > 0
        ? groups.map((group, index) => (
            <Fragment key={`${group.handle}:${group.title}`}>
              {index > 0 && " · "}
              <TypeDot handle={group.handle} className="mr-1.5 mb-px align-middle" />
              {group.title}
              {group.count > 1 && <span className="tabular-nums"> ×{group.count}</span>}
            </Fragment>
          ))
        : plural(nodeCount, "node")}
    </span>
  );

  return (
    <section role="group" aria-labelledby={titleId} data-run-offer={offer.offerId} className="flex flex-col gap-2.5">
      <RunHeaderLine
        headingId={titleId}
        status={record?.status}
        title={current.label}
        summary={record ? runSummary : offerSummary}
        trailing={!record && cost ? <span className="shrink-0 tabular-nums text-ink-3">{cost}</span> : undefined}
        actions={
          transcript && (
            <div
              className={cn(
                "flex h-7 min-w-0 items-stretch overflow-hidden rounded-[7px] text-xs",
                ink
                  ? cn("font-display text-[13px] font-semibold tracking-[-0.01em]", held ? "bg-white/8 text-neutral-500" : "bg-neutral-200 text-neutral-900")
                  : "bg-white/[0.05] text-neutral-300",
              )}
            >
              <button
                type="button"
                aria-label={buttonName}
                title={buttonName === buttonText ? undefined : buttonName}
                aria-disabled={held ? true : undefined}
                aria-describedby={reason && !failure ? reasonId : undefined}
                onClick={runningHere ? stopChatRun : held ? undefined : () => run(current)}
                className={cn(ink ? SPLIT_HALF : QUIET_HALF, "min-w-0 gap-1.5 pr-2.5 pl-2.5")}
              >
                {runningHere ? (
                  <SquareIcon aria-hidden="true" strokeWidth={0} fill="currentColor" className="size-3 shrink-0" />
                ) : record ? (
                  <RotateCcwIcon aria-hidden="true" strokeWidth={1.75} className="size-3.5 shrink-0" />
                ) : (
                  <PlayIcon aria-hidden="true" strokeWidth={0} fill="currentColor" className="size-3 shrink-0" />
                )}
                <span className="truncate">{buttonText}</span>
              </button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                  aria-label="Run options"
                  className={cn(
                    ink ? SPLIT_HALF : QUIET_HALF,
                    "w-7 shrink-0 justify-center border-l",
                    ink
                      ? held
                        ? "border-white/10 hover:bg-white/10 data-[state=open]:bg-white/10"
                        : "border-black/10 data-[state=open]:bg-[#e0e0e0]"
                      : "border-white/[0.06] data-[state=open]:bg-white/[0.1]",
                  )}
                >
                  <ChevronDownIcon aria-hidden="true" strokeWidth={2} className="size-3.5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  sideOffset={6}
                  className={cn(
                    menuSurfaceClass,
                    AGENT_POPOVER_LAYER,
                    "w-auto min-w-[220px] max-w-[min(20rem,calc(100vw-2rem))] bg-card px-0 py-1 text-neutral-300 shadow-menu ring-0",
                  )}
                >
                  {/* The canvas's Run menu, row for row: the other ways to run, then the run count. */}
                  {others.map((option) => (
                    <DropdownMenuItem
                      key={`${option.label}:${JSON.stringify(option.scope)}`}
                      disabled={!!blockedFor(option)}
                      className={MENU_ROW}
                      onSelect={() => run(option)}
                    >
                      <OptionIcon scope={option.scope} />
                      <span className="min-w-0 truncate">{option.label}</span>
                      <span className="ml-auto shrink-0 pl-3 tabular-nums text-neutral-500">{plural(option.nodeIds.length, "node")}</span>
                    </DropdownMenuItem>
                  ))}
                  {record && (
                    <DropdownMenuItem
                      className={MENU_ROW}
                      onSelect={() => transcript.showOnCanvas({ ...(offer.tabId ? { tabId: offer.tabId } : {}), nodeIds: nodesForCanvas })}
                    >
                      <LocateFixedIcon aria-hidden="true" strokeWidth={2} className="size-3.5" />
                      Show on canvas
                    </DropdownMenuItem>
                  )}
                  {(others.length > 0 || record) && <MenuDivider className="my-1" />}
                  {/* Its steps are menu items, so the arrow keys reach them; they keep the menu open. */}
                  <div className="flex min-h-7 items-center gap-2 px-2.5 py-1 text-xs text-neutral-300">
                    <RepeatIcon aria-hidden="true" strokeWidth={2} className="size-3.5 shrink-0" />
                    <span>Runs</span>
                    <span role="group" aria-label="Runs" className="ml-auto inline-flex h-[22px] items-center rounded-[6px] bg-well shadow-well">
                      <DropdownMenuItem
                        aria-label="Fewer runs"
                        disabled={runs <= 1 || runningHere}
                        onSelect={(event) => {
                          event.preventDefault();
                          setRuns((count) => clampRunCount(count - 1));
                        }}
                        className={STEP}
                      >
                        <MinusIcon aria-hidden="true" strokeWidth={2} className="size-3" />
                      </DropdownMenuItem>
                      <output aria-live="polite" className="min-w-7 text-center font-mono text-[11px] tabular-nums text-neutral-100">
                        {runs}
                      </output>
                      <DropdownMenuItem
                        aria-label="More runs"
                        disabled={runs >= MAX_RUN_COUNT || runningHere}
                        onSelect={(event) => {
                          event.preventDefault();
                          setRuns((count) => clampRunCount(count + 1));
                        }}
                        className={STEP}
                      >
                        <PlusIcon aria-hidden="true" strokeWidth={2} className="size-3" />
                      </DropdownMenuItem>
                    </span>
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        }
      />

      {transcript && (failure || reason) && (
        <div className="-mt-1.5 flex justify-end">
          {failure ? (
            <p role="alert" className="flex items-center gap-2 text-[11px] leading-4 text-neutral-300">
              <StatusDot tone="blocked" />
              {failure}
            </p>
          ) : (
            <p id={reasonId} className="text-[11px] leading-4 text-ink-3">
              {reason}
            </p>
          )}
        </div>
      )}

      {record && <AgentRunResults record={record} embedded />}
    </section>
  );
}
