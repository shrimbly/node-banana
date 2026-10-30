/** A press becomes a drag once the pointer has travelled more than this, px. */
export const DRAG_START_PX = 4;
/** The lanes scroll while the pointer is this near their sides or the rows' top or bottom, this far each frame. */
const AUTO_SCROLL_EDGE_PX = 20;
const AUTO_SCROLL_STEP_PX = 6;

export const edgeSpeed = (at: number, from: number, to: number) =>
  at < from + AUTO_SCROLL_EDGE_PX ? -AUTO_SCROLL_STEP_PX : at > to - AUTO_SCROLL_EDGE_PX ? AUTO_SCROLL_STEP_PX : 0;
/** An edge's scroll, only once the pointer has travelled toward that edge since the press (travel: now − press). */
export const armed = (speed: number, travel: number) =>
  (speed > 0 && travel > DRAG_START_PX) || (speed < 0 && travel < -DRAG_START_PX) ? speed : 0;
