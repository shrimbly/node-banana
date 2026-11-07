"use client";

import {
  memo,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { Check, Film, Music } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { tileThumbUrl } from "@/components/assets/AssetTile";
import { projectLabel } from "@/components/assets/assetFormat";
import { requestPoster } from "@/components/assets/posterRequests";
import { assetName } from "@/lib/assets/name";
import type { AssetView } from "@/lib/assets/types";
import { formatTimecode } from "@/lib/stitch/timecode";

/** About a quarter of the 880px dialog, for the thumbnail size asked for. */
const TILE_WIDTH = 200;

/** What a click or a drag does with an item in the Edit video view's media pane: its tooltip's second line. */
export const LIBRARY_ADD_HINT = "Click to add at the playhead, or drag onto the timeline.";

/** Whether the element is inside the scroll area's view (always, where IntersectionObserver is missing). */
export function useOnScreen(ref: RefObject<HTMLElement | null>, root: HTMLElement | null): boolean {
  const [onScreen, setOnScreen] = useState(typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry?.isIntersecting ?? false), { root });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, root]);
  return onScreen;
}

/** A cover with no poster to show: the empty frame's grey, with a faint film glyph (never a tinted placeholder). */
export function BlankCover() {
  return (
    <span aria-hidden="true" className="flex h-full w-full items-center justify-center bg-edit-field">
      <Film size={16} strokeWidth={1.5} className="text-neutral-600" />
    </span>
  );
}

/** A video's thumbnail filling its cover, or the blank frame when there is none to show (a 204, a file that is gone). */
export function CoverImage({
  asset,
  hasPoster,
  gone = false,
  width = TILE_WIDTH,
}: {
  asset: Pick<AssetView, "sha256">;
  hasPoster: boolean;
  gone?: boolean;
  /** The cover's width, for the thumbnail size asked for. */
  width?: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = tileThumbUrl({ sha256: asset.sha256, hasPoster }, width);
  if (gone || failed === url) return <BlankCover />;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a library thumbnail route, which can answer 204
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(url)}
      className="pointer-events-none h-full w-full object-cover"
    />
  );
}

/**
 * A video without a poster gets one made while it is on screen, through the Assets view's own capture queue; one
 * scrolled past before its turn is withdrawn.
 */
export function usePosterRequest(asset: AssetView | null | undefined, needsPoster: boolean, onScreen: boolean): void {
  useEffect(() => {
    if (!needsPoster || !onScreen || !asset) return;
    return requestPoster(asset);
    // Once per asset, whatever else about the record changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsPoster, onScreen, asset?.id]);
}

/** A chip on a cover: its length at rest, its name on keyboard focus. */
export const COVER_CHIP = "rounded bg-pane/60 px-1 py-0.5 text-[10px] font-medium leading-none text-neutral-100";

/** A cover's length, in whole seconds, at its bottom right: the one thing drawn on it at rest. */
export function CoverLength({ seconds }: { seconds: number }) {
  return (
    <span className={cn(COVER_CHIP, "absolute bottom-1 right-1 tabular-nums")}>
      {formatTimecode(seconds, 0)}
    </span>
  );
}

/**
 * A cover with nothing to show yet or any more: the blank frame dimmed, a `name` at its top and a `note` at its foot
 * when given. A file on its way into the library, or (in the media pane's grid) one the library lost. The rest of the
 * props (a role, a name, a title) go on the cover.
 */
export function DimmedCover({
  name,
  note,
  ...props
}: { name?: string; note?: string } & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div {...props} className="relative aspect-video w-full overflow-hidden rounded-md bg-edit-field">
      <span aria-hidden="true" className="block h-full w-full opacity-40">
        <BlankCover />
      </span>
      {name !== undefined && (
        <span className="absolute inset-x-1 top-1 flex">
          <span className={cn(COVER_CHIP, "max-w-full truncate")}>{name}</span>
        </span>
      )}
      {note !== undefined && (
        <span className={cn(COVER_CHIP, "absolute bottom-1 right-1 font-normal text-neutral-300")}>{note}</span>
      )}
    </div>
  );
}

/**
 * A file on its way into the library (one uploaded in the picker, one dropped on the media pane's grid), until its
 * record exists: a blank cover with its name and `note` on it, or a sound's row with them. Nothing to press yet.
 */
export function PendingTile({ name, kind, note }: { name: string; kind: "video" | "audio"; note: string }) {
  if (kind === "audio") {
    return (
      <div className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md bg-edit-field px-2">
        <Music size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-400">{name}</span>
        <span className="shrink-0 text-[11px] text-ink-3">{note}</span>
      </div>
    );
  }
  return <DimmedCover name={name} note={note} />;
}

/**
 * One library file, as the picker shows it under its project's name (and the
 * Edit video view's media pane its covers, in the grid). A video is a 16:9
 * cover with nothing on it but its length; an audio file is a one-line row (a
 * music glyph, its name, its length). Its name, project and whether it is a
 * favourite are in its accessible name, and the name is its tooltip's first
 * line. A video without a poster on screen gets one made, through the Assets
 * view's own capture queue; a file that is gone cannot be picked or added.
 *
 * In the picker (`mode="pick"`) a tile is a toggle button, ringed in white
 * once picked (a sound's row also checks it). In the media pane
 * (`mode="add"`) a click (or Enter) adds it at the playhead and a press can
 * start a drag onto the timeline, which the tooltip says. A tile that cannot
 * be added yet says why in its tooltip. A cover carries nothing but its
 * length; on keyboard focus, which no title tooltip follows, it also shows
 * its name (and why it cannot be added yet) at its top.
 */
export const LibraryTile = memo(function LibraryTile({
  asset,
  selected,
  posterReady,
  scrollRoot,
  onToggle,
  mode = "pick",
  disabledReason = null,
  onPointerDown,
}: {
  asset: AssetView;
  selected: boolean;
  /** A poster was made for it since the page was read. */
  posterReady: boolean;
  scrollRoot: HTMLElement | null;
  /** The click: pick or unpick, or (add mode) add. */
  onToggle: (asset: AssetView) => void;
  mode?: "pick" | "add";
  /** Add mode: why it cannot be added now ("Waiting for the clips to load"); it is then aria-disabled. */
  disabledReason?: string | null;
  /** Add mode: the press that may start a drag. */
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>, asset: AssetView) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const onScreen = useOnScreen(ref, scrollRoot);
  const hasPoster = !!asset.hasPoster || posterReady;
  const missing = !!asset.missing;
  const audio = asset.kind === "audio";
  const adding = mode === "add";
  const blocked = adding && !missing && disabledReason !== null;
  usePosterRequest(asset, !audio && !hasPoster && !missing, onScreen);

  const duration = typeof asset.durationSec === "number" && asset.durationSec > 0 ? asset.durationSec : null;
  const project = projectLabel(asset.workflow?.projectPath ?? null);
  const name = assetName(asset);
  // Everything the tile knows, for a screen reader (the pressed state is aria-pressed)
  const label = [
    adding ? `Add ${name}` : name,
    duration !== null ? formatTimecode(duration, 1) : null,
    project,
    asset.favorite ? "favorite" : null,
    missing ? "file missing" : null,
  ]
    .filter(Boolean)
    .join(", ");
  // The name the tile no longer shows, then what a press does or why it does nothing
  const title = [
    name,
    missing ? "The file is missing" : blocked ? disabledReason : adding ? LIBRARY_ADD_HINT : null,
  ]
    .filter(Boolean)
    .join("\n");
  const length = duration !== null ? formatTimecode(duration, 0) : null;

  const shared = {
    ref,
    type: "button" as const,
    "aria-pressed": adding ? undefined : selected,
    "aria-label": adding && !missing ? `${label}, at the playhead` : label,
    "aria-disabled": blocked || undefined,
    "data-asset-id": asset.id,
    disabled: missing,
    title,
    onClick: () => onToggle(asset),
    onPointerDown: adding && !missing ? (event: ReactPointerEvent<HTMLButtonElement>) => onPointerDown?.(event, asset) : undefined,
  };
  // The pick is the white ring; keyboard focus a fainter one, set off from a pick by its offset. The offset is the
  // surface the tile sits on: the pane, in the view and in the picker
  const rings = cn(
    "focus-visible:outline-none",
    selected
      ? "ring-2 ring-neutral-100 focus-visible:ring-offset-2"
      : "focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-1",
    "focus-visible:ring-offset-pane",
    missing && "opacity-40",
    adding && !missing && "touch-none select-none",
  );

  if (audio) {
    return (
      <button
        {...shared}
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2 rounded-md bg-edit-field px-2 text-left transition-colors enabled:hover:bg-edit-pressed",
          rings,
        )}
      >
        <Music size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-ink-3" />
        <span className={cn("min-w-0 flex-1 truncate text-xs", selected ? "text-neutral-100" : "text-neutral-300")}>
          {name}
        </span>
        {selected && (
          <span aria-label="Selected" className="flex shrink-0 text-neutral-100">
            <Check size={14} strokeWidth={1.5} aria-hidden="true" />
          </span>
        )}
        {length !== null && <span className="shrink-0 text-[11px] tabular-nums text-ink-3">{length}</span>}
      </button>
    );
  }

  return (
    <button
      {...shared}
      className={cn("group relative block aspect-video w-full min-w-0 overflow-hidden rounded-md bg-edit-field", rings)}
    >
      <CoverImage asset={asset} hasPoster={hasPoster} gone={missing} />
      {duration !== null && <CoverLength seconds={duration} />}
      {/* What the title says on hover, for the keys: inside the cover, so a scrolling list never clips it */}
      <span
        aria-hidden="true"
        data-testid="library-tile-focus-name"
        className="pointer-events-none absolute inset-x-1 top-1 flex flex-col items-start gap-0.5 opacity-0 transition-opacity group-focus-visible:opacity-100"
      >
        <span className={cn(COVER_CHIP, "max-w-full truncate")}>{name}</span>
        {blocked && <span className={cn(COVER_CHIP, "max-w-full truncate font-normal text-neutral-300")}>{disabledReason}</span>}
      </span>
    </button>
  );
});
