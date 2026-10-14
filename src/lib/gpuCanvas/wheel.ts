/**
 * What a wheel does on the GPU canvas: the classic canvas's two wheel
 * handlers in the order they see it. React Flow's zoom pane (d3-zoom) comes
 * first and takes a pinch, or a wheel with its zoom key held, zooming about
 * the pointer and stopping the event there. What it leaves goes to
 * `useWheelPanZoom` on the wrapper, which leaves an inner area that can
 * still scroll to the browser and otherwise steps the zoom 1.2x about the
 * centre, pans (a macOS trackpad) or does nothing. Chrome beside the pane
 * (the agent pill, the history drop-down) is the wrapper handler's alone.
 */
import { findScrollableAncestor, isMacOS, wheelAction } from "@/hooks/useWheelPanZoom";
import type { CanvasNavigationSettings } from "@/types/canvas";

export type SceneWheel =
  | { type: "zoom"; factor: number; about: "pointer" | "centre" }
  | { type: "pan"; dx: number; dy: number }
  /** Nothing moves, but the browser must not zoom the page either. */
  | { type: "block" }
  /** Left to the browser (an inner area scrolls, or the wheel does nothing). */
  | null;

export interface SceneWheelOptions {
  settings: CanvasNavigationSettings;
  /** React Flow's `zoomOnPinch` on classic (off in the tutorial and under a modal). */
  zoomOnPinch: boolean;
  /** Whether `useWheelPanZoom` runs on classic (off under a modal). */
  wrapperWheel: boolean;
  /**
   * The wheel is over React Flow's zoom pane (the nodes, connections and empty canvas), not over
   * chrome beside it (the agent pill, the history drop-down), which only the wrapper's handler sees.
   */
  pane?: boolean;
  /** React Flow's `panActivationKeyCode` is held (Space, in the "space" pan mode): it pans on scroll. */
  panKey?: boolean;
  mac?: boolean;
}

/** React Flow's d3 wheel delta: a zoom by 2^delta. */
function flowWheelDelta(event: WheelEvent, mac: boolean) {
  const factor = event.ctrlKey && mac ? 10 : 1;
  return -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * factor;
}

/** React Flow's panOnScrollSpeed default. */
const PAN_ON_SCROLL_SPEED = 0.5;

export function sceneWheel(event: WheelEvent, { settings, zoomOnPinch, wrapperWheel, pane = true, panKey = false, mac = isMacOS }: SceneWheelOptions): SceneWheel {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const noWheel = !!target?.closest(".nowheel");
  // The pan key turns React Flow's panOnScroll on, unless its zoom activation key (Meta on macOS,
  // Control elsewhere) is down too: then only a pinch zooms, and the event goes no further.
  if (pane && panKey && !noWheel && !(mac ? event.metaKey : event.ctrlKey)) {
    if (event.ctrlKey && zoomOnPinch) return { type: "zoom", factor: 2 ** flowWheelDelta(event, mac), about: "pointer" };
    const lines = event.deltaMode === 1 ? 20 : 1;
    // Shift sends a vertical wheel sideways off the Mac.
    const sideways = !mac && event.shiftKey;
    const dx = (sideways ? event.deltaY : event.deltaX) * lines, dy = sideways ? 0 : event.deltaY * lines;
    return { type: "pan", dx: dx * PAN_ON_SCROLL_SPEED, dy: dy * PAN_ON_SCROLL_SPEED };
  }
  // React Flow's zoom pane: a pinch (ctrl) when zoomOnPinch is on, or the zoom
  // activation key (Meta on macOS, Control elsewhere, which is the pinch's ctrl).
  const flowZooms = pane && (event.ctrlKey ? zoomOnPinch : mac && event.metaKey);
  if (flowZooms && !noWheel) return { type: "zoom", factor: 2 ** flowWheelDelta(event, mac), about: "pointer" };
  // A pinch over a .nowheel area never zooms the page (React Flow's rule).
  const held: SceneWheel = pane && event.ctrlKey && noWheel ? { type: "block" } : null;
  if (!wrapperWheel || (target && findScrollableAncestor(target, event.deltaX, event.deltaY))) return held;
  const action = wheelAction(event, settings, mac);
  if (action === "ignore") return held;
  if (action === "pan") return { type: "pan", dx: event.deltaX, dy: event.deltaY };
  // React Flow's zoomIn/zoomOut: a 1.2x step about the centre, whatever the delta.
  return { type: "zoom", factor: action === "zoomIn" ? 1.2 : 1 / 1.2, about: "centre" };
}

/**
 * A wheel on the canvas over a painted node's inner area that scrolls (a long prompt, a `.nowheel` list). On
 * classic that area is there and takes the wheel (findScrollableAncestor) before the canvas pans or steps its
 * zoom; on the GPU canvas the node is still a picture (or turning live, hidden until settled), so the wheel is
 * held instead of moving the view, and the ones after it reach the live node's area. A pinch or zoom-key zoom
 * still zooms over a textarea, as React Flow's zoom pane takes it first, but not over `.nowheel`.
 */
export function holdOverScrollArea(action: SceneWheel, area: { nowheel: boolean } | null): SceneWheel {
  if (!action || !area || action.type === "block") return action;
  if (action.type === "zoom" && action.about === "pointer" && !area.nowheel) return action;
  return { type: "block" };
}
