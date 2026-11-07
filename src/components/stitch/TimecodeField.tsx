"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { formatTimecode, parseTimecode } from "@/lib/stitch/timecode";
import { TIMECODE_WELL, EDITOR_PANEL_SELECTOR } from "./editorStyles";

/**
 * An m:ss.cc well (the rail's In and Out). It shows the value, edits as
 * text while focused, and commits a parsed time on Enter or blur; Escape
 * or text that is not a time puts the value back. Only typed text commits:
 * the display is rounded to hundredths, so focusing and leaving a value such
 * as 1.23456 must not write 1.23. Enter and Escape hand focus to the dialog
 * panel rather than <body>, so Tab stays inside the editor. The editor's
 * keys leave a focused text field alone, so typing "i" or "s" here only
 * types. The caller clamps what it is given.
 *
 * format, parse and className make it a seconds well (Overlap). With onNudge,
 * ↑ and ↓ (⇧ for a big step) change the value live: the field shows what the
 * caller stored, and that becomes the text Enter or blur would not commit.
 * Text typed before the arrow is committed first, so the step starts from
 * it; with ⌘, Ctrl or ⌥ held the arrows move the caret instead.
 */
export function TimecodeField({
  value,
  onCommit,
  label,
  disabled,
  format = formatTimecode,
  parse = parseTimecode,
  className = TIMECODE_WELL,
  onNudge,
}: {
  value: number;
  onCommit: (seconds: number) => void;
  label: string;
  disabled?: boolean;
  format?: (seconds: number) => string;
  parse?: (text: string) => number | null;
  className?: string;
  /** ↑ / ↓: applies one step and returns the value now stored, or null when nothing changed. */
  onNudge?: (direction: 1 | -1, big: boolean) => number | null;
}) {
  const [text, setText] = useState<string | null>(null);
  // Enter and Escape leave the field; the blur that follows must not commit again
  const settled = useRef(false);
  // What the field showed when it took focus: text still equal to it was not edited
  const shown = useRef("");

  /** Commits typed text that parses; true when it did. */
  const commit = (raw: string): boolean => {
    if (raw.trim() === shown.current) return false;
    const parsed = parse(raw);
    if (parsed === null) return false;
    onCommit(parsed);
    return true;
  };

  const leave = (input: HTMLInputElement) => {
    settled.current = true;
    const panel = input.closest<HTMLElement>(EDITOR_PANEL_SELECTOR);
    if (panel) panel.focus();
    else input.blur();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // ⌘, Ctrl or ⌥ with an arrow moves the caret, as in any text field
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    if (onNudge && !modified && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      // A value typed and not yet committed is the one the step starts from
      const typed = commit(event.currentTarget.value);
      const stored = onNudge(event.key === "ArrowUp" ? 1 : -1, event.shiftKey);
      if (stored !== null) {
        shown.current = format(stored);
        setText(shown.current);
      } else if (typed) {
        // Committed but not stepped (at a limit): show what is stored, and the blur has nothing left to commit
        shown.current = "";
        setText(null);
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(event.currentTarget.value);
      leave(event.currentTarget);
    } else if (event.key === "Escape") {
      // The value goes back; the editor's Escape does not run
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      leave(event.currentTarget);
    }
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      spellCheck={false}
      autoComplete="off"
      disabled={disabled}
      className={className}
      value={text ?? format(value)}
      onFocus={(event) => {
        settled.current = false;
        shown.current = format(value);
        setText(shown.current);
        event.currentTarget.select();
      }}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        // Enter and Escape have already settled theirs; commit() skips text nobody typed
        if (text !== null && !settled.current) commit(event.currentTarget.value);
        settled.current = false;
        setText(null);
      }}
    />
  );
}
