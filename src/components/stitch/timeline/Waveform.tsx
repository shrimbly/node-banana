"use client";

import { useEffect, useRef } from "react";
import { peakInRange } from "@/lib/stitch/peaks";
import type { TimeAxis } from "@/lib/stitch/timeAxis";

/** 2px bars on a 3px pitch, measured from the block's left edge so they hold still while the lanes scroll. */
const BAR_PITCH = 3;
const BAR_WIDTH = 2;
/** A full-scale peak's bar, as a share of the block's height (28px of the 44px block). */
const BAR_REACH = 28 / 44;

const colors: Record<"wave" | "active", string | null> = { wave: null, active: null };
/**
 * The waveform's grey from the theme, lighter while the clip is selected: read once (a canvas cannot take a class), and
 * again while the theme has none.
 */
function waveColor(selected: boolean): string {
  const key = selected ? "active" : "wave";
  if (!colors[key] && typeof document !== "undefined") {
    const token = selected ? "--color-edit-wave-active" : "--color-edit-wave";
    colors[key] = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  }
  return colors[key] ?? "";
}

/**
 * An audio clip's waveform under its volume curve: one bar per 3px, mirrored
 * about the block's centre, as tall as the loudest sample in the source
 * time it covers (sequence time + sourceOffset: a clip's In less its start),
 * in grey (lighter while the clip is selected). Drawn to a canvas across the
 * visible part of the block only, so a long sequence at a high zoom never
 * makes a canvas too large to draw. No bars inside a slot: it takes no time.
 */
export function Waveform({
  peaks,
  duration,
  axis,
  blockX,
  blockWidth,
  height,
  selected = false,
  viewLeft,
  viewRight,
  sourceOffset = 0,
}: {
  peaks: Float32Array;
  duration: number;
  axis: TimeAxis;
  /** The block on the lane. */
  blockX: number;
  blockWidth: number;
  height: number;
  /** The clip is selected: the lighter grey. */
  selected?: boolean;
  /** The lane range to draw (the visible lanes with an overscan). */
  viewLeft: number;
  viewRight: number;
  /** Source seconds less sequence seconds. */
  sourceOffset?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const left = Math.max(0, Math.floor(viewLeft - blockX));
  const right = Math.min(Math.ceil(blockWidth), Math.ceil(viewRight - blockX));
  const width = Math.max(0, right - left);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    const color = waveColor(selected);
    if (!ctx || !color) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    const barWidth = BAR_WIDTH;
    const reach = height * BAR_REACH;
    const centre = height / 2;
    for (let k = Math.floor(left / BAR_PITCH); k * BAR_PITCH < right; k++) {
      const x0 = blockX + k * BAR_PITCH;
      const x1 = x0 + BAR_PITCH;
      if (axis.slots.some((slot) => x1 > slot.x && x0 < slot.x + slot.width)) continue;
      const peak = peakInRange(peaks, duration, axis.xToTime(x0) + sourceOffset, axis.xToTime(x1) + sourceOffset);
      if (peak <= 0) continue;
      const barHeight = Math.max(1, peak * reach);
      // On whole pixels, so a bar stays sharp at a device pixel ratio of 1
      ctx.fillRect(k * BAR_PITCH - left, centre - barHeight / 2, barWidth, barHeight);
    }
  }, [peaks, duration, axis, blockX, left, right, width, height, selected, sourceOffset]);

  if (width === 0) return null;
  return (
    <canvas
      ref={ref}
      aria-hidden="true"
      data-testid="stitch-waveform"
      className="pointer-events-none absolute top-0"
      style={{ left, width, height }}
    />
  );
}
