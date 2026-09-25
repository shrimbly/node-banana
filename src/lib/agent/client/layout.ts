/**
 * Where the agent button and window sit on the canvas, and which part of the
 * canvas the user can actually see around them. Pure geometry, in CSS pixels
 * unless a name says "flow" (React Flow coordinates).
 */

/** The button's card: one 32px chrome icon button in a 4px inset, like the navigator's control row. */
export const AGENT_BUTTON_SIZE = 40;
/** Space between the navigator, the agent button and the window. */
export const AGENT_STACK_GAP = 8;
export const AGENT_PANEL_WIDTH = 400;
/** Keeps the window below the floating menu and workflow tabs. */
export const AGENT_PANEL_MIN_TOP = 56;
export const AGENT_PANEL_MAX_HEIGHT = 680;
/** The window never comes closer than this to the viewport's left edge (the navigator's margin). */
export const AGENT_PANEL_EDGE = 16;
/** Gap between the window's left edge and the canvas area treated as visible. */
const OCCLUSION_GAP = 16;

/** Bottom offset of the agent button: stacked above the canvas navigator, whatever its height. */
export function getAgentButtonBottom({ margin, navigatorHeight }: { margin: number; navigatorHeight: number }): number {
  return margin + navigatorHeight + AGENT_STACK_GAP;
}

export interface AgentPanelFrame {
  right: number;
  bottom: number;
  width: number;
  /** CSS max-height keeping the top edge at or below AGENT_PANEL_MIN_TOP. */
  maxHeight: string;
}

/**
 * The window's box: right-aligned with the button and stacked above it,
 * narrowing on a small viewport rather than running off the left edge.
 * Numeric (not a CSS clamp) so the occlusion maths stays right.
 */
export function getAgentPanelFrame({
  buttonRight,
  buttonBottom,
  viewportWidth,
}: {
  buttonRight: number;
  buttonBottom: number;
  /** window.innerWidth */
  viewportWidth: number;
}): AgentPanelFrame {
  const bottom = buttonBottom + AGENT_BUTTON_SIZE + AGENT_STACK_GAP;
  const maxHeight = `calc(100vh - ${bottom + AGENT_PANEL_MIN_TOP}px)`;
  const width = Math.max(0, Math.min(AGENT_PANEL_WIDTH, viewportWidth - buttonRight - AGENT_PANEL_EDGE));
  return { right: buttonRight, bottom, width, maxHeight };
}

/** Horizontal canvas pixels covered by the window, measured from the right edge. */
export function getAgentPanelOcclusion(frame: Pick<AgentPanelFrame, "right" | "width">): number {
  return frame.right + frame.width + OCCLUSION_GAP;
}

export interface FlowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The canvas area the user can see, in flow coordinates, leaving out the
 * strip the open agent window covers. When the window would leave too little
 * room (a narrow screen) the whole pane counts instead.
 */
export function getVisibleFlowRect({
  transform,
  paneWidth,
  paneHeight,
  occludedRight = 0,
}: {
  /** React Flow's [translateX, translateY, zoom]. */
  transform: readonly [number, number, number];
  paneWidth: number;
  paneHeight: number;
  occludedRight?: number;
}): FlowRect & { zoom: number } {
  const [tx, ty, rawZoom] = transform;
  const zoom = rawZoom > 0 ? rawZoom : 1;
  const unobstructed = paneWidth - occludedRight;
  const width = unobstructed >= 240 ? unobstructed : paneWidth;
  const round = (value: number) => Math.round(value);
  return {
    x: round(-tx / zoom),
    y: round(-ty / zoom),
    width: round(width / zoom),
    height: round(paneHeight / zoom),
    zoom: Math.round(zoom * 1000) / 1000,
  };
}

export function rectContains(outer: FlowRect, inner: FlowRect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}
