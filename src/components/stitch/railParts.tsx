"use client";

import type { CSSProperties, FocusEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { Tooltip } from "@/components/ui/Tooltip";
import { formatSeconds } from "@/lib/stitch/timecode";
import { EDITOR_PANEL_SELECTOR, HEADER_TITLE, RAIL_ACTION, SEGMENT, SEGMENT_OFF, SEGMENT_ON, SEGMENTS } from "./editorStyles";
import { LIBRARY_SOURCE, type RailSource } from "./useStitchEditorMedia";

/**
 * The line under the rail's title: where the clip comes from, then how long it is, "4.20 s of 12.06 s" once a trim
 * makes it shorter than its file. `source` is the media view's (none while it has no view), `full` the file's length
 * and `length` the clip's (null while unknown). The Edit video view leaves out "Library", since every clip of an edit
 * is the library's.
 */
export function railDetail(
  source: RailSource | undefined,
  full: number | null,
  length: number | null,
  inEdit: boolean,
): string {
  const kind = !source || (inEdit && source.kind === LIBRARY_SOURCE) ? null : source.kind;
  const fullText = full !== null ? formatSeconds(full) : null;
  const lengthText =
    fullText === null || length === null
      ? null
      : formatSeconds(length) === fullText
        ? fullText
        : `${formatSeconds(length)} of ${fullText}`;
  return [kind, source?.detail, lengthText].filter(Boolean).join(" · ");
}

/** What the rail shows: its name in the display face, and a quiet line or two under it. */
export function RailTitle({ title, lines }: { title: string; lines: ReadonlyArray<string> }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className={cn(HEADER_TITLE, "truncate leading-5")}>{title}</span>
      {lines.filter(Boolean).map((line, i) => (
        <span key={i} className="mt-1 truncate text-xs leading-4 text-ink-3 tabular-nums">
          {line}
        </span>
      ))}
    </div>
  );
}

/** Start's keys, either one: [ starts the clip at the playhead, ] ends it there. */
export const START_KEYS: readonly string[] = ["[", "]"];

/** The rail's fields side by side: two (In, Out) or three (Start, In, Out) equal columns. */
export function RailFields({ children }: { children: ReactNode }) {
  return <div className="mt-7 grid auto-cols-fr grid-flow-col gap-2">{children}</div>;
}

/**
 * One field: its label above, the field under it. `hint` and `shortcut` are the hover label (the key that sets it at
 * the playhead), which takes the place of the key hints the rail used to list. It opens from the field's left edge;
 * the last field's (`last`) from its right edge, so it stays inside the rail rather than widening it.
 */
export function RailField({
  label,
  hint,
  shortcut,
  last,
  onBlur,
  children,
}: {
  label: string;
  hint?: string;
  /** One key, or alternative keys (["[", "]"]). */
  shortcut?: string | readonly string[];
  last?: boolean;
  onBlur?: (event: FocusEvent<HTMLLabelElement>) => void;
  children: ReactNode;
}) {
  return (
    <label className="group relative flex min-w-0 flex-col" onBlur={onBlur}>
      <span className="mb-1.5 text-xs leading-3 text-ink-3">{label}</span>
      {children}
      {hint && <Tooltip label={hint} shortcut={shortcut} placement="top" align={last ? "end" : "start"} />}
    </label>
  );
}

/** A quiet sentence under the fields (a trim the encode leaves out, and why). */
export function RailNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs leading-4 text-ink-3">{children}</p>;
}

/** The rail's switch: 32×18, a white track with a dark knob when on, a dark grey one with a grey knob when off. */
export function RailSwitch({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Why it is off, say: its tooltip and its accessible description. */
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-neutral-100" : "bg-edit-switch-off",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full transition-transform motion-reduce:transition-none",
          checked ? "translate-x-4 bg-pane" : "translate-x-0.5 bg-ink-3",
        )}
      />
    </button>
  );
}

/** A 32px row: a label at the left, its control at the right. */
export function RailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-3">
      <span className="text-[13px] text-neutral-300">{label}</span>
      {children}
    </div>
  );
}

/** Volume: its label, the slider and the percentage. */
export function RailSlider({
  label,
  ariaLabel,
  value,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  /** 0–100. */
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex h-8 items-center gap-3">
      <span className="w-[52px] shrink-0 text-[13px] text-neutral-300">{label}</span>
      <input
        type="range"
        aria-label={ariaLabel}
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="range-edit min-w-0 flex-1"
        style={{ "--p": `${value}%` } as CSSProperties}
      />
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-3">{`${value}%`}</span>
    </div>
  );
}

export interface RailSegment {
  label: string;
  pressed: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}

/** A row of segments on the field ground, the pressed ones lifted (a clip's Sound across a selection, a volume curve). */
export function RailSegments({
  label,
  segments,
  className,
}: {
  /** The group's accessible name. */
  label: string;
  segments: ReadonlyArray<RailSegment>;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn(SEGMENTS, className)}>
      {segments.map((segment) => (
        <button
          key={segment.label}
          type="button"
          aria-pressed={segment.pressed}
          disabled={segment.disabled}
          title={segment.title}
          onClick={segment.onClick}
          className={cn(SEGMENT, segment.pressed ? SEGMENT_ON : SEGMENT_OFF)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
}

/** The rail's actions, pushed to its foot (they scroll with the rest when the rail is short). */
export function RailActions({ children }: { children: ReactNode }) {
  return <div className="mt-auto flex flex-col pt-6">{children}</div>;
}

/**
 * A rail action: a text row with its icon. The key is shown on hover or focus and given as aria-keyshortcuts.
 * `vanishes`: the row goes once it has done its work (Reset trim, with no trim left), so it hands focus to the editor
 * first rather than drop it on the page.
 */
export function RailAction({
  icon,
  label,
  shortcut,
  keyshortcuts,
  disabled,
  title,
  vanishes,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  /** The key as drawn ("S", "⌫"). */
  shortcut?: string;
  /** The key as aria-keyshortcuts names it ("S", "Backspace"); defaults to `shortcut`. */
  keyshortcuts?: string;
  disabled?: boolean;
  title?: string;
  vanishes?: boolean;
  onClick: () => void;
}) {
  const press = (event: MouseEvent<HTMLButtonElement>) => {
    if (vanishes) event.currentTarget.closest<HTMLElement>(EDITOR_PANEL_SELECTOR)?.focus({ preventScroll: true });
    onClick();
  };
  return (
    <button
      type="button"
      className={RAIL_ACTION}
      disabled={disabled}
      title={title}
      aria-keyshortcuts={keyshortcuts ?? shortcut}
      onClick={press}
    >
      <span className="flex shrink-0 text-ink-3 [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <span
          aria-hidden="true"
          className="shrink-0 text-[11px] text-ink-3 opacity-0 transition-opacity group-hover/action:opacity-100 group-focus-visible/action:opacity-100"
        >
          {shortcut}
        </span>
      )}
    </button>
  );
}
