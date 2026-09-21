"use client";

import type { ButtonHTMLAttributes, ComponentPropsWithRef, HTMLAttributes, ReactNode } from "react";

import { cn } from "@/components/nodes/ui/cn";
import { KbdGroup } from "@/components/ui/Kbd";

/**
 * The one menu surface. Context menus, the node search, connection-drop
 * pickers and the small floating toolbars (handle, edge, multi-select) all
 * sit on this skin, which is the node's controls card lifted a tier: the
 * same surface, a solid border in place of the card's faint one, and a real
 * shadow. The type is the "Instrument" skin from the design canvas: mono
 * uppercase section labels and hints, 28px rows, shortcuts in mono on the
 * right, 6px corners.
 *
 * Two shapes: a `list` stacks rows, a `bar` lines up icon buttons. Position,
 * focus and dismissal stay with the caller — they differ per menu and are
 * all behaviour, which this file does not own.
 */

/** Surface classes alone, for a menu that must keep its own element. */
export const menuSurfaceClass = "bg-card border border-chrome-border rounded-md shadow-menu";

export interface MenuSurfaceProps extends ComponentPropsWithRef<"div"> {
  variant?: "list" | "bar";
  /** `position: fixed` on the menu tier (z-100). Off for menus anchored inside a parent. */
  floating?: boolean;
}

export function MenuSurface({
  variant = "list",
  floating = true,
  className,
  children,
  ...rest
}: MenuSurfaceProps) {
  return (
    <div
      {...rest}
      className={cn(
        menuSurfaceClass,
        floating && "fixed z-100",
        variant === "list"
          ? "overflow-hidden min-w-[160px] outline-none"
          : "flex items-center gap-1 p-1",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Top row of a list menu: a search well or a section label. */
export function MenuHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("px-2 py-1.5 border-b border-chrome-border", className)}>
      {children}
    </div>
  );
}

/** Uppercase label over a run of items. */
export function MenuSectionLabel({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn("font-mono text-[10px] leading-[14px] uppercase tracking-eyebrow text-ink-3", className)}
    >
      {children}
    </div>
  );
}

export function MenuList({ className, children, ...rest }: ComponentPropsWithRef<"div">) {
  return (
    <div {...rest} className={cn("py-1", className)}>
      {children}
    </div>
  );
}

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Keyboard or pointer highlight. */
  selected?: boolean;
}

/** Item classes alone, for a row that must be an `<a>` or keep its own element. */
export const menuItemClass = cn(
  "w-full min-h-7 px-2.5 py-1 text-left text-xs flex items-center gap-2 transition-colors",
  "focus-visible:outline-none focus-visible:bg-neutral-700 focus-visible:text-neutral-100",
  "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent",
  "text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100"
);

export function MenuItem({ selected = false, className, type = "button", children, ...rest }: MenuItemProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cn(menuItemClass, selected && "bg-neutral-700 text-neutral-100", className)}
    >
      {children}
    </button>
  );
}

/** Keyboard shortcut or meta at the right edge of an item, in mono. */
export function MenuShortcut({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...rest} className={cn("ml-auto pl-3 font-mono text-[11px] text-ink-3 whitespace-nowrap", className)}>
      {children}
    </span>
  );
}

/** Empty-result row. */
export function MenuEmpty({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("px-2.5 py-2 text-xs text-neutral-500", className)}>
      {children}
    </div>
  );
}

/** Bottom row of a list menu, for keyboard hints. */
export function MenuFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={cn("px-2.5 py-1.5 border-t border-chrome-border flex items-center justify-between gap-3", className)}
    >
      {children}
    </div>
  );
}

/** `⌘ + K`-style hint: a key cap and what it does. */
export function MenuHint({ keys, children }: { keys: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] leading-[14px] uppercase tracking-eyebrow text-ink-3 whitespace-nowrap">
      <KbdGroup keys={keys} size="xs" />
      {children}
    </span>
  );
}

/** Rule between groups: a line across a list, a short vertical tick in a bar. */
export function MenuDivider({
  variant = "list",
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { variant?: "list" | "bar" }) {
  return variant === "bar" ? (
    <div {...rest} className={cn("w-px h-4 bg-neutral-600", className)} />
  ) : (
    <div {...rest} className={cn("border-t border-chrome-border", className)} />
  );
}

/** Icon button in a bar menu. 28px, rounded inside the bar's 10px corners. */
export function MenuIconButton({ className, type = "button", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type={type}
      className={cn(
        "p-1.5 rounded-md transition-colors text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
        "disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent",
        className
      )}
    >
      {children}
    </button>
  );
}

/** Text chip at the start of a bar menu (a count, "Image 2"), ruled off from the buttons. */
export function MenuBarLabel({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex items-center gap-1.5 px-2 text-[10px] font-medium text-neutral-300 border-r border-neutral-600 whitespace-nowrap",
        className
      )}
    >
      {children}
    </span>
  );
}
