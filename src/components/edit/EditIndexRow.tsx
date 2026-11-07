"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { formatDuration } from "@/components/assets/assetFormat";
import { ActionMenu } from "@/components/stitch/ActionMenu";
import { ICON_BUTTON } from "@/components/stitch/editorStyles";
import type { EditSummary } from "@/lib/edits/types";
import { useEditProjectStore } from "@/store/editProjectStore";
import { revealText } from "./EditMenu";
import { editCardMeta } from "./editMeta";
import { EditNameField } from "./EditNameField";

/** The row menu's height and gap, about: it opens upward when the list has less room than this under the row. */
const MENU_PX = 160;

/** Marks the list's scroller, which the row menu measures its room in. */
export const INDEX_SCROLLER = "data-edit-index-scroller";

/** Where the pointer is, in the window's pixels. */
export type PointerSpot = { x: number; y: number };

/** The name field, set in the row's own type: 22 px display on the editor's field ground, the text where the name was. */
const RENAME_FIELD = cn(
  "-ml-2 flex-1",
  "[&_input]:h-10 [&_input]:w-full [&_input]:border-0 [&_input]:bg-edit-field [&_input]:px-2",
  "[&_input]:font-display [&_input]:text-[22px] [&_input]:font-medium [&_input]:tracking-[-0.02em]",
);

/**
 * One edit on the home's Index: its name, large, and its length. The active
 * row (hovered or focused; the preview shows it) is lit and carries ⋯, which
 * renames it in place, duplicates it, shows its file or deletes it. A press
 * or Enter opens it. With keyboard focus on it (after a key, not the focus
 * the home gives the newest row as it shows) the whole row takes a faint fill
 * and a white ring inside its edge.
 */
export function EditIndexRow({
  edit,
  active,
  menuOpen,
  renaming,
  openRef,
  onPointer,
  onFocusIn,
  onMenuChange,
  onRenamingChange,
}: {
  edit: EditSummary;
  /** The edit the preview shows: lit, with ⋯, and the list's one tab stop, so Tab comes back to it. */
  active: boolean;
  menuOpen: boolean;
  renaming: boolean;
  openRef: Ref<HTMLButtonElement>;
  /** The pointer came over the row or moved on it. */
  onPointer: (at: PointerSpot) => void;
  /** Focus came into the row: onto its open button (`true`), or its ⋯ or name field. */
  onFocusIn: (onOpen: boolean) => void;
  onMenuChange: (open: boolean) => void;
  onRenamingChange: (renaming: boolean) => void;
}) {
  const renameError = useEditProjectStore((s) => s.renameError);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuUp, setMenuUp] = useState(false);
  const store = useEditProjectStore.getState;
  const meta = editCardMeta(edit);
  const length = (
    <span className={cn("shrink-0 text-[13px] tabular-nums transition-colors", active ? "text-neutral-300" : "text-ink-3")}>
      {formatDuration(edit.durationSec)}
    </span>
  );

  const toggleMenu = () => {
    if (menuOpen) {
      onMenuChange(false);
      return;
    }
    // Under the row while the list has room for it there, else over it
    const trigger = triggerRef.current;
    const scroller = trigger?.closest(`[${INDEX_SCROLLER}]`);
    const below = trigger && scroller ? scroller.getBoundingClientRect().bottom - trigger.getBoundingClientRect().bottom : Infinity;
    setMenuUp(below < MENU_PX);
    onMenuChange(true);
  };

  const pointed = (event: ReactPointerEvent) => onPointer({ x: event.clientX, y: event.clientY });

  return (
    <li
      data-active={active || undefined}
      // Keyboard focus on the row's open button, once a key has been pressed: a faint fill and the editor's white ring
      // round the whole row (the lit name alone also marks the last row hovered). The ring is drawn inside the row: its
      // edges are the list scroller's, which would cut an outer ring off
      className="-mx-2 flex h-12 items-center gap-4 rounded-md px-2 transition-colors in-data-[keyed]:has-[[data-edit-row]:focus-visible]:bg-white/6 in-data-[keyed]:has-[[data-edit-row]:focus-visible]:ring-2 in-data-[keyed]:has-[[data-edit-row]:focus-visible]:ring-inset in-data-[keyed]:has-[[data-edit-row]:focus-visible]:ring-white/40"
      onPointerEnter={pointed}
      onPointerMove={pointed}
      onFocus={(event) => onFocusIn((event.target as HTMLElement).dataset.editRow !== undefined)}
    >
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <EditNameField
            name={edit.name}
            editing
            onEditingChange={onRenamingChange}
            onCommit={(next) => store().rename(next, edit.id)}
            error={renameError}
            className={RENAME_FIELD}
          />
          {length}
        </div>
      ) : (
        <button
          ref={openRef}
          type="button"
          tabIndex={active ? 0 : -1}
          data-edit-row={edit.id}
          aria-label={`Open ${edit.name}, ${meta.label}`}
          onClick={() => void store().openEditById(edit.id)}
          className="flex h-full min-w-0 flex-1 items-center gap-4 text-left focus-visible:outline-none"
        >
          <span
            className={cn(
              "min-w-0 flex-1 truncate font-display text-[22px] font-medium leading-[1.2] tracking-[-0.02em] transition-colors",
              active ? "text-neutral-100" : "text-ink-3",
            )}
          >
            {edit.name}
          </span>
          {length}
        </button>
      )}
      <div className="relative flex w-7 shrink-0" data-edit-chrome>
        {(active || menuOpen) && (
          <button
            ref={triggerRef}
            type="button"
            aria-label={`More for ${edit.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={cn(ICON_BUTTON, menuOpen && "bg-white/6 text-neutral-100")}
            onClick={toggleMenu}
          >
            <MoreHorizontal size={16} strokeWidth={1.5} />
          </button>
        )}
        {menuOpen && (
          <ActionMenu
            label={edit.name}
            triggerRef={triggerRef}
            className={menuUp ? "bottom-full right-0 top-auto mb-1 mt-0" : "right-0"}
            entries={[
              { kind: "item", label: "Rename", onSelect: () => onRenamingChange(true) },
              { kind: "item", label: "Duplicate", onSelect: () => void store().duplicate(edit.id) },
              { kind: "item", label: revealText(), onSelect: () => void store().reveal(edit.id) },
              { kind: "divider" },
              { kind: "item", label: "Delete…", onSelect: () => store().requestDelete(edit.id) },
            ]}
            onClose={(refocus) => {
              onMenuChange(false);
              if (refocus) triggerRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>
    </li>
  );
}
