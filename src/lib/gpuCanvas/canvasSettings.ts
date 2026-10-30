/**
 * The canvas's trade-offs between speed and detail, in Settings › Canvas.
 *
 * Each is read where it applies, so a change takes effect without a reload:
 * the canvas listens (subscribeCanvasSettings) for the ones that need work
 * done at once (repainting pictures, rebuilding the canvas for live nodes).
 * The defaults are the canvas as it ships.
 *
 * - browserNodes: without HTML-in-Canvas (a browser), nodes are painted into
 *   images ("painted"), or every node in view is a live component ("live",
 *   no painter; kept in "node-banana-live-nodes" as `on`, which the runner's
 *   `--live-nodes` sets).
 * - pictureQuality: how a browser's painted nodes copy their pictures
 *   (domSnapshot.ts): "fast" draws every one at the size it shows, "balanced"
 *   takes a picture's file unless it is large, "sharp" always takes the file.
 * - waitForPaint: an opened workflow shows a bare canvas until its view is
 *   painted, rather than stand-in cards.
 * - loadingScreen: large workflows open behind the loading screen while they paint.
 * - connectionDetailZoom: from this zoom, connections show their labels and stubs.
 * - sharpenWhilePanning: the painter works while the view moves (painter.ts),
 *   rather than waiting for it to be still, so pictures sharpen during a long
 *   pan at the cost of a hitch now and then.
 *
 * The rest live in "node-banana-canvas-performance" as JSON.
 */
import { OVERVIEW_ZOOM_THRESHOLD } from "@/utils/canvasPerformance";

export type BrowserNodes = "painted" | "live";
export type PictureQuality = "fast" | "balanced" | "sharp";

export interface CanvasSettings {
  browserNodes: BrowserNodes;
  pictureQuality: PictureQuality;
  waitForPaint: boolean;
  loadingScreen: boolean;
  connectionDetailZoom: number;
  sharpenWhilePanning: boolean;
}

export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = {
  browserNodes: "painted",
  pictureQuality: "balanced",
  waitForPaint: true,
  loadingScreen: true,
  connectionDetailZoom: OVERVIEW_ZOOM_THRESHOLD,
  sharpenWhilePanning: false,
};

const LIVE_NODES_KEY = "node-banana-live-nodes";
const STORAGE_KEY = "node-banana-canvas-performance";
const QUALITIES: readonly PictureQuality[] = ["fast", "balanced", "sharp"];

function read(): CanvasSettings {
  const settings = { ...DEFAULT_CANVAS_SETTINGS };
  try {
    if (localStorage.getItem(LIVE_NODES_KEY) === "on") settings.browserNodes = "live";
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<CanvasSettings>;
    if (QUALITIES.includes(stored.pictureQuality as PictureQuality)) settings.pictureQuality = stored.pictureQuality!;
    if (typeof stored.waitForPaint === "boolean") settings.waitForPaint = stored.waitForPaint;
    if (typeof stored.loadingScreen === "boolean") settings.loadingScreen = stored.loadingScreen;
    if (typeof stored.sharpenWhilePanning === "boolean") settings.sharpenWhilePanning = stored.sharpenWhilePanning;
    const zoom = Number(stored.connectionDetailZoom);
    if (zoom > 0 && zoom <= 2) settings.connectionDetailZoom = zoom;
  } catch {
    // Storage unavailable or unreadable: the defaults
  }
  return settings;
}

let current: CanvasSettings = typeof window === "undefined" ? DEFAULT_CANVAS_SETTINGS : read();
const listeners = new Set<(next: CanvasSettings, previous: CanvasSettings) => void>();

export function getCanvasSettings(): CanvasSettings {
  return current;
}

export function setCanvasSettings(changes: Partial<CanvasSettings>) {
  const previous = current;
  const next = { ...current, ...changes };
  if ((Object.keys(next) as (keyof CanvasSettings)[]).every((key) => next[key] === previous[key])) return;
  current = next;
  try {
    if (next.browserNodes === "live") localStorage.setItem(LIVE_NODES_KEY, "on");
    else localStorage.removeItem(LIVE_NODES_KEY);
    const stored: Partial<CanvasSettings> = { ...next };
    delete stored.browserNodes;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable: the settings last for this session
  }
  for (const listener of listeners) listener(next, previous);
}

export function subscribeCanvasSettings(listener: (next: CanvasSettings, previous: CanvasSettings) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== "undefined") {
  // For comparing from the console: __bananaCanvasSettings({ pictureQuality: "sharp" }).
  (window as unknown as { __bananaCanvasSettings: typeof setCanvasSettings }).__bananaCanvasSettings = setCanvasSettings;
}
