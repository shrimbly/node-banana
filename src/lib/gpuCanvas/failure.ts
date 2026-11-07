"use client";

/**
 * When the canvas cannot draw.
 *
 * The GPU canvas is the only canvas. One that cannot start (no WebGL2, a
 * shader that will not compile) or whose GPU resets more than once reports
 * it here, and WorkflowCanvas shows why in its place, with a way to try
 * again (`clearGpuCanvasFailure`). The rest of the app (Assets, the chat,
 * the Edit video view) keeps working.
 */
import { useSyncExternalStore } from "react";

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

/** The canvas cannot draw: the first reason is kept until it is cleared. */
export function reportGpuCanvasFailure(reason: string) {
  if (failure) return;
  failure = reason;
  console.error(`GPU canvas: ${reason}.`);
  notify();
}

/** Try the canvas again. */
export function clearGpuCanvasFailure() {
  if (!failure) return;
  failure = null;
  notify();
}

export function getGpuCanvasFailure() {
  return failure;
}

export function useGpuCanvasFailure(): string | null {
  return useSyncExternalStore(subscribe, getGpuCanvasFailure, () => null);
}
