"use client";

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import {
  CheckIcon,
  CircleAlertIcon,
  DownloadIcon,
  LibraryBigIcon,
  LocateFixedIcon,
  PauseIcon,
  RotateCcwIcon,
  SquareIcon,
  WandSparklesIcon,
} from "lucide-react";
import { useShallow } from "zustand/shallow";
import { MediaViewer, type MediaViewerAction, type MediaViewerItem } from "@/components/MediaViewer";
import { cn } from "@/components/agent/lib/utils";
import { assetFileUrl } from "@/lib/assets/client/api";
import { NODE_TITLES } from "@/lib/nodes/handles";
import { MAX_RUN_OUTPUTS, chatRunBlockedReason, nodeTextOutputs, rerunChatRun, stopChatRun, useLatestRun } from "@/lib/agent/client/runs";
import type { AgentRunOutput, AgentRunRecord, AgentRunStatus } from "@/lib/agent/types";
import { useAssetStore } from "@/store/assetStore";
import { useWorkflowStore, type WorkflowStore } from "@/store/workflowStore";
import type { NodeType, WorkflowNode } from "@/types";
import { downloadMedia } from "@/utils/downloadMedia";
import { AGENT_ICON, InlineSpinner, StatusDot } from "./AgentChrome";
import { AgentAlert, AgentTextButton } from "./AgentNotice";
import {
  CardIconButton,
  outputFileSrc,
  PendingAudioRow,
  PendingTextCard,
  posterUrl,
  RunAudioRow,
  RunMediaGrid,
  RunTextCard,
  type PendingOutput,
  type RunVisual,
} from "./AgentRunMedia";
import { useAgentTranscriptActions } from "./AgentSession";
import { useAgentSurface } from "./AgentSurface";

/**
 * A chat-started run in the transcript: its status, batch progress and time,
 * then what it made as it arrives (skeletons for what is still coming), any
 * errors with a way to ask the agent to fix them, and a full-screen viewer
 * over its images and videos.
 */

const STATUS_LABELS: Record<AgentRunStatus, string> = {
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  paused: "Paused",
};

/** What a screen reader hears when a run it watched ends. */
const ENDED_LABELS: Record<Exclude<AgentRunStatus, "running">, string> = {
  done: "finished",
  failed: "failed",
  stopped: "stopped",
  paused: "paused",
};

/** Why a run in another tab waits: switching tabs mid-turn would stop the turn. */
export const AGENT_TURN_RUNNING = "Wait for the agent to finish";

const VISUAL_KINDS: ReadonlySet<AgentRunOutput["kind"]> = new Set(["image", "video", "model3d"]);

/** What each generator makes, for its skeleton while it runs. */
const GENERATOR_KINDS: Partial<Record<NodeType, AgentRunOutput["kind"]>> = {
  nanoBanana: "image",
  generateVideo: "video",
  generateAudio: "audio",
  generate3d: "model3d",
  llmGenerate: "text",
  comfyApp: "image",
};

/** 12s, 1m 05s, 1h 02m. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The node's title as the canvas shows it. */
export function nodeDisplayTitle(node: Pick<WorkflowNode, "type" | "data">): string {
  const title = (node.data as { customTitle?: unknown } | undefined)?.customTitle;
  return typeof title === "string" && title.trim() ? title.trim() : NODE_TITLES[node.type ?? ""] ?? String(node.type);
}

function nodeKind(node: WorkflowNode): AgentRunOutput["kind"] | undefined {
  if (node.type !== "comfyApp") return GENERATOR_KINDS[node.type as NodeType];
  const first = (node.data as { app?: { outputs?: Array<{ type?: string }> } | null }).app?.outputs?.[0]?.type;
  if (first === "3d") return "model3d";
  return first === "video" || first === "audio" || first === "text" ? first : "image";
}

/** "16:9" → 16/9. */
function parseAspect(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) return undefined;
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0 ? ratio : undefined;
}

/**
 * The outputs a running record still waits for: one per run of the batch for
 * each planned or started generator (text once: it is read when the run ends),
 * minus what has arrived. Once a long batch has dropped its oldest outputs,
 * only the current run's. Nodes that failed show in the errors instead.
 */
export function pendingOutputs(record: AgentRunRecord, state: Pick<WorkflowStore, "activeTabId" | "nodes">): PendingOutput[] {
  if (record.status !== "running" || state.activeTabId !== record.tabId) return [];
  const nodes = new Map(state.nodes.map((node) => [node.id, node] as const));
  // The record keeps the newest outputs only: past that, counting them says nothing about earlier runs.
  const capped = record.runs > 1 && record.outputs.length >= MAX_RUN_OUTPUTS;
  const current = record.progress.index - 1;
  const pending: PendingOutput[] = [];
  for (const id of new Set([...record.plannedNodeIds, ...record.ranNodeIds])) {
    const node = nodes.get(id);
    const kind = node ? nodeKind(node) : undefined;
    if (!node || !kind || (node.data as { status?: unknown }).status === "error") continue;
    const made = record.outputs.filter((output) => output.nodeId === id && output.kind === kind);
    const missing =
      kind === "text" ? 1 - made.length : capped ? Number(!made.some((output) => output.batchIndex === current)) : record.progress.index - made.length;
    const aspect = parseAspect((node.data as { aspectRatio?: unknown }).aspectRatio) ?? (kind === "video" ? 16 / 9 : undefined);
    for (let index = made.length; index < made.length + missing; index++) {
      pending.push({ key: `pending:${id}:${index}`, nodeId: id, nodeTitle: nodeDisplayTitle(node), kind, ...(aspect ? { aspect } : {}) });
    }
  }
  return pending;
}

const LIVE_FIELDS: Partial<Record<AgentRunOutput["kind"], string>> = {
  image: "outputImage",
  video: "outputVideo",
  audio: "outputAudio",
  model3d: "output3dUrl",
};
const NO_SOURCES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The nodes' own media for the record's outputs, by output id, while its tab
 * is open: what a live output shows, and what a missing library file falls
 * back to; and the whole of a shortened text while its node still holds it.
 * Strings only, so a shallow compare keeps the card still.
 */
export function liveSources(record: AgentRunRecord, state: Pick<WorkflowStore, "activeTabId" | "nodes">): Readonly<Record<string, string>> {
  if (state.activeTabId !== record.tabId) return NO_SOURCES;
  const nodes = new Map(state.nodes.map((node) => [node.id, node] as const));
  const sources: Record<string, string> = {};
  for (const output of record.outputs) {
    const node = nodes.get(output.nodeId);
    if (output.kind === "text") {
      // The node's text still starts with what the record kept (less its "…"): it is the same reply.
      const kept = output.truncated && output.text ? output.text.slice(0, -1) : undefined;
      const whole = kept && node ? nodeTextOutputs(node).find((text) => text.startsWith(kept)) : undefined;
      if (whole) sources[output.id] = whole;
      continue;
    }
    const field = LIVE_FIELDS[output.kind];
    const value = field ? (node?.data as Record<string, unknown> | undefined)?.[field] : undefined;
    if (typeof value === "string" && value) sources[output.id] = value;
  }
  return sources;
}

/**
 * The message "Ask the agent to fix it" sends: each failed node, by name and
 * id, with its error. `elsewhere`: the run's tab isn't the live one, so the
 * message names it for the agent to switch to.
 */
export function fixRequestMessage(record: AgentRunRecord, elsewhere = false): string {
  const tab = elsewhere ? ` (${record.tabId})` : "";
  const where = record.workflowName ? ` in "${record.workflowName}"${tab}` : elsewhere ? ` in an untitled workflow${tab}` : "";
  const lines = record.errors.map((error) => `- ${error.nodeTitle} (${error.nodeId}): ${error.message}`);
  return `The run "${record.label}"${where} failed:\n${lines.join("\n")}\nPlease fix it.`;
}

function viewerDetails(output: AgentRunOutput, record: AgentRunRecord): [string, string][] {
  const details: [string, string][] = [["Node", output.nodeTitle]];
  if (output.model) details.push(["Model", output.model]);
  if (record.runs > 1 && output.batchIndex !== undefined) details.push(["Run", `${output.batchIndex + 1} of ${record.runs}`]);
  return details;
}

/** Re-renders every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The status as a glyph; `silent` where the heading next to it already says it. */
function RunStatusIcon({ status, silent = false }: { status: AgentRunStatus; silent?: boolean }) {
  const icon = (() => {
    switch (status) {
      case "running":
        return <InlineSpinner className="size-4 text-neutral-300 motion-reduce:animate-none" />;
      case "done":
        return <CheckIcon {...AGENT_ICON} strokeWidth={2} className="size-4 text-neutral-300" />;
      case "failed":
        return <CircleAlertIcon {...AGENT_ICON} className="size-4 text-error" />;
      case "stopped":
        return <SquareIcon {...AGENT_ICON} className="size-3.5 text-neutral-400" />;
      case "paused":
        return <PauseIcon {...AGENT_ICON} className="size-4 text-neutral-400" />;
    }
  })();
  return (
    <span
      {...(silent ? { "aria-hidden": true } : { role: "img", "aria-label": STATUS_LABELS[status] })}
      data-run-status={status}
      className="flex size-4 shrink-0 items-center justify-center"
    >
      {icon}
    </span>
  );
}

export interface AgentRunResultsProps {
  record: AgentRunRecord;
  /** Inside an offer's card: no frame of its own, and the card's own button runs it again. */
  embedded?: boolean;
}

/** The results card for one run record. */
export function AgentRunResults({ record, embedded = false }: AgentRunResultsProps) {
  const transcript = useAgentTranscriptActions();
  const surface = useAgentSurface();
  const headingId = useId();
  const running = record.status === "running";

  const pendingKey = useWorkflowStore((state) => (running ? JSON.stringify(pendingOutputs(record, state)) : ""));
  const pending = useMemo<PendingOutput[]>(() => (pendingKey ? JSON.parse(pendingKey) : []), [pendingKey]);
  const sources = useWorkflowStore(useShallow((state) => liveSources(record, state)));
  // Only for this card's own Run again (an offer's card has its own button).
  const blocked = useWorkflowStore((state) =>
    embedded || running
      ? null
      : chatRunBlockedReason({ tabId: record.tabId, scope: record.scope, plannedNodeIds: record.plannedNodeIds }, state) ??
        (transcript?.busy && state.activeTabId !== record.tabId ? AGENT_TURN_RUNNING : null),
  );
  const stopMode = useWorkflowStore((state) =>
    !state.batch ? "now" : state.batch.stopping ? "stopping" : state.batch.index < state.batch.count ? "after" : "now",
  );

  const now = useNow(running);
  const elapsed = running ? now - record.startedAt : record.finishedAt !== undefined ? record.finishedAt - record.startedAt : undefined;
  const { index, count } = record.progress;
  const batchNote = count > 1 ? (running || index < count ? `Run ${index} of ${count}` : `${count} runs`) : null;
  // Inside an offer's card the card already names the run: the heading is the status.
  const heading = embedded ? STATUS_LABELS[record.status] : record.label;
  const statusNote = embedded || running || record.status === "done" ? null : STATUS_LABELS[record.status];
  const meta = [statusNote, batchNote, elapsed !== undefined ? formatElapsed(elapsed) : null].filter(Boolean).join(" · ");

  // Said once, politely, when a run this card watched ends (not for a record that was already over).
  const [watched, setWatched] = useState<string | null>(running ? record.id : null);
  if (running && watched !== record.id) setWatched(record.id);
  const announcement = !running && watched === record.id ? `${record.label} ${ENDED_LABELS[record.status as Exclude<AgentRunStatus, "running">]}` : "";

  const [note, setNote] = useState<{ id: string; text: string } | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const visual: RunVisual[] = [
    ...record.outputs.filter((output) => VISUAL_KINDS.has(output.kind)).map((output) => ({ key: output.id, output })),
    ...pending.filter((entry) => VISUAL_KINDS.has(entry.kind)).map((entry) => ({ key: entry.key, pending: entry })),
  ];
  const audio = record.outputs.filter((output) => output.kind === "audio");
  const texts = record.outputs.filter((output) => output.kind === "text");
  const pendingAudio = pending.filter((entry) => entry.kind === "audio");
  const pendingTexts = pending.filter((entry) => entry.kind === "text");
  const hasBody = visual.length + audio.length + texts.length + pendingAudio.length + pendingTexts.length + record.errors.length > 0;

  const viewerItems = useMemo<MediaViewerItem[]>(
    () =>
      record.outputs.flatMap((output) => {
        if (output.kind !== "image" && output.kind !== "video") return [];
        const src = outputFileSrc(output, sources[output.id]);
        if (!src) return [];
        const thumb = output.kind === "video" ? posterUrl(output) : undefined;
        return [
          {
            id: output.id,
            src,
            kind: output.kind,
            ...(thumb ? { thumb } : {}),
            title: output.prompt || output.nodeTitle,
            details: viewerDetails(output, record),
          },
        ];
      }),
    [record, sources],
  );
  const viewerIndex = viewing ? viewerItems.findIndex((item) => item.id === viewing) : -1;
  const viewed = viewerIndex >= 0 ? record.outputs.find((output) => output.id === viewing) : undefined;
  const closeViewer = () => setViewing(null);

  const nodesInView = record.ranNodeIds.length > 0 ? record.ranNodeIds : record.plannedNodeIds;
  const showNode = transcript
    ? (nodeId: string) => transcript.showOnCanvas({ tabId: record.tabId, nodeIds: [nodeId] })
    : undefined;

  const viewerActions: MediaViewerAction[] = viewed
    ? [
        {
          label: "Download",
          icon: DownloadIcon,
          shortcut: "d",
          onClick: () => {
            const src = viewed.assetId ? assetFileUrl(viewed.assetId, true) : sources[viewed.id];
            if (!src) return;
            downloadMedia(src, viewed.kind === "video" ? "video" : "image").catch((error) => console.error("Run output download failed:", error));
          },
        },
        ...(showNode
          ? [
              {
                label: "Show on canvas",
                icon: LocateFixedIcon,
                onClick: () => {
                  closeViewer();
                  showNode(viewed.nodeId);
                },
              },
            ]
          : []),
      ]
    : [];

  // The viewer is portalled, but its keys still bubble through this card to
  // the agent's surfaces, which keep every key and close on Escape: none would
  // reach the document, where the viewer listens. They end here, and the card
  // does what the viewer would: Escape closes, the arrows step, an action's shortcut (D) fires it.
  const keepViewerKeys = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeViewer();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    const action = viewerActions.find((entry) => entry.shortcut && !entry.disabled && entry.shortcut.toLowerCase() === event.key.toLowerCase());
    if (!step && !action) return;
    event.preventDefault();
    if (action) action.onClick();
    else if (viewerItems[viewerIndex + step]) setViewing(viewerItems[viewerIndex + step].id);
  };

  const runAgain = () => {
    const result = rerunChatRun(record);
    setNote(result.ok ? null : { id: record.id, text: result.reason });
  };
  const askToFix = () => {
    if (!transcript) return;
    const store = useWorkflowStore.getState();
    let elsewhere = record.tabId !== store.activeTabId && store.tabs.some((tab) => tab.id === record.tabId);
    // The agent works in the live tab: go to the run's first, unless that would stop a turn or a tab is busy.
    if (elsewhere && !transcript.busy && !store.tabsBusyReason() && store.switchTab(record.tabId)) elsewhere = false;
    if (transcript.send(fixRequestMessage(record, elsewhere))) setAsked(record.id);
  };

  const page = surface === "page";
  return (
    <section
      role="group"
      aria-labelledby={headingId}
      data-run-results={record.id}
      data-status={record.status}
      className={cn("flex flex-col", !embedded && "rounded-card squircle border border-white/[0.08] bg-white/[0.02]")}
    >
      {/* The same inset as the Run card's text; the icon buttons' own padding makes up the right side. */}
      <div className={cn("flex min-h-11 items-center gap-2 py-2", page ? "pr-2.5 pl-4" : "pr-2 pl-3.5")}>
        <RunStatusIcon status={record.status} silent={embedded} />
        <h3 id={headingId} className={cn("min-w-0 truncate font-medium text-neutral-100", page ? "text-sm leading-5" : "text-[13px] leading-5")}>
          {heading}
        </h3>
        {/* The transcript is a live log: the time ticks without being read out each second (the end is announced below). */}
        {meta && (
          <span aria-live="off" className="shrink-0 text-xs leading-4 tabular-nums text-ink-3">
            {meta}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {running && (
            <CardIconButton
              label={stopMode === "after" ? "Stop after this run" : stopMode === "stopping" ? "Stop now" : "Stop"}
              onClick={stopChatRun}
              className="[&_svg]:size-3"
            >
              {/* Filled, as the composer's stop: an outline square reads as a checkbox (and is the "stopped" status). */}
              <SquareIcon aria-hidden="true" strokeWidth={0} className="fill-current" />
            </CardIconButton>
          )}
          {transcript && (
            <CardIconButton label="Show on canvas" onClick={() => transcript.showOnCanvas({ tabId: record.tabId, nodeIds: nodesInView })}>
              <LocateFixedIcon {...AGENT_ICON} />
            </CardIconButton>
          )}
          {!running && !embedded && (
            <CardIconButton label="Run again" onClick={runAgain} disabledReason={blocked}>
              <RotateCcwIcon {...AGENT_ICON} />
            </CardIconButton>
          )}
        </div>
      </div>
      {note?.id === record.id && (
        <p role="alert" className={cn("-mt-1 flex items-center gap-2 pb-2 text-[11px] leading-4 text-neutral-300", page ? "px-4" : "px-3.5")}>
          <StatusDot tone="blocked" />
          {note.text}
        </p>
      )}

      {hasBody && (
        <div className="flex flex-col gap-1 border-t border-white/[0.06] p-1">
          <RunMediaGrid items={visual} liveSources={sources} surface={surface} onOpen={setViewing} onShowNode={showNode} />
          {audio.map((output) => (
            <RunAudioRow key={output.id} output={output} liveSrc={sources[output.id]} onShowNode={showNode} />
          ))}
          {pendingAudio.map((entry) => (
            <PendingAudioRow key={entry.key} pending={entry} />
          ))}
          {texts.map((output) => (
            <RunTextCard key={output.id} output={output} fullText={sources[output.id]} />
          ))}
          {pendingTexts.map((entry) => (
            <PendingTextCard key={entry.key} pending={entry} />
          ))}
          {record.errors.length > 0 && (
            <div className="px-2 py-1.5">
              <AgentAlert
                tone="danger"
                actions={
                  transcript ? (
                    <AgentTextButton onClick={askToFix} disabled={asked === record.id}>
                      <WandSparklesIcon aria-hidden="true" strokeWidth={1.75} />
                      {asked === record.id ? "Asked the agent" : "Ask the agent to fix it"}
                    </AgentTextButton>
                  ) : undefined
                }
              >
                {record.errors.length === 1 ? (
                  <ErrorLine {...record.errors[0]} />
                ) : (
                  <ul className="flex flex-col gap-1">
                    {record.errors.map((error) => (
                      <li key={error.nodeId}>
                        <ErrorLine {...error} />
                      </li>
                    ))}
                  </ul>
                )}
              </AgentAlert>
            </div>
          )}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="contents" onKeyDown={keepViewerKeys}>
        <MediaViewer
          open={viewerIndex >= 0}
          items={viewerItems}
          index={Math.max(0, viewerIndex)}
          onIndexChange={(next) => setViewing(viewerItems[next]?.id ?? null)}
          onClose={closeViewer}
          actions={viewerActions}
          label={record.label}
          footer={
            <button
              type="button"
              onClick={() => {
                closeViewer();
                useAssetStore.getState().setAppView("assets");
              }}
              className="flex h-7 items-center justify-center gap-2 rounded-md text-[11px] font-medium text-neutral-400 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
            >
              <LibraryBigIcon size={14} strokeWidth={1.75} />
              <span>Open in Assets</span>
            </button>
          }
        />
      </div>
    </section>
  );
}

function ErrorLine({ nodeTitle, message }: { nodeTitle: string; message: string }) {
  return (
    <>
      <span className="font-medium text-neutral-100">{nodeTitle}</span>: {message}
    </>
  );
}

/** Under a run_workflow call: the results of the run it started, once there is a record of it. */
export function AgentToolRunResults({ toolCallId }: { toolCallId: string }) {
  const record = useLatestRun({ toolCallId });
  return record ? <AgentRunResults record={record} /> : null;
}
