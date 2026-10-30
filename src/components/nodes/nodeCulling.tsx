"use client";

import type { ReactFlowState } from "@xyflow/react";

/**
 * The area around the view whose nodes get their floating headers: the view
 * plus a full viewport on every side, snapped to CULL_STEP so a pan
 * re-evaluates it every few hundred pixels rather than every frame.
 */
export const CULL_STEP = 500;

/** The mounted area in flow coordinates: [minX, minY, maxX, maxY]. */
export function mountedArea(transform: readonly number[], width: number, height: number): [number, number, number, number] {
  const [x, y, zoom] = transform;
  const left = -x / zoom;
  const top = -y / zoom;
  const w = width / zoom;
  const h = height / zoom;
  const snap = (v: number) => Math.floor(v / CULL_STEP) * CULL_STEP;
  return [snap(left - w), snap(top - h), snap(left + 2 * w) + CULL_STEP, snap(top + 2 * h) + CULL_STEP];
}

/** The mounted area as a string, so a store selector can return it unchanged. */
export const selectMountedArea = (s: ReactFlowState): string => mountedArea(s.transform, s.width, s.height).join(" ");
