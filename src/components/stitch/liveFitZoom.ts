/**
 * The mounted timeline's px/s, as its axis last drew it; null while no
 * timeline is mounted. The timeline sets it on each render and clears it on
 * unmount. The rail and the keys move clips from outside the timeline and
 * cannot read its axis: a move made in Fit stores this first (keepZoom in
 * editorActions), so the lane keeps the zoom the move was drawn at.
 */

let current: number | null = null;

export const liveFitZoom = {
  get(): number | null {
    return current;
  },
  set(pxPerSec: number | null): void {
    current = pxPerSec !== null && Number.isFinite(pxPerSec) && pxPerSec > 0 ? pxPerSec : null;
  },
};
