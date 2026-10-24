"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";

/**
 * A file drag over a drop target hears dragover every few hundred ms, even holding still: after this long without one
 * it has gone, also when a child it entered was replaced under it (which hears no dragleave).
 */
const FILE_DRAG_GONE_MS = 1_000;

/** A drop target while files are dragged over it: edit-line is lost on the pane's ground, this reads as a quiet frame. */
export const FILE_DROP_FRAME = "ring-1 ring-inset ring-white/15";

/**
 * Only a drag of files from the computer over the target itself: the editor's own drags are pointer events, never one
 * of these, and the events of a sheet or menu the target opens reach it too, though they are portalled elsewhere.
 */
const isFileDrag = (event: ReactDragEvent) =>
  event.currentTarget.contains(event.target as Node) && Array.from(event.dataTransfer?.types ?? []).includes("Files");

/**
 * An element as a drop target for files from the computer (the Edit video view's media pane, Add media): whether a
 * file drag is over it, and the handlers to spread on it. Entering and leaving its children fires on it too, so it
 * counts them. The dropped files go to `onFiles`, all of them, in the order given. While it is off, a file dropped on
 * it is still taken (the browser would open it), and nothing else happens.
 */
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const gone = useRef<number | null>(null);
  // The latest for the handlers, which are made once
  const latest = useRef({ onFiles, enabled });
  useEffect(() => {
    latest.current = { onFiles, enabled };
  });
  useEffect(
    () => () => {
      if (gone.current !== null) window.clearTimeout(gone.current);
    },
    [],
  );

  const handlers = useMemo(() => {
    const stop = () => {
      depth.current = 0;
      setOver(false);
      if (gone.current !== null) window.clearTimeout(gone.current);
      gone.current = null;
    };
    const stillOver = () => {
      if (gone.current !== null) window.clearTimeout(gone.current);
      gone.current = window.setTimeout(stop, FILE_DRAG_GONE_MS);
    };
    return {
      onDragEnter: (event: ReactDragEvent) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (!latest.current.enabled) return;
        depth.current += 1;
        setOver(true);
        stillOver();
      },
      onDragOver: (event: ReactDragEvent) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (!latest.current.enabled) {
          event.dataTransfer.dropEffect = "none";
          return;
        }
        event.dataTransfer.dropEffect = "copy";
        stillOver();
      },
      onDragLeave: (event: ReactDragEvent) => {
        if (!isFileDrag(event) || !latest.current.enabled) return;
        depth.current -= 1;
        if (depth.current <= 0) stop();
      },
      onDrop: (event: ReactDragEvent) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        stop();
        if (latest.current.enabled) latest.current.onFiles(Array.from(event.dataTransfer.files ?? []));
      },
    };
  }, []);
  return { over: over && enabled, handlers };
}

/** "Drop to add" across the foot of a drop target, inside its frame, while files are over it; what it holds stays shown. */
export function DropToAdd() {
  return (
    <p className="pointer-events-none absolute inset-x-px bottom-px flex h-11 items-center justify-center bg-pane text-xs text-ink-3">
      Drop to add
    </p>
  );
}
