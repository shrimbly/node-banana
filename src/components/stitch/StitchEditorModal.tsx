"use client";

import { useRef, useState, type HTMLAttributes } from "react";
import { KeyboardShortcutsDialog } from "@/components/KeyboardShortcutsDialog";
import { Dialog } from "@/components/ui/Dialog";
import { requestSave } from "@/store/saveRequestStore";
import { selectIsDirty, useStitchEditorStore } from "@/store/stitchEditorStore";
import { commitStitchEdit } from "./commitStitchEdit";
import { DiscardSheet } from "./DiscardSheet";
import { EditorHeader, headerMenuOpen } from "./EditorHeader";
import { EditorWorkspace } from "./EditorWorkspace";
import { HEADER_PX, STITCH_EDITOR_PANEL } from "./editorStyles";
import { LibraryPicker } from "./library/LibraryPicker";
import { useEditorComposition } from "./useEditorComposition";
import { useEditorLifecycle } from "./useEditorLifecycle";
import { useStitchEditorKeys, type StitchEditorKeyOptions } from "./useStitchEditorKeys";

/** Cancel and Escape: straight out when nothing changed, otherwise the discard sheet asks. */
function requestClose(): void {
  const s = useStitchEditorStore.getState();
  if (selectIsDirty(s)) s.setDiscardOpen(true);
  else s.close();
}

/** The header's ⋯ menu owns Escape, Space, ⌫ and the rest while it is open, as the Edit video view's menus do. */
const KEY_OPTIONS: StitchEditorKeyOptions = { isStacked: headerMenuOpen };

/** ?, as the canvas reads it: no ⌘, Ctrl or ⌥. */
const isShortcutsKey = (e: KeyboardEvent) => e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey;

/** The marker the library picker hands focus back by (see STITCH_EDITOR_PANEL). */
const EDITOR_PANEL_PROPS = { [STITCH_EDITOR_PANEL]: "" } as HTMLAttributes<HTMLDivElement>;

/**
 * The Stitch editor: a near-full-screen dialog over the canvas, opened by
 * the node's Expand or Open editor. On the Dialog primitive inset 24px, like
 * the annotation editor, so it sits under the desktop's drag regions rather
 * than in them. Everything it edits is the editor store's draft until Done
 * (or Save, which keeps it open) writes it to the node in one step.
 */
export function StitchEditorModal() {
  // An edit project's session belongs to the Edit video view, never to this dialog
  const isOpen = useStitchEditorStore((s) => s.isOpen && s.nodeId !== null);
  if (!isOpen) return null;
  return <StitchEditor />;
}

function StitchEditor() {
  const rootRef = useRef<HTMLDivElement>(null);

  // The keyboard shortcuts, the editor's first, over the dialog: its own list, in a portal, so it sits above the
  // dialog (the canvas's mounts earlier in the page, under it) and owns Escape
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  useEditorLifecycle();
  const composition = useEditorComposition(rootRef, HEADER_PX);
  useStitchEditorKeys(rootRef, requestClose, {
    ...KEY_OPTIONS,
    onOtherKey: (e) => {
      if (!isShortcutsKey(e)) return false;
      setShortcutsOpen(true);
      return true;
    },
    zoom: composition.zoom,
  });

  return (
    <Dialog
      open
      onClose={requestClose}
      closeOnBackdrop={false}
      closeOnEscape={false}
      stopWheel={false}
      label="Edit video"
      panelProps={EDITOR_PANEL_PROPS}
      className="w-[calc(100vw-48px)] max-w-none h-[calc(100vh-48px)] max-h-none bg-editor-chrome"
    >
      <div ref={rootRef} className="flex h-full min-h-0 flex-col">
        <EditorHeader
          clipCount={composition.clipCount}
          size={composition.size}
          fps={composition.fps}
          onCancel={requestClose}
          // The editor's lifecycle answers every save request by writing the edit first
          onSave={() => requestSave("button")}
          onDone={commitStitchEdit}
        />
        <EditorWorkspace composition={composition} />
      </div>
      <DiscardSheet />
      <LibraryPicker />
      <KeyboardShortcutsDialog isOpen={shortcutsOpen} onClose={() => setShortcutsOpen(false)} portal />
    </Dialog>
  );
}
