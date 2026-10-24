"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { Dialog, DialogButton, DialogCloseButton, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/Dialog";
import { addToOpenEditMedia, editUploadContext, uploadFiles, type FileUpload } from "@/components/edit/mediaUploads";
import { DropToAdd, FILE_DROP_FRAME, useFileDrop } from "@/components/edit/useFileDrop";
import { useEditProjectStore } from "@/store/editProjectStore";
import { useStitchEditorStore, type StitchEditorState } from "@/store/stitchEditorStore";
import { useWorkflowStore } from "@/store/workflowStore";
import { fetchFacets } from "@/lib/assets/client/api";
import { UPLOAD_ACCEPT } from "@/lib/assets/client/upload";
import type { AssetFacets, AssetView } from "@/lib/assets/types";
import { DEFAULT_LIBRARY_QUERY, libraryKinds, type LibraryKind, type LibraryVideoQuery } from "@/lib/stitch/libraryRequest";
import { draftSpans } from "@/lib/stitch/draft";
import { clipName } from "@/lib/stitch/labels";
import { isPlaced } from "@/lib/stitch/timeline";
import { formatTimecode } from "@/lib/stitch/timecode";
import { addLibraryClips, drawnPlayhead } from "../editorActions";
import { DIALOG_BUTTON_RING, HEADER_TITLE, QUIET_BUTTON, STITCH_EDITOR_PANEL } from "../editorStyles";
import { LibraryResults, type LibraryLeadingItem } from "./LibraryResults";
import { FilterDivider, FilterRow, FilterSegments, FilterSwitch, LibrarySearch, SORT_OPTIONS } from "./LibrarySearch";
import { LibraryTile, PendingTile } from "./LibraryTile";
import { ProjectMenu } from "./ProjectMenu";
import { useLibraryAvailable } from "./useLibraryAvailable";
import { useLibraryVideos } from "./useLibraryVideos";

const NO_PROJECTS: AssetFacets["projects"] = [];

const KIND_OPTIONS: readonly { value: LibraryKind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
];

/** What the list says with nothing to show, by kind: when something narrows it, and when the library has none. */
const EMPTY_TEXT: Record<LibraryKind, { filtered: string; none: string }> = {
  all: { filtered: "No videos or audio match", none: "Nothing in the library yet" },
  video: { filtered: "No videos match", none: "No videos in the library yet" },
  audio: { filtered: "No audio matches", none: "No audio in the library yet" },
};

const UPLOADING = "Uploading…";

/** The footer's buttons on the pane ground: the editor's white ring, set off by the pane. */
const PANE_BUTTON = cn(DIALOG_BUTTON_RING, "focus-visible:ring-offset-pane");

const closePicker = () => useStitchEditorStore.getState().setPickerOpen(false);

/** A file the picker's Upload (or a drop on it) is recording, and its record once it exists. */
interface PickerUpload extends FileUpload {
  asset: AssetView | null;
}

/**
 * The clip new ones go after: the last row, or in a placed stack the clip that ends last (they start Overlap before
 * its end). -1 with no clip.
 */
function goesAfterIndex(s: StitchEditorState): number {
  const draft = s.draft;
  if (!draft || draft.timeline.length === 0) return -1;
  const last = draft.timeline.length - 1;
  if (draft.sequenceLayout.mode !== "stacked" || !isPlaced(draft.timeline)) return last;
  let latest: { index: number; end: number } | null = null;
  for (const span of draftSpans(draft, s.durations)) {
    if (span.length > 0 && (!latest || span.end >= latest.end)) latest = { index: span.index, end: span.end };
  }
  return latest?.index ?? last;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 videos", "1 audio file", "2 videos and 1 audio file". */
function pickedSummary(videos: number, sounds: number): string {
  return [videos > 0 ? count(videos, "video", "videos") : null, sounds > 0 ? count(sounds, "audio file", "audio files") : null]
    .filter(Boolean)
    .join(" and ");
}

/** Where the dialog's Add puts the picks: videos after the last clip, each sound on a new row at the playhead. */
function whereText(videos: number, sounds: number, afterIndex: number, playhead: number): string {
  const after = afterIndex >= 0 ? `after ${clipName(afterIndex)}` : "first";
  const at = `at ${formatTimecode(playhead)} on a new row`;
  if (sounds === 0) return `goes ${after}`;
  if (videos === 0) return `${sounds === 1 ? "starts" : "each starts"} ${at}`;
  const video = videos === 1 ? "the video goes" : "the videos go";
  const sound = sounds === 1 ? "the audio file starts" : "each audio file starts";
  return `${video} ${after}, ${sound} ${at}`;
}

/**
 * Add media, over the Stitch editor: the library's videos and audio files
 * grouped by project, searched, and narrowed by kind (from what opened it:
 * a timeline + shows videos, + Audio audio, the media pane's Add media both),
 * project, favourites and (in the node's dialog) this workflow, newest or
 * oldest first, in the search's filter popover. Files are picked in order, and
 * picks outlast every filter. Upload (or files dropped on it) records files
 * from the computer into the library; each shows at the top as it uploads,
 * then as a picked tile, whatever the filters say. Add waits for them.
 *
 * In the Edit video view, Add puts the picks in the edit's media (the pane,
 * shown if it was hidden, selects the last), nothing on the timeline. In the
 * node's dialog it puts each video after the last clip and each sound on a
 * new audio row of its own at the playhead, as one undo step. The picker owns
 * its query and its pages; it never touches the Assets view's own list.
 * Escape closes only the picker.
 */
export function LibraryPicker() {
  const open = useStitchEditorStore((s) => s.pickerOpen);
  if (!open) return null;
  return <OpenPicker key={open} preset={open} />;
}

function OpenPicker({ preset }: { preset: LibraryKind }) {
  const workflowId = useWorkflowStore((s) => s.workflowId);
  const inEdit = useStitchEditorStore((s) => s.editId !== null);
  const afterIndex = useStitchEditorStore(goesAfterIndex);
  const playhead = useStitchEditorStore(drawnPlayhead);
  const libraryOn = useLibraryAvailable();
  const [kind, setKind] = useState<LibraryKind>(preset);
  const [query, setQuery] = useState<LibraryVideoQuery>(DEFAULT_LIBRARY_QUERY);
  const list = useLibraryVideos(query, workflowId, libraryOn, libraryKinds(kind));
  const update = (patch: Partial<LibraryVideoQuery>) => setQuery((q) => ({ ...q, ...patch }));

  // Focus goes to the search through the Dialog (not autoFocus), so the Dialog records what opened it and gives
  // focus back to it. After an Add in the node's dialog, the first added clip takes it instead: focusing it scrolls
  // the lanes to it (a zoomed-in timeline may have it far off to the right), and the keyboard lands on what was
  // added. After an Add in the view whose opener is gone (the empty pane's Add media), the item it revealed in the
  // pane does. When none is there, the editor's panel takes it, so its keys and its Tab trap keep working.
  const searchRef = useRef<HTMLInputElement>(null);
  const added = useRef<"clips" | "media" | null>(null);
  useEffect(
    () => () => {
      const placed = added.current;
      requestAnimationFrame(() => {
        const panel = document.querySelector<HTMLElement>(`[${STITCH_EDITOR_PANEL}]`);
        if (placed === "clips") {
          const selection = useStitchEditorStore.getState().selection;
          const box = selection
            ? panel?.querySelector<HTMLElement>(
                selection.kind === "audio"
                  ? `[role="option"][data-audio-clip-id="${CSS.escape(selection.clipId)}"]`
                  : `[role="option"][data-clip-id="${CSS.escape(selection.clipId)}"]`,
              )
            : null;
          if (box) {
            box.focus();
            return;
          }
        }
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) return;
        if (placed === "media") {
          const id = useEditProjectStore.getState().mediaFocus.id;
          const item = id
            ? document.querySelector<HTMLElement>(`[data-media-id="${CSS.escape(id)}"] button[data-asset-id]:not(:disabled)`)
            : null;
          if (item) {
            item.focus({ preventScroll: true });
            return;
          }
        }
        panel?.focus({ preventScroll: true });
      });
    },
    [],
  );

  /** In the order they were picked; kept across filter changes, so a pick is never lost by narrowing the list. */
  const [picked, setPicked] = useState<AssetView[]>([]);
  const toggle = useCallback(
    (asset: AssetView) =>
      setPicked((prev) => (prev.some((a) => a.id === asset.id) ? prev.filter((a) => a.id !== asset.id) : [...prev, asset])),
    [],
  );

  // Uploads, in the order they were started: each is shown at the top until the picker closes, and picked once its
  // record exists, among the picks in the order the files were started however soon each is recorded. Recorded under
  // the open edit in the view (it joins the media on Add); under "Uploads" in the node's dialog.
  const [uploads, setUploads] = useState<PickerUpload[]>([]);
  const startedUploads = useRef(0);
  /** A record's id → its upload's place in the order the uploads were started. */
  const uploadRank = useRef(new Map<string, number>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = (files: File[]) => {
    const editId = useStitchEditorStore.getState().editId;
    const ranks = new Map<string, number>();
    uploadFiles(files, editId !== null ? editUploadContext(editId) : {}, {
      started: (file) => {
        ranks.set(file.key, startedUploads.current++);
        setUploads((prev) => [...prev, { ...file, asset: null }]);
      },
      recorded: (file, asset) => {
        const rank = ranks.get(file.key)!;
        uploadRank.current.set(asset.id, rank);
        setUploads((prev) => prev.map((u) => (u.key === file.key ? { ...u, asset } : u)));
        setPicked((prev) => {
          if (prev.some((a) => a.id === asset.id)) return prev;
          const before = prev.findIndex((a) => (uploadRank.current.get(a.id) ?? -1) > rank);
          return before < 0 ? [...prev, asset] : [...prev.slice(0, before), asset, ...prev.slice(before)];
        });
      },
      failed: (file) => setUploads((prev) => prev.filter((u) => u.key !== file.key)),
    });
  };
  const fileDrop = useFileDrop(upload, libraryOn);

  // The uploads' records show at the top only, never again in the list under them
  const uploadedIds = useMemo(() => new Set(uploads.flatMap((u) => (u.asset ? [u.asset.id] : []))), [uploads]);
  // Add waits for them: one still uploading would be left out
  const uploading = uploads.filter((u) => u.asset === null).length;

  const add = () => {
    if (inEdit) {
      added.current = "media";
      // The picks go to the pane, so a hidden one is shown (the timeline's + and + Audio open the picker without it)
      useEditProjectStore.getState().setPaneOpen(true);
      addToOpenEditMedia(picked, (asset) => uploadedIds.has(asset.id));
      closePicker();
      return;
    }
    added.current = "clips";
    addLibraryClips(picked);
  };

  const listed = list.assets;
  const assets = useMemo(
    () => (uploadedIds.size === 0 ? listed : listed.filter((asset) => !uploadedIds.has(asset.id))),
    [listed, uploadedIds],
  );
  const leading = useMemo(
    () => ({
      label: "Uploads",
      items: uploads.map(
        (u): LibraryLeadingItem => ({
          key: u.key,
          kind: u.asset ? (u.asset.kind === "audio" ? "audio" : "video") : u.kind,
          asset: u.asset,
          pending: (
            <div aria-busy="true" data-upload-pending={u.key}>
              <PendingTile name={u.name} kind={u.kind} note={UPLOADING} />
            </div>
          ),
        }),
      ),
    }),
    [uploads],
  );

  // The scrim closes the picker only for a press that starts and ends on it: a drag out of the search field
  // that is let go over the scrim is not a click on it, and must not drop the picks
  const pressedScrim = useRef(false);

  const [projects, setProjects] = useState<AssetFacets["projects"]>(NO_PROJECTS);
  useEffect(() => {
    if (!libraryOn) return;
    const controller = new AbortController();
    fetchFacets(controller.signal).then(
      (facets) => setProjects(facets.projects),
      () => {
        // The menu then offers All projects only
      },
    );
    return () => controller.abort();
  }, [libraryOn]);

  // Enter in the search goes to the first file in the list, which Enter or Space then picks
  const resultsRef = useRef<HTMLDivElement>(null);
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    const first = resultsRef.current?.querySelector<HTMLElement>("button[data-asset-id]:not(:disabled)");
    if (!first) return;
    event.preventDefault();
    first.focus();
  };

  const pickedIds = new Set(picked.map((a) => a.id));
  const pickedSec = picked.reduce((sum, a) => sum + (a.durationSec ?? 0), 0);
  const n = picked.length;
  const sounds = picked.filter((a) => a.kind === "audio").length;
  const where = inEdit || n === 0 ? null : whereText(n - sounds, sounds, afterIndex, playhead);
  // While files upload the footer says so, in place of where the picks go (which the uploads may change)
  const uploadingText = uploading > 0 ? `Uploading ${count(uploading, "file", "files")}…` : null;
  const note = uploadingText ?? where;
  const filtered = query.q.trim() !== "" || query.project !== null || query.favourites || query.thisWorkflow;
  // The dot on the filter button: anything in its popover not as it opened (the kind it opened on is its default)
  const filtersOn = kind !== preset || query.project !== null || query.favourites || query.thisWorkflow || query.sort !== "newest";
  // An empty library is no longer empty once something of the kind listed is uploaded: the list then says nothing
  // under the uploads
  const uploadedKind = leading.items.some((item) => kind === "all" || item.kind === kind);
  const emptyText = uploadedKind && !filtered ? null : EMPTY_TEXT[kind][filtered ? "filtered" : "none"];

  return (
    <Dialog
      open
      onClose={closePicker}
      size="lg"
      portal
      initialFocusRef={searchRef}
      closeOnBackdrop={false}
      overlayProps={{
        onPointerDown: (event) => {
          pressedScrim.current = event.target === event.currentTarget;
        },
        onClick: (event) => {
          if (event.target === event.currentTarget && pressedScrim.current) closePicker();
          pressedScrim.current = false;
        },
      }}
      panelProps={fileDrop.handlers}
      className="max-w-[880px] h-[min(580px,85vh)] border-edit-line bg-pane"
    >
      {/* Its own Close, for the editor's white ring (the header's would be the dialogs' blue) */}
      <DialogHeader
        divider
        closeButton={false}
        className="items-center border-edit-line py-3"
        actions={
          <>
            <button
              type="button"
              disabled={!libraryOn}
              onClick={() => fileInputRef.current?.click()}
              className={cn(QUIET_BUTTON, "gap-1.5 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent")}
            >
              <Upload size={14} strokeWidth={1.5} aria-hidden="true" />
              Upload
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              multiple
              hidden
              tabIndex={-1}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                // Cleared, so the same file can be chosen again
                event.target.value = "";
                if (files.length > 0) upload(files);
              }}
            />
            <DialogCloseButton className={DIALOG_BUTTON_RING} />
          </>
        }
      >
        <div className="flex min-w-0 items-center gap-4">
          <DialogTitle className={cn(HEADER_TITLE, "shrink-0")}>Add media</DialogTitle>
          <LibrarySearch
            inputRef={searchRef}
            className="w-[280px] min-w-0 shrink"
            label="Search the library"
            placeholder="Search"
            value={query.q}
            onChange={(q) => update({ q })}
            onKeyDown={onSearchKeyDown}
            disabled={!libraryOn}
            filtered={filtersOn}
            filters={
              <>
                <FilterRow label="Kind">
                  <FilterSegments label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
                </FilterRow>
                <FilterRow label="Project">
                  <ProjectMenu value={query.project} projects={projects} onChange={(project) => update({ project })} />
                </FilterRow>
                <FilterSwitch label="Favorites" checked={query.favourites} onChange={(favourites) => update({ favourites })} />
                {!inEdit && (
                  <FilterSwitch
                    label="This workflow"
                    checked={query.thisWorkflow}
                    disabled={workflowId === null}
                    title={workflowId === null ? "Nothing from this workflow is in the library yet" : undefined}
                    onChange={(thisWorkflow) => update({ thisWorkflow })}
                  />
                )}
                <FilterDivider />
                <FilterRow label="Sort">
                  <FilterSegments label="Sort" value={query.sort} options={SORT_OPTIONS} onChange={(sort) => update({ sort })} />
                </FilterRow>
              </>
            }
          />
        </div>
      </DialogHeader>

      <div ref={resultsRef} className={cn("relative flex min-h-0 flex-1 flex-col", fileDrop.over && FILE_DROP_FRAME)}>
        <LibraryResults
          libraryOn={libraryOn}
          list={{ ...list, assets }}
          emptyText={emptyText}
          layout="picker"
          testId="stitch-library-grid"
          className="px-5 pt-4 pb-4"
          leading={leading}
          renderTile={(asset, { scrollRoot, posterReady }) => (
            <LibraryTile
              asset={asset}
              selected={pickedIds.has(asset.id)}
              posterReady={posterReady}
              scrollRoot={scrollRoot}
              onToggle={toggle}
            />
          )}
        />
        {fileDrop.over && <DropToAdd />}
      </div>

      <DialogFooter className="border-edit-line">
        <div className="mr-auto flex min-w-0 items-center gap-2 text-xs">
          {n > 0 ? (
            <>
              <span className="shrink-0 text-neutral-400">{pickedSummary(n - sounds, sounds)}</span>
              <span aria-hidden="true" className="text-neutral-600">
                ·
              </span>
              <span className="shrink-0 tabular-nums text-neutral-400">{formatTimecode(pickedSec, 0)}</span>
              {note && <span className="ml-1 min-w-0 truncate text-ink-3">{note}</span>}
            </>
          ) : (
            <span className="text-neutral-400">{uploadingText ?? "Pick videos or audio to add"}</span>
          )}
        </div>
        <DialogButton variant="ghost" className={PANE_BUTTON} onClick={closePicker}>
          Cancel
        </DialogButton>
        <DialogButton variant="primary" className={PANE_BUTTON} disabled={n === 0 || uploading > 0} onClick={add}>
          Add
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
