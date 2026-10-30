"use client";

import type { WeightPiece } from "@/lib/stitch/placement";

/** A mark narrower than this is not drawn. */
const MIN_MARK_PX = 2;
/** A weight this close to 0 or 1 is that end of a wedge. */
const WEDGE_EPS = 1e-6;

/** A fade drawn as its ramp: at the box's own side, or at `left` px inside it. */
function Wedge({ side, width, left }: { side: "in" | "out"; width: number; left?: number }) {
  const incoming = side === "in";
  const placed = left !== undefined;
  return (
    <svg
      aria-hidden="true"
      data-testid={incoming ? "stitch-crossfade-in" : "stitch-crossfade-out"}
      className={
        placed
          ? "pointer-events-none absolute inset-y-0"
          : incoming
            ? "pointer-events-none absolute inset-y-0 left-0"
            : "pointer-events-none absolute inset-y-0 right-0"
      }
      style={placed ? { left, width, height: "100%" } : { width, height: "100%" }}
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
    >
      <polygon points={incoming ? "0,0 1,0 0,1" : "0,0 1,0 1,1"} className="fill-black/40" />
      <line
        x1="0"
        y1={incoming ? 1 : 0}
        x2="1"
        y2={incoming ? 0 : 1}
        className="stroke-neutral-200/70"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * A lined-up Stacked clip's overlaps, drawn inside its box over the frames
 * (the box's radius clips them); a placed stack draws LayerMarks instead.
 * With Crossfade on, a wedge over the head it fades in on and one over the
 * tail it fades out on: the diagonal is the picture's ramp. With it off,
 * the head the clip above hides is darkened, with no hatch (the hatch means
 * "trimmed away"), and the tail has no mark: the clip is in front there.
 * Same-source cuts have no overlap, so no mark.
 */
export function CrossfadeMarks({
  overlapIn,
  overlapOut,
  pxPerSec,
  crossfade,
  coveredBy,
}: {
  /** Seconds this clip shares with the clip before it and the one after it. */
  overlapIn: number;
  overlapOut: number;
  pxPerSec: number;
  crossfade: boolean;
  /** The clip above, by name ("Clip 1"), for the covered head's title. */
  coveredBy: string | null;
}) {
  const head = overlapIn * pxPerSec;
  const tail = overlapOut * pxPerSec;
  if (!crossfade) {
    if (!(head >= MIN_MARK_PX)) return null;
    return (
      <div
        data-testid="stitch-covered-head"
        title={coveredBy ? `Hidden under ${coveredBy}. Its sound plays.` : undefined}
        className="absolute inset-y-0 left-0 bg-black/50"
        style={{ width: head }}
      />
    );
  }
  return (
    <>
      {head >= MIN_MARK_PX && <Wedge side="in" width={head} />}
      {tail >= MIN_MARK_PX && <Wedge side="out" width={tail} />}
    </>
  );
}

/** A weight that is not a plain fade in or out: the area above it darkened, and its line, over one piece. */
function WeightCurve({
  left,
  width,
  fromSec,
  toSec,
  points,
}: {
  left: number;
  width: number;
  fromSec: number;
  toSec: number;
  /** [own seconds, weight]. */
  points: ReadonlyArray<readonly [number, number]>;
}) {
  // y runs down: the weight w sits at 1 − w, so the area above it is from y 0 down to the line
  const xy = points.map(([t, w]) => `${t},${1 - w}`);
  const line = xy.join(" ");
  const area = `${fromSec},0 ${toSec},0 ${xy.slice().reverse().join(" ")}`;
  return (
    <svg
      aria-hidden="true"
      data-testid="stitch-weight-curve"
      className="pointer-events-none absolute inset-y-0"
      style={{ left, width, height: "100%" }}
      viewBox={`${fromSec} 0 ${toSec - fromSec} 1`}
      preserveAspectRatio="none"
    >
      <polygon points={area} className="fill-black/40" />
      <polyline
        points={line}
        fill="none"
        className="stroke-neutral-200/70"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * A placed clip's share of the picture over its own span (weightPieces), drawn inside its box: nothing where it is
 * the whole picture, a wedge where it fades in or out over the clips below or under one above, the darkened area
 * above its weight where several fades meet, and a dark band where a higher row hides it (Crossfade off: covered
 * there but still heard).
 */
export function LayerMarks({
  pieces,
  pxPerSec,
  crossfade,
  coverName,
}: {
  pieces: readonly WeightPiece[];
  pxPerSec: number;
  crossfade: boolean;
  /** The covering clip's name for a hidden band, from its row in the timeline the marks were built from. */
  coverName: (row: number) => string;
}) {
  return (
    <>
      {pieces.map((piece) => {
        const left = piece.fromSec * pxPerSec;
        const width = (piece.toSec - piece.fromSec) * pxPerSec;
        if (!(width >= MIN_MARK_PX)) return null;
        const key = `${piece.kind}:${piece.fromSec}`;
        if (piece.kind === "hidden") {
          const name = coverName(piece.coveredByRow);
          return (
            <div
              key={key}
              data-testid="stitch-hidden"
              title={crossfade ? `Hidden under ${name}.` : `Hidden under ${name}. Its sound plays.`}
              className="absolute inset-y-0 bg-black/50"
              style={{ left, width }}
            />
          );
        }
        if (piece.kind === "ramp") {
          const fadeIn = piece.from <= WEDGE_EPS && piece.to >= 1 - WEDGE_EPS;
          const fadeOut = piece.from >= 1 - WEDGE_EPS && piece.to <= WEDGE_EPS;
          if (fadeIn || fadeOut) return <Wedge key={key} side={fadeIn ? "in" : "out"} width={width} left={left} />;
        }
        const points: ReadonlyArray<readonly [number, number]> =
          piece.kind === "ramp"
            ? [
                [piece.fromSec, piece.from],
                [piece.toSec, piece.to],
              ]
            : piece.points;
        return <WeightCurve key={key} left={left} width={width} fromSec={piece.fromSec} toSec={piece.toSec} points={points} />;
      })}
    </>
  );
}
