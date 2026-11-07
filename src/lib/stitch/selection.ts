/**
 * The editor's clip selection: one lead clip, and any others selected with
 * it. A selection holds video clips or audio clips, never both; the
 * functions here work on either, given its order (the timeline's for video,
 * row then start then id for audio). They return a video selection; the
 * audio one takes the same ids. Pure: ids and an order, no store.
 */

/** The ids a selection holds, whatever kind of clip it selects. */
export interface SelectionIds {
  /** The lead: the rail's single-clip view, the lane's tab stop, the clip a single-clip key acts on. */
  clipId: string;
  /** Every selected clip in its order, the lead among them. Absent (or one id) = the lead alone. */
  clipIds?: readonly string[];
  /** Where ⇧-click ranges from. Absent = the lead. */
  anchorId?: string;
}

/** Video clips selected in the editor. */
export interface ClipSelection extends SelectionIds {
  kind: "clip";
}

/** The selected ids in timeline order: clipIds, else [clipId]. Ids not in `order` are dropped. */
export function clipIdsOf(selection: SelectionIds | null | undefined, order: readonly string[]): string[] {
  if (!selection) return [];
  const ids = new Set(selection.clipIds && selection.clipIds.length > 0 ? selection.clipIds : [selection.clipId]);
  return order.filter((id) => ids.has(id));
}

/**
 * A selection of `ids` (any order), or null when none is in `order`. clipIds is sorted by `order`, deduplicated, and
 * left out when only one id remains. The lead is `lead` if selected, else the first id. The anchor is `anchor` if
 * selected and different from the lead, else left out.
 */
export function makeSelection(
  order: readonly string[],
  ids: readonly string[],
  lead?: string,
  anchor?: string,
): ClipSelection | null {
  const wanted = new Set(ids);
  const selected = order.filter((id) => wanted.has(id));
  if (selected.length === 0) return null;
  const clipId = lead !== undefined && selected.includes(lead) ? lead : selected[0];
  const anchorId = anchor !== undefined && anchor !== clipId && selected.includes(anchor) ? anchor : undefined;
  return {
    kind: "clip",
    clipId,
    ...(selected.length > 1 ? { clipIds: selected } : {}),
    ...(anchorId !== undefined ? { anchorId } : {}),
  };
}

/** ⌘-click: id joins, or leaves when already in. Joining makes it the lead and the anchor. Leaving the last one → null. */
export function toggleClip(order: readonly string[], current: SelectionIds | null, id: string): ClipSelection | null {
  const ids = clipIdsOf(current, order);
  if (!order.includes(id)) return makeSelection(order, ids, current?.clipId, current?.anchorId);
  if (!ids.includes(id)) return makeSelection(order, [...ids, id], id, id);
  return makeSelection(
    order,
    ids.filter((other) => other !== id),
    current?.clipId === id ? undefined : current?.clipId,
    current?.anchorId,
  );
}

/** ⇧-click: the run from the anchor (else the lead, else id) to id, inclusive. Lead = id; anchor kept. */
export function rangeTo(order: readonly string[], current: SelectionIds | null, id: string): ClipSelection {
  const to = order.indexOf(id);
  if (to === -1) return { kind: "clip", clipId: id };
  const anchor = [current?.anchorId, current?.clipId].find((c) => c !== undefined && order.includes(c)) ?? id;
  const from = order.indexOf(anchor);
  const run = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  return makeSelection(order, run, id, anchor) ?? { kind: "clip", clipId: id };
}

/** ⌘A: every id. Lead kept if it is in order, else the first. Null when order is empty. */
export function selectAll(order: readonly string[], current: SelectionIds | null): ClipSelection | null {
  return makeSelection(order, order, current?.clipId, current?.anchorId);
}

export interface HitBox {
  x: number;
  width: number;
  top: number;
  height: number;
}

export interface LaneRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Indices of the boxes the rectangle touches: "x" tests x only (Track), "xy" both axes (Stacked). Touching edges count. */
export function boxHits(boxes: readonly HitBox[], rect: LaneRect, axes: "x" | "xy"): number[] {
  const hits: number[] = [];
  boxes.forEach((box, i) => {
    const inX = box.x <= rect.right && box.x + box.width >= rect.left;
    const inY = axes === "x" || (box.top <= rect.bottom && box.top + box.height >= rect.top);
    if (inX && inY) hits.push(i);
  });
  return hits;
}
