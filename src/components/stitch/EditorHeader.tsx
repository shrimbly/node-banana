"use client";

import { Redo2, Undo2 } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { selectCanRedo, selectCanUndo, selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { MoreMenu } from "./ActionMenu";
import { HEADER_GHOST, HEADER_ICON_BUTTON, HEADER_PRIMARY, HEADER_TITLE } from "./editorStyles";
import { sequenceMetaLine, useLoopMenuEntry } from "./sequenceMenu";

/** Whether the dialog header's menu is open: it owns the keys meanwhile, as the view's menus do (see StitchEditorModal). */
export const headerMenuOpen = () => document.querySelector("[data-editor-header] [role='menu']") !== null;

/** Undo and Redo over the editor's own history, as icons, dimmed when there is nothing to undo or redo. */
export function HistoryButtons() {
  const canUndo = useStitchEditorStore(selectCanUndo);
  const canRedo = useStitchEditorStore(selectCanRedo);
  const undo = useStitchEditorStore((s) => s.undo);
  const redo = useStitchEditorStore((s) => s.redo);
  return (
    <>
      {/* The tooltips open downward, into the stage */}
      <div className="group relative flex">
        <button type="button" aria-label="Undo" className={HEADER_ICON_BUTTON} disabled={!canUndo} onClick={undo}>
          <Undo2 size={16} strokeWidth={1.5} />
        </button>
        <Tooltip label="Undo" shortcut="⌘Z" placement="bottom" />
      </div>
      <div className="group relative flex">
        <button type="button" aria-label="Redo" className={HEADER_ICON_BUTTON} disabled={!canRedo} onClick={redo}>
          <Redo2 size={16} strokeWidth={1.5} />
        </button>
        <Tooltip label="Redo" shortcut="⇧⌘Z" placement="bottom" />
      </div>
    </>
  );
}

/**
 * The dialog's 56px header, in the Edit video view's quiet language: "Edit
 * video"; Undo, Redo and the ⋯ menu (Loop, the row the view's menu has, then
 * what the sequence is: clips, size, rate); Cancel, Save (keeps the editor
 * open) and Done. Nothing clickable sits in the top 12px of the left 60px,
 * where the desktop's window controls draw over the panel's corner.
 */
export function EditorHeader({
  clipCount,
  size,
  fps,
  onCancel,
  onSave,
  onDone,
}: {
  clipCount: number;
  /** "1920 × 1080", or null when no ready clip has a size. */
  size: string | null;
  /** "24 fps", or null (mixed or unknown rates). */
  fps: string | null;
  onCancel: () => void;
  onSave: () => void;
  onDone: () => void;
}) {
  const dirty = useStitchEditorStore(selectIsDirty);
  const initialClipCount = useStitchEditorStore((s) => s.initial?.timeline.length ?? 0);
  const loop = useLoopMenuEntry();

  return (
    <div data-editor-header className="relative z-20 flex h-14 shrink-0 items-center gap-2 bg-pane pl-5 pr-4">
      <h2 className={`${HEADER_TITLE} min-w-0 flex-1 truncate`}>Edit video</h2>
      <div className="flex shrink-0 items-center gap-0.5">
        <HistoryButtons />
        <MoreMenu label="Edit menu" entries={[loop]} footer={sequenceMetaLine(clipCount, size, fps)} />
      </div>
      <div className="ml-2 flex shrink-0 items-center gap-1">
        <button type="button" className={HEADER_GHOST} onClick={onCancel}>
          Cancel
        </button>
        <div className="group relative flex">
          <button type="button" className={HEADER_GHOST} disabled={!dirty} onClick={onSave}>
            Save
          </button>
          <Tooltip label="Save and keep editing" shortcut="⌘S" placement="bottom" />
        </div>
        <button
          type="button"
          className={`${HEADER_PRIMARY} ml-1`}
          // Off only when there is nothing and nothing was given; a user who removed every clip can apply that.
          // Not "dirty": with nothing given, a loop count alone is nothing to keep.
          disabled={clipCount === 0 && initialClipCount === 0}
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </div>
  );
}
