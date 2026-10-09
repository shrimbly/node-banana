/**
 * What the Assets view's buttons, menus and keys do, in one place, so the
 * context menu, the detail panel, the bulk bar and the keyboard agree.
 * Failures become a notice in the view; nothing here throws.
 */

import JSZip from "jszip";
import * as api from "@/lib/assets/client/api";
import { openAssetWorkflow, type OpenWorkflowMode } from "@/lib/assets/client/openWorkflow";
import type { AssetSelection, AssetView } from "@/lib/assets/types";
import { NOT_IN_VIEW, bulkFavoriteOp, selectionCount, selectionInView, useAssetStore, viewScope } from "@/store/assetStore";
import { useSettingsDialogStore } from "@/store/settingsDialogStore";
import { baseName, formatCount } from "./assetFormat";

/** The browser zips a selection only below these; above them Export copies on the server. */
export const ZIP_MAX_FILES = 200;
export const ZIP_MAX_BYTES = 500 * 1000 * 1000;

export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && !!window.nodeBananaDesktop;
}

function notice(message: string, tone: "info" | "error" = "info") {
  useAssetStore.getState().showNotice({ message, tone });
}

function failure(error: unknown, fallback: string) {
  notice(error instanceof Error && error.message ? error.message : fallback, "error");
}

export const selectionOf = (ids: string[]): AssetSelection => ({ mode: "ids", ids });

/** Show one asset's file, selected, in Finder or Explorer. */
export async function revealAssetFile(asset: Pick<AssetView, "id">) {
  try {
    await api.revealAsset(asset.id);
  } catch (error) {
    failure(error, "The file could not be shown.");
  }
}

export async function revealLibrary() {
  try {
    await api.revealLibraryRoot();
  } catch (error) {
    failure(error, "The library folder could not be shown.");
  }
}

/** Settings → Library, from anywhere. */
export function changeLibraryLocation() {
  useSettingsDialogStore.getState().openSettings("library");
}

function clickDownload(href: string, filename: string) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** One file, straight from the server (no bytes pass through the page). */
export function downloadAsset(asset: Pick<AssetView, "id" | "filename">) {
  clickDownload(api.assetFileUrl(asset.id, true), asset.filename);
}

/** The zip's name, dated by the user's own calendar (not UTC's, which is a day off half the day in some zones). */
export function zipFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Node Banana assets ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.zip`;
}

/**
 * Zip entry times in local wall-clock time: JSZip writes the DOS date/time
 * fields from the UTC parts of the date it is given, and unzip tools read
 * them as local time.
 */
function zipEntryDate(now: Date = new Date()): Date {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
}

/** Whether the browser may zip this much. */
export function canZip(count: number, bytes: number): boolean {
  return count > 0 && count <= ZIP_MAX_FILES && bytes <= ZIP_MAX_BYTES;
}

/** Several files as one zip, built in the page: only ever under the thresholds above. */
export async function downloadZip(assets: Pick<AssetView, "id" | "filename" | "bytes">[]) {
  const bytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  if (!canZip(assets.length, bytes)) {
    notice("That is too much to zip in the browser. Use Export… instead.", "error");
    return;
  }
  if (assets.length === 1) {
    downloadAsset(assets[0]!);
    return;
  }
  notice(`Preparing ${formatCount(assets.length, "file")}…`);
  try {
    const zip = new JSZip();
    const used = new Set<string>();
    const date = zipEntryDate();
    for (const asset of assets) {
      let name = asset.filename;
      for (let n = 2; used.has(name.toLowerCase()); n++) name = asset.filename.replace(/(\.[^.]*)?$/, ` ${n}$1`);
      used.add(name.toLowerCase());
      // Stored, not deflated: the media is already compressed
      zip.file(name, await api.fetchAssetBlob(asset.id), { compression: "STORE", date });
    }
    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    clickDownload(url, zipFileName());
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    notice(`Downloaded ${formatCount(assets.length, "file")}`);
  } catch (error) {
    failure(error, "The zip could not be made.");
  }
}

/** Ask for a folder with the native picker. Null when cancelled or unavailable (reported). */
export async function pickFolder(purpose: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/browse-directory?purpose=${encodeURIComponent(purpose)}`);
    const result = (await response.json()) as { success?: boolean; cancelled?: boolean; path?: string; error?: string };
    if (!result.success) {
      notice(result.error || "The folder picker could not be opened.", "error");
      return null;
    }
    if (result.cancelled || !result.path) return null;
    return result.path;
  } catch (error) {
    failure(error, "The folder picker could not be opened.");
    return null;
  }
}

/** Copy a selection's files into a folder the user picks, on the server, as a job with progress. */
export async function exportAssets(selection: AssetSelection) {
  const dest = await pickFolder("export");
  if (!dest) return;
  try {
    const job = await api.startExport({ selection, dest });
    useAssetStore.getState().trackJob(job, (done) => `Exported ${formatCount(done.done, "file")} to ${baseName(dest)}`);
  } catch (error) {
    failure(error, "The export could not start.");
  }
}

/** "Save a copy…" on desktop (a folder and a server copy), a download in the browser. */
export function saveCopy(asset: Pick<AssetView, "id" | "filename">) {
  if (isDesktopApp()) void exportAssets(selectionOf([asset.id]));
  else downloadAsset(asset);
}

export async function copyPrompt(asset: Pick<AssetView, "prompt">) {
  if (!asset.prompt) return;
  try {
    await navigator.clipboard.writeText(asset.prompt);
    notice("Prompt copied");
  } catch {
    notice("The prompt could not be copied.", "error");
  }
}

/**
 * Open the asset's workflow (or project) and go back to the canvas when it
 * opened. The detail closes with it, so coming back to Assets lands on the
 * grid (where it was, on that tile) rather than on a stale detail.
 */
export async function openWorkflowFor(asset: AssetView, mode: OpenWorkflowMode) {
  const result = await openAssetWorkflow(asset, mode);
  if (result.ok) {
    const store = useAssetStore.getState();
    store.closeDetail();
    store.setAppView("canvas");
  } else if (!result.kept) {
    notice(result.reason, "error");
  }
}

/** Toggle one asset's favorite. */
export function toggleFavorite(asset: Pick<AssetView, "id" | "favorite">) {
  void useAssetStore.getState().runBulk(selectionOf([asset.id]), { action: asset.favorite ? "unfavorite" : "favorite" });
}

/** Favorite the current selection, or unfavorite it when every one already is. */
export function favoriteSelection() {
  const state = useAssetStore.getState();
  void state.runBulk(state.selection, bulkFavoriteOp(state));
}

/** Records the view holds for a selection (all of an ids selection it has seen, the loaded part of a query). */
export function recordsOf(selection: AssetSelection): AssetView[] {
  const state = useAssetStore.getState();
  if (selection.mode === "ids") {
    const byId = new Map(state.items.filter((item) => item.asset).map((item) => [item.id, item.asset!]));
    return selection.ids.map((id) => byId.get(id) ?? state.selectedRecords[id] ?? (state.detailAsset?.id === id ? state.detailAsset : undefined)).filter((a): a is AssetView => !!a);
  }
  return state.items
    .map((item) => item.asset)
    .filter((asset): asset is AssetView => !!asset && !selection.excludeIds.includes(asset.id));
}

/** The destructive key and buttons: Trash in the library, Delete permanently in Trash, Remove from library in Missing. */
export function removeSelection(selection: AssetSelection) {
  const state = useAssetStore.getState();
  const count = selection === state.selection ? selectionCount(state) : selection.mode === "ids" ? selection.ids.length : state.total;
  if (count === 0) return;
  if (state.filters.view === "trash") {
    requestPermanentDelete(selection, count);
  } else if (state.filters.view === "missing") {
    requestRemoveFromLibrary(selection, count);
  } else {
    void state.runBulk(selection, { action: "trash" });
  }
}

/**
 * A confirm is a dialog on document.body, which a fullscreen detail would
 * hide (while it held the keyboard): leave fullscreen first. So is every
 * other dialog, the shortcuts and Settings among them.
 */
export function leaveFullscreen() {
  if (typeof document !== "undefined" && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
}

/**
 * What of `selection` a permanent delete may reach from this view (only
 * trashed assets in the Trash, only missing ones otherwise), and how many
 * that is; null, said in a notice, when nothing.
 */
function deletable(selection: AssetSelection, count: number): { selection: AssetSelection; count: number } | null {
  const state = useAssetStore.getState();
  const scoped = selectionInView(state, selection, { action: "delete" });
  if (!scoped) {
    notice(NOT_IN_VIEW[viewScope(state.filters.view)], "error");
    return null;
  }
  return { selection: scoped.selection, count: scoped.selection.mode === "ids" ? scoped.selection.ids.length : count };
}

/** For records whose file is gone: drop the record (there is nothing to put in any Trash). */
export function requestRemoveFromLibrary(selection: AssetSelection, count: number) {
  const target = deletable(selection, count);
  if (!target) return;
  leaveFullscreen();
  useAssetStore.getState().requestConfirm({ kind: "remove", selection: target.selection, count: target.count, projectCount: 0 });
}

export function requestPermanentDelete(selection: AssetSelection, count: number) {
  const target = deletable(selection, count);
  if (!target) return;
  // Files in project folders are kept unless the user opts in; say how many
  // there are, when every record of the selection is at hand
  const records = recordsOf(target.selection);
  const inProjects = records.filter((asset) => asset.file.root === "external").length;
  const projectCount = records.length >= target.count ? inProjects : null;
  leaveFullscreen();
  useAssetStore.getState().requestConfirm({ kind: "delete", selection: target.selection, count: target.count, projectCount });
}

export function restoreSelection(selection: AssetSelection) {
  void useAssetStore.getState().runBulk(selection, { action: "restore" });
}

/** Offer to index the generations of the projects this browser has saved. */
export async function importProjects(projectDirs: string[]) {
  if (projectDirs.length === 0) return;
  try {
    const job = await api.startImport({ projectDirs });
    useAssetStore.getState().trackJob(job, (done) => `Imported ${formatCount(done.done, "file")} from ${formatCount(projectDirs.length, "project")}`);
  } catch (error) {
    failure(error, "The import could not start.");
  }
}
