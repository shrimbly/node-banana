/**
 * Bottom-chrome surface: one grey ramp shared by the action bar, its popovers
 * and the canvas navigator. Depth comes from alpha whites over neutral-800,
 * never from hue, so the minimap's node colours stay the only colour down there.
 */

/** Glass card: neutral-800 at 92% with blur, hairline border and top light. */
export const CHROME_SURFACE =
  "squircle border border-white/8 bg-neutral-800/92 backdrop-blur-md " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_1px_2px_rgba(0,0,0,0.4),0_12px_32px_-8px_rgba(0,0,0,0.5)]";

/** Icon button, sized by CHROME_ICON_BUTTON_SIZE: rest → hover lift → pressed dip. */
export const CHROME_ICON_BUTTON =
  "flex shrink-0 items-center justify-center rounded-lg squircle text-neutral-400 " +
  "transition-[background-color,color,transform] duration-[120ms] ease-out " +
  "hover:bg-white/7 hover:text-neutral-100 active:scale-[0.96] active:bg-white/12 active:text-white " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 " +
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-400";

/** md: navigator controls (32px). lg: the action bar (36px). */
export const CHROME_ICON_BUTTON_SIZE = { md: "h-8 w-8", lg: "h-9 w-9" } as const;

/** A button whose popover is up, or a stateful toggle that is on. */
export const CHROME_ICON_BUTTON_OPEN = "bg-white/10 text-white";

export const CHROME_DIVIDER = "mx-1 h-5 w-px shrink-0 bg-white/10";

/** Popover anchored above a bar button. */
export const CHROME_MENU =
  CHROME_SURFACE + " absolute bottom-full mb-2 flex flex-col gap-px rounded-[10px] p-1";

export const CHROME_MENU_ITEM =
  "flex h-7 w-full items-center gap-2 rounded-md squircle px-2 text-left text-[11px] font-medium " +
  "text-neutral-300 transition-colors duration-[120ms] hover:bg-white/7 hover:text-neutral-100 " +
  "disabled:cursor-not-allowed disabled:text-neutral-500 disabled:hover:bg-transparent";

export const CHROME_MENU_HEADING = "px-2 pb-0.5 pt-1.5 text-[10px] uppercase tracking-[0.06em] text-neutral-500";

/** Right-aligned shortcut hint inside a menu item. */
export const CHROME_MENU_HINT = "ml-auto text-[9px] text-neutral-500";
