import { useState, useEffect, useRef, useCallback, useDeferredValue } from "react";
import { useStore, type ReactFlowState } from "@xyflow/react";
import { generateThumbnail } from "@/utils/imageThumbnail";
import {
  getThumbnail,
  setThumbnail,
  getPending,
  setPending,
  removePending,
} from "@/store/thumbnailCache";

const EFFECTIVE_WIDTH_THRESHOLD = 200;
const DEFAULT_NODE_WIDTH = 350;

/**
 * Returns an adaptive image source that swaps between a small JPEG thumbnail
 * and the full-resolution image based on how large the node appears on screen.
 *
 * - When `nodeWidth * zoom < 300px` → returns thumbnail (~256px JPEG)
 * - Otherwise → returns full source
 * - Thumbnails are generated eagerly when fullSrc changes and cached in memory
 */
export function useAdaptiveImageSrc(
  fullSrc: string | null | undefined,
  nodeId: string
): string | null {
  // Read zoom (quantized to 0.1 steps) and node width in a single selector
  // to minimize re-renders
  const shouldUseThumbnail = useStore(
    useCallback(
      (state: ReactFlowState) => {
        const zoom = state.transform[2];
        const node = state.nodeLookup.get(nodeId);
        const width =
          node?.measured?.width ?? (node as Record<string, unknown>)?.width as number ?? DEFAULT_NODE_WIDTH;
        return (width as number) * zoom < EFFECTIVE_WIDTH_THRESHOLD;
      },
      [nodeId]
    ),
    // Only re-render when the boolean result changes
    (a, b) => a === b
  );
  // Every image node crosses the threshold on the same zoom step, so the
  // swap is deferred and React spreads it across frames instead of
  // re-rendering them all in one
  const thumbnailWanted = useDeferredValue(shouldUseThumbnail);

  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(null);
  const prevSrcRef = useRef<string | null>(null);

  // Eagerly generate thumbnail when fullSrc changes
  useEffect(() => {
    if (!fullSrc) {
      setThumbnailSrc(null);
      prevSrcRef.current = null;
      return;
    }

    // Skip if same source
    if (fullSrc === prevSrcRef.current) return;
    prevSrcRef.current = fullSrc;

    // Check cache first
    const cached = getThumbnail(fullSrc);
    if (cached) {
      setThumbnailSrc(cached);
      return;
    }

    // Check if generation is already in progress
    const existing = getPending(fullSrc);
    if (existing) {
      existing
        .then((thumb) => {
          if (prevSrcRef.current === fullSrc) {
            setThumbnailSrc(thumb);
          }
        })
        .catch(() => {});
      return;
    }

    // Generate thumbnail
    const promise = generateThumbnail(fullSrc)
      .then((thumb) => {
        setThumbnail(fullSrc, thumb);
        if (prevSrcRef.current === fullSrc) {
          setThumbnailSrc(thumb);
        }
        return thumb;
      })
      .finally(() => {
        removePending(fullSrc);
      });
    setPending(fullSrc, promise);

    // Suppress unhandled rejection — fullSrc falls back gracefully
    promise.catch(() => {});
  }, [fullSrc]);

  if (!fullSrc) return null;

  return thumbnailWanted && thumbnailSrc ? thumbnailSrc : fullSrc;
}
