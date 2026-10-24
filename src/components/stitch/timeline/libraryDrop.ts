import type { LibraryDropTarget, LibraryItem } from "@/lib/stitch/libraryInsert";

/**
 * A library drag's live state, outside the editor store so its many subscribers do not re-run at pointer rate (the
 * repo's drags keep live state local). The mounted Timeline registers a probe that turns a pointer position into a
 * drop target from its own axis and boxes, and its lanes for the drag's auto-scroll; the drag sets the target it would
 * drop on (and the item, whose length the marker draws), and the lanes' marker draws it.
 */

export interface LibraryProbeOptions {
  /** Snap a start to the playhead and the clips' edges (the editor's Snap, ⇧ held turns it off). */
  snap: boolean;
}

export type LibraryDropProbe = (
  clientX: number,
  clientY: number,
  item: LibraryItem,
  opts?: LibraryProbeOptions,
) => LibraryDropTarget | null;

let probe: LibraryDropProbe | null = null;
let lanes: (() => HTMLElement | null) | null = null;
let target: LibraryDropTarget | null = null;
let dragged: LibraryItem | null = null;
const listeners = new Set<() => void>();

export const libraryDrop = {
  /** Registers the Timeline's probe (and its scrolling lanes); returns the unregister (which leaves a newer one alone). */
  register(next: LibraryDropProbe, scroller?: () => HTMLElement | null): () => void {
    probe = next;
    lanes = scroller ?? null;
    return () => {
      if (probe !== next) return;
      probe = null;
      lanes = null;
    };
  },
  /** Null when no Timeline is mounted or the point is over no lane that takes the item. */
  probe(clientX: number, clientY: number, item: LibraryItem, opts?: LibraryProbeOptions): LibraryDropTarget | null {
    return probe ? probe(clientX, clientY, item, opts) : null;
  },
  /** The Timeline's scrolling lanes, for the drag's auto-scroll; null when none is mounted. */
  lanes(): HTMLElement | null {
    return lanes?.() ?? null;
  },
  get(): LibraryDropTarget | null {
    return target;
  },
  /** The item being dragged while a target is set. */
  item(): LibraryItem | null {
    return dragged;
  },
  set(next: LibraryDropTarget | null, item: LibraryItem | null = null): void {
    const nextItem = next ? item : null;
    if (next === target && nextItem === dragged) return;
    target = next;
    dragged = nextItem;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
