/**
 * "Open original workflow" / "Open project" for an asset.
 *
 * - `snapshot`: fetch the run snapshot for the asset, hydrate it, prepare it
 *   (fresh id, never bound to a folder), then `openWorkflowInNewTab`. If a
 *   tab opened earlier from the same run is still open (restored desktop
 *   sessions included) and not since saved to a folder, switch to it
 *   instead. Centres on the producing node when it exists.
 * - `project`: load the project folder's workflow file
 *   (GET /api/workflow?path=…&load=true) and open it bound to the folder,
 *   or switch to a tab that already has that workflow id bound to that folder.
 *
 * Never throws. Refuses (with the reason) while `tabsBusyReason()` is set,
 * and asks before leaving a workflow the agent is still working on (`kept`
 * when the user keeps it working). The caller switches the app back to the
 * canvas view on `ok`.
 */

import { confirmStopAgent } from "@/lib/agent/client/stopGuard";
import { useWorkflowStore, type WorkflowFile } from "@/store/workflowStore";
import type { AssetView } from "../types";
import { fetchAssetBlob, fetchAssetWorkflow } from "./api";
import { blobToDataUrl } from "./mediaBlob";
import { getRecorderLibraryStatus } from "./recorder";
import { INLINE_VIDEO_LIMIT, hydrateSnapshot, injectsIntoProducer, prepareWorkflowForOpen } from "./snapshot";

export type OpenWorkflowMode = "snapshot" | "project";

export type OpenWorkflowResult =
  | { ok: true; tabId: string; nodeId: string | null }
  | { ok: false; reason: string; kept?: true };

/** The user kept the agent working rather than open another workflow: nothing went wrong. */
const KEPT_AGENT = { ok: false, reason: "The agent is still working", kept: true } as const;

/**
 * runId → id of the copy opened from its snapshot, so a second open goes
 * back to that tab. Kept in localStorage too: the desktop app restores its
 * tabs after a restart, and the copy tab should still be found then. An
 * entry only ever points at a tab that is open, so a stale one is harmless.
 */
export const OPENED_COPIES_KEY = "node-banana-assets-opened-copies";
const OPENED_COPIES_LIMIT = 50;
let openedCopies: Map<string, string> | null = null;
/** One open per run or project at a time; a second click waits for the first. */
const inflight = new Map<string, Promise<OpenWorkflowResult>>();

function copies(): Map<string, string> {
  if (openedCopies) return openedCopies;
  openedCopies = new Map();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(OPENED_COPIES_KEY) ?? "[]");
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") openedCopies.set(entry[0], entry[1]);
      }
    }
  } catch {
    // No storage (a private window, blocked site data): this page's copies are still remembered.
  }
  return openedCopies;
}

function saveCopies(): void {
  try {
    localStorage.setItem(OPENED_COPIES_KEY, JSON.stringify([...copies()]));
  } catch {
    // As above: remembered for this page only.
  }
}

function rememberCopy(runId: string, workflowId: string): void {
  const map = copies();
  map.delete(runId);
  map.set(runId, workflowId);
  for (const oldest of map.keys()) {
    if (map.size <= OPENED_COPIES_LIMIT) break;
    map.delete(oldest);
  }
  saveCopies();
}

function forgetCopy(runId: string): void {
  if (copies().delete(runId)) saveCopies();
}

function fail(reason: string): OpenWorkflowResult {
  return { ok: false, reason };
}

/** Why an asset's workflow cannot be opened right now (busy tabs, no snapshot, no project), or null. */
export function openWorkflowBlockedReason(asset: AssetView, mode: OpenWorkflowMode): string | null {
  const busy = useWorkflowStore.getState().tabsBusyReason();
  if (busy) return busy;
  if (mode === "snapshot" && asset.imported) return "This asset was imported, so there is no snapshot of its workflow.";
  if (mode === "project" && !asset.workflow.projectPath) return "This asset isn't in a project.";
  return null;
}

export function openAssetWorkflow(asset: AssetView, mode: OpenWorkflowMode): Promise<OpenWorkflowResult> {
  const key = mode === "snapshot" ? `run:${asset.runId}` : `project:${asset.workflow.projectPath}`;
  const previous = inflight.get(key);
  const run = (previous ? previous.then(() => undefined) : Promise.resolve())
    .then(() => (mode === "snapshot" ? openSnapshot(asset) : openProject(asset)))
    .catch((error: unknown) => fail(error instanceof Error && error.message ? error.message : "The workflow couldn't be opened."));
  inflight.set(key, run);
  void run.finally(() => {
    if (inflight.get(key) === run) inflight.delete(key);
  });
  return run;
}

/* Tabs ---------------------------------------------------------------- */

type TabMatch = (fields: { workflowId: string | null; saveDirectoryPath: string | null }) => boolean;
type Focused = { ok: true; tabId: string } | { ok: false; reason: string; kept?: true };

/** Brings the tab matching `match` into the canvas. Null when no tab matches. */
function focusTab(match: TabMatch): Focused | null {
  const state = useWorkflowStore.getState();
  if (match(state)) return { ok: true, tabId: state.activeTabId };
  const tab = state.tabs.find((candidate) => candidate.snapshot && match(candidate.snapshot));
  if (!tab) return null;
  if (!state.tabsBusyReason() && !confirmStopAgent("Switching workflows")) return KEPT_AGENT;
  if (!state.switchTab(tab.id)) {
    return { ok: false, reason: useWorkflowStore.getState().tabsBusyReason() ?? "That tab couldn't be opened." };
  }
  return { ok: true, tabId: tab.id };
}

type LiveNode = { id: string; type?: string; data?: unknown };

/** Centres the canvas on `nodeId` when the live workflow has such a node (and it passes `accept`). */
function centreOn(nodeId: string, accept: (node: LiveNode) => boolean = () => true): string | null {
  const state = useWorkflowStore.getState();
  const node = (state.nodes as LiveNode[]).find((candidate) => candidate.id === nodeId);
  if (!node || !accept(node)) return null;
  state.setNavigationTarget(nodeId);
  return nodeId;
}

/* Blob URLs ----------------------------------------------------------- */

type Path = (string | number)[];
interface BlobPatch {
  nodeId: string;
  path: Path;
  url: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * loadWorkflow drops every blob: URL in a file (a saved one died with its
 * session), but these were made a moment ago for large videos and 3D. Hold
 * them back (null in a field, "" in a list, so nothing shifts) and put them
 * in once the workflow is live.
 */
function detachBlobUrls(file: WorkflowFile): { file: WorkflowFile; patches: BlobPatch[] } {
  const patches: BlobPatch[] = [];
  const nodes = file.nodes.map((node) => {
    const before = patches.length;
    const path: Path = [];
    const walk = (value: unknown, inList: boolean): unknown => {
      if (typeof value === "string" && value.startsWith("blob:")) {
        patches.push({ nodeId: node.id, path: [...path], url: value });
        return inList ? "" : null;
      }
      if (Array.isArray(value)) {
        return value.map((item, index) => {
          path.push(index);
          const next = walk(item, true);
          path.pop();
          return next;
        });
      }
      if (!isPlainObject(value)) return value;
      const next: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        path.push(key);
        next[key] = walk(child, false);
        path.pop();
      }
      return next;
    };
    const data = walk(node.data, false);
    return patches.length > before ? { ...node, data: data as typeof node.data } : node;
  });
  return { file: { ...file, nodes }, patches };
}

/** `value` with `path` set to `url`, copying along the way; undefined when the path no longer fits. */
function setAtPath(value: unknown, path: Path, url: string): unknown {
  if (!path.length) return url;
  const [head, ...rest] = path;
  if (typeof head === "number") {
    if (!Array.isArray(value) || head >= value.length) return undefined;
    const child = setAtPath(value[head], rest, url);
    if (child === undefined) return undefined;
    const copy = [...value];
    copy[head] = child;
    return copy;
  }
  if (!isPlainObject(value)) return undefined;
  const child = setAtPath(value[head], rest, url);
  return child === undefined ? undefined : { ...value, [head]: child };
}

function reattachBlobUrls(workflowId: string, patches: BlobPatch[]): void {
  const state = useWorkflowStore.getState();
  const unused = new Set(patches.map((patch) => patch.url));
  if (state.workflowId === workflowId) {
    const byNode = new Map<string, BlobPatch[]>();
    for (const patch of patches) byNode.set(patch.nodeId, [...(byNode.get(patch.nodeId) ?? []), patch]);
    const nodes = state.nodes.map((node) => {
      const nodePatches = byNode.get(node.id);
      if (!nodePatches) return node;
      let data: unknown = node.data;
      for (const patch of nodePatches) {
        const next = setAtPath(data, patch.path, patch.url);
        if (next === undefined) continue;
        data = next;
        unused.delete(patch.url);
      }
      return data === node.data ? node : { ...node, data: data as typeof node.data };
    });
    // A direct set: this is part of the load, not an edit to undo or save.
    useWorkflowStore.setState({ nodes });
  }
  for (const url of unused) URL.revokeObjectURL(url);
}

function revokeAll(patches: BlobPatch[]): void {
  for (const patch of patches) URL.revokeObjectURL(patch.url);
}

/* Snapshot mode ------------------------------------------------------- */

/** The asset's own bytes as node data holds them; blob: URLs for 3D and large videos. Null when unreadable. */
async function loadAssetMedia(asset: AssetView): Promise<string | null> {
  try {
    const fetched = await fetchAssetBlob(asset.id);
    const blob = fetched.type ? fetched : new Blob([fetched], { type: asset.mime });
    if (asset.kind === "3d" || (asset.kind === "video" && blob.size > INLINE_VIDEO_LIMIT)) return URL.createObjectURL(blob);
    return await blobToDataUrl(blob);
  } catch (error) {
    console.warn("Couldn't load the asset into its workflow:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Opens a prepared copy in a new tab (or the current one when untouched) and confirms it is live. */
async function openCopy(prepared: WorkflowFile): Promise<OpenWorkflowResult> {
  const { file, patches } = detachBlobUrls(prepared);
  const busy = useWorkflowStore.getState().tabsBusyReason();
  if (busy) {
    revokeAll(patches);
    return fail(busy);
  }
  if (!confirmStopAgent("Opening another workflow")) {
    revokeAll(patches);
    return KEPT_AGENT;
  }
  await useWorkflowStore.getState().openWorkflowInNewTab(file);
  const live = useWorkflowStore.getState();
  if (live.workflowId !== prepared.id) {
    revokeAll(patches);
    return fail(live.tabsBusyReason() ?? "The workflow couldn't be opened.");
  }
  if (patches.length) reattachBlobUrls(prepared.id!, patches);
  return { ok: true, tabId: live.activeTabId, nodeId: null };
}

async function openSnapshot(asset: AssetView): Promise<OpenWorkflowResult> {
  const blocked = openWorkflowBlockedReason(asset, "snapshot");
  if (blocked) return fail(blocked);

  const copyId = copies().get(asset.runId);
  if (copyId) {
    // A copy since saved to a folder is the user's own workflow now, not the run as it was.
    const focused = focusTab((tab) => tab.workflowId === copyId && !tab.saveDirectoryPath);
    if (focused?.ok) return { ok: true, tabId: focused.tabId, nodeId: centreOn(asset.producer.nodeId) };
    if (focused) return focused;
    forgetCopy(asset.runId);
  }

  const result = await fetchAssetWorkflow(asset.id);
  if (!result) return fail("There's no snapshot of this asset's workflow.");
  const recorded = result.asset ?? asset;
  // A split cell is not put back into its source node, so its bytes are not needed.
  const [file, assetMedia] = await Promise.allSettled([
    hydrateSnapshot(result.workflow),
    injectsIntoProducer(recorded) ? loadAssetMedia(asset) : Promise.resolve(null),
  ]);
  const media = assetMedia.status === "fulfilled" ? assetMedia.value : null;
  if (file.status === "rejected") {
    if (media?.startsWith("blob:")) URL.revokeObjectURL(media);
    throw file.reason;
  }
  const prepared = prepareWorkflowForOpen(file.value, { asset: recorded, assetMedia: media, openedAt: Date.now() });

  const opened = await openCopy(prepared);
  if (!opened.ok) return opened;
  rememberCopy(asset.runId, prepared.id!);
  return { ok: true, tabId: opened.tabId, nodeId: centreOn(asset.producer.nodeId) };
}

/* Project mode -------------------------------------------------------- */

/** macOS and Windows file systems ignore case; the server's platform decides, else the browser's. */
function pathsIgnoreCase(): boolean {
  const platform = getRecorderLibraryStatus()?.platform;
  if (platform) return platform === "win32" || platform === "darwin";
  return typeof navigator !== "undefined" && /Macintosh|Mac OS|Windows/i.test(navigator.userAgent);
}

/** Two folder paths name the same place, whatever their separators or trailing slash. */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const ignoreCase = pathsIgnoreCase();
  const normalise = (path: string) => {
    const unified = path.replace(/[\\/]+/g, "/");
    const trimmed = unified.length > 1 ? unified.replace(/\/$/, "") : unified;
    return ignoreCase ? trimmed.toLowerCase() : trimmed;
  };
  return normalise(a) === normalise(b);
}

/** A project's node shows this asset when its carousel lists it (by asset id or the file's legacy id). */
function showsAsset(asset: AssetView) {
  const legacyId = asset.filename.replace(/\.[^.]+$/, "");
  return (node: LiveNode): boolean => {
    if (node.type !== asset.producer.nodeType) return false;
    const data = isPlainObject(node.data) ? node.data : {};
    const histories = ["imageHistory", "videoHistory", "audioHistory"]
      .map((key) => data[key])
      .filter((history): history is unknown[] => Array.isArray(history) && history.length > 0);
    if (!histories.length) return true;
    return histories.some((history) =>
      history.some((item) => isPlainObject(item) && (item.assetId === asset.id || item.id === legacyId)),
    );
  };
}

async function loadProjectWorkflow(projectPath: string): Promise<WorkflowFile | string> {
  let response: Response;
  try {
    response = await fetch(`/api/workflow?path=${encodeURIComponent(projectPath)}&load=true`, { cache: "no-store" });
  } catch {
    return "The project folder couldn't be reached.";
  }
  const body = (await response.json().catch(() => null)) as { success?: boolean; workflow?: WorkflowFile; error?: string } | null;
  if (!response.ok || !body?.success || !body.workflow) {
    return body?.error || "The project folder has no workflow to open.";
  }
  return body.workflow;
}

async function openProject(asset: AssetView): Promise<OpenWorkflowResult> {
  const blocked = openWorkflowBlockedReason(asset, "project");
  if (blocked) return fail(blocked);
  const projectPath = asset.workflow.projectPath!;
  const bound = (workflowId: string) => (tab: { workflowId: string | null; saveDirectoryPath: string | null }) =>
    tab.workflowId === workflowId && samePath(tab.saveDirectoryPath, projectPath);

  const focused = focusTab(bound(asset.workflow.id));
  if (focused && !focused.ok) return focused;
  if (focused?.ok) return { ok: true, tabId: focused.tabId, nodeId: centreOn(asset.producer.nodeId, showsAsset(asset)) };

  const workflow = await loadProjectWorkflow(projectPath);
  if (typeof workflow === "string") return fail(workflow);
  // The folder's newest workflow may be open already under its own id.
  if (workflow.id && workflow.id !== asset.workflow.id) {
    const already = focusTab(bound(workflow.id));
    if (already && !already.ok) return already;
    if (already?.ok) return { ok: true, tabId: already.tabId, nodeId: centreOn(asset.producer.nodeId, showsAsset(asset)) };
  }

  const busy = useWorkflowStore.getState().tabsBusyReason();
  if (busy) return fail(busy);
  if (!confirmStopAgent("Opening another workflow")) return KEPT_AGENT;
  await useWorkflowStore.getState().openWorkflowInNewTab(workflow, projectPath);
  const live = useWorkflowStore.getState();
  const opened = workflow.id ? live.workflowId === workflow.id : samePath(live.saveDirectoryPath, projectPath);
  if (!opened) return fail(live.tabsBusyReason() ?? "The project couldn't be opened.");
  return { ok: true, tabId: live.activeTabId, nodeId: centreOn(asset.producer.nodeId, showsAsset(asset)) };
}
