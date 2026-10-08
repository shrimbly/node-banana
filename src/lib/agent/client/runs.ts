/**
 * The runs the chat started (the agent's run_workflow, or an offer's Run
 * button) and what came of them, for the chat's results cards.
 *
 * A record is followed while its run goes: the nodes that started, batch
 * progress, errors, and every asset the library recorded under the run's ids
 * (late uploads included, for a minute after it ends). Records hold ids and
 * text only, never media bytes: an output the library did not record is
 * marked `live` and shown from the node while its tab is open. They are kept
 * in localStorage (newest first, capped) and forgotten with their
 * conversation; a record still running when the page went away reads as
 * stopped.
 */

import { create } from "zustand";
import { onAssetRecorded } from "@/lib/assets/client/recorder";
import type { AssetView, RecordAssetResult } from "@/lib/assets/types";
import { NODE_TITLES } from "@/lib/nodes/handles";
import { useWorkflowStore, type WorkflowStore } from "@/store/workflowStore";
import { clampRunCount, type RunBatch, type RunScope } from "@/store/utils/runBatch";
import type { NodeType, WorkflowNode } from "@/types";
import type { AgentRunOffer, AgentRunOption, AgentRunOutput, AgentRunRecord, AgentRunStatus } from "../types";

export const AGENT_RUNS_KEY = "node-banana-agent-runs";
export const MAX_RUN_RECORDS = 100;
export const MAX_RUN_OUTPUTS = 24;
/** Characters of one text output kept in a record. */
export const RUN_TEXT_LIMIT = 4000;
const PROMPT_LIMIT = 1000;
/** Characters of JSON: the records share localStorage with the chat history and the app. */
const RUNS_BUDGET = 600_000;
/** Assets the recorder finishes uploading after the run ended still join its record for this long. */
export const LATE_ASSET_MS = 60_000;
const SAVE_DELAY_MS = 250;

export type AgentRunAnchor = AgentRunRecord["anchor"];

interface AgentRunsState {
  /** Newest first. */
  records: AgentRunRecord[];
}

export const useAgentRuns = create<AgentRunsState>(() => ({ records: loadAgentRuns() }));

/** The latest run shown at `anchor` (a run_workflow call, or an offer's card), if any. */
export function latestRunFor(records: readonly AgentRunRecord[], anchor: AgentRunAnchor | null | undefined): AgentRunRecord | undefined {
  const key = anchor ? anchorKey(anchor) : null;
  return key ? records.find((record) => anchorKey(record.anchor) === key) : undefined;
}

export function useLatestRun(anchor: AgentRunAnchor | null | undefined): AgentRunRecord | undefined {
  const key = anchor ? anchorKey(anchor) : null;
  return useAgentRuns((state) => (key ? state.records.find((record) => anchorKey(record.anchor) === key) : undefined));
}

function anchorKey(anchor: AgentRunAnchor): string {
  return "toolCallId" in anchor ? `tool:${anchor.toolCallId}` : `offer:${anchor.offerId}`;
}

// ---------------------------------------------------------------------------
// Starting runs
// ---------------------------------------------------------------------------

export type StartChatRunResult = { ok: true; record: AgentRunRecord } | { ok: false; reason: string };

export interface ChatRunTarget {
  /** The tab to run in; another tab is switched to first. Absent: the live tab. */
  tabId?: string;
  scope: RunScope;
  /**
   * The nodes it was planned for (an offer's nodeIds, a record's
   * plannedNodeIds): a whole-workflow run with none of them left is refused.
   */
  plannedNodeIds?: readonly string[];
}

export interface StartChatRunInput extends ChatRunTarget {
  chatId: string;
  anchor: AgentRunAnchor;
  label: string;
  runs: number;
  /** The nodes expected to run, for the card's placeholders; those no longer on the canvas are left out. */
  plannedNodeIds: string[];
}

const RUN_GOING = "Wait for the run to finish";
const TAB_CLOSED = "That workflow is no longer open";
const NODES_GONE = "The nodes it would run are no longer on the canvas";

/**
 * Why `target` can't run right now, or null: a run is going, its tab was
 * closed or can't be switched to yet, or what it would run is gone.
 */
export function chatRunBlockedReason(
  target: ChatRunTarget,
  state: Pick<WorkflowStore, "isRunning" | "batch" | "tabs" | "activeTabId" | "nodes" | "tabsBusyReason"> = useWorkflowStore.getState(),
): string | null {
  if (state.isRunning || state.batch) return RUN_GOING;
  const live = !target.tabId || target.tabId === state.activeTabId;
  let nodes = state.nodes;
  if (!live) {
    const tab = state.tabs.find((candidate) => candidate.id === target.tabId);
    if (!tab?.snapshot) return TAB_CLOSED;
    const busy = state.tabsBusyReason();
    if (busy) return busy;
    nodes = tab.snapshot.nodes;
  }
  return scopeOnCanvas(target.scope, nodes, target.plannedNodeIds) ? null : NODES_GONE;
}

/** The scope with the nodes no longer on the canvas left out; null when nothing of it is left. */
function scopeOnCanvas(scope: RunScope, nodes: readonly WorkflowNode[], plannedNodeIds: readonly string[] = []): RunScope | null {
  const present = new Set(nodes.map((node) => node.id));
  if (scope.kind === "all") {
    // None of the nodes it was planned for is left: what the tab holds now is another workflow.
    if (plannedNodeIds.length > 0 && !plannedNodeIds.some((id) => present.has(id))) return null;
    return nodes.length > 0 ? scope : null;
  }
  if (scope.kind === "from") return present.has(scope.nodeId) ? scope : null;
  const nodeIds = scope.nodeIds.filter((id) => present.has(id));
  return nodeIds.length > 0 ? { kind: "nodes", nodeIds } : null;
}

/**
 * The nodes a run of `scope` is expected to run on this canvas, for the
 * card's placeholders: `checked` (what the agent validated) when it sent it,
 * else every node outside a locked group for "all", the node and everything
 * it feeds for "from", the scope's own for "nodes". Only those on the canvas.
 */
export function plannedRunNodeIds(
  scope: RunScope,
  canvas: Pick<WorkflowStore, "nodes" | "edges" | "groups">,
  checked?: readonly string[],
): string[] {
  const present = new Set(canvas.nodes.map((node) => node.id));
  return (checked ?? scopeNodeIds(scope, canvas)).filter((id) => present.has(id));
}

function scopeNodeIds(scope: RunScope, { nodes, edges, groups }: Pick<WorkflowStore, "nodes" | "edges" | "groups">): readonly string[] {
  if (scope.kind === "nodes") return scope.nodeIds;
  const unlocked = (node: WorkflowNode) => !(node.groupId && groups[node.groupId]?.locked);
  if (scope.kind === "all") return nodes.filter(unlocked).map((node) => node.id);
  const reached = new Set([scope.nodeId]);
  const queue = [scope.nodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of edges) {
      if (edge.source !== id || edge.data?.isLoop || reached.has(edge.target)) continue;
      reached.add(edge.target);
      queue.push(edge.target);
    }
  }
  return nodes.filter((node) => reached.has(node.id) && unlocked(node)).map((node) => node.id);
}

/**
 * Starts a run from the chat (switching to its tab first when it is not the
 * live one) and records it under `anchor`. Run again is another call with
 * the same anchor: the card shows the newest record.
 */
export function startChatRun(input: StartChatRunInput): StartChatRunResult {
  const blocked = chatRunBlockedReason(input);
  if (blocked) return { ok: false, reason: blocked };
  if (input.tabId && input.tabId !== useWorkflowStore.getState().activeTabId) {
    const store = useWorkflowStore.getState();
    if (!store.switchTab(input.tabId)) return { ok: false, reason: store.tabsBusyReason() ?? TAB_CLOSED };
  }
  const store = useWorkflowStore.getState();
  const scope = scopeOnCanvas(input.scope, store.nodes, input.plannedNodeIds);
  if (!scope) return { ok: false, reason: NODES_GONE };
  const runs = clampRunCount(input.runs);
  void store.runBatch(scope, runs);
  const after = useWorkflowStore.getState();
  // The first run is going before runBatch first awaits; nothing running now means it was
  // refused (offline, nothing to run). A batch set up for it clears itself a moment later.
  if (!after.isRunning) return { ok: false, reason: "The run didn't start" };
  const present = new Set(store.nodes.map((node) => node.id));
  const record = trackStartedRun({
    chatId: input.chatId,
    anchor: input.anchor,
    label: input.label,
    scope,
    runs,
    tabId: after.activeTabId,
    plannedNodeIds: input.plannedNodeIds.filter((id) => present.has(id)),
  });
  return { ok: true, record };
}

/** An offer's Run button: `option` is its primary or one of its alternatives. */
export function startOfferRun({
  chatId,
  offer,
  option,
  runs,
}: {
  chatId: string;
  offer: AgentRunOffer;
  option: AgentRunOption;
  runs: number;
}): StartChatRunResult {
  return startChatRun({
    chatId,
    anchor: { offerId: offer.offerId },
    label: option.label,
    ...(offer.tabId ? { tabId: offer.tabId } : {}),
    scope: option.scope,
    runs,
    plannedNodeIds: option.nodeIds,
  });
}

/** Run a finished record's scope again, under the same anchor. */
export function rerunChatRun(record: AgentRunRecord, runs = record.runs): StartChatRunResult {
  return startChatRun({
    chatId: record.chatId,
    anchor: record.anchor,
    label: record.label,
    tabId: record.tabId,
    scope: record.scope,
    runs,
    plannedNodeIds: record.plannedNodeIds,
  });
}

/** The results card's Stop: as the Run button's (mid-batch the first press lets the current run finish). */
export function stopChatRun(): void {
  useWorkflowStore.getState().requestStop();
}

/** A conversation was deleted: its runs go with it. */
export function forgetChatRuns(chatId: string): void {
  for (const watcher of [...watchers.values()]) {
    if (watcher.chatId === chatId) disposeWatcher(watcher);
  }
  useAgentRuns.setState((state) => {
    const records = state.records.filter((record) => record.chatId !== chatId);
    return records.length === state.records.length ? state : { records };
  });
}

// ---------------------------------------------------------------------------
// Following a run
// ---------------------------------------------------------------------------

export interface TrackRunInput {
  chatId: string;
  anchor: AgentRunAnchor;
  label: string;
  scope: RunScope;
  runs: number;
  /** The tab the run goes in (the live one). */
  tabId: string;
  plannedNodeIds: string[];
}

/** Records a run that has just started on the live tab, and follows it until it ends. */
export function trackStartedRun(input: TrackRunInput): AgentRunRecord {
  const state = useWorkflowStore.getState();
  const runs = clampRunCount(input.runs);
  const record: AgentRunRecord = {
    id: newRecordId(),
    chatId: input.chatId,
    anchor: input.anchor,
    tabId: input.tabId,
    ...(state.workflowName ? { workflowName: state.workflowName } : {}),
    label: input.label,
    scope: input.scope,
    runs,
    startedAt: Date.now(),
    status: "running",
    progress: { index: state.batch?.index ?? 1, count: state.batch?.count ?? runs },
    plannedNodeIds: [...input.plannedNodeIds],
    ranNodeIds: [],
    outputs: [],
    errors: [],
  };
  useAgentRuns.setState((current) => ({ records: [record, ...current.records].slice(0, MAX_RUN_RECORDS) }));
  watch(record);
  return findRecord(record.id) ?? record;
}

interface Watcher {
  recordId: string;
  chatId: string;
  tabId: string;
  /** The run was seen going on its tab. */
  seen: boolean;
  /** Asset run ids, one per run of the batch, in order. */
  runIds: string[];
  /** Each node's status as last seen, to notice it change. */
  statuses: Map<string, unknown>;
  nodes: WorkflowNode[] | null;
  controller: AbortController | null;
  lastBatch: RunBatch | null;
  stopRequested: boolean;
  /** The canvas's pause point as last seen; a run of selected nodes leaves an earlier one in place. */
  pausedAt: string | null;
  /** The run paused at a pause edge while it was followed. */
  paused: boolean;
  leftTab: boolean;
  finalized: boolean;
  unsubscribeStore: (() => void) | null;
  unsubscribeAssets: (() => void) | null;
  lateTimer: ReturnType<typeof setTimeout> | null;
}

const watchers = new Map<string, Watcher>();

function watch(record: AgentRunRecord): void {
  const state = useWorkflowStore.getState();
  const watcher: Watcher = {
    recordId: record.id,
    chatId: record.chatId,
    tabId: record.tabId,
    seen: false,
    runIds: [],
    statuses: new Map(),
    nodes: null,
    controller: null,
    lastBatch: null,
    stopRequested: false,
    pausedAt: state.pausedAtNodeId,
    paused: false,
    leftTab: false,
    finalized: false,
    unsubscribeStore: null,
    unsubscribeAssets: null,
    lateTimer: null,
  };
  if (state.activeTabId === record.tabId) {
    watcher.nodes = state.nodes;
    for (const node of state.nodes) watcher.statuses.set(node.id, nodeData(node).status);
  }
  watchers.set(record.id, watcher);
  watcher.unsubscribeAssets = onAssetRecorded((result) => attachAsset(watcher, result));
  // Read the store afresh on every change: its own subscriber (closing the asset run) sets state from inside a notification.
  watcher.unsubscribeStore = useWorkflowStore.subscribe(() => observe(watcher));
  observe(watcher);
}

function observe(watcher: Watcher): void {
  if (watcher.finalized) return;
  const state = useWorkflowStore.getState();
  const onTab = state.activeTabId === watcher.tabId;
  const going = onTab && (state.isRunning || state.batch !== null);
  if (!onTab) watcher.leftTab = true;
  if (going) {
    watcher.seen = true;
    if (state._abortController) watcher.controller = state._abortController;
    const runId = state._currentRun?.run.runId;
    if (runId && !watcher.runIds.includes(runId)) watcher.runIds.push(runId);
    if (state.batch) {
      watcher.lastBatch = state.batch;
      if (state.batch.stopping) watcher.stopRequested = true;
    }
    if (state.pausedAtNodeId !== watcher.pausedAt) {
      watcher.pausedAt = state.pausedAtNodeId;
      if (state.pausedAtNodeId) watcher.paused = true;
    }
  }

  const record = findRecord(watcher.recordId);
  if (!record) {
    disposeWatcher(watcher);
    return;
  }
  let ranNodeIds = record.ranNodeIds;
  let errors = record.errors;
  if (onTab && state.nodes !== watcher.nodes) {
    watcher.nodes = state.nodes;
    for (const node of state.nodes) {
      const data = nodeData(node);
      const before = watcher.statuses.get(node.id);
      const now = data.status;
      if (before === now) continue;
      watcher.statuses.set(node.id, now);
      // A node already "loading" when the run began (left so by an earlier stop) ran if it finishes now.
      const ran = now === "loading" || now === "error" || before === "loading";
      if (ran && !ranNodeIds.includes(node.id)) ranNodeIds = [...ranNodeIds, node.id];
      if (now === "error") {
        const message = typeof data.error === "string" && data.error ? data.error : "Failed";
        errors = [...errors.filter((entry) => entry.nodeId !== node.id), { nodeId: node.id, nodeTitle: nodeTitle(node), message }];
      }
    }
  }
  const batch = going ? state.batch : null;
  const progress =
    batch && (batch.index !== record.progress.index || batch.count !== record.progress.count)
      ? { index: batch.index, count: batch.count }
      : record.progress;
  if (ranNodeIds !== record.ranNodeIds || errors !== record.errors || progress !== record.progress) {
    updateRecord(record.id, (current) => ({ ...current, ranNodeIds, errors, progress }));
  }

  // Between the runs of a batch isRunning drops for a moment; the batch is still going.
  if (!going) finalize(watcher);
}

function finalize(watcher: Watcher): void {
  watcher.finalized = true;
  watcher.unsubscribeStore?.();
  watcher.unsubscribeStore = null;
  const state = useWorkflowStore.getState();
  const onTab = !watcher.leftTab && state.activeTabId === watcher.tabId;
  const record = findRecord(watcher.recordId);
  if (!record) {
    disposeWatcher(watcher);
    return;
  }
  const nodesById = new Map(onTab ? state.nodes.map((node) => [node.id, node] as const) : []);
  const leftLoading = record.ranNodeIds.some((id) => {
    const node = nodesById.get(id);
    return !!node && nodeData(node).status === "loading";
  });
  const endedEarly = !!watcher.lastBatch && watcher.lastBatch.index < watcher.lastBatch.count;
  // The named aborts (Stop, a tab switch, a load or clear); a pause or a failing node aborts without a reason.
  const aborted = !!watcher.controller?.signal.aborted && typeof watcher.controller.signal.reason === "string";
  let status: AgentRunStatus;
  if (record.errors.length > 0) status = "failed";
  else if (onTab && watcher.paused) status = "paused";
  else if (!watcher.seen || !onTab || watcher.stopRequested || aborted || leftLoading || endedEarly) status = "stopped";
  else status = "done";

  const fromNodes = nodeOutputs(record, nodesById);
  updateRecord(record.id, (current) => ({
    ...current,
    status,
    finishedAt: Date.now(),
    outputs: fromNodes.length > 0 ? capOutputs([...current.outputs, ...fromNodes]) : current.outputs,
  }));
  if (watcher.runIds.length === 0) {
    disposeWatcher(watcher);
    return;
  }
  watcher.lateTimer = setTimeout(() => disposeWatcher(watcher), LATE_ASSET_MS);
}

/** What the ran nodes hold that no asset carried: their text, and media the library did not record. */
function nodeOutputs(record: AgentRunRecord, nodesById: ReadonlyMap<string, WorkflowNode>): AgentRunOutput[] {
  const outputs: AgentRunOutput[] = [];
  const withAsset = new Set(record.outputs.map((output) => output.nodeId));
  for (const id of record.ranNodeIds) {
    const node = nodesById.get(id);
    // What a node that failed or was stopped holds is an earlier run's.
    if (!node || nodeData(node).status !== "complete") continue;
    const data = nodeData(node);
    const base = { nodeId: id, nodeTitle: nodeTitle(node), nodeType: node.type as NodeType };
    let index = 0;
    for (const text of textOutputs(node)) {
      outputs.push({ ...base, id: `${id}:${index++}`, kind: "text", text: capText(text, RUN_TEXT_LIMIT) });
    }
    if (withAsset.has(id) || !LIVE_MEDIA_TYPES.has(node.type as NodeType)) continue;
    for (const [field, kind] of LIVE_MEDIA_FIELDS) {
      if (typeof data[field] === "string" && data[field]) outputs.push({ ...base, id: `${id}:${index++}`, kind, live: true });
    }
  }
  return outputs;
}

/** Generators whose media is worth showing from the node when the library did not record it. */
const LIVE_MEDIA_TYPES: ReadonlySet<NodeType> = new Set<NodeType>(["nanoBanana", "generateVideo", "generateAudio", "generate3d", "comfyApp"]);
const LIVE_MEDIA_FIELDS: ReadonlyArray<[string, AgentRunOutput["kind"]]> = [
  ["outputImage", "image"],
  ["outputVideo", "video"],
  ["outputAudio", "audio"],
  ["output3dUrl", "model3d"],
];

function textOutputs(node: WorkflowNode): string[] {
  const data = nodeData(node);
  if (node.type === "llmGenerate") return typeof data.outputText === "string" && data.outputText ? [data.outputText] : [];
  if (node.type !== "comfyApp") return [];
  const app = data.app as { outputs?: Array<{ id: string; type: string }> } | null | undefined;
  const outputs = (data.outputs ?? {}) as Record<string, unknown>;
  const texts = (app?.outputs ?? [])
    .filter((output) => output.type === "text")
    .map((output) => outputs[output.id])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (texts.length > 0) return texts;
  return typeof data.outputText === "string" && data.outputText ? [data.outputText] : [];
}

function attachAsset(watcher: Watcher, { asset }: RecordAssetResult): void {
  const runIndex = watcher.runIds.indexOf(asset.runId);
  if (runIndex < 0) return;
  const record = findRecord(watcher.recordId);
  if (!record) {
    disposeWatcher(watcher);
    return;
  }
  if (record.outputs.some((output) => output.assetId === asset.id)) return;
  const output = assetOutput(asset, record.runs > 1 ? (asset.batch ? asset.batch.index - 1 : runIndex) : undefined, watcher);
  updateRecord(record.id, (current) => {
    // The library caught up with a node shown live so far: the asset replaces it.
    const rest = current.outputs.filter((entry) => !(entry.live && entry.nodeId === output.nodeId && entry.kind === output.kind));
    const ranNodeIds = current.ranNodeIds.includes(output.nodeId) ? current.ranNodeIds : [...current.ranNodeIds, output.nodeId];
    return { ...current, ranNodeIds, outputs: capOutputs([...rest, output]) };
  });
}

function assetOutput(asset: AssetView, batchIndex: number | undefined, watcher: Watcher): AgentRunOutput {
  const state = useWorkflowStore.getState();
  const node = state.activeTabId === watcher.tabId ? state.nodes.find((candidate) => candidate.id === asset.producer.nodeId) : undefined;
  const nodeType = asset.producer.nodeType as NodeType;
  const model = asset.model?.displayName || asset.model?.modelId;
  return {
    id: asset.id,
    nodeId: asset.producer.nodeId,
    nodeTitle: asset.producer.nodeTitle || (node ? nodeTitle(node) : NODE_TITLES[nodeType] ?? nodeType),
    nodeType,
    kind: asset.kind === "3d" ? "model3d" : asset.kind,
    assetId: asset.id,
    sha256: asset.sha256,
    ...(asset.hasPoster ? { hasPoster: true } : {}),
    ...(typeof asset.width === "number" ? { width: asset.width } : {}),
    ...(typeof asset.height === "number" ? { height: asset.height } : {}),
    ...(model ? { model } : {}),
    ...(asset.prompt ? { prompt: capText(asset.prompt, PROMPT_LIMIT) } : {}),
    ...(batchIndex !== undefined ? { batchIndex } : {}),
  };
}

function disposeWatcher(watcher: Watcher): void {
  watcher.finalized = true;
  watcher.unsubscribeStore?.();
  watcher.unsubscribeAssets?.();
  if (watcher.lateTimer) clearTimeout(watcher.lateTimer);
  watcher.unsubscribeStore = null;
  watcher.unsubscribeAssets = null;
  watcher.lateTimer = null;
  watchers.delete(watcher.recordId);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

function findRecord(id: string): AgentRunRecord | undefined {
  return useAgentRuns.getState().records.find((record) => record.id === id);
}

function updateRecord(id: string, change: (record: AgentRunRecord) => AgentRunRecord): void {
  useAgentRuns.setState((state) => {
    const index = state.records.findIndex((record) => record.id === id);
    if (index < 0) return state;
    const records = [...state.records];
    records[index] = change(records[index]);
    return { records };
  });
}

/** The newest outputs, MAX_RUN_OUTPUTS at most. */
function capOutputs(outputs: AgentRunOutput[]): AgentRunOutput[] {
  return outputs.length > MAX_RUN_OUTPUTS ? outputs.slice(-MAX_RUN_OUTPUTS) : outputs;
}

function nodeData(node: WorkflowNode): Record<string, unknown> {
  return (node.data ?? {}) as Record<string, unknown>;
}

function nodeTitle(node: WorkflowNode): string {
  const title = nodeData(node).customTitle;
  return typeof title === "string" && title.trim() ? title.trim() : NODE_TITLES[node.type ?? ""] ?? String(node.type);
}

function capText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

let recordCounter = 0;
function newRecordId(): string {
  recordCounter += 1;
  return `run-${Date.now().toString(36)}-${recordCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STATUSES: ReadonlySet<string> = new Set<AgentRunStatus>(["running", "done", "failed", "stopped", "paused"]);

/** The records kept in localStorage; a record still running when they were written reads as stopped. */
export function loadAgentRuns(): AgentRunRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(AGENT_RUNS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { savedAt?: unknown; records?: unknown };
    const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : Date.now();
    if (!Array.isArray(parsed.records)) return [];
    return parsed.records
      .filter(isRunRecord)
      .slice(0, MAX_RUN_RECORDS)
      .map((record) =>
        // Its page went away mid-run: nothing follows it any more.
        record.status === "running" ? { ...record, status: "stopped" as const, finishedAt: record.finishedAt ?? savedAt } : record,
      );
  } catch {
    return [];
  }
}

function isRunRecord(value: unknown): value is AgentRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AgentRunRecord>;
  const anchor = record.anchor as Partial<{ toolCallId: unknown; offerId: unknown }> | undefined;
  return (
    typeof record.id === "string" &&
    typeof record.chatId === "string" &&
    !!anchor &&
    (typeof anchor.toolCallId === "string" || typeof anchor.offerId === "string") &&
    typeof record.tabId === "string" &&
    typeof record.label === "string" &&
    !!record.scope &&
    typeof record.scope === "object" &&
    typeof record.runs === "number" &&
    typeof record.startedAt === "number" &&
    typeof record.status === "string" &&
    STATUSES.has(record.status) &&
    !!record.progress &&
    Array.isArray(record.plannedNodeIds) &&
    Array.isArray(record.ranNodeIds) &&
    Array.isArray(record.outputs) &&
    Array.isArray(record.errors)
  );
}

/** Writes the records now (they are otherwise written shortly after each change). */
export function flushAgentRuns(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (typeof window === "undefined") return;
  let records = useAgentRuns
    .getState()
    .records.slice(0, MAX_RUN_RECORDS)
    .map((record) => (record.outputs.length > MAX_RUN_OUTPUTS ? { ...record, outputs: capOutputs(record.outputs) } : record));
  // Oldest first out of the budget, and again if the quota is tighter than that.
  while (records.length > 0) {
    const json = JSON.stringify({ savedAt: Date.now(), records });
    if (json.length <= RUNS_BUDGET) {
      try {
        window.localStorage.setItem(AGENT_RUNS_KEY, json);
        return;
      } catch {
        // Over the quota: keep fewer.
      }
    }
    records = records.slice(0, Math.floor(records.length / 2));
  }
  try {
    window.localStorage.removeItem(AGENT_RUNS_KEY);
  } catch {
    // Storage unavailable: the records live for this page only.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

useAgentRuns.subscribe((state, previous) => {
  if (state.records === previous.records || typeof window === "undefined" || saveTimer) return;
  saveTimer = setTimeout(flushAgentRuns, SAVE_DELAY_MS);
});

if (typeof window !== "undefined") window.addEventListener("pagehide", () => flushAgentRuns());
