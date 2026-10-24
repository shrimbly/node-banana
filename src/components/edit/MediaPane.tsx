"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { AudioLines, LayoutGrid, List, MoreHorizontal, Music, PanelLeftClose, Plus } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { DialogButton } from "@/components/ui/Dialog";
import { Tooltip } from "@/components/ui/Tooltip";
import { tileThumbUrl } from "@/components/assets/AssetTile";
import { patchAsset } from "@/lib/assets/client/api";
import { onPosterReady } from "@/lib/assets/client/poster";
import { ASSET_NAME_MAX, assetName } from "@/lib/assets/name";
import type { AssetView } from "@/lib/assets/types";
import { editMediaOf } from "@/lib/edits/document";
import type { EditAssetSnapshot } from "@/lib/edits/types";
import {
  getAssetInfo,
  getAssetInfoVersion,
  primeAssetInfo,
  requestAssetInfo,
  subscribeAssetInfo,
} from "@/lib/stitch/assetInfo";
import { WAITING_FOR_CLIPS } from "@/lib/stitch/libraryInsert";
import { formatTimecode } from "@/lib/stitch/timecode";
import { ActionMenu } from "@/components/stitch/ActionMenu";
import {
  addLibraryItemAt,
  libraryAddBlockedReason,
  mediaUseCount,
  openLibraryPicker,
  removeMediaItem,
} from "@/components/stitch/editorActions";
import {
  CONTROL_BUTTON,
  DIALOG_BUTTON_RING,
  EDITOR_CHIP,
  HEADER_ICON_BUTTON,
  ICON_BUTTON,
  LIFTED_CLIP,
  QUIET_BUTTON,
  STITCH_EDITOR_PANEL,
} from "@/components/stitch/editorStyles";
import {
  BlankCover,
  CoverImage,
  CoverLength,
  DimmedCover,
  LIBRARY_ADD_HINT,
  LibraryTile,
  PendingTile,
  useOnScreen,
  usePosterRequest,
} from "@/components/stitch/library/LibraryTile";
import { keepFocus } from "@/components/stitch/timeline/ClipBox";
import { useAssetStore } from "@/store/assetStore";
import { useEditProjectStore, type EditPaneLayout } from "@/store/editProjectStore";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { EditNameField } from "./EditNameField";
import { Sheet } from "./EditSheets";
import { addFilesToEdit, editUploadContext, useMediaUploads, type PendingMedia } from "./mediaUploads";
import { showInAssets } from "./renderEdit";
import { DropToAdd, FILE_DROP_FRAME, useFileDrop } from "./useFileDrop";
import { useLibraryDrag, useLibraryDragGhost } from "./useLibraryDrag";

/** How long a click on an item's name waits for a second one before it adds: a double-click renames instead. */
export const NAME_CLICK_WAIT_MS = 250;
const NOT_IN_LIBRARY = "Not in the library";
const NO_IDS: string[] = [];
/** The ghost's cover, as wide as a tile's; an audio file's row. */
const GHOST_WIDTH = 112;
const GHOST_ROW_WIDTH = 200;
/** A list row's cover, px wide: the thumbnail size asked for. */
const LIST_COVER_WIDTH = 56;
/** The ⋯ menu's height and gap, about: it opens upward when the pane has less room than this under its item. */
const MENU_PX = 140;
/** Marks the pane's scroller, which a ⋯ menu measures its room in. */
const MEDIA_SCROLLER = "data-media-scroller";
/** A sound's cover in a list row: its glyph on the slot ground. */
const SOUND_COVER = "flex h-8 w-14 shrink-0 items-center justify-center rounded bg-edit-slot";
const ADDING = "Adding…";

const VIDEO_ITEM = { assetId: "", kind: "video", durationSec: null } as const;

const LAYOUTS: ReadonlyArray<{ layout: EditPaneLayout; label: string; Icon: typeof List }> = [
  { layout: "list", label: "List", Icon: List },
  { layout: "grid", label: "Grid", Icon: LayoutGrid },
];

/** One of the edit's media, as the pane shows it. */
interface MediaItem {
  id: string;
  /** The library's record: null once the library says it is gone, undefined while it is read. */
  view: AssetView | null | undefined;
  name: string;
  kind: "video" | "audio";
  durationSec: number | null;
  /** The library has lost it (no record, or a record whose file is missing): it cannot be placed. */
  lost: boolean;
}

function mediaItem(id: string, view: AssetView | null | undefined, snapshot: EditAssetSnapshot | undefined): MediaItem {
  const kind = view?.kind === "audio" || view?.kind === "video" ? view.kind : (snapshot?.kind ?? "video");
  const seconds = view ? view.durationSec : snapshot?.durationSec;
  return {
    id,
    view,
    name: view ? assetName(view) : (snapshot?.name ?? "Unknown file"),
    kind,
    durationSec: typeof seconds === "number" && seconds > 0 ? seconds : null,
    lost: view === null || view?.missing === true,
  };
}

/** The record an item can be placed from: there, and its file too. */
const placeable = (item: MediaItem): AssetView | null => (item.view && !item.lost ? item.view : null);

/** Why a video cannot be added at the playhead now (one answer for every video), or null. */
function useVideoAddBlocked(): string | null {
  return useStitchEditorStore((s) => libraryAddBlockedReason(VIDEO_ITEM, s));
}

/** Files dropped on the pane go into the edit it shows. */
function dropFiles(files: File[]): void {
  const editId = useStitchEditorStore.getState().editId;
  if (editId === null || files.length === 0) return;
  addFilesToEdit(files, editUploadContext(editId));
}

/** The pane's open ⋯ menu and rename field, and what an item's add, rename and removal do. */
interface ItemActions {
  selectedId: string | null;
  videoBlocked: string | null;
  menuFor: string | null;
  setMenuFor: (id: string | null) => void;
  /** The item whose name is a field, and the note under it when a rename of that item was refused. */
  renaming: string | null;
  renameError: { id: string; message: string } | null;
  startRename: (id: string) => void;
  /** The field of `id` closed: a later one (another item's) stays open. */
  endRename: (id: string) => void;
  commitRename: (view: AssetView, value: string) => Promise<boolean>;
  remove: (item: MediaItem) => void;
  add: (view: AssetView) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, view: AssetView) => void;
  consumeClick: () => boolean;
  scrollRoot: HTMLElement | null;
  posters: ReadonlySet<string>;
}

/**
 * The Edit video view's media pane, beside the timeline: the edit's own
 * videos and sounds (its `media`), in the order they came in, as a list (a
 * small cover, the name, the length) or a grid (covers two to a row, sounds
 * as rows). A click (or Enter) on one adds it at the playhead; a drag puts it
 * where it is dropped on the timeline (which the tooltips say). A double-click
 * on a name, or ⋯ › Rename, renames it in place: the asset's display name, so
 * the library and every edit see it. ⋯ also shows it in Assets and removes it
 * from the edit, with its clips (asking first when it has any). Add media
 * opens the library picker. An item the library has lost says so and can no
 * longer be placed.
 *
 * Video and audio files dropped on the pane from the computer (its empty
 * state too) are recorded into the library and join the media; each shows
 * after it as "Adding…" until it is in (`mediaUploads.ts`).
 */
export function MediaPane() {
  const layout = useEditProjectStore((s) => s.pane.layout);
  const selectedId = useEditProjectStore((s) => s.mediaFocus.id);
  const reveal = useEditProjectStore((s) => s.mediaFocus.reveal);
  const snapshot = useEditProjectStore((s) => s.open?.assets);
  const editId = useStitchEditorStore((s) => s.editId);
  const media = useStitchEditorStore((s) => s.draft?.media);
  const timeline = useStitchEditorStore((s) => s.draft?.timeline);
  const audioClips = useStitchEditorStore((s) => s.draft?.audioClips);
  const uploads = useMediaUploads((s) => s.uploads);
  const videoBlocked = useVideoAddBlocked();
  const drag = useLibraryDrag();
  const fileDrop = useFileDrop(dropFiles);
  const version = useSyncExternalStore(subscribeAssetInfo, getAssetInfoVersion, getAssetInfoVersion);

  // The files dropped on this edit that are not in its media yet, after it in the order they came
  const pending = useMemo(() => uploads.filter((upload) => upload.editId === editId), [uploads, editId]);

  // The sequence's own are appended in case a draft lacks one: every asset a clip uses is the edit's
  const ids = useMemo(
    () => (timeline && audioClips ? editMediaOf({ media, timeline, audioClips }) : NO_IDS),
    [media, timeline, audioClips],
  );
  const items = useMemo(
    () => ids.map((id) => mediaItem(id, getAssetInfo(id), snapshot?.[id])),
    // The records are read through the cache's version
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, snapshot, version],
  );

  // Opening the edit asked for its media's records; one added since (without its record) is asked for here
  useEffect(() => requestAssetInfo(ids), [ids]);

  const [posters, setPosters] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => onPosterReady((assetId) => setPosters((prev) => new Set(prev).add(assetId))), []);

  // The covers observe the scroller as their root
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const scrollRootRef = useCallback((el: HTMLDivElement | null) => {
    scrollEl.current = el;
    setScrollRoot(el);
  }, []);

  // A new item (Add media, a drop) is scrolled into view; a pane shown again goes to the one last revealed
  const revealed = useRef(0);
  useEffect(() => {
    if (reveal === revealed.current) return;
    revealed.current = reveal;
    const id = useEditProjectStore.getState().mediaFocus.id;
    const rows = scrollEl.current?.querySelectorAll<HTMLElement>("[data-media-id]") ?? [];
    Array.from(rows)
      .find((row) => row.dataset.mediaId === id)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [reveal]);

  const [menuFor, setMenuFor] = useState<string | null>(null);
  // A commit can settle after its field gave way to another item's (a blur commits): its answer is for its own item only
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<ItemActions["renameError"]>(null);
  const startRename = useCallback((id: string) => {
    setRenaming(id);
    setRenameError(null);
  }, []);
  const endRename = useCallback((id: string) => {
    setRenaming((current) => (current === id ? null : current));
    setRenameError((error) => (error?.id === id ? null : error));
  }, []);
  const commitRename = useCallback(async (view: AssetView, value: string) => {
    const name = value.trim();
    // An empty name puts the old one back; an unchanged one asks nothing
    if (name === "" || name === assetName(view)) return true;
    try {
      const renamed = await patchAsset(view.id, { name });
      primeAssetInfo([renamed]);
      useEditProjectStore.getState().noteAssetRenamed(renamed);
      followInAssets(renamed);
      return true;
    } catch (error) {
      setRenameError({ id: view.id, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }, []);

  // Remove from edit takes the row that had focus (its ⋯ menu, or the sheet that opened): focus goes to the next
  // item once it is gone, else the one before it, else Add media
  const focusAfterRemove = useRef<string[] | null>(null);
  const addMediaRef = useRef<HTMLButtonElement>(null);
  const removeNow = useCallback((id: string) => {
    const draft = useStitchEditorStore.getState().draft;
    const order = draft ? editMediaOf(draft) : NO_IDS;
    const at = order.indexOf(id);
    focusAfterRemove.current = [order[at + 1], order[at - 1]].filter((other) => other !== undefined);
    if (!removeItem(id)) focusAfterRemove.current = null;
  }, []);
  useEffect(() => {
    const beside = focusAfterRemove.current;
    focusAfterRemove.current = null;
    const active = document.activeElement;
    if (!beside || (active && active !== document.body && active.isConnected)) return;
    const rows = Array.from(scrollEl.current?.querySelectorAll<HTMLElement>("[data-media-id]") ?? []);
    const target =
      beside.map((id) => itemFocusTarget(rows.find((row) => row.dataset.mediaId === id))).find(Boolean) ??
      addMediaRef.current ??
      document.querySelector<HTMLElement>(`[${STITCH_EDITOR_PANEL}]`);
    target?.focus({ preventScroll: true });
  }, [ids]);

  const [removing, setRemoving] = useState<{ id: string; name: string; count: number } | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const remove = useCallback(
    (item: MediaItem) => {
      const draft = useStitchEditorStore.getState().draft;
      const count = draft ? mediaUseCount(draft, item.id) : 0;
      if (count > 0) setRemoving({ id: item.id, name: item.name, count });
      else removeNow(item.id);
    },
    [removeNow],
  );

  const { consumeClick, onPointerDown } = drag;
  const add = useCallback(
    (view: AssetView) => {
      if (consumeClick()) return;
      useEditProjectStore.getState().selectMedia(view.id);
      addLibraryItemAt(view);
    },
    [consumeClick],
  );

  const actions: ItemActions = {
    selectedId,
    videoBlocked,
    menuFor,
    setMenuFor,
    renaming,
    renameError,
    startRename,
    endRename,
    commitRename,
    remove,
    add,
    onPointerDown,
    consumeClick,
    scrollRoot,
    posters,
  };

  return (
    <aside
      aria-label="Media"
      data-edit-chrome
      {...fileDrop.handlers}
      className={cn(
        "relative flex w-[264px] shrink-0 flex-col border-r border-edit-line bg-pane",
        fileDrop.over && FILE_DROP_FRAME,
      )}
    >
      <div className="flex h-14 shrink-0 items-center gap-0.5 pl-4 pr-2">
        <h2 className="mr-auto text-[13px] font-medium text-neutral-400">Media</h2>
        <div role="group" aria-label="Layout" className="flex shrink-0 items-center gap-0.5">
          {LAYOUTS.map(({ layout: option, label, Icon }) => (
            <div key={option} className="group relative flex">
              <button
                type="button"
                aria-label={label}
                aria-pressed={option === layout}
                // Focus stays where it was, so the editor's keys keep working after a click
                onMouseDown={keepFocus}
                onClick={() => useEditProjectStore.getState().setPaneLayout(option)}
                className={CONTROL_BUTTON}
              >
                <Icon size={16} strokeWidth={1.5} />
              </button>
              <Tooltip label={label} placement="bottom" />
            </div>
          ))}
        </div>
        <div className="group relative flex shrink-0">
          <button
            ref={addMediaRef}
            type="button"
            aria-label="Add media"
            className={HEADER_ICON_BUTTON}
            onClick={() => openLibraryPicker("all")}
          >
            <Plus size={16} strokeWidth={1.5} />
          </button>
          <Tooltip label="Add media" placement="bottom" />
        </div>
        <div className="group relative flex shrink-0">
          <button
            type="button"
            aria-label="Hide media"
            aria-expanded
            // It says the pane is open, but is not drawn as an open control
            className={cn(HEADER_ICON_BUTTON, "aria-expanded:bg-transparent aria-expanded:text-neutral-400 aria-expanded:hover:bg-white/6 aria-expanded:hover:text-neutral-100")}
            onClick={() => useEditProjectStore.getState().setPaneOpen(false)}
          >
            <PanelLeftClose size={16} strokeWidth={1.5} />
          </button>
          <Tooltip label="Hide media" placement="bottom" />
        </div>
      </div>
      {items.length === 0 && pending.length === 0 ? (
        // Centred in the pane's upper third
        <div className="grid min-h-0 flex-1 grid-rows-[1fr_2fr]">
          <div className="flex flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-xs text-ink-3">No media yet</p>
            <button type="button" className={cn(QUIET_BUTTON, "gap-1.5")} onClick={() => openLibraryPicker("all")}>
              <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
              Add media
            </button>
          </div>
        </div>
      ) : (
        <div ref={scrollRootRef} {...{ [MEDIA_SCROLLER]: "" }} className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-4">
          {layout === "list" ? (
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => (
                <MediaRow key={item.id} item={item} variant="list" actions={actions} />
              ))}
              {pending.map((upload) => (
                <PendingRow key={upload.key} upload={upload} />
              ))}
            </ul>
          ) : (
            <MediaGrid items={items} pending={pending} actions={actions} />
          )}
        </div>
      )}
      {fileDrop.over && <DropToAdd />}
      {removing && (
        <Sheet
          title={
            removing.count === 1
              ? `Remove “${removing.name}” and its clip?`
              : `Remove “${removing.name}” and its ${removing.count} clips?`
          }
          description="The file stays in the asset library."
          onClose={() => setRemoving(null)}
          initialFocusRef={cancelRef}
        >
          <DialogButton compact variant="ghost" className={DIALOG_BUTTON_RING} ref={cancelRef} onClick={() => setRemoving(null)}>
            Cancel
          </DialogButton>
          <DialogButton
            compact
            variant="danger"
            className={DIALOG_BUTTON_RING}
            onClick={() => {
              removeNow(removing.id);
              setRemoving(null);
            }}
          >
            Remove
          </DialogButton>
        </Sheet>
      )}
      <DragGhost />
    </aside>
  );
}

/** Remove from edit, as one undo step; the item stops being the selected one. Returns whether the edit changed. */
function removeItem(id: string): boolean {
  if (!removeMediaItem(id)) return false;
  const project = useEditProjectStore.getState();
  if (project.mediaFocus.id === id) project.selectMedia(null);
  return true;
}

/** Where an item takes focus: its add button, or its ⋯ when it can no longer be placed. Null for none (or no item). */
function itemFocusTarget(item: HTMLElement | null | undefined): HTMLElement | null {
  return (
    item?.querySelector<HTMLElement>("button[data-asset-id]:not(:disabled)") ??
    item?.querySelector<HTMLElement>("button[aria-haspopup]") ??
    null
  );
}

/**
 * The Assets view's loaded list and open detail follow a renamed record, as they follow one changed there (the editor's
 * cache is primed apart). Whether it still answers the view's search is the server's to say, at its next refresh.
 */
function followInAssets(asset: AssetView): void {
  useAssetStore.setState((state) => {
    const listed = state.items.some((item) => item.id === asset.id && item.asset);
    const arrived = state.arrivals.some((a) => a.id === asset.id);
    const selected = state.selectedRecords[asset.id] !== undefined;
    const detail = state.detailAsset?.id === asset.id;
    if (!listed && !arrived && !selected && !detail) return {};
    return {
      ...(listed ? { items: state.items.map((item) => (item.id === asset.id && item.asset ? { ...item, asset } : item)) } : {}),
      ...(arrived ? { arrivals: state.arrivals.map((a) => (a.id === asset.id ? asset : a)) } : {}),
      ...(selected ? { selectedRecords: { ...state.selectedRecords, [asset.id]: asset } } : {}),
      ...(detail ? { detailAsset: asset } : {}),
    };
  });
}

/**
 * A rename's field gone (Enter, Escape) with focus nowhere: back to the item, so the keys still work there. Its add
 * button, or its ⋯ when it can no longer be placed.
 */
function useFocusAfterRename(renaming: boolean, itemRef: RefObject<HTMLLIElement | null>): void {
  const wasRenaming = useRef(renaming);
  useEffect(() => {
    const was = wasRenaming.current;
    wasRenaming.current = renaming;
    if (!was || renaming) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    itemFocusTarget(itemRef.current)?.focus({ preventScroll: true });
  }, [renaming, itemRef]);
}

/**
 * The grid: covers two to a row, a sound a whole row, all in the media's order. Each cover's ⋯ menu opens over the
 * column it is in, so it stays inside the pane.
 */
function MediaGrid({ items, pending, actions }: { items: MediaItem[]; pending: PendingMedia[]; actions: ItemActions }) {
  return (
    <ul className="grid grid-cols-2 gap-2">
      {gridColumns(items).map(({ item, left }) =>
        item.kind === "audio" ? (
          <MediaRow key={item.id} item={item} variant="sound" actions={actions} />
        ) : (
          <MediaCover key={item.id} item={item} left={left} actions={actions} />
        ),
      )}
      {pending.map((upload) => (
        <li
          key={upload.key}
          data-media-pending={upload.key}
          aria-busy="true"
          className={cn("min-w-0", upload.kind === "audio" && "col-span-2")}
        >
          <PendingTile name={upload.name} kind={upload.kind} note={ADDING} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A dropped file not in the media yet, as a list row: a blank cover or a sound's glyph, its file's name, "Adding…"
 * where the length goes. Nothing to press or drag yet. (In the grid it is the library's pending tile.)
 */
function PendingRow({ upload }: { upload: PendingMedia }) {
  return (
    <li data-media-pending={upload.key} aria-busy="true" className="-mx-2 flex h-10 min-w-0 items-center gap-2.5 rounded-md pr-2.5 pl-2">
      {upload.kind === "audio" ? (
        <span aria-hidden="true" className={SOUND_COVER}>
          <AudioLines size={14} strokeWidth={1.5} className="text-ink-3" />
        </span>
      ) : (
        <span aria-hidden="true" className="h-8 w-14 shrink-0 overflow-hidden rounded">
          <BlankCover />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] leading-4 text-neutral-400">{upload.name}</span>
      <span className="shrink-0 text-xs text-ink-3">{ADDING}</span>
    </li>
  );
}

/** Each item with whether it starts a grid row: a sound takes a whole row, so the cover after it starts the next. */
function gridColumns(items: readonly MediaItem[]): { item: MediaItem; left: boolean }[] {
  const placed: { item: MediaItem; left: boolean }[] = [];
  let left = true;
  for (const item of items) {
    if (item.kind === "audio") {
      placed.push({ item, left: true });
      left = true;
    } else {
      placed.push({ item, left });
      left = !left;
    }
  }
  return placed;
}

/**
 * One item as a row: in the list (a 56 × 32 cover, the name, the length) or a sound in the grid (today's one-line
 * row). The row is a button that adds the item at the playhead, and a drag source; ⋯ sits beside it. A click on
 * the name waits a moment, so a double-click there renames without adding.
 */
function MediaRow({ item, variant, actions }: { item: MediaItem; variant: "list" | "sound"; actions: ItemActions }) {
  const { add, onPointerDown, consumeClick, menuFor, setMenuFor } = actions;
  const view = placeable(item);
  const list = variant === "list";
  const renaming = actions.renaming === item.id;
  // The record a rename writes to: the library's, whether or not its file is still there
  const renameTarget = renaming ? item.view : null;
  const selected = actions.selectedId === item.id;
  const blocked = view && item.kind === "video" ? actions.videoBlocked : null;
  const length = item.lost ? NOT_IN_LIBRARY : item.durationSec !== null ? formatTimecode(item.durationSec, 0) : null;

  const itemRef = useRef<HTMLLIElement>(null);
  useFocusAfterRename(renaming, itemRef);
  const nameRef = useRef<HTMLSpanElement>(null);
  const pending = useRef<number | null>(null);
  const clearPending = () => {
    if (pending.current === null) return;
    window.clearTimeout(pending.current);
    pending.current = null;
  };
  useEffect(() => clearPending, []);

  // Whether the press began on the name. The drag's pointer capture sends the click and the double-click that follow
  // to the button, so their own target cannot say
  const pressOnName = useRef(false);
  const onName = (event: ReactMouseEvent) => pressOnName.current || !!nameRef.current?.contains(event.target as Node);

  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!view || consumeClick()) return;
    clearPending();
    // A pointer's click on the name (a key's click has no detail): the first waits for a second, which renames
    if (event.detail > 0 && onName(event)) {
      if (event.detail === 1) {
        pending.current = window.setTimeout(() => {
          pending.current = null;
          add(view);
        }, NAME_CLICK_WAIT_MS);
      }
      return;
    }
    add(view);
  };

  // The name, then what a press does or why it does nothing
  const title = [item.name, item.lost ? NOT_IN_LIBRARY : (blocked ?? (view ? LIBRARY_ADD_HINT : null))]
    .filter(Boolean)
    .join("\n");
  const seconds = item.durationSec !== null ? formatTimecode(item.durationSec, 1) : null;
  const label = view
    ? [`Add ${item.name}`, seconds, "at the playhead"].filter(Boolean).join(", ")
    : item.lost
      ? `${item.name}, not in the library`
      : item.name;

  const nameClass = cn(
    "min-w-0 flex-1 truncate",
    list ? "text-[13px] leading-4" : "text-xs",
    item.lost ? "text-ink-3" : selected ? "text-neutral-100" : "text-neutral-300 group-hover/row:text-neutral-100",
  );
  // The ⋯ takes the length's place while the row is hovered or focused, so the name keeps the width
  const lengthClass = cn(
    "shrink-0 tabular-nums text-ink-3 group-hover/row:invisible group-focus-within/row:invisible",
    list ? "text-xs" : "text-[11px]",
    menuFor === item.id && "invisible",
  );
  const glyph = list ? (
    <ListCover item={item} posterReady={actions.posters.has(item.id)} scrollRoot={actions.scrollRoot} />
  ) : (
    <Music size={14} strokeWidth={1.5} aria-hidden="true" className={cn("shrink-0 text-ink-3", item.lost && "opacity-40")} />
  );

  return (
    <li
      ref={itemRef}
      data-media-id={item.id}
      data-selected={selected || undefined}
      className={cn(
        "group/row relative flex min-w-0 items-center rounded-md transition-colors",
        list ? "-mx-2 h-10" : "col-span-2 h-8 bg-edit-field",
        // A sound's row is on the field ground already: lifted while renamed, so the field shows on it
        (selected || menuFor === item.id || (renaming && !list)) && "bg-edit-pressed",
        !renaming && "hover:bg-edit-pressed",
        // Keyboard focus on the row's button: the editor's white ring, inside the row (the scroller would cut it)
        "has-[[data-media-add]:focus-visible]:ring-2 has-[[data-media-add]:focus-visible]:ring-inset has-[[data-media-add]:focus-visible]:ring-white/40",
      )}
    >
      {renameTarget ? (
        <div className={cn("flex h-full min-w-0 flex-1 items-center pr-1", list ? "gap-2.5 pl-2" : "gap-2 pl-2")}>
          {glyph}
          <EditNameField
            name={item.name}
            editing
            onEditingChange={(editing) => !editing && actions.endRename(item.id)}
            onCommit={(value) => actions.commitRename(renameTarget, value)}
            error={actions.renameError?.id === item.id ? actions.renameError.message : null}
            maxLength={ASSET_NAME_MAX}
            inputLabel={`Rename ${item.name}`}
            className={RENAME_FIELD}
          />
        </div>
      ) : (
        <button
          type="button"
          data-media-add=""
          data-asset-id={item.id}
          aria-label={label}
          aria-disabled={blocked !== null || undefined}
          title={title}
          disabled={!view}
          onClick={onClick}
          onDoubleClick={(event) => {
            if (!onName(event)) return;
            clearPending();
            if (item.view) actions.startRename(item.id);
          }}
          onPointerDown={(event) => {
            pressOnName.current = !!nameRef.current?.contains(event.target as Node);
            if (view) onPointerDown(event, view);
          }}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center text-left focus-visible:outline-none",
            list ? "gap-2.5 pr-2.5 pl-2" : "gap-2 px-2",
            view && "touch-none select-none",
          )}
        >
          {glyph}
          <span ref={nameRef} className={nameClass}>
            {item.name}
          </span>
          {length !== null && <span className={lengthClass}>{length}</span>}
        </button>
      )}
      <div className="absolute inset-y-0 right-1 flex items-center">
        {!renaming && (
          <ItemMenu
            item={item}
            open={menuFor === item.id}
            onOpenChange={(open) => setMenuFor(open ? item.id : null)}
            onRename={() => actions.startRename(item.id)}
            onRemove={() => actions.remove(item)}
            triggerClassName="opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
            menuClassName="right-0"
          />
        )}
      </div>
    </li>
  );
}

/** The rename field in a row: the name's place and type, on the editor's field ground. */
const RENAME_FIELD = cn(
  "-ml-2 flex-1",
  "[&_input]:h-7 [&_input]:w-full [&_input]:border-0 [&_input]:bg-edit-field [&_input]:px-2 [&_input]:text-[13px] [&_input]:font-normal",
  "[&_[role=alert]]:max-w-[220px] [&_[role=alert]]:whitespace-normal",
);

/** A list row's 56 × 32 cover: a video's poster (one is made while it is on screen), a sound's glyph. */
function ListCover({
  item,
  posterReady,
  scrollRoot,
}: {
  item: MediaItem;
  posterReady: boolean;
  scrollRoot: HTMLElement | null;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const onScreen = useOnScreen(ref, scrollRoot);
  const view = item.view;
  const hasPoster = !!view?.hasPoster || posterReady;
  usePosterRequest(view, item.kind === "video" && !item.lost && !hasPoster, onScreen);

  if (item.kind === "audio") {
    return (
      <span ref={ref} aria-hidden="true" className={cn(SOUND_COVER, item.lost && "opacity-40")}>
        <AudioLines size={14} strokeWidth={1.5} className="text-ink-3" />
      </span>
    );
  }
  return (
    <span ref={ref} aria-hidden="true" className={cn("relative h-8 w-14 shrink-0 overflow-hidden rounded bg-edit-field", item.lost && "opacity-40")}>
      {view ? <CoverImage asset={view} hasPoster={hasPoster} gone={item.lost} width={LIST_COVER_WIDTH} /> : <BlankCover />}
    </span>
  );
}

/**
 * A video in the grid: the library tile in its add mode (its length on the cover, its name on keyboard focus), ⋯ at
 * its top right on hover or focus. Renamed, the field lies across the cover's foot.
 */
function MediaCover({ item, left, actions }: { item: MediaItem; left: boolean; actions: ItemActions }) {
  const { menuFor, setMenuFor } = actions;
  const view = placeable(item);
  const renaming = actions.renaming === item.id;
  const renameTarget = renaming ? item.view : null;
  const itemRef = useRef<HTMLLIElement>(null);
  useFocusAfterRename(renaming, itemRef);
  return (
    <li
      ref={itemRef}
      data-media-id={item.id}
      data-selected={actions.selectedId === item.id || undefined}
      className="group/tile relative min-w-0"
    >
      {renameTarget ? (
        <div className="relative aspect-video w-full overflow-hidden rounded-md bg-edit-field">
          {/* The tile's own picture, which stays under the field */}
          <CoverImage
            asset={renameTarget}
            hasPoster={!!renameTarget.hasPoster || actions.posters.has(item.id)}
            gone={item.lost}
          />
          <EditNameField
            name={item.name}
            editing
            onEditingChange={(editing) => !editing && actions.endRename(item.id)}
            onCommit={(value) => actions.commitRename(renameTarget, value)}
            error={actions.renameError?.id === item.id ? actions.renameError.message : null}
            maxLength={ASSET_NAME_MAX}
            inputLabel={`Rename ${item.name}`}
            className={cn(RENAME_FIELD, "absolute inset-x-1 bottom-1 ml-0")}
          />
        </div>
      ) : view ? (
        <LibraryTile
          asset={view}
          selected={actions.selectedId === item.id}
          posterReady={actions.posters.has(item.id)}
          scrollRoot={actions.scrollRoot}
          onToggle={actions.add}
          mode="add"
          disabledReason={actions.videoBlocked}
          onPointerDown={actions.onPointerDown}
        />
      ) : (
        <DimmedCover
          data-asset-id={item.id}
          role="img"
          aria-label={item.lost ? `${item.name}, not in the library` : item.name}
          title={item.lost ? `${item.name}\n${NOT_IN_LIBRARY}` : item.name}
          note={item.lost ? NOT_IN_LIBRARY : undefined}
        />
      )}
      {!renameTarget && (
        <ItemMenu
          item={item}
          open={menuFor === item.id}
          onOpenChange={(open) => setMenuFor(open ? item.id : null)}
          onRename={() => actions.startRename(item.id)}
          onRemove={() => actions.remove(item)}
          onCover
          triggerClassName="absolute right-1 top-1 opacity-0 group-hover/tile:opacity-100 group-focus-within/tile:opacity-100"
          menuClassName={left ? "left-0" : "right-0"}
        />
      )}
    </li>
  );
}

/** An item's ⋯: Rename, Show in Assets and Remove from edit, which asks first ("…") when clips use it. */
function ItemMenu({
  item,
  open,
  onOpenChange,
  onRename,
  onRemove,
  onCover = false,
  triggerClassName,
  menuClassName,
}: {
  item: MediaItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  onRemove: () => void;
  /** On a grid cover: a 24px button on a plate that stays under it, so it reads on any picture. */
  onCover?: boolean;
  triggerClassName: string;
  /** Where the menu sits across its positioned parent. */
  menuClassName: string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [up, setUp] = useState(false);
  const used = useStitchEditorStore((s) => (open && s.draft ? mediaUseCount(s.draft, item.id) : 0));
  const view = item.view;

  const toggle = () => {
    if (open) {
      onOpenChange(false);
      return;
    }
    // Under the item while the pane has room for it there, else over it. It hangs from the item's foot, not the
    // trigger's: a row's, or a whole cover's (well under the ⋯ at its top)
    const trigger = triggerRef.current;
    const scroller = trigger?.closest(`[${MEDIA_SCROLLER}]`);
    const anchor = trigger?.closest("[data-media-id]");
    const below =
      anchor && scroller ? scroller.getBoundingClientRect().bottom - anchor.getBoundingClientRect().bottom : Infinity;
    setUp(below < MENU_PX);
    onOpenChange(true);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`More for ${item.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          ICON_BUTTON,
          onCover && "h-6 w-6 bg-pane/60 hover:bg-pane/80",
          triggerClassName,
          open && (onCover ? "bg-pane/80" : "bg-white/6"),
          open && "text-neutral-100 opacity-100",
        )}
        onClick={toggle}
      >
        <MoreHorizontal size={onCover ? 14 : 16} strokeWidth={1.5} />
      </button>
      {open && (
        <ActionMenu
          label={item.name}
          triggerRef={triggerRef}
          className={cn(menuClassName, up && "bottom-full top-auto mb-1 mt-0")}
          entries={[
            { kind: "item", label: "Rename", disabled: !view, onSelect: onRename },
            // The library lists it already: the Assets view opens on it without taking it in as new
            { kind: "item", label: "Show in Assets", disabled: !view, onSelect: () => view && showInAssets(view, { arrived: false }) },
            { kind: "divider" },
            { kind: "item", label: used > 0 ? "Remove from edit…" : "Remove from edit", onSelect: onRemove },
          ]}
          onClose={(refocus) => {
            onOpenChange(false);
            if (refocus) triggerRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

/**
 * What follows the pointer while an item is dragged: the tile itself, lifted. A video's cover and its length (with
 * why it cannot land there yet, while it cannot), or a sound's row.
 */
function DragGhost() {
  const ghost = useLibraryDragGhost();
  if (!ghost) return null;
  const { asset } = ghost;
  const duration = typeof asset.durationSec === "number" && asset.durationSec > 0 ? asset.durationSec : null;
  const place = { left: ghost.x + 12, top: ghost.y + 12 };
  if (asset.kind === "audio") {
    return (
      <div
        aria-hidden="true"
        data-testid="library-drag-ghost"
        className={cn(
          "pointer-events-none fixed z-100 flex h-8 items-center gap-2 rounded-md bg-edit-field px-2 ring-1 ring-white/10",
          LIFTED_CLIP,
        )}
        style={{ ...place, width: GHOST_ROW_WIDTH }}
      >
        <Music size={14} strokeWidth={1.5} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-200">{assetName(asset)}</span>
        {duration !== null && <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{formatTimecode(duration, 0)}</span>}
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      data-testid="library-drag-ghost"
      className="pointer-events-none fixed z-100 flex flex-col gap-1"
      style={{ ...place, width: GHOST_WIDTH }}
    >
      <div className={cn("relative aspect-video w-full overflow-hidden rounded-md bg-edit-field ring-1 ring-white/10", LIFTED_CLIP)}>
        {asset.hasPoster ? (
          // eslint-disable-next-line @next/next/no-img-element -- a library thumbnail route
          <img src={tileThumbUrl(asset, GHOST_WIDTH)} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <BlankCover />
        )}
        {duration !== null && <CoverLength seconds={duration} />}
      </div>
      {ghost.waiting && <span className={cn(EDITOR_CHIP, "self-start whitespace-nowrap text-neutral-200")}>{WAITING_FOR_CLIPS}</span>}
    </div>
  );
}
