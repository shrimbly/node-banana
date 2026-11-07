"use client";

import { useRef } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { Dialog, DialogButton, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { describeDraftChanges } from "@/lib/stitch/draft";
import { DIALOG_BUTTON_RING } from "./editorStyles";

/**
 * "Discard changes?", over the editor when Cancel or Escape would lose
 * edits. Keep editing is the default: it has focus, and Escape on the sheet
 * means it too (the sheet's own Dialog hears Escape; the editor's key
 * handler stands aside while a stacked dialog is up). It takes focus through
 * initialFocusRef, not autoFocus: an autoFocus button is focused before the
 * Dialog records its opener, so closing would leave focus on <body>,
 * outside the editor. Its buttons take the editor's white focus ring.
 */
export function DiscardSheet() {
  const open = useStitchEditorStore((s) => s.discardOpen);
  const initial = useStitchEditorStore((s) => s.initial);
  const draft = useStitchEditorStore((s) => s.draft);
  // Moved clips are told from the stacked layout these lengths give
  const durations = useStitchEditorStore((s) => s.durations);
  // Pasted, duplicated and cut clips are named as such, not as splits and removals
  const clipOrigins = useStitchEditorStore((s) => s.clipOrigins);
  const setDiscardOpen = useStitchEditorStore((s) => s.setDiscardOpen);
  const close = useStitchEditorStore((s) => s.close);
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  if (!open || !initial || !draft) return null;

  const keepEditing = () => setDiscardOpen(false);
  return (
    <Dialog open onClose={keepEditing} size="xs" portal label="Discard changes?" initialFocusRef={keepEditingRef}>
      <DialogHeader compact closeButton={false} className="pt-3.5 pb-1.5">
        <DialogTitle compact>Discard changes?</DialogTitle>
        <DialogDescription className="mt-0.5">{describeDraftChanges(initial, draft, durations, clipOrigins)}</DialogDescription>
      </DialogHeader>
      <DialogFooter compact className="mt-1.5 pb-3">
        <DialogButton compact variant="danger" className={DIALOG_BUTTON_RING} onClick={close}>
          Discard
        </DialogButton>
        <DialogButton compact variant="primary" className={cn("px-3", DIALOG_BUTTON_RING)} ref={keepEditingRef} onClick={keepEditing}>
          Keep editing
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
