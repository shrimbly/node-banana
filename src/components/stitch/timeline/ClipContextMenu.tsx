"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuDivider, MenuItem, MenuShortcut, MenuSurface } from "@/components/ui/Menu";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { useStitchClipboard } from "@/store/stitchClipboardStore";
import { clipName } from "@/lib/stitch/labels";
import { clipIdsOf } from "@/lib/stitch/selection";
import { isTrimmed } from "@/lib/stitch/timeline";
import { canPaste, copySelection, cutSelection, duplicateSelection, pasteClipboard } from "../clipboardActions";
import {
  canEndAtPlayhead,
  canEndAudioAtPlayhead,
  canMoveAudioRow,
  canMoveRow,
  canRevealSource,
  canSplitAudioAtPlayhead,
  canSplitSelectedAtPlayhead,
  canStartAtPlayhead,
  canStartAudioAtPlayhead,
  endSelectedAtPlayhead,
  endSelectedAudioAtPlayhead,
  moveSelectedAudioRow,
  moveSelectedRow,
  removeAudioClipsById,
  removeSelection,
  resetSelectedTrim,
  revealSelectedSource,
  splitAtPlayhead,
  splitBlockedReason,
  splitSelectedAudioAtPlayhead,
  startSelectedAtPlayhead,
  startSelectedAudioAtPlayhead,
  toggleSelectedAudioMute,
  toggleSelectedClipMute,
} from "../editorActions";
import type { AudioClipView, ClipMediaView } from "../useStitchEditorMedia";
import { audioRowName } from "./AudioLane";
import {
  EDIT_MENU_DIVIDER,
  EDIT_MENU_MUTED,
  EDIT_MENU_ROW,
  EDIT_MENU_SURFACE,
  EDIT_MENU_VALUE,
  EDITOR_PANEL_SELECTOR,
} from "../editorStyles";

/** The edit menus' 220px. */
const MENU_WIDTH = 220;
const EDGE = 8;

type ItemOpts = { shortcut?: string; disabled?: boolean; title?: string };

/** The menu's heading: the clip (and its source or row), or how many, as a muted line. */
const HEADING = cn(EDIT_MENU_MUTED, "pb-1.5 pt-1.5");

/**
 * What both menus share: the placement inside the window, focus on the first row and back to the panel however it
 * closes, any press outside (even one that cancels its pointerdown), a wheel elsewhere or a resize closing it, and
 * the arrows, Home, End and Tab.
 */
function useMenuChrome(ref: RefObject<HTMLDivElement | null>, x: number, y: number) {
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(EDGE, Math.min(x, window.innerWidth - MENU_WIDTH - EDGE)),
      top: Math.max(EDGE, Math.min(y, window.innerHeight - height - EDGE)),
    });
  }, [ref, x, y]);

  useEffect(() => {
    const menu = ref.current;
    const panel = menu?.closest<HTMLElement>(EDITOR_PANEL_SELECTOR) ?? null;
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
    const dismiss = () => useStitchEditorStore.getState().openMenu(null);
    // Capture phase, and pointerdown: a press whose pointerdown is cancelled fires no mousedown
    const onPointerDown = (event: PointerEvent) => {
      if (menu && !menu.contains(event.target as Node)) dismiss();
    };
    const onWheel = (event: WheelEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", dismiss);
      // Its focused row is gone with it: focus would fall to <body>, outside the dialog's Tab trap
      const active = document.activeElement;
      if (panel?.isConnected && (!active || active === document.body || menu?.contains(active))) {
        panel.focus({ preventScroll: true });
      }
    };
  }, [ref]);

  // Focus goes back to the panel, so the editor's keys work and Tab stays in the dialog
  const close = (run?: () => void) => {
    const panel = ref.current?.closest<HTMLElement>(EDITOR_PANEL_SELECTOR);
    useStitchEditorStore.getState().openMenu(null);
    run?.();
    panel?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []);
    if (rows.length === 0) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % rows.length;
    else if (event.key === "ArrowUp") next = at <= 0 ? rows.length - 1 : at - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  return { position, close, onKeyDown };
}

/** One row: its label and key, the same action as the key. */
function menuItem(act: (run: () => void) => () => void) {
  return function item(label: string, run: () => void, opts: ItemOpts = {}) {
    return (
      <MenuItem role="menuitem" disabled={opts.disabled} title={opts.title} onClick={act(run)} className={EDIT_MENU_ROW}>
        <span className="truncate">{label}</span>
        {opts.shortcut && <MenuShortcut className={cn("font-sans text-xs tabular-nums", EDIT_MENU_VALUE)}>{opts.shortcut}</MenuShortcut>}
      </MenuItem>
    );
  };
}

/**
 * A clip's right-click menu (an audio clip's is AudioMenu), on the edit menus' skin (the headers' ⋯): a muted
 * heading, then its rows with their keys, no icons. Its sound, a split at
 * the playhead, in Stacked its place (start or end at the playhead, a row up
 * or down), its trim, copy, cut, paste and duplicate, its source node, and
 * removing it. The clip is the selection (the right-click selected it), so
 * each item is the same action as its key; an item selects it again before
 * it runs, so the label and the action never part. Opened on one of several
 * selected clips it acts on all of them ("3 clips"); the place items that
 * are one clip's are off then. Any press outside closes it, even one that cancels its
 * pointerdown (a trim handle, the ruler). Escape belongs to the editor's key
 * handler, which closes it. However it closes, focus that was in it goes
 * back to the panel, so the editor's keys and its Tab trap keep working.
 */
export function ClipContextMenu({
  media,
  audio,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  audio: ReadonlyMap<string, AudioClipView>;
}) {
  const menu = useStitchEditorStore((s) => s.menu);
  if (!menu) return null;
  const key = `${menu.kind}:${menu.clipId}:${menu.x}:${menu.y}`;
  if (menu.kind === "audio") return <AudioMenu key={key} views={audio} clipId={menu.clipId} x={menu.x} y={menu.y} />;
  return <OpenMenu key={key} media={media} clipId={menu.clipId} x={menu.x} y={menu.y} />;
}

function OpenMenu({
  media,
  clipId,
  x,
  y,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  clipId: string;
  x: number;
  y: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { position, close, onKeyDown } = useMenuChrome(ref, x, y);
  const index = useStitchEditorStore((s) => s.draft?.timeline.findIndex((c) => c.id === clipId) ?? -1);
  const clip = useStitchEditorStore((s) => s.draft?.timeline.find((c) => c.id === clipId) ?? null);
  const canSplit = useStitchEditorStore(canSplitSelectedAtPlayhead);
  const splitBlocked = useStitchEditorStore(splitBlockedReason);
  const stacked = useStitchEditorStore((s) => s.draft?.sequenceLayout.mode === "stacked");
  const canStart = useStitchEditorStore(canStartAtPlayhead);
  const canEnd = useStitchEditorStore(canEndAtPlayhead);
  const canRowUp = useStitchEditorStore((s) => canMoveRow(s, -1));
  const canRowDown = useStitchEditorStore((s) => canMoveRow(s, 1));
  const selection = useStitchEditorStore((s) => s.selection);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  // Its own subscription: a copy made elsewhere turns Paste on with no change to the editor's store
  const hasClipboard = useStitchClipboard((c) => c.clipboard !== null);
  const pasteOn = useStitchEditorStore((s) => canPaste(hasClipboard, s));
  // An edit project's clips come from the library: there is no source node to reveal
  const inEdit = useStitchEditorStore((s) => s.editId !== null);
  const view = media.get(clipId);
  const group = useMemo(() => {
    if (selection?.kind !== "clip" || !timeline) return [];
    const ids = new Set(clipIdsOf(selection, timeline.map((c) => c.id)));
    return timeline.filter((c) => ids.has(c.id));
  }, [selection, timeline]);
  const multi = group.length > 1 && group.some((c) => c.id === clipId);

  const act = (run: () => void) => () =>
    close(() => {
      // A group's menu acts on the group, which nothing can change while it is open
      if (!multi) useStitchEditorStore.getState().select({ kind: "clip", clipId });
      run();
    });

  // A clip removed by undo while the menu was up: nothing to act on
  useEffect(() => {
    if (!clip) useStitchEditorStore.getState().openMenu(null);
  }, [clip]);

  if (!clip) return null;
  const name = clipName(index);
  const source = view?.sourceLabel;
  const muted = multi ? group.every((c) => c.muted) : clip.muted;
  const trimmed = multi ? group.some(isTrimmed) : isTrimmed(clip);
  const header = multi ? `${group.length} clips` : source ? `${name} · ${source}` : name;
  const item = menuItem(act);

  return (
    <MenuSurface
      ref={ref}
      role="menu"
      aria-label={multi ? header : name}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className={EDIT_MENU_SURFACE}
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      <div className={cn(HEADING, "truncate")}>{header}</div>
      {muted
        ? item("Unmute clip audio", toggleSelectedClipMute, { shortcut: "⌥M" })
        : item("Mute clip audio", toggleSelectedClipMute, { shortcut: "⌥M" })}
      {item("Split at playhead", splitAtPlayhead, {
        shortcut: "S",
        disabled: !canSplit,
        title: canSplit ? undefined : (splitBlocked ?? undefined),
      })}
      {stacked && (
        <>
          {item("Start at playhead", startSelectedAtPlayhead, {
            shortcut: "[",
            disabled: multi || !canStart,
            title: multi ? "Select one clip" : undefined,
          })}
          {item("End at playhead", endSelectedAtPlayhead, {
            shortcut: "]",
            disabled: multi || !canEnd,
            title: multi ? "Select one clip" : canEnd ? undefined : "The clip is longer than the time before the playhead",
          })}
          {item("Move up a row", () => moveSelectedRow(-1), { shortcut: "⌥↑", disabled: !canRowUp })}
          {item("Move down a row", () => moveSelectedRow(1), {
            shortcut: "⌥↓",
            disabled: !canRowDown,
          })}
        </>
      )}
      {item("Reset trim", resetSelectedTrim, { disabled: !trimmed })}
      <MenuDivider role="separator" className={EDIT_MENU_DIVIDER} />
      {item("Copy", copySelection, { shortcut: "⌘C" })}
      {item("Cut", cutSelection, { shortcut: "⌘X" })}
      {item("Paste", pasteClipboard, {
        shortcut: "⌘V",
        disabled: !pasteOn,
      })}
      {item("Duplicate", duplicateSelection, { shortcut: "⌘D" })}
      <MenuDivider role="separator" className={EDIT_MENU_DIVIDER} />
      {!inEdit &&
        item("Reveal source node", revealSelectedSource, {
          disabled: multi || !canRevealSource(clip, view),
          title: multi ? "Select one clip" : undefined,
        })}
      {item(multi ? `Remove ${group.length} clips` : "Remove clip", removeSelection, {
        shortcut: "⌫",
      })}
    </MenuSurface>
  );
}

/**
 * An audio clip's right-click menu: a split at the playhead, its place (start
 * or end at the playhead, a row up or down), its sound, copy, cut, paste and
 * duplicate, and removing it. Opened on one of several selected audio clips
 * it acts on all of them ("3 audio clips"); Start and End are one clip's.
 */
function AudioMenu({
  views,
  clipId,
  x,
  y,
}: {
  views: ReadonlyMap<string, AudioClipView>;
  clipId: string;
  x: number;
  y: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { position, close, onKeyDown } = useMenuChrome(ref, x, y);
  const clip = useStitchEditorStore((s) => s.draft?.audioClips.find((c) => c.id === clipId) ?? null);
  const selection = useStitchEditorStore((s) => s.selection);
  const audioClips = useStitchEditorStore((s) => s.draft?.audioClips);
  const canSplit = useStitchEditorStore(canSplitAudioAtPlayhead);
  const canStart = useStitchEditorStore(canStartAudioAtPlayhead);
  const canEnd = useStitchEditorStore(canEndAudioAtPlayhead);
  const canRowUp = useStitchEditorStore((s) => canMoveAudioRow(s, -1));
  const canRowDown = useStitchEditorStore((s) => canMoveAudioRow(s, 1));
  const hasClipboard = useStitchClipboard((c) => c.clipboard !== null);
  const pasteOn = useStitchEditorStore((s) => canPaste(hasClipboard, s));
  const group = useMemo(() => {
    if (selection?.kind !== "audio" || !audioClips) return [];
    const ids = new Set(clipIdsOf(selection, audioClips.map((c) => c.id)));
    return audioClips.filter((c) => ids.has(c.id));
  }, [selection, audioClips]);
  const multi = group.length > 1 && group.some((c) => c.id === clipId);

  const act = (run: () => void) => () =>
    close(() => {
      if (!multi) useStitchEditorStore.getState().select(audioSelectionOf({ clipId }));
      run();
    });

  // A clip removed by undo while the menu was up: nothing to act on
  useEffect(() => {
    if (!clip) useStitchEditorStore.getState().openMenu(null);
  }, [clip]);

  if (!clip) return null;
  const view = views.get(clipId);
  const name = view?.fileName ?? "Audio";
  const header = multi ? `${group.length} audio clips` : `${name} · ${audioRowName(clip.row)}`;
  const muted = multi ? group.every((c) => c.muted) : clip.muted;
  const item = menuItem(act);
  const oneClip = multi ? { disabled: true, title: "Select one clip" } : null;

  return (
    <MenuSurface
      ref={ref}
      role="menu"
      aria-label={header}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      className={EDIT_MENU_SURFACE}
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
    >
      {/* A library file's name is long: it gives way, the row's name stays whole */}
      <div className={cn(HEADING, "flex min-w-0 whitespace-nowrap")} title={multi ? undefined : name}>
        {multi ? (
          header
        ) : (
          <>
            <span className="min-w-0 truncate">{name}</span>
            <span className="shrink-0">&nbsp;· {audioRowName(clip.row)}</span>
          </>
        )}
      </div>
      {item("Split at playhead", splitSelectedAudioAtPlayhead, {
        shortcut: "S",
        disabled: !canSplit,
      })}
      {item("Start at playhead", startSelectedAudioAtPlayhead, {
        shortcut: "[",
        ...(oneClip ?? { disabled: !canStart }),
      })}
      {item("End at playhead", endSelectedAudioAtPlayhead, {
        shortcut: "]",
        ...(oneClip ?? {
          disabled: !canEnd,
          title: canEnd ? undefined : "The clip is longer than the time before the playhead",
        }),
      })}
      {item("Move up a row", () => moveSelectedAudioRow(-1), {
        shortcut: "⌥↑",
        disabled: !canRowUp,
      })}
      {item("Move down a row", () => moveSelectedAudioRow(1), {
        shortcut: "⌥↓",
        disabled: !canRowDown,
      })}
      {muted
        ? item(multi ? "Unmute clips" : "Unmute clip", toggleSelectedAudioMute, { shortcut: "M" })
        : item(multi ? "Mute clips" : "Mute clip", toggleSelectedAudioMute, { shortcut: "M" })}
      <MenuDivider role="separator" className={EDIT_MENU_DIVIDER} />
      {item("Copy", copySelection, { shortcut: "⌘C" })}
      {item("Cut", cutSelection, { shortcut: "⌘X" })}
      {item("Paste", pasteClipboard, { shortcut: "⌘V", disabled: !pasteOn })}
      {item("Duplicate", duplicateSelection, { shortcut: "⌘D" })}
      <MenuDivider role="separator" className={EDIT_MENU_DIVIDER} />
      {item(
        multi ? `Remove ${group.length} clips` : "Remove clip",
        () => {
          const s = useStitchEditorStore.getState();
          s.untagCut(removeAudioClipsById(multi ? group.map((c) => c.id) : [clipId]));
        },
        { shortcut: "⌫" },
      )}
    </MenuSurface>
  );
}
