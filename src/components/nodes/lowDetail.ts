"use client";

/**
 * Low detail when zoomed out.
 *
 * Below the low-detail zoom (25% unless changed) the GPU canvas marks running
 * nodes with a halo, so they can be found from far out. Where it runs without
 * HTML-in-Canvas (a browser), nodes below it are the scene's stand-in cards
 * rather than live components, so large workflows pan smoothly.
 *
 * On by default; both the switch and the zoom are in Settings › Canvas,
 * kept in localStorage ("node-banana-low-detail", "node-banana-low-detail-zoom").
 * For comparing from the console: __bananaLowDetail(false),
 * __bananaLowDetailZoom(0.3).
 */

/** Below this zoom the canvas draws nodes at low detail, unless changed. */
export const LOW_DETAIL_ZOOM = 0.25;

const STORAGE_KEY = "node-banana-low-detail";
const ZOOM_STORAGE_KEY = "node-banana-low-detail-zoom";

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function readThreshold(): number {
  try {
    const stored = Number(localStorage.getItem(ZOOM_STORAGE_KEY));
    return stored > 0 && stored < 2 ? stored : LOW_DETAIL_ZOOM;
  } catch {
    return LOW_DETAIL_ZOOM;
  }
}

let enabled = typeof window === "undefined" ? true : readEnabled();
let threshold = typeof window === "undefined" ? LOW_DETAIL_ZOOM : readThreshold();

export function setLowDetailEnabled(next: boolean) {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // Storage unavailable: the switch lasts for this session
  }
}

/** The zoom low detail starts below; anything else resets it to LOW_DETAIL_ZOOM. */
export function setLowDetailZoom(next: number) {
  threshold = next > 0 && next < 2 ? next : LOW_DETAIL_ZOOM;
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, String(threshold));
  } catch {
    // Storage unavailable: the value lasts for this session
  }
}

if (typeof window !== "undefined") {
  const w = window as unknown as { __bananaLowDetail: typeof setLowDetailEnabled; __bananaLowDetailZoom: typeof setLowDetailZoom };
  w.__bananaLowDetail = setLowDetailEnabled;
  w.__bananaLowDetailZoom = setLowDetailZoom;
}

/** Whether low detail is switched on, and the zoom it starts below, as they stand. */
export function getLowDetailSettings(): { enabled: boolean; zoom: number } {
  return { enabled, zoom: threshold };
}
