"use client";

import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/components/nodes/ui/cn";

/**
 * Key caps. One `<kbd>` per key, grouped with a small gap, so ⇧G reads as
 * two keys pressed together rather than a word. Every shortcut in the app —
 * menu rows, hover labels, the shortcuts dialog — uses these, which is why
 * the cap carries no surface of its own beyond an alpha white: it has to sit
 * on the chrome glass, a menu and a dialog card alike.
 */

/** Names worth drawing as their symbol. Modifier words the platform differs on (Ctrl) stay words. */
const SYMBOLS: Record<string, string> = {
  shift: "⇧",
  cmd: "⌘",
  command: "⌘",
  meta: "⌘",
  alt: "⌥",
  option: "⌥",
  enter: "↵",
  return: "↵",
  backspace: "⌫",
  delete: "⌫",
  tab: "⇥",
  escape: "Esc",
  space: "Space",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
};

/** The symbols that can lead a compact shortcut like "⇧G" or "⌘↵". */
const MODIFIER_GLYPHS = "⌘⇧⌥⌃";

/** Glyphs that are each a whole key. */
const KEY_GLYPHS = MODIFIER_GLYPHS + "↑↓←→↵⏎⌫⇥⎋";

/**
 * "⇧G" → ["⇧", "G"], "⌘↵" → ["⌘", "↵"], "↑↓" → ["↑", "↓"], "Ctrl+K" → ["Ctrl", "K"].
 * A label that is not a key ("Hold H", "Trackpad") comes back whole.
 */
export function splitKeys(input: string): string[] {
  const parts = input.includes("+") ? input.split("+") : [input];
  const keys: string[] = [];
  for (const part of parts) {
    let rest = part.trim();
    if (!rest) continue;
    // A run of nothing but glyphs ("↑↓", "⌘↵") is one key per glyph.
    if (rest.length > 1 && [...rest].every((char) => KEY_GLYPHS.includes(char))) {
      keys.push(...rest);
      continue;
    }
    // Peel leading modifier glyphs; "⇧" alone stays one key.
    while (rest.length > 1 && MODIFIER_GLYPHS.includes(rest[0]!)) {
      keys.push(rest[0]!);
      rest = rest.slice(1);
    }
    if (rest) keys.push(rest);
  }
  return keys;
}

export type KbdSize = "xs" | "sm" | "md";

const SIZE: Record<KbdSize, string> = {
  xs: "h-4 min-w-4 px-[3px] text-[10px] rounded-[3px]",
  sm: "h-[18px] min-w-[18px] px-1 text-[11px]",
  md: "h-[22px] min-w-[22px] px-1.5 text-xs",
};

export interface KbdProps extends HTMLAttributes<HTMLElement> {
  /** `xs` for hover labels and menu footers, `sm` for menu rows, `md` for the shortcuts dialog. */
  size?: KbdSize;
}

/** One key cap. */
export function Kbd({ size = "sm", className, children, ...rest }: KbdProps) {
  const label = typeof children === "string" ? (SYMBOLS[children.toLowerCase()] ?? children) : children;
  return (
    <kbd
      {...rest}
      className={cn(
        "inline-flex select-none items-center justify-center rounded border border-white/8 bg-white/8",
        // The system face, not the mono: its ⌘ ⇧ ⌥ are drawn at full size.
        "font-sans font-medium leading-none text-neutral-300",
        SIZE[size],
        className
      )}
    >
      {label}
    </kbd>
  );
}

export interface KbdGroupProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** The keys, as an array or a compact string ("⇧G", "Ctrl+K"). */
  keys?: string | string[];
  size?: KbdSize;
  children?: ReactNode;
}

/** A run of caps for one shortcut. */
export function KbdGroup({ keys, size = "sm", className, children, ...rest }: KbdGroupProps) {
  const list = keys === undefined ? [] : typeof keys === "string" ? splitKeys(keys) : keys;
  return (
    <span {...rest} className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)}>
      {list.map((key, index) => (
        <Kbd key={`${key}-${index}`} size={size}>
          {key}
        </Kbd>
      ))}
      {children}
    </span>
  );
}
