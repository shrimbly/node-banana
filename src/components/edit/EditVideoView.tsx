"use client";

import { useCallback, useEffect, useRef, type HTMLAttributes } from "react";
import { DialogSpinner } from "@/components/ui/Dialog";
import { EditorWorkspace } from "@/components/stitch/EditorWorkspace";
import { LibraryPicker } from "@/components/stitch/library/LibraryPicker";
import { isTypingTarget } from "@/components/stitch/editorKeys";
import { HEADER_PX, STITCH_EDITOR_PANEL } from "@/components/stitch/editorStyles";
import { useEditorComposition } from "@/components/stitch/useEditorComposition";
import { useStitchEditorKeys, type StitchEditorKeyOptions } from "@/components/stitch/useStitchEditorKeys";
import { useEditProjectStore } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { insideAgentWindow, isSaveShortcut } from "@/utils/saveShortcut";
import { EditHeader } from "./EditHeader";
import { EditHome } from "./EditHome";
import { EDIT_BANNER_PX, EditBanner, EditSheets, useEditBanner } from "./EditSheets";
import { editViewKeyAction, runEditViewKey } from "./editViewKeys";
import { useAddRecordedUploads } from "./mediaUploads";
import { MediaPane } from "./MediaPane";

/** Marked as the editor's panel: the editor's controls hand focus back to it, as they do to the dialog's. */
const EDITOR_PANEL_PROPS = { [STITCH_EDITOR_PANEL]: "" } as HTMLAttributes<HTMLDivElement>;

/** Escape with nothing to cancel leaves the view alone: it is left on purpose (E, the tab strip), never by dismissing. */
const stayOpen = () => {};

/** The view's own menus (the header's, a media item's ⋯) own the keys while open. */
const viewMenuOpen = () => document.querySelector("[data-edit-chrome] [role='menu'], [data-edit-chrome] [role='dialog']") !== null;

const KEY_OPTIONS: StitchEditorKeyOptions = {
  onOtherKey: (e) => {
    const action = editViewKeyAction(e);
    if (!action) return false;
    runEditViewKey(action, e.repeat);
    return true;
  },
  isStacked: viewMenuOpen,
};

/**
 * The Edit video view, laid over the canvas while `appView` is "edit" (bare E,
 * the tab strip's toggle, the menu's row). It edits edit projects, not nodes:
 * with none open it lists them (EditHome, which takes focus as it shows: on
 * the newest edit, so Enter opens it); with one open, the media pane
 * runs down the left beside the editor (header, stage with its control row,
 * rail and timeline, the dialog's own body and keys), all on the pane colour.
 *
 * Showing it brings back the edit left open here, or opens the last one;
 * leaving it parks that edit, saving it first when Save automatically is on.
 * Strict Mode's enter, leave, enter opens the edit once: leaving drops the
 * first read's answer.
 *
 * ⌘S saves the open edit for as long as the view shows (on the home screen it
 * does nothing), heard in the capture phase before the canvas's listener
 * would save the workflow. The agent window keeps its own ⌘S.
 */
export function EditVideoView() {
  const editOpen = useStitchEditorStore((s) => s.isOpen && s.editId !== null);
  const opening = useEditProjectStore((s) => s.opening);

  useEffect(() => {
    const store = useEditProjectStore.getState();
    void store.enterView();
    return () => store.leaveView();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event) || insideAgentWindow(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const editor = useStitchEditorStore.getState();
      if (editor.isOpen && editor.editId !== null) void useEditProjectStore.getState().saveNow("manual");
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // The home screen's view keys; with an edit open the editor's key hook hands them over instead (onOtherKey)
  useEffect(() => {
    if (editOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (document.querySelector('[role="menu"], [role="listbox"], [data-dialog-overlay]')) return;
      const action = editViewKeyAction(event);
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runEditViewKey(action, event.repeat);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [editOpen]);

  return (
    <section role="region" aria-label="Edit video" className="flex min-w-0 flex-1 bg-pane">
      {editOpen ? (
        <OpenEdit />
      ) : opening !== null ? (
        <div className="flex flex-1 items-center justify-center" aria-busy>
          <DialogSpinner />
        </div>
      ) : (
        <EditHome />
      )}
      <EditSheets />
    </section>
  );
}

/**
 * One edit open: the media pane, then the header, a banner when one is needed, and the editor's body; Add media (and
 * the timeline's +) opens the library picker over it all.
 */
function OpenEdit() {
  const rootRef = useRef<HTMLDivElement>(null);
  const paneOpen = useEditProjectStore((s) => s.pane.open);
  const snapshot = useEditProjectStore((s) => s.open?.assets);
  const banner = useEditBanner();

  // A clip the library has lost is named from the edit's file
  const assetFallback = useCallback((assetId: string) => snapshot?.[assetId], [snapshot]);
  const composition = useEditorComposition(rootRef, HEADER_PX + (banner ? EDIT_BANNER_PX : 0), { assetFallback });
  useStitchEditorKeys(rootRef, stayOpen, { ...KEY_OPTIONS, zoom: composition.zoom });
  // Files dropped on this edit's pane that were recorded while it was not open join its media now, pane shown or not
  useAddRecordedUploads();

  // Space plays at once: the editor takes focus as it opens
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="flex min-w-0 flex-1">
      {paneOpen && <MediaPane />}
      <div
        ref={rootRef}
        tabIndex={-1}
        {...EDITOR_PANEL_PROPS}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-pane outline-none"
      >
        <EditHeader composition={composition} />
        {banner && <EditBanner banner={banner} />}
        <EditorWorkspace composition={composition} />
      </div>
      <LibraryPicker />
    </div>
  );
}
