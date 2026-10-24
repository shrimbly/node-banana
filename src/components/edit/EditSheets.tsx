"use client";

import { useRef, type ReactNode, type RefObject } from "react";
import { cn } from "@/components/nodes/ui/cn";
import { DIALOG_BUTTON_RING } from "@/components/stitch/editorStyles";
import { Dialog, DialogButton, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { useEditProjectStore } from "@/store/editProjectStore";

/** The banner's height: the stage gives it up, the header row never grows. */
export const EDIT_BANNER_PX = 32;

type BannerTone = "amber" | "red" | "neutral";

const TONES: Record<BannerTone, string> = {
  amber: "bg-amber-500/10 border-amber-500/30 text-amber-200",
  red: "bg-red-500/10 border-red-500/30 text-red-200",
  neutral: "bg-white/[0.03] border-chrome-border text-neutral-300",
};

/** What the banner says now, by precedence; null when nothing needs words. */
export function useEditBanner(): { tone: BannerTone; text: string; actions: { label: string; onClick: () => void }[] } | null {
  const save = useEditProjectStore((s) => s.save);
  const render = useEditProjectStore((s) => s.render);
  const openId = useEditProjectStore((s) => s.open?.id ?? null);
  const store = useEditProjectStore.getState;
  switch (save.state) {
    case "conflict":
      return {
        tone: "amber",
        text: "This edit was changed in another window.",
        actions: [
          { label: "Keep mine", onClick: () => void store().resolveConflict("keepMine") },
          { label: "Use the other version", onClick: () => void store().resolveConflict("useTheirs") },
        ],
      };
    case "gone":
      return {
        tone: "red",
        text: "This edit is no longer in the Edits folder.",
        actions: [{ label: "Save as a new edit", onClick: () => void store().saveAsNew() }],
      };
    case "failed":
      return {
        tone: "red",
        text: save.error ? `Save failed: ${save.error}` : "Save failed.",
        actions: [{ label: "Retry", onClick: () => void store().saveNow("manual") }],
      };
    case "waiting":
      return {
        tone: "neutral",
        text: "The library is moving. Saving resumes when it finishes.",
        actions: [{ label: "Retry", onClick: () => void store().saveNow("manual") }],
      };
    default:
      break;
  }
  if (render.state === "failed" && render.editId === openId) {
    return {
      tone: "red",
      text: render.message ? `Render failed: ${render.message}` : "Render failed.",
      actions: [{ label: "Dismiss", onClick: () => store().setRenderState({ state: "idle", message: null }) }],
    };
  }
  return null;
}

/** One line under the header for a state that needs words: a conflict, a gone edit, a failed save or render, a move. */
export function EditBanner({ banner }: { banner: NonNullable<ReturnType<typeof useEditBanner>> }) {
  return (
    <div
      role="alert"
      className={cn("flex h-8 shrink-0 items-center gap-3 border-b px-4 text-[12px]", TONES[banner.tone])}
    >
      <span className="min-w-0 truncate">{banner.text}</span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {banner.actions.map((action) => (
          <DialogButton key={action.label} compact variant="ghost" className={cn("h-6 focus-visible:ring-offset-pane", DIALOG_BUTTON_RING)} onClick={action.onClick}>
            {action.label}
          </DialogButton>
        ))}
      </div>
    </div>
  );
}

/**
 * A small question over the view (these, and the media pane's Remove from edit): Escape and the backdrop cancel. Its
 * title wraps, a long name breaking where it must, so none of the question is cut off.
 */
export function Sheet({
  label,
  title,
  description,
  onClose,
  children,
  initialFocusRef,
}: {
  /** The dialog's name; without one, its title names it. */
  label?: string;
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <Dialog open onClose={onClose} size="xs" portal label={label} initialFocusRef={initialFocusRef}>
      <DialogHeader compact closeButton={false} className="pt-3.5 pb-1.5">
        {/* text-clip drops the title's truncate (they merge as one), so it wraps */}
        <DialogTitle compact className="text-clip [overflow-wrap:anywhere]">
          {title}
        </DialogTitle>
        <DialogDescription className="mt-0.5">{description}</DialogDescription>
      </DialogHeader>
      <DialogFooter compact className="mt-1.5 pb-3">
        {children}
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The view's two questions: "Save changes to …?" before switching away from
 * an edit with changes while Save automatically is off, and "Delete …?"
 * before an edit goes to the Trash. Each is a sheet over the view: Escape
 * and the backdrop mean Cancel. Their buttons take the editor's white focus
 * ring.
 */
export function EditSheets() {
  const pendingSwitch = useEditProjectStore((s) => s.pendingSwitch);
  const confirmDelete = useEditProjectStore((s) => s.confirmDelete);
  const openName = useEditProjectStore((s) => s.open?.name ?? null);
  const openId = useEditProjectStore((s) => s.open?.id ?? null);
  const listed = useEditProjectStore((s) => s.list.edits);
  const saveRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const store = useEditProjectStore.getState;

  if (pendingSwitch) {
    const cancel = () => void store().resolveSwitch("cancel");
    return (
      <Sheet
        label="Save changes?"
        title={openName ? `Save changes to “${openName}”?` : "Save changes?"}
        description="Your changes are lost if you don't save them."
        onClose={cancel}
        initialFocusRef={saveRef}
      >
        <DialogButton compact variant="danger" className={cn("mr-auto", DIALOG_BUTTON_RING)} onClick={() => void store().resolveSwitch("discard")}>
          Don&apos;t save
        </DialogButton>
        <DialogButton compact variant="ghost" className={DIALOG_BUTTON_RING} onClick={cancel}>
          Cancel
        </DialogButton>
        <DialogButton compact variant="primary" className={cn("px-3", DIALOG_BUTTON_RING)} ref={saveRef} onClick={() => void store().resolveSwitch("save")}>
          Save
        </DialogButton>
      </Sheet>
    );
  }
  if (confirmDelete) {
    const name = confirmDelete === openId ? openName : (listed.find((e) => e.id === confirmDelete)?.name ?? null);
    const cancel = () => store().cancelDelete();
    return (
      <Sheet
        label="Delete edit?"
        title={name ? `Delete “${name}”?` : "Delete this edit?"}
        description="The edit moves to the Trash. Its renders stay in the asset library."
        onClose={cancel}
        initialFocusRef={cancelRef}
      >
        <DialogButton compact variant="ghost" className={DIALOG_BUTTON_RING} ref={cancelRef} onClick={cancel}>
          Cancel
        </DialogButton>
        <DialogButton compact variant="danger" className={DIALOG_BUTTON_RING} onClick={() => void store().confirmDeleteEdit()}>
          Delete
        </DialogButton>
      </Sheet>
    );
  }
  return null;
}
