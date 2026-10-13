"use client";

/**
 * The GPU canvas setting (Settings › Canvas).
 *
 * The GPU canvas is the desktop app's canvas: on by default there, with the
 * classic React Flow canvas one switch away for this release. It runs only
 * where HTML-in-Canvas exists, which is the desktop app with Chromium's
 * CanvasDrawElement feature on. The desktop app turns that on at launch
 * unless the classic canvas was chosen (electron/lib/gpu-canvas.cjs), so
 * going back to the GPU canvas from the classic one takes a restart. The
 * browser keeps the classic canvas unless the setting is turned on in a
 * Chromium started with the feature. Kept in localStorage
 * ("node-banana-gpu-canvas", `on` or `off`) for the page, and mirrored to
 * the desktop app.
 *
 * A GPU canvas that cannot start, or whose GPU keeps resetting, gives way to
 * the classic canvas for the rest of the session (`reportGpuCanvasFailure`)
 * without changing the setting.
 */
import { useSyncExternalStore } from "react";
import { detectHtmlInCanvas } from "./htmlInCanvas";

const STORAGE_KEY = "node-banana-gpu-canvas";

/** On where nothing was chosen: the desktop app (which mirrors the choice) defaults to the GPU canvas. */
function read(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "on" || stored === "off") return stored === "on";
  } catch {
    // Storage unavailable: fall back to the default
  }
  return !!window.nodeBananaDesktop?.gpuCanvas;
}

let enabled = typeof window === "undefined" ? false : read();
let failure: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) listener();
}

export function getGpuCanvasEnabled() {
  return enabled;
}

export function setGpuCanvasEnabled(next: boolean) {
  enabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // Storage unavailable: the switch lasts for this session
  }
  void window.nodeBananaDesktop?.gpuCanvas?.set(next).catch(() => false);
  notify();
}

/** Whether this page can run the GPU canvas (HTML-in-Canvas is on). */
export function gpuCanvasSupported(): boolean {
  return typeof window !== "undefined" && detectHtmlInCanvas().available;
}

/** The GPU canvas failed (no WebGL2, the GPU kept resetting): the classic canvas runs for the rest of the session. */
export function reportGpuCanvasFailure(reason: string) {
  if (failure) return;
  failure = reason;
  console.error(`GPU canvas: ${reason}. Using the classic canvas until Node Banana restarts.`);
  notify();
}

export function getGpuCanvasFailure() {
  return failure;
}

export function useGpuCanvasFailure(): string | null {
  return useSyncExternalStore(subscribe, getGpuCanvasFailure, () => null);
}

export function useGpuCanvasEnabled(): boolean {
  return useSyncExternalStore(subscribe, getGpuCanvasEnabled, () => false);
}

/** The canvas draws with the GPU canvas: the setting is on, this page supports it, and it has not failed. */
export function useGpuCanvasActive(): boolean {
  const enabled = useGpuCanvasEnabled();
  const failed = useGpuCanvasFailure() !== null;
  return enabled && !failed && gpuCanvasSupported();
}

if (typeof window !== "undefined") {
  (window as unknown as { __bananaGpuCanvas: typeof setGpuCanvasEnabled }).__bananaGpuCanvas = setGpuCanvasEnabled;
}
