"use client";

import { forwardRef, type ReactNode } from "react";
import { KbdGroup } from "@/components/ui/Kbd";
import { CHROME_ICON_BUTTON, CHROME_ICON_BUTTON_OPEN, CHROME_ICON_BUTTON_SIZE } from "./chromeStyles";

/**
 * Hover label for an icon-only button. CSS-driven (300ms delay, fades in on
 * hover and on keyboard focus), so it never fights the popover state.
 */
function Tooltip({ label, shortcut, placement, align }: { label: string; shortcut?: string; placement: TooltipPlacement; align: TooltipAlign }) {
  const side = placement === "bottom" ? "top-full mt-2.5" : "bottom-full mb-2.5";
  const edge = align === "end" ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute ${side} ${edge} z-10 flex items-center gap-1.5 whitespace-nowrap rounded-md squircle border border-white/10 bg-neutral-950 py-1 pl-2 pr-1.5 text-[10px] font-medium leading-3 text-neutral-200 opacity-0 shadow-[0_4px_12px_rgba(0,0,0,0.5)] transition-opacity delay-300 duration-[120ms] group-hover:opacity-100 group-has-focus-visible:opacity-100`}
    >
      {label}
      {shortcut && <KbdGroup keys={shortcut} size="xs" className="gap-0.5 [&_kbd]:text-neutral-400" />}
    </span>
  );
}

export type TooltipPlacement = "top" | "bottom";
/** "end" keeps the label inside the window for a button on the right edge. */
export type TooltipAlign = "center" | "end";

export interface ChromeIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also the hover label. */
  label: string;
  shortcut?: string;
  /** Popover up, or a stateful toggle that is on. */
  open?: boolean;
  /** Suppress the hover label (while this button's own popover is up). */
  silent?: boolean;
  /** Where the hover label sits; "bottom" for buttons along the top edge. */
  tooltipPlacement?: TooltipPlacement;
  tooltipAlign?: TooltipAlign;
  badge?: ReactNode;
  size?: keyof typeof CHROME_ICON_BUTTON_SIZE;
  children: ReactNode;
}

/** Icon-only button on the chrome surface, with its hover label. */
export const ChromeIconButton = forwardRef<HTMLButtonElement, ChromeIconButtonProps>(function ChromeIconButton(
  { label, shortcut, open = false, silent = false, tooltipPlacement = "top", tooltipAlign = "center", badge, size = "md", className = "", children, ...rest },
  ref,
) {
  return (
    <div className="group relative flex">
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={`${CHROME_ICON_BUTTON} ${CHROME_ICON_BUTTON_SIZE[size]} ${open ? CHROME_ICON_BUTTON_OPEN : ""} ${className}`}
        {...rest}
      >
        {children}
      </button>
      {badge}
      {!silent && <Tooltip label={label} shortcut={shortcut} placement={tooltipPlacement} align={tooltipAlign} />}
    </div>
  );
});
