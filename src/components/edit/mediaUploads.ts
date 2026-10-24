import { useEffect } from "react";
import { create } from "zustand";
import { useToast } from "@/components/Toast";
import { addMediaItems } from "@/components/stitch/editorActions";
import {
  NOT_MEDIA_REASON,
  recordUpload,
  UNSUPPORTED_MEDIA_REASON,
  uploadVerdict,
  type UploadContext,
  type UploadKind,
} from "@/lib/assets/client/upload";
import type { AssetView } from "@/lib/assets/types";
import { editMediaOf } from "@/lib/edits/document";
import { getAssetInfo, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { editSwitchInProgress, onEditIdMoved, onEditSwitchEnded, useEditProjectStore } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";

/**
 * Files from the computer, recorded into the asset library as uploads.
 * `uploadFiles` does that for both of Add media's pickers (the Edit video
 * view's, under the open edit, and a Stitch node's editor's, under
 * "Uploads") and for the media pane.
 *
 * Files dropped on the Edit video view's media pane are on their way into an
 * edit's media: each is recorded as an upload, all at once (the recorder
 * sends two at a time). Until it joins the edit's media a file is a pending
 * upload here, kept by edit, so the pane still shows it after being hidden
 * or the view left. Recorded files join in the order they were dropped (one
 * waits for a file dropped before it), as one undo step, and the pane
 * scrolls to the last; one recorded while the edit is not open joins the
 * next time it is. They wait, too, while a switch away from the edit saves
 * or asks (the draft may be closed unsaved: they join the edit when it next
 * opens, or as soon as the switch ends without leaving it), and while a
 * gesture runs (a slider drag or a run of nudges is one undo step, which
 * they would split): they join as it ends. Like any change, a file joining
 * clears what Redo could bring back.
 */

/** A file on its way into the library. */
export interface FileUpload {
  /** Tells two uploads of one file apart. */
  key: string;
  /** The file's own name, which its row shows until the record names it. */
  name: string;
  kind: UploadKind;
}

export interface UploadHandlers {
  started?(upload: FileUpload): void;
  recorded(upload: FileUpload, asset: AssetView): void;
  /** After the failure toast. */
  failed?(upload: FileUpload, reason: string): void;
}

let nextKey = 0;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Records the video and audio files among `files` into the library, every one at once; anything else is left out,
 * with one notice for the lot. So is video or audio in a format the library doesn't store (AVI, AIFF…), with a
 * notice of its own that names the files. A file that can't be added says so with its name and why. Each record
 * goes to the asset cache before `recorded` hears of it. Returns the uploads started, in the order given.
 */
export function uploadFiles(files: Iterable<File>, context: UploadContext, on: UploadHandlers): FileUpload[] {
  const started: { file: File; upload: FileUpload }[] = [];
  const unsupported: string[] = [];
  let skipped = false;
  for (const file of files) {
    const verdict = uploadVerdict(file);
    if (verdict === "video" || verdict === "audio") {
      started.push({ file, upload: { key: `upload-${++nextKey}`, name: file.name, kind: verdict } });
    } else if (verdict === "unsupported") unsupported.push(file.name);
    else skipped = true;
  }
  if (skipped) useToast.getState().show(NOT_MEDIA_REASON, "info");
  if (unsupported.length > 0) {
    const [title, detail] =
      unsupported.length === 1
        ? [`Couldn't add “${unsupported[0]}”`, UNSUPPORTED_MEDIA_REASON]
        : [`Couldn't add ${unsupported.length} files`, `${UNSUPPORTED_MEDIA_REASON.replace(/\.$/, "")}: ${unsupported.join(", ")}.`];
    useToast.getState().show(title, "error", false, detail);
  }
  for (const { file, upload } of started) {
    on.started?.(upload);
    recordUpload(file, context).then(
      (asset) => {
        primeAssetInfo([asset]);
        on.recorded(upload, asset);
      },
      (error: unknown) => {
        const reason = reasonOf(error);
        useToast.getState().show(`Couldn't add “${upload.name}”`, "error", false, reason);
        on.failed?.(upload, reason);
      },
    );
  }
  return started.map(({ upload }) => upload);
}

/** A file dropped on an edit's media pane. */
export interface PendingMedia extends FileUpload {
  editId: string;
  /** Its record, once one exists: it joins the edit's media after the files dropped before it, with the edit open. */
  asset: AssetView | null;
}

interface MediaUploadsState {
  uploads: PendingMedia[];
}

export const useMediaUploads = create<MediaUploadsState>(() => ({ uploads: [] }));

const setUploads = (recipe: (uploads: PendingMedia[]) => PendingMedia[]) =>
  useMediaUploads.setState((state) => ({ uploads: recipe(state.uploads) }));

/**
 * Whether the editor holds that edit's session (the view shows it), and no switch away from it is saving or asking:
 * the draft may then be closed unsaved, and a file put in it would be lost with it.
 */
function editorHolds(editId: string): boolean {
  const s = useStitchEditorStore.getState();
  return s.isOpen && s.editId === editId && s.draft?.media !== undefined && !editSwitchInProgress();
}

/**
 * A gesture whose key is still set but that has not changed the draft for this long is over: a nudge's key stays
 * until the next press, and files waiting on it would wait for that.
 */
export const GESTURE_IDLE_MS = 1_000;

/** When a gesture last changed the draft. */
let gestureChangedAt = 0;
let gestureRetry: ReturnType<typeof setTimeout> | null = null;

/** How much longer the gesture running holds recorded files back: 0 with none running. */
function gestureHold(): number {
  if (useStitchEditorStore.getState().gestureKey === null) return 0;
  return Math.max(0, gestureChangedAt + GESTURE_IDLE_MS - Date.now());
}

/** The open edit's recorded uploads join its media, if they can now. */
function addRecordedToOpenEdit(): void {
  const { isOpen, editId } = useStitchEditorStore.getState();
  if (isOpen && editId !== null) addRecordedUploads(editId);
}

/**
 * The item already in the open edit's media with these very bytes (the same file dropped again is a second record
 * of one file), or null. One whose file the library lost doesn't count: the new record can be placed.
 */
function sameFileInMedia(asset: AssetView): string | null {
  const draft = useStitchEditorStore.getState().draft;
  if (!draft) return null;
  for (const id of editMediaOf(draft)) {
    if (id === asset.id) continue;
    const view = getAssetInfo(id);
    if (view && !view.missing && view.sha256 === asset.sha256) return id;
  }
  return null;
}

/**
 * Files into the open edit's media, in order, as one undo step (Add media's picks, the files dropped on the pane);
 * one already there adds nothing. Nor does a file just recorded from the computer (`fromComputer`: every one dropped
 * on the pane) whose bytes the media holds already: the same file added twice is a second record of it. A pick from
 * the library is added whatever its bytes. The pane selects the last of them and scrolls to it (the one already
 * there, for a file added twice).
 */
export function addToOpenEditMedia(
  assets: readonly AssetView[],
  fromComputer: (asset: AssetView) => boolean = () => true,
): void {
  let last: string | null = null;
  const fresh: AssetView[] = [];
  for (const asset of assets) {
    const existing = fromComputer(asset)
      ? (sameFileInMedia(asset) ?? fresh.find((other) => other.sha256 === asset.sha256)?.id ?? null)
      : null;
    if (existing) last = existing;
    else {
      fresh.push(asset);
      last = asset.id;
    }
  }
  addMediaItems(fresh);
  if (last) useEditProjectStore.getState().revealMedia(last);
}

/** What a file added to an edit is recorded under: the edit, and its name while it is the open one. */
export function editUploadContext(editId: string): { editId: string; editName?: string } {
  const open = useEditProjectStore.getState().open;
  return { editId, editName: open?.id === editId ? open.name : undefined };
}

/** The edit an upload is going into now: Save as a new edit moves them. */
const editOf = (key: string) => useMediaUploads.getState().uploads.find((upload) => upload.key === key)?.editId ?? null;

/**
 * The files dropped on an edit's media pane: video and audio are recorded into the library as uploads under the edit
 * and join its media in the order they came as their records exist (anything else is left out, with one notice).
 * Each shows as a pending upload of that edit until then.
 */
export function addFilesToEdit(files: Iterable<File>, edit: { editId: string; editName?: string }): void {
  uploadFiles(files, edit, {
    started: (upload) => setUploads((uploads) => [...uploads, { ...upload, editId: edit.editId, asset: null }]),
    recorded: (upload, asset) => {
      const editId = editOf(upload.key);
      if (editId === null) return;
      setUploads((uploads) => uploads.map((u) => (u.key === upload.key ? { ...u, asset } : u)));
      addRecordedUploads(editId);
    },
    failed: (upload) => {
      const editId = editOf(upload.key);
      if (editId === null) return;
      setUploads((uploads) => uploads.filter((u) => u.key !== upload.key));
      // The files dropped after it may have been waiting for it
      addRecordedUploads(editId);
    },
  });
}

/**
 * Once the editor holds `editId`: its recorded uploads join its media in the order they were dropped, as one undo
 * step, up to the first one still being recorded.
 */
export function addRecordedUploads(editId: string): void {
  if (!editorHolds(editId)) return;
  const ready: PendingMedia[] = [];
  for (const upload of useMediaUploads.getState().uploads) {
    if (upload.editId !== editId) continue;
    if (!upload.asset) break;
    ready.push(upload);
  }
  if (ready.length === 0) return;
  const hold = gestureHold();
  if (hold > 0) {
    // Looked at again once the gesture could be idle, in case its key is never cleared
    if (gestureRetry === null) {
      gestureRetry = setTimeout(() => {
        gestureRetry = null;
        addRecordedToOpenEdit();
      }, hold);
    }
    return;
  }
  const keys = new Set(ready.map((upload) => upload.key));
  setUploads((uploads) => uploads.filter((upload) => !keys.has(upload.key)));
  addToOpenEditMedia(ready.map((upload) => upload.asset!));
}

/** Save as a new edit: the uploads still on their way into `from` go into the new edit instead. */
export function moveEditUploads(from: string, to: string): void {
  if (!useMediaUploads.getState().uploads.some((upload) => upload.editId === from)) return;
  setUploads((uploads) => uploads.map((upload) => (upload.editId === from ? { ...upload, editId: to } : upload)));
}

onEditIdMoved(moveEditUploads);
// The switch was cancelled or refused, or opened another edit: the files held back join the edit now open
onEditSwitchEnded(addRecordedToOpenEdit);
useStitchEditorStore.subscribe((state, previous) => {
  if (state.gestureKey !== null && state.draft !== previous.draft) gestureChangedAt = Date.now();
  else if (state.gestureKey === null && previous.gestureKey !== null) addRecordedToOpenEdit();
});

/** For the open edit: its uploads recorded while it was not open (or under the id it had) join its media as it shows. */
export function useAddRecordedUploads(): void {
  const editId = useStitchEditorStore((s) => (s.isOpen ? s.editId : null));
  const ready = useMediaUploads((s) => editId !== null && !!s.uploads.find((upload) => upload.editId === editId)?.asset);
  useEffect(() => {
    if (editId !== null && ready) addRecordedUploads(editId);
  }, [editId, ready]);
}

/** For tests: no uploads pending. */
export function __resetMediaUploadsForTests(): void {
  nextKey = 0;
  gestureChangedAt = 0;
  if (gestureRetry !== null) clearTimeout(gestureRetry);
  gestureRetry = null;
  useMediaUploads.setState({ uploads: [] });
}
