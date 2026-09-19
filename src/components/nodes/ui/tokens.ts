/**
 * Node anatomy constants, mirrored from the @theme tokens in globals.css.
 * Everything that has to be *computed* (socket tops, derived node heights,
 * width clamps) reads from here; everything that is only *painted* uses the
 * Tailwind tokens directly.
 */

/** Padding between the media card's border and the media clip. */
export const CARD_PAD = 4;

/** Centre of the first socket, measured from the media card's top edge. */
export const SOCKET_TOP = 24;
/** Distance between consecutive socket centres on one side. */
export const SOCKET_PITCH = 30;
/** Socket swell box (the Handle element itself). */
export const SOCKET_W = 18;
export const SOCKET_H = 28;
/** Hole radius and its ring, drawn inside the swell. */
export const SOCKET_HOLE_R = 3;
export const SOCKET_RING_W = 1.5;

/** Row between the media card and the controls card (history nav / scrubber). */
export const GAP_ROW_H = 28;
/** Spacing between the cards when the gap row has nothing to show. */
export const CONTROLS_GAP = 8;
/** Collapsed controls card: the summary row. */
export const SUMMARY_ROW_H = 28;
/** Controls card is `node width − CONTROLS_INSET`, capped at CONTROLS_MAX_W. */
export const CONTROLS_INSET = 24;
export const CONTROLS_MAX_W = 360;

/** Settings panel fields (tight density). */
export const FIELD_ROW_H = 22;
export const FIELD_GAP = 4;
export const FIELD_LABEL_W = 72;

/** Node width bounds. Height is always derived. */
export const NODE_MIN_W = 200;
export const NODE_MAX_W = 500;

/**
 * Minimum media-card height that fits `count` sockets on one side, keeping
 * the same breathing room below the last socket as above the first.
 */
export function socketMinHeight(count: number): number {
  if (count <= 0) return 0;
  return SOCKET_TOP + SOCKET_PITCH * (count - 1) + SOCKET_TOP;
}

/** Centre-line of socket `index` from the media card's top edge. */
export function socketCenter(index: number): number {
  return SOCKET_TOP + SOCKET_PITCH * index;
}
