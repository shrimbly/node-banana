"use client";

import type { ReactNode } from "react";
import { CHROME_ICON_BUTTON, CHROME_ICON_BUTTON_OPEN } from "./chromeStyles";

/**
 * Hover label for an icon-only button. CSS-driven (300ms delay, fades in on
 * hover and on keyboard focus), so it never fights the popover state.
 */
function Tooltip({ label, shortcut }: { label: string; shortcut?: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2.5 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md squircle border border-white/10 bg-neutral-950 py-1 pl-2 pr-1.5 text-[10px] font-medium leading-3 text-neutral-200 opacity-0 shadow-[0_4px_12px_rgba(0,0,0,0.5)] transition-opacity delay-300 duration-[120ms] group-hover:opacity-100 group-has-focus-visible:opacity-100"
    >
      {label}
      {shortcut && (
        <kbd className="rounded-[3px] border border-white/6 bg-white/6 px-1 font-sans text-[9px] text-neutral-500">
          {shortcut}
        </kbd>
      )}
    </span>
  );
}

export interface ChromeIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also the hover label. */
  label: string;
  shortcut?: string;
  /** Popover up, or a stateful toggle that is on. */
  open?: boolean;
  /** Suppress the hover label (while this button's own popover is up). */
  silent?: boolean;
  badge?: ReactNode;
  children: ReactNode;
}

/** 28px icon-only button on the chrome surface, with its hover label. */
export function ChromeIconButton({ label, shortcut, open = false, silent = false, badge, className = "", children, ...rest }: ChromeIconButtonProps) {
  return (
    <div className="group relative flex">
      <button
        type="button"
        aria-label={label}
        className={`${CHROME_ICON_BUTTON} ${open ? CHROME_ICON_BUTTON_OPEN : ""} ${className}`}
        {...rest}
      >
        {children}
      </button>
      {badge}
      {!silent && <Tooltip label={label} shortcut={shortcut} />}
    </div>
  );
}
