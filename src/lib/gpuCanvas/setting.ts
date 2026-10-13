"use client";

/**
 * The GPU canvas setting (Settings › Canvas), off by default.
 *
 * The canvas runs only where HTML-in-Canvas exists: the desktop app with
 * Chromium's CanvasDrawElement feature on. The desktop app turns that on at
 * launch when the setting was on (electron/lib/gpu-canvas.cjs), so turning
 * the setting on takes a restart the first time. Kept in localStorage
 * ("node-banana-gpu-canvas") for the page, and mirrored to the desktop app.
 */
import { useSyncExternalStore } from "react";
import { detectHtmlInCanvas } from "./htmlInCanvas";

const STORAGE_KEY = "node-banana-gpu-canvas";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

let enabled = typeof window === "undefined" ? false : read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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
  for (const listener of listeners) listener();
}

/** Whether this page can run the GPU canvas (HTML-in-Canvas is on). */
export function gpuCanvasSupported(): boolean {
  return typeof window !== "undefined" && detectHtmlInCanvas().available;
}

export function useGpuCanvasEnabled(): boolean {
  return useSyncExternalStore(subscribe, getGpuCanvasEnabled, () => false);
}

/** The canvas draws with the GPU canvas: the setting is on and this page supports it. */
export function useGpuCanvasActive(): boolean {
  return useGpuCanvasEnabled() && gpuCanvasSupported();
}

if (typeof window !== "undefined") {
  (window as unknown as { __bananaGpuCanvas: typeof setGpuCanvasEnabled }).__bananaGpuCanvas = setGpuCanvasEnabled;
}
