/**
 * Drag-to-reorder in the clips lane: which place a dragged clip would take,
 * and where the insertion bar marks it. Boxes are the lane's boxes in
 * sequence order (the dragged one included), in lane pixels. Pure.
 */

type Box = { x: number; width: number };

/** The final index for moveClip: how many of the other clips have their midpoint left of the pointer. */
export function dropIndexAt(x: number, boxes: ReadonlyArray<Box>, draggedIndex: number): number {
  let index = 0;
  boxes.forEach((box, i) => {
    if (i !== draggedIndex && box.x + box.width / 2 < x) index++;
  });
  return index;
}

/** x of the 3px insertion bar's centre for that drop index: in the gap between the clips it falls between. */
export function insertionX(dropIndex: number, boxes: ReadonlyArray<Box>, draggedIndex: number): number {
  const others = boxes.filter((_, i) => i !== draggedIndex);
  if (others.length === 0) return boxes[0]?.x ?? 0;
  if (dropIndex <= 0) return others[0].x - 2;
  if (dropIndex >= others.length) {
    const last = others[others.length - 1];
    return last.x + last.width + 2;
  }
  const before = others[dropIndex - 1];
  const after = others[dropIndex];
  return (before.x + before.width + after.x) / 2;
}

/** How many boxes outside `dragged` have their midpoint left of x: the toIndex for moveClipsBlock. */
export function blockDropIndexAt(x: number, boxes: ReadonlyArray<Box>, dragged: ReadonlySet<number>): number {
  let index = 0;
  boxes.forEach((box, i) => {
    if (!dragged.has(i) && box.x + box.width / 2 < x) index++;
  });
  return index;
}

/** insertionX for a block: the gap among the boxes outside `dragged`. */
export function blockInsertionX(dropIndex: number, boxes: ReadonlyArray<Box>, dragged: ReadonlySet<number>): number {
  const others = boxes.filter((_, i) => !dragged.has(i));
  if (others.length === 0) return boxes[0]?.x ?? 0;
  if (dropIndex <= 0) return others[0].x - 2;
  if (dropIndex >= others.length) {
    const last = others[others.length - 1];
    return last.x + last.width + 2;
  }
  const before = others[dropIndex - 1];
  const after = others[dropIndex];
  return (before.x + before.width + after.x) / 2;
}

/**
 * Stacked rows: the final index for moveClip from the lifted box's centre, dy pixels from its row. A row's centre
 * crossing half a row moves it one place.
 */
export function stackedDropIndex(index: number, dy: number, rowCount: number, rowHeight: number): number {
  if (rowCount <= 0) return 0;
  const steps = Number.isFinite(dy) && rowHeight > 0 ? Math.round(dy / rowHeight) : 0;
  return Math.min(Math.max(index + steps, 0), rowCount - 1);
}

/** y of the insertion bar's centre in the rows block: above the drop row moving up, below it moving down; null when unmoved. */
export function stackedInsertionY(dropIndex: number, draggedIndex: number, rowHeight: number): number | null {
  if (dropIndex === draggedIndex) return null;
  return dropIndex < draggedIndex ? dropIndex * rowHeight : (dropIndex + 1) * rowHeight;
}
