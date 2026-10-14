import { useEffect, type RefObject } from "react";
import { useReactFlow } from "@xyflow/react";
import type { CanvasNavigationSettings } from "@/types/canvas";
import { setCanvasWheelPanningClass } from "@/utils/canvasPerformance";

/**
 * Wheel-based pan/zoom for a React Flow canvas, honoring the user's
 * CanvasNavigationSettings. Shared by the main canvas and the split-grid cell
 * editor's mini canvas so both navigate identically (e.g. trackpad scroll pans
 * when zoomMode is altScroll/ctrlScroll).
 *
 * Uses a non-passive wheel listener so it can preventDefault (blocking browser
 * back/forward swipe and React Flow's built-in scroll zoom). The React Flow
 * instance it drives is the nearest ReactFlowProvider's — call this inside the
 * provider whose viewport you want to control. Set `zoomOnScroll={false}` on
 * that ReactFlow so it doesn't also zoom on scroll.
 */

export const isMacOS =
  typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

interface ViewportState {
  x: number;
  y: number;
  zoom: number;
}

interface ViewportPanBatcherOptions {
  getViewport: () => ViewportState;
  setViewport: (viewport: ViewportState) => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
}

interface PanActivityTrackerOptions {
  setActive: (active: boolean) => void;
  endDelayMs?: number;
  scheduleEnd?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelEnd?: (handle: ReturnType<typeof setTimeout>) => void;
}

export function createPanActivityTracker({
  setActive,
  endDelayMs = 120,
  scheduleEnd = setTimeout,
  cancelEnd = clearTimeout,
}: PanActivityTrackerOptions): { signal: () => void; dispose: () => void } {
  let active = false;
  let endTimer: ReturnType<typeof setTimeout> | null = null;

  const deactivate = () => {
    endTimer = null;
    if (!active) return;
    active = false;
    setActive(false);
  };

  return {
    signal() {
      if (!active) {
        active = true;
        setActive(true);
      }
      if (endTimer !== null) cancelEnd(endTimer);
      endTimer = scheduleEnd(deactivate, endDelayMs);
    },
    dispose() {
      if (endTimer !== null) cancelEnd(endTimer);
      endTimer = null;
      if (active) {
        active = false;
        setActive(false);
      }
    },
  };
}

export function createViewportPanBatcher({
  getViewport,
  setViewport,
  requestFrame = requestAnimationFrame,
  cancelFrame = cancelAnimationFrame,
}: ViewportPanBatcherOptions): {
  queue: (deltaX: number, deltaY: number) => void;
  dispose: () => void;
} {
  let frameId: number | null = null;
  let pendingDeltaX = 0;
  let pendingDeltaY = 0;

  const flush = () => {
    frameId = null;
    const viewport = getViewport();
    setViewport({
      x: viewport.x - pendingDeltaX,
      y: viewport.y - pendingDeltaY,
      zoom: viewport.zoom,
    });
    pendingDeltaX = 0;
    pendingDeltaY = 0;
  };

  return {
    queue(deltaX, deltaY) {
      pendingDeltaX += deltaX;
      pendingDeltaY += deltaY;
      if (frameId === null) frameId = requestFrame(flush);
    },
    dispose() {
      if (frameId !== null) cancelFrame(frameId);
      frameId = null;
      pendingDeltaX = 0;
      pendingDeltaY = 0;
    },
  };
}

// Detect if a wheel event is from a mouse (vs trackpad).
export function isMouseWheel(event: WheelEvent): boolean {
  // Mouse wheels typically use deltaMode 1 (lines); trackpads use deltaMode 0
  // (pixels) with smaller, smoother deltas.
  if (event.deltaMode === 1) return true;
  const threshold = 50;
  return Math.abs(event.deltaY) >= threshold && Math.abs(event.deltaY) % 40 === 0;
}

// Whether an element can scroll further in the wheel's direction.
function canElementScroll(element: HTMLElement, deltaX: number, deltaY: number): boolean {
  const style = window.getComputedStyle(element);
  const canScrollY = style.overflowY === "auto" || style.overflowY === "scroll";
  const canScrollX = style.overflowX === "auto" || style.overflowX === "scroll";

  if (canScrollY && deltaY !== 0 && element.scrollHeight > element.clientHeight) {
    if (deltaY > 0 && element.scrollTop < element.scrollHeight - element.clientHeight) return true;
    if (deltaY < 0 && element.scrollTop > 0) return true;
  }
  if (canScrollX && deltaX !== 0 && element.scrollWidth > element.clientWidth) {
    if (deltaX > 0 && element.scrollLeft < element.scrollWidth - element.clientWidth) return true;
    if (deltaX < 0 && element.scrollLeft > 0) return true;
  }
  return false;
}

// Nearest scrollable ancestor (nowheel/textarea) that can consume the wheel,
// so inner scroll areas keep their own scrolling instead of panning the canvas.
export function findScrollableAncestor(
  target: HTMLElement,
  deltaX: number,
  deltaY: number
): HTMLElement | null {
  let current: HTMLElement | null = target;
  while (current && !current.classList.contains("react-flow")) {
    if (current.classList.contains("nowheel") || current.tagName === "TEXTAREA") {
      if (canElementScroll(current, deltaX, deltaY)) return current;
    }
    current = current.parentElement;
  }
  return null;
}

export type WheelAction = "zoomIn" | "zoomOut" | "pan" | "ignore";

/**
 * What a wheel event outside an inner scroll area does to the canvas, by the
 * navigation settings, the device and the platform (the GPU canvas asks too).
 */
export function wheelAction(event: WheelEvent, settings: CanvasNavigationSettings, mac = isMacOS): WheelAction {
  const { zoomMode } = settings;
  const shouldZoom =
    zoomMode === "scroll" ||
    (zoomMode === "altScroll" && event.altKey) ||
    (zoomMode === "ctrlScroll" && (event.ctrlKey || event.metaKey));
  const zoom = event.deltaY < 0 ? "zoomIn" : "zoomOut";

  // Pinch gesture (ctrl + trackpad) always zooms.
  if (event.ctrlKey && !event.altKey) return zoom;
  if (shouldZoom) return zoom;
  // A macOS trackpad pans (which also blocks horizontal swipe navigation); a
  // mouse wheel, or any wheel elsewhere, zooms only when settings ask for it.
  if (mac && !isMouseWheel(event)) return "pan";
  return "ignore";
}

export function useWheelPanZoom(
  wrapperRef: RefObject<HTMLElement | null>,
  settings: CanvasNavigationSettings,
  enabled = true
): void {
  const { getViewport, setViewport, zoomIn, zoomOut } = useReactFlow();

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || !enabled) return;
    const panBatcher = createViewportPanBatcher({ getViewport, setViewport });
    const panActivity = createPanActivityTracker({
      setActive: (active) => setCanvasWheelPanningClass(active, wrapper),
    });

    const handleWheel = (event: WheelEvent) => {
      // Let inner scroll areas (nowheel/textarea) keep their own scrolling.
      const target = event.target as HTMLElement;
      if (findScrollableAncestor(target, event.deltaX, event.deltaY)) return;

      const action = wheelAction(event, settings);
      if (action === "ignore") return;
      event.preventDefault();
      if (action === "zoomIn") zoomIn();
      else if (action === "zoomOut") zoomOut();
      else {
        panActivity.signal();
        panBatcher.queue(event.deltaX, event.deltaY);
      }
    };

    wrapper.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      wrapper.removeEventListener("wheel", handleWheel);
      panBatcher.dispose();
      panActivity.dispose();
    };
  }, [wrapperRef, enabled, settings, getViewport, setViewport, zoomIn, zoomOut]);
}
