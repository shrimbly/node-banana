"use client";

import { DB_GUIDES, dbToGain, gainToLevel } from "@/lib/stitch/curve";
import { curvePolyline, levelToY, type CurveMetrics, type CurveWindow } from "@/lib/stitch/curveGeometry";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { VolumePoint } from "@/types";
import type { CurveHover } from "./useCurveDrag";

/** −12 dB, drawn on the middle guide. */
const MINUS_12_LEVEL = gainToLevel(dbToGain(-12));

/** The guides' labels: 0 dB and −12 (−∞ is the block's foot, which needs none). */
const DB_LABELS = DB_GUIDES.filter((guide) => Number.isFinite(guide.db));
/** A label's left, clear of the block's In handle (or, scrolled, of the lanes' side padding), px. */
const DB_LABEL_X = 14;
/** A label's line, px: its foot sits 1px over its guide. */
const DB_LABEL_LINE = 12;
/**
 * A block narrower than this has no room for the labels beside its handles, px: it draws no guides either, so a
 * dashed line is never left unnamed (its curve still shows, and a dragged point's readout says its level).
 */
const DB_LABEL_MIN_WIDTH = 64;
/** What a label keeps to the block's right: itself and the Out handle, px. */
const DB_LABEL_ROOM = DB_LABEL_MIN_WIDTH - DB_LABEL_X;

/**
 * The dB labels' left in their block: 14px in from its left, or from where the lanes come into view once its left
 * has scrolled out under the side padding, so a long clip keeps its guides named wherever it is scrolled to; never
 * so far that they would leave the block (they go out of view with its end).
 */
function dbLabelLeft(blockX: number, blockWidth: number, lanesLeft: number): number {
  return Math.min(Math.max(DB_LABEL_X, lanesLeft - blockX + DB_LABEL_X), blockWidth - DB_LABEL_ROOM);
}

/**
 * An audio clip's volume curve over its block. Selected, the line in white
 * and a dot per point inside the clip's window (its In to its drawn end, in
 * its source seconds, drawn at sequence time t − offset). Not selected, it
 * is drawn only on the expanded row, as a faint line with no dots: at rest a
 * clip shows its waveform alone, as the boards do. Points outside the window
 * keep shaping the line to its ends, but are not drawn. A point at either
 * end of the window (a fade's) gets no dot, as on the boards: the block's
 * rounded edge would cut it in half. It still takes a press, and shows while
 * it is dragged or selected. Expanded, it adds the 0 dB and −12 dB guides,
 * each labelled just over it at the block's left, or at the lanes' left while
 * the block's start is scrolled out of view (what the track header's labels
 * said before the header went; a block too narrow for the labels draws no
 * guides), the dragged point drawn larger and the dashed ghost where a click
 * would add one. It draws only; the box takes the pointer.
 */
export function CurveLayer({
  curve,
  axis,
  metrics,
  window,
  blockX,
  blockWidth,
  lanesLeft,
  height,
  expanded,
  selected,
  dragIndex,
  selectedIndex,
  hover,
}: {
  curve: readonly VolumePoint[];
  axis: TimeAxis;
  metrics: CurveMetrics;
  window: CurveWindow;
  blockX: number;
  blockWidth: number;
  /** The lanes' first x in view, past the side padding that covers them once scrolled: where the labels stay. */
  lanesLeft: number;
  height: number;
  expanded: boolean;
  /** The clip is selected: the line in white, with its points. */
  selected: boolean;
  dragIndex: number | null;
  selectedIndex: number | null;
  hover: CurveHover | null;
}) {
  if (!selected && !expanded) return null;
  const poly = curvePolyline(curve, axis.total, axis, metrics, window).map((v) => ({ x: v.x - blockX, y: v.y }));
  if (poly.length === 0) return null;
  const line = poly.map((v) => `${v.x},${v.y}`).join(" ");
  const zeroDb = levelToY(0, metrics);
  const minus12 = levelToY(MINUS_12_LEVEL, metrics);
  // The guides only where their labels fit
  const guides = expanded && blockWidth >= DB_LABEL_MIN_WIDTH;
  const labelLeft = dbLabelLeft(blockX, blockWidth, lanesLeft);

  return (
    <>
      {guides &&
        DB_LABELS.map((guide) => (
          // On the clip's own ground, so the waveform under it never makes it hard to read; under the line and its dots
          <span
            key={guide.label}
            aria-hidden="true"
            data-testid="stitch-db-label"
            className="pointer-events-none absolute rounded-[3px] bg-edit-clip px-1 text-[9px] tabular-nums text-ink-3"
            style={{
              left: labelLeft,
              top: levelToY(gainToLevel(dbToGain(guide.db)), metrics) - DB_LABEL_LINE - 1,
              lineHeight: `${DB_LABEL_LINE}px`,
            }}
          >
            {guide.label}
          </span>
        ))}
      <svg
        aria-hidden="true"
        data-testid="stitch-curve"
        className="pointer-events-none absolute inset-0 overflow-visible"
        width={blockWidth}
        height={height}
      >
        {guides && (
          <g data-testid="stitch-db-guides" strokeWidth={1} strokeDasharray="3 3">
            <line x1={0} x2={blockWidth} y1={zeroDb + 0.5} y2={zeroDb + 0.5} className="stroke-white/10" />
            <line x1={0} x2={blockWidth} y1={minus12 + 0.5} y2={minus12 + 0.5} className="stroke-white/7" />
          </g>
        )}
        <polyline
          points={line}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          className={selected ? "stroke-neutral-100" : "stroke-white/35"}
        />
        {(selected || dragIndex !== null) && curve.map((p, i) => {
          if (p.t < window.from || p.t > window.to) return null;
          const big = expanded && (i === dragIndex || (dragIndex === null && i === selectedIndex));
          if (!big && (p.t <= window.from || p.t >= window.to)) return null;
          return (
            <circle
              key={i}
              data-testid="stitch-curve-point"
              data-index={i}
              data-selected={i === selectedIndex || undefined}
              cx={axis.timeToX(p.t - window.offset) - blockX}
              cy={levelToY(gainToLevel(p.gain), metrics)}
              r={big ? 6 : 4}
              strokeWidth={2}
              className="fill-neutral-100 stroke-edit-clip"
            />
          );
        })}
        {hover && (
          <circle
            cx={hover.x - blockX}
            cy={hover.y}
            r={4}
            fill="none"
            strokeWidth={1.5}
            strokeDasharray="2 2"
            className="stroke-neutral-100/60"
          />
        )}
      </svg>
    </>
  );
}
