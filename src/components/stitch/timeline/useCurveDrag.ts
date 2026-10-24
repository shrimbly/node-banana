import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import {
  addPoint,
  gainAt,
  gainToLevel,
  MIN_POINT_GAP_SEC,
  movePoint,
  offsetCurve,
} from "@/lib/stitch/curve";
import {
  curvePolyline,
  distanceToPolyline,
  levelToY,
  pointerToPoint,
  type CurveMetrics,
  type CurveWindow,
} from "@/lib/stitch/curveGeometry";
import type { TimeAxis } from "@/lib/stitch/timeAxis";
import type { VolumePoint } from "@/types";
import { releaseTypingFocus } from "./releaseTypingFocus";

/**
 * Editing an audio clip's volume curve, on the single selected clip of an
 * expanded row. A press on a point drags it (its neighbours bound it); a
 * press on the line adds a point there and drags that; ⌥ held at the press
 * moves the whole line up or down. While the pointer moves the curve is this
 * hook's state only; on release it is written once (the added point with
 * its move), so a gesture is one undo step and nothing reaches the workflow
 * store. Escape cancels. A double-click on a point removes it. A press that
 * hits neither a point nor the line is not the curve's (onPointerDown says
 * false), and the box takes it. Times are the clip's source seconds, drawn
 * through its window; the pointer is read against the lane's content, so a
 * scroll during the drag keeps the point under it.
 */

/** A press this close to a point's centre takes the point. */
const POINT_HIT_PX = 7;
/** A press this close to the line adds a point on it. */
const LINE_HIT_PX = 6;
/** Travel before a press moves anything, so a click that selects a point (or starts a double-click) leaves it put. */
const DRAG_START_PX = 3;
/** Two presses this close in time and on screen are a double-click's. */
const DOUBLE_PRESS_MS = 500;
const DOUBLE_PRESS_PX = 5;

export interface CurveDragLive {
  curve: VolumePoint[];
  /** The point being dragged; null while ⌥ moves the whole line. */
  index: number | null;
}

/** Where a click would add a point: on the line under the pointer, lane x and block y. */
export interface CurveHover {
  x: number;
  y: number;
}

interface CurveDragOptions {
  axis: TimeAxis;
  metrics: CurveMetrics;
  /** The clip's part of its curve and where it is drawn. */
  curveWindow: CurveWindow;
  /** The lane content (pointer x is measured from its left) and the audio block (y from its top). */
  contentRef: RefObject<HTMLDivElement | null>;
  blockRef: RefObject<HTMLDivElement | null>;
  /** Off unless the clip is the single selection on an expanded row, unmuted: every press is the box's. */
  editable: boolean;
  /** The curve as the draft holds it now; undefined once the clip is gone. */
  read: () => readonly VolumePoint[] | undefined;
  /** One gesture's result, as one undo step. */
  write: (curve: VolumePoint[]) => void;
  /** The clip selected with this curve point (null: none), its last press on the curve. */
  selectPoint: (point: number | null) => void;
  /** A double-click on a point takes it off. */
  removePoint: (index: number) => void;
}

type Hit = { kind: "point"; index: number } | { kind: "line" } | { kind: "none" };

/** One press on the block, kept to tell a double-click's two apart. */
interface Press {
  time: number;
  clientX: number;
  clientY: number;
  /** The curve took this press. */
  editable: boolean;
  /** The point it took, and the curve it took it on. */
  point: number | null;
  curve: readonly VolumePoint[] | undefined;
}

const inWindow = (t: number, w: CurveWindow) => t >= w.from && t <= w.to;

/**
 * The drawn points (inside the window) nearest the pointer, then the line. On the line, a point closer in time
 * than MIN_POINT_GAP_SEC is the hit: adding one there would replace it (an instant step's two points, drawn as a
 * tall vertical segment, would both go).
 */
function hitTest(
  curve: readonly VolumePoint[],
  axis: TimeAxis,
  m: CurveMetrics,
  w: CurveWindow,
  x: number,
  y: number,
): Hit {
  let index = -1;
  let best = POINT_HIT_PX;
  curve.forEach((p, i) => {
    if (!inWindow(p.t, w)) return;
    const d = Math.hypot(axis.timeToX(p.t - w.offset) - x, levelToY(gainToLevel(p.gain), m) - y);
    if (d <= best) {
      best = d;
      index = i;
    }
  });
  if (index !== -1) return { kind: "point", index };
  if (distanceToPolyline({ x, y }, curvePolyline(curve, axis.total, axis, m, w)) > LINE_HIT_PX) return { kind: "none" };
  const t = pointerToPoint(x, y, axis, m, axis.total, w).t;
  let near = -1;
  let nearest = MIN_POINT_GAP_SEC;
  curve.forEach((p, i) => {
    const gap = Math.abs(p.t - t);
    if (inWindow(p.t, w) && gap < nearest) {
      nearest = gap;
      near = i;
    }
  });
  return near === -1 ? { kind: "line" } : { kind: "point", index: near };
}

export function useCurveDrag(options: CurveDragOptions) {
  const { contentRef, blockRef, editable } = options;
  const [live, setLive] = useState<CurveDragLive | null>(null);
  const [hover, setHover] = useState<CurveHover | null>(null);
  const [overPoint, setOverPoint] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  // The last press, and the one before it when the two make a double-click
  const lastPress = useRef<Press | null>(null);
  const pairedPress = useRef<Press | null>(null);
  // The press measures with the axis it saw last, which a zoom mid-drag cannot change (the ⌘ wheel waits)
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => () => stop.current?.(), []);

  const position = useCallback(
    (clientX: number, clientY: number) => ({
      x: clientX - (contentRef.current?.getBoundingClientRect().left ?? 0),
      y: clientY - (blockRef.current?.getBoundingClientRect().top ?? 0),
    }),
    [contentRef, blockRef],
  );

  /** Whether the curve takes the press: a point, the line, or ⌥ anywhere on an editable box. */
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>): boolean => {
      if (event.button !== 0) return false;
      const { axis: pressAxis, metrics: m, curveWindow: w, editable: canEdit, read, write, selectPoint } = latest.current;
      const curveAtStart = read();
      const prev = lastPress.current;
      const repeat =
        prev !== null &&
        event.timeStamp - prev.time < DOUBLE_PRESS_MS &&
        Math.hypot(event.clientX - prev.clientX, event.clientY - prev.clientY) <= DOUBLE_PRESS_PX;
      pairedPress.current = repeat ? prev : null;
      const press: Press = {
        time: event.timeStamp,
        clientX: event.clientX,
        clientY: event.clientY,
        editable: false,
        point: null,
        curve: curveAtStart,
      };
      lastPress.current = press;
      if (!curveAtStart || !canEdit) return false;
      const at = position(event.clientX, event.clientY);
      const hit = event.altKey ? null : hitTest(curveAtStart, pressAxis, m, w, at.x, at.y);
      if (hit?.kind === "none") return false;
      releaseTypingFocus(event.currentTarget);
      event.preventDefault();
      stop.current?.();
      press.editable = true;

      // The curve the move starts from, and the point it moves: an added point is on the line where it was pressed
      let base: VolumePoint[] = curveAtStart.slice();
      let index: number | null = null;
      let added = false;
      if (hit?.kind === "point") {
        index = hit.index;
        press.point = index;
        selectPoint(index);
      } else if (hit?.kind === "line") {
        const t = pointerToPoint(at.x, at.y, pressAxis, m, pressAxis.total, w).t;
        const result = addPoint(curveAtStart, t);
        if (result.index === -1) return true;
        base = result.curve;
        index = result.index;
        added = true;
      } else {
        selectPoint(null);
      }
      // The pointer's offset from the point's centre, in lane content and block coordinates
      const startPoint = index === null ? null : base[index];
      const offsetX = startPoint ? at.x - pressAxis.timeToX(startPoint.t - w.offset) : 0;
      const offsetY = startPoint ? at.y - levelToY(gainToLevel(startPoint.gain), m) : 0;

      const target = event.currentTarget;
      const pointerId = event.pointerId;
      target.setPointerCapture?.(pointerId);
      const scroller = contentRef.current?.parentElement ?? null;
      let lastClientX = event.clientX;
      let lastClientY = event.clientY;
      let moved = false;
      let current: CurveDragLive = { curve: base, index };

      // Measured on the lane's content as it is now, so a scroll since the press counts as travel
      const update = () => {
        const p = position(lastClientX, lastClientY);
        if (!moved && Math.hypot(p.x - at.x, p.y - at.y) < DRAG_START_PX) return;
        moved = true;
        if (index === null) {
          current = { curve: offsetCurve(curveAtStart, (p.y - at.y) / m.span, w.to), index: null };
        } else {
          const point = pointerToPoint(p.x - offsetX, p.y - offsetY, pressAxis, m, pressAxis.total, w);
          current = { curve: movePoint(base, index, point.t, point.gain), index };
        }
        setLive(current);
      };

      const end = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", end);
        scroller?.removeEventListener("scroll", update);
        if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
        stop.current = null;
        setLive(null);
        const s = useStitchEditorStore.getState();
        if (s.cancelGesture === end) s.setCancelGesture(null);
      };
      const onMove = (e: PointerEvent) => {
        lastClientX = e.clientX;
        lastClientY = e.clientY;
        update();
      };
      const onUp = (e: PointerEvent) => {
        onMove(e);
        end();
        if (!moved && !added) return;
        // A draft that changed under the drag is not overwritten with what was measured against the old one
        if (latest.current.read() !== curveAtStart) return;
        write(current.curve);
        // The store forgets a point when the curve changes: the dragged one is selected again by its new index
        latest.current.selectPoint(current.index);
      };

      setHover(null);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", end);
      scroller?.addEventListener("scroll", update, { passive: true });
      stop.current = end;
      useStitchEditorStore.getState().setCancelGesture(end);
      setLive(current);
      return true;
    },
    [position, contentRef],
  );

  /**
   * Removes a point only when both presses of the double-click took that point, on the lane as it is, and neither
   * changed the curve: a double-click that opened the lane, or one on the line, removes nothing.
   */
  const onDoubleClick = useCallback(() => {
    const first = pairedPress.current;
    const second = lastPress.current;
    const curve = latest.current.read();
    if (!latest.current.editable || !curve || !first || !second) return;
    if (!first.editable || !second.editable || first.point === null || first.point !== second.point) return;
    if (first.curve !== curve || second.curve !== curve) return;
    latest.current.removePoint(second.point);
  }, []);

  /** The hover ghost and its "Add point" chip: only over the line, away from the points, with no drag running. */
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const { axis: a, metrics: m, curveWindow: w, editable: canEdit, read } = latest.current;
      const curve = read();
      if (!canEdit || !curve || stop.current || event.altKey) {
        setHover(null);
        setOverPoint(false);
        return;
      }
      const at = position(event.clientX, event.clientY);
      const hit = hitTest(curve, a, m, w, at.x, at.y);
      setOverPoint(hit.kind === "point");
      if (hit.kind !== "line") {
        setHover(null);
        return;
      }
      const x = Math.min(Math.max(at.x, a.timeToX(w.from - w.offset)), a.timeToX(w.to - w.offset));
      setHover({ x, y: levelToY(gainToLevel(gainAt(curve, a.xToTime(x) + w.offset)), m) });
    },
    [position],
  );
  const onPointerLeave = useCallback(() => {
    setHover(null);
    setOverPoint(false);
  }, []);

  return {
    live,
    hover: editable ? hover : null,
    /** The pointer is over a point it can drag. */
    overPoint: editable && overPoint,
    onPointerDown,
    onDoubleClick,
    onPointerMove,
    onPointerLeave,
  };
}
