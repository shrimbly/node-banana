"use client";

import { useEffect, useState } from "react";
import { ChevronRight, PanelLeft } from "lucide-react";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/components/nodes/ui/cn";
import { HistoryButtons } from "@/components/stitch/EditorHeader";
import {
  HEADER_GHOST,
  HEADER_ICON_BUTTON,
  HEADER_OUTLINE,
  HEADER_PRIMARY,
  HEADER_TITLE,
} from "@/components/stitch/editorStyles";
import { sequenceMetaLine } from "@/components/stitch/sequenceMenu";
import type { EditorComposition } from "@/components/stitch/useEditorComposition";
import { useLibraryAvailable } from "@/components/stitch/library/useLibraryAvailable";
import { clipName } from "@/lib/stitch/labels";
import { sessionIsDirty, useEditProjectStore, type EditSaveState } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { EditMenu } from "./EditMenu";
import { EditNameField } from "./EditNameField";

/** The encoder is asked once per page. */
let encoderCheck: Promise<boolean> | null = null;

/** Whether this browser can encode the render; null until it has said. */
function useEncoderSupported(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    encoderCheck ??= import("@/hooks/useStitchVideos").then((m) => m.checkEncoderSupport()).catch(() => false);
    void encoderCheck.then((ok) => {
      if (live) setSupported(ok);
    });
    return () => {
      live = false;
    };
  }, []);
  return supported;
}

/** The word the header shows for how saving stands, in 12px ink-3 after the name (the banners carry any alarm). */
export function saveStateWord(state: EditSaveState, dirty: boolean): { text: string; title?: string } {
  switch (state) {
    case "saving":
      return { text: "Saving…" };
    case "waiting":
      return { text: "Waiting…", title: "Waiting for the library to finish moving" };
    case "failed":
      return { text: "Save failed" };
    case "gone":
      return { text: "Not in Edits" };
    case "conflict":
      return { text: "Changed elsewhere" };
    case "saved":
      return { text: dirty ? "Unsaved" : "Saved" };
  }
}

/** Why Render cannot run now, or null. */
function renderBlockedReason(
  composition: EditorComposition,
  libraryOn: boolean,
  encoder: boolean | null,
  otherRendering: boolean,
): string | null {
  if (!libraryOn) return "The asset library is off";
  if (encoder === false) return "This browser can't encode H.264 video";
  if (otherRendering) return "Another edit is rendering";
  if (composition.clipCount === 0) return "Add a clip to render";
  for (const span of composition.spans) {
    const media = composition.byClip.get(span.clip.id);
    if (media?.missing) return `${clipName(span.index)}'s video is no longer in the library`;
    if (media?.status === "error") return `${clipName(span.index)}'s video can't be read`;
  }
  const loading = composition.spans.some((span) => composition.byClip.get(span.clip.id)?.status === "loading");
  if (!loading && composition.spans.every((span) => span.length <= 0)) return "Every clip is empty";
  return null;
}

/** The edit's name in the breadcrumb, in the header's title type; a click renames it in place. */
const NAME_BUTTON = cn(HEADER_TITLE, "-mx-1 max-w-none px-1 py-0.5 font-medium focus-visible:ring-white/40");

/** The name field, set in the same type, its box clear of the chevron and its text about where the name was. */
const NAME_FIELD = cn(
  "-ml-1.5",
  "[&_input]:h-8 [&_input]:w-[360px] [&_input]:max-w-full [&_input]:rounded-md [&_input]:border-0 [&_input]:bg-edit-field [&_input]:px-2",
  "[&_input]:font-display [&_input]:text-[15px] [&_input]:font-medium [&_input]:tracking-[-0.02em]",
  "[&_input:focus-visible]:ring-white/40",
);

/**
 * The open edit's 56px header, quiet on the pane: Show media while the pane
 * is hidden, then "Edits › name" (Edits goes home; the name renames
 * in place) and how saving stands; at the right Undo, Redo and the ⋯ menu
 * (which also holds Loop and what the sequence is), then Save (only with
 * Save automatically off) and Render. A render in progress replaces Save and
 * Render with "Rendering N%" and Stop, which ends where Render did, and draws
 * its progress along the header's bottom edge.
 */
export function EditHeader({ composition }: { composition: EditorComposition }) {
  const { clipCount, size, fps } = composition;
  const name = useEditProjectStore((s) => s.open?.name ?? "");
  const editId = useEditProjectStore((s) => s.open?.id ?? null);
  const saveState = useEditProjectStore((s) => s.save.state);
  const renameError = useEditProjectStore((s) => s.renameError);
  const paneOpen = useEditProjectStore((s) => s.pane.open);
  const render = useEditProjectStore((s) => s.render);
  const autoSave = useWorkflowStore((s) => s.autoSaveEnabled);
  const dirty = useStitchEditorStore((s) => sessionIsDirty(s));
  const libraryOn = useLibraryAvailable();
  const encoder = useEncoderSupported();
  const [renaming, setRenaming] = useState(false);

  const store = useEditProjectStore.getState;
  const word = saveStateWord(saveState, dirty);
  const rendering = render.state === "rendering" && render.editId === editId;
  const blocked = renderBlockedReason(composition, libraryOn, encoder, render.state === "rendering" && !rendering);
  const percent = Math.round(Math.min(100, Math.max(0, render.progress)));

  const setEditing = (editing: boolean) => {
    setRenaming(editing);
    if (!editing) useEditProjectStore.setState({ renameError: null });
  };

  return (
    <div
      data-edit-chrome
      className={cn("relative z-20 flex h-14 shrink-0 items-center gap-2 bg-pane pr-4", paneOpen ? "pl-5" : "pl-3")}
    >
      {!paneOpen && (
        <div className="group relative flex shrink-0">
          <button
            type="button"
            aria-label="Show media"
            aria-expanded={false}
            className={HEADER_ICON_BUTTON}
            onClick={() => store().setPaneOpen(true)}
          >
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>
          <Tooltip label="Show media" placement="bottom" align="start" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            className="-mx-1 shrink-0 rounded-md px-1 py-0.5 text-[13px] leading-4 text-ink-3 transition-colors hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            onClick={() => void store().goHome()}
          >
            Edits
          </button>
          <ChevronRight size={14} strokeWidth={1.5} className="shrink-0 text-neutral-600" aria-hidden="true" />
          <EditNameField
            name={name}
            editing={renaming}
            onEditingChange={setEditing}
            onCommit={(next) => store().rename(next)}
            error={renameError}
            className={NAME_FIELD}
            buttonClassName={NAME_BUTTON}
          />
        </nav>
        <span
          aria-live="polite"
          data-testid="edit-save-state"
          title={word.title}
          className="ml-3 shrink-0 whitespace-nowrap text-xs leading-4 text-ink-3"
        >
          {word.text}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <HistoryButtons />
        <EditMenu onRename={() => setEditing(true)} meta={sequenceMetaLine(clipCount, size, fps)} />
      </div>
      {rendering ? (
        <div className="ml-2 flex shrink-0 items-center gap-3">
          {/* As wide as "Rendering 100%", so the buttons beside it stay put as the number grows */}
          <span className="w-[104px] whitespace-nowrap text-right text-[13px] tabular-nums text-neutral-300">{`Rendering ${percent}%`}</span>
          <button type="button" className={HEADER_OUTLINE} onClick={() => store().stopRender()}>
            Stop
          </button>
        </div>
      ) : (
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {!autoSave && (
            <div className="group relative flex">
              <button
                type="button"
                className={HEADER_GHOST}
                disabled={!dirty && saveState === "saved"}
                onClick={() => void store().saveNow("manual")}
              >
                Save
              </button>
              <Tooltip label="Save" shortcut="⌘S" placement="bottom" />
            </div>
          )}
          {/* On the wrapper: a disabled button is never hovered itself */}
          <div className="group relative flex" data-testid="edit-render-slot">
            <button
              type="button"
              className={HEADER_PRIMARY}
              disabled={blocked !== null}
              onClick={() => store().startRender()}
            >
              Render
            </button>
            {blocked && <Tooltip label={blocked} placement="bottom" align="end" />}
          </div>
        </div>
      )}
      {rendering && (
        <div
          role="progressbar"
          aria-label="Rendering"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-edit-line"
        >
          <div
            className="h-full bg-neutral-100 transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}
