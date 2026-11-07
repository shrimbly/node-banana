/**
 * Words and numbers for the Assets view: sizes, durations, dates, day
 * sections, workflow and project labels, and the platform's name for its
 * file manager. Pure, so the grid, the rail and the detail panel say the
 * same thing and tests can pin it.
 *
 * Dates are written day-first with English short names ("Mon 22 Sep"),
 * the way the rest of the app writes them, rather than by locale.
 */

import type { AssetCost, AssetKind, AssetModelRef, AssetOrigin, AssetView, LibraryStatus } from "@/lib/assets/types";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Midnight (local) of the day `ms` falls on. */
export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `YYYY-MM-DD` of the local day, the key the grid sections by. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Whole local days between two instants (DST-safe: counts calendar days). */
function daysBetween(earlier: number, later: number): number {
  const a = new Date(startOfDay(earlier));
  const b = new Date(startOfDay(later));
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / DAY_MS);
}

/** "14:02" */
export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "Mon 22 Sep", or "Mon 22 Sep 2025" outside the current year. */
export function formatDay(ms: number, now: number = Date.now()): string {
  const d = new Date(ms);
  const base = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Heading of a day section: "Today", "Yesterday", "Mon 22 Sep", "Mon 22 Sep 2025". */
export function daySectionLabel(ms: number, now: number = Date.now()): string {
  const days = daysBetween(ms, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return formatDay(ms, now);
}

/** "27 Sep 2026, 14:02": the Created row. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${formatTime(ms)}`;
}

/** "27 Sep 14:02": short stamp for unnamed workflows. */
export function formatShortStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${formatTime(ms)}`;
}

/** "Just now", "5m ago", "3h ago", "Yesterday", then the day. */
export function formatRelativeDate(ms: number, now: number = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return "Just now";
  const days = daysBetween(ms, now);
  if (days === 0) {
    const minutes = Math.floor(diff / 60_000);
    return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
  }
  if (days === 1) return "Yesterday";
  return formatDay(ms, now);
}

/** Decimal units, as Finder shows them: "512 B", "1.2 KB", "34 MB", "1.25 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : unit >= 2 ? 2 : 1;
  return `${Number(value.toFixed(digits))} ${units[unit]}`;
}

/** "0:07", "12:05", "1:02:03". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** "1 asset", "1,240 assets". */
export function formatCount(count: number, noun = "asset", plural = `${noun}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? noun : plural}`;
}

/** "$0.0325", "Est. $0.04". */
export function formatCost(cost: AssetCost): string {
  const amount = cost.amount >= 0.1 ? cost.amount.toFixed(2) : Number(cost.amount.toFixed(4)).toString();
  return `${cost.estimated ? "Est. " : ""}$${amount}`;
}

/** "1024 × 768" */
export function formatDimensions(width?: number, height?: number): string | null {
  if (!width || !height) return null;
  return `${width} × ${height}`;
}

export const KIND_LABELS: Record<AssetKind, string> = { image: "Image", video: "Video", audio: "Audio", "3d": "3D" };
export const KIND_PLURALS: Record<AssetKind, string> = { image: "Images", video: "Videos", audio: "Audio", "3d": "3D" };
export const ORIGIN_LABELS: Record<AssetOrigin, string> = { generated: "Generated", edited: "Edited", uploaded: "Uploaded" };

/** What an edited asset did, or how an upload came in, in words: "resize" → "Resized". */
const OPERATION_LABELS: Record<string, string> = {
  annotate: "Annotated",
  removeBackground: "Background removed",
  resize: "Resized",
  gif: "GIF",
  stitch: "Video edit",
  trim: "Trimmed",
  easeCurve: "Ease curve",
  frameGrab: "Frame grab",
  splitGrid: "Grid split",
  splitToNodes: "Split to nodes",
  upload: "Upload",
};

export function operationLabel(operation?: string): string | null {
  if (!operation) return null;
  return OPERATION_LABELS[operation] ?? operation;
}

export function modelLabel(model?: AssetModelRef): string | null {
  if (!model) return null;
  return model.displayName || model.modelId;
}

/** Last folder name of a native path, either separator. */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** A project's label: its folder name. `null` is "Not in a project". */
export function projectLabel(path: string | null): string {
  return path ? baseName(path) : "Not in a project";
}

/** A workflow's name, or "Untitled · 27 Sep 14:02" for one never named. */
export function workflowLabel(name: string | null | undefined, at: number): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : `Untitled · ${formatShortStamp(at)}`;
}

/**
 * The name the user gave the asset; else the first line of the prompt; else
 * what made the asset and where: "Split to nodes · cell 3 · Product shots",
 * "Video · Untitled".
 */
export function assetTitle(
  asset: Pick<AssetView, "prompt" | "filename" | "name"> & Partial<Pick<AssetView, "kind" | "origin" | "producer" | "workflowName" | "workflow">>,
): string {
  if (asset.name) return asset.name;
  const line = asset.prompt?.split(/\r?\n/).find((l) => l.trim())?.trim();
  if (line) return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
  if (!asset.kind) return asset.filename;
  const made =
    asset.origin === "edited" ? operationLabel(asset.producer?.operation) ?? ORIGIN_LABELS.edited : KIND_LABELS[asset.kind];
  const cell = asset.producer?.batchIndex !== undefined && /split/i.test(asset.producer.operation ?? "") ? `cell ${asset.producer.batchIndex + 1}` : null;
  const workflow = asset.workflow?.name ?? asset.workflowName;
  return [made, cell, workflow].filter(Boolean).join(" · ");
}

/** Eyebrow over the detail title: "Image · Generated · 27 Sep 2026", "Video · Uploaded · 20 Oct 2026". */
export function assetEyebrow(asset: Pick<AssetView, "kind" | "origin" | "createdAt" | "producer">): string {
  const origin =
    asset.origin === "edited"
      ? operationLabel(asset.producer.operation) ?? ORIGIN_LABELS.edited
      : asset.origin === "uploaded"
        ? ORIGIN_LABELS.uploaded
        : ORIGIN_LABELS.generated;
  const d = new Date(asset.createdAt);
  return [KIND_LABELS[asset.kind], origin, `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`].join(" · ");
}

/** The platform the library's server runs on, else the browser's. */
export function resolvePlatform(status?: Pick<LibraryStatus, "platform"> | null): string {
  if (status?.platform) return status.platform;
  if (typeof window !== "undefined" && window.nodeBananaDesktop?.platform) return window.nodeBananaDesktop.platform;
  if (typeof navigator !== "undefined") {
    const agent = navigator.userAgent;
    if (/Mac|iPhone|iPad/.test(agent)) return "darwin";
    if (/Windows/.test(agent)) return "win32";
    if (/Linux/.test(agent)) return "linux";
  }
  return "unknown";
}

/** "Show in Finder" on macOS, "Show in Explorer" on Windows, "Show in folder" elsewhere. */
export function revealLabel(platform: string): string {
  if (platform === "darwin") return "Show in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in folder";
}

/** "~/Pictures/Node Banana" → "Pictures › Node Banana": the last two folders, for a one-line hint. */
export function shortLibraryPath(root: string): string {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join(" › ") || root;
}
