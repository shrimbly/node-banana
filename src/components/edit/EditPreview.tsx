"use client";

import { useState } from "react";
import { Film } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { tileThumbUrl } from "@/components/assets/AssetTile";
import type { EditSummary } from "@/lib/edits/types";
import { editCardMeta } from "./editMeta";

/** The preview's frame: 16:9, rounded. */
const FRAME = "aspect-video overflow-hidden rounded-[10px]";

/** A frame with nothing to show (no edits, or an edit without a poster): the editor's well inside a hairline, never a tinted placeholder. */
const BLANK_FRAME = "flex items-center justify-center border border-edit-line bg-editor-well";

/**
 * The preview's width: up to 680 px, no wider than its column and, with the
 * caption's 32 px under it, no taller (the column is a size container), so a
 * short window keeps the caption in view. A window too short even for 160 px
 * scrolls the column.
 */
const FIT_WITH_CAPTION = "w-[min(680px,100cqw,max(160px,calc((100cqh_-_32px)*16/9)))]";
const FIT = "w-[min(680px,100cqw,max(160px,calc(100cqh*16/9)))]";

/** The thumbnail width the preview asks for (the 640 px bucket). */
export const PREVIEW_THUMB_PX = 640;

/** The blank frame's one mark: a faint film glyph. */
function FilmGlyph() {
  return <Film size={24} strokeWidth={1.5} className="text-neutral-600" />;
}

/**
 * The home's preview of the active edit: its poster (the first clip's) and,
 * under it, what it holds. An edit with no poster, or one that fails to load,
 * shows the empty frame. The row already says all of it to a screen reader,
 * so the preview is hidden from one.
 */
export function EditPreview({ edit }: { edit: EditSummary }) {
  // The poster that failed to load, so another edit's poster gets its own try
  const [failed, setFailed] = useState<string | null>(null);
  const poster = edit.poster && failed !== edit.poster.sha256 ? edit.poster : null;

  return (
    <figure aria-hidden="true" data-edit-preview={edit.id} className={cn("m-0 shrink-0", FIT_WITH_CAPTION)}>
      <div className={cn(FRAME, "w-full", poster ? "bg-edit-field" : BLANK_FRAME)}>
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element -- a library thumbnail route, which can answer 204
          <img
            key={poster.sha256}
            src={tileThumbUrl(poster, PREVIEW_THUMB_PX)}
            alt=""
            draggable={false}
            onError={() => setFailed(poster.sha256)}
            className="h-full w-full object-cover"
          />
        ) : (
          <FilmGlyph />
        )}
      </div>
      <figcaption className="mt-3.5 truncate text-[13px] leading-[18px] text-ink-3 tabular-nums">{editCardMeta(edit).text}</figcaption>
    </figure>
  );
}

/** Where the preview goes while there is no edit: the empty frame. */
export function EmptyPreview() {
  return (
    <div aria-hidden="true" data-edit-preview="" className={cn(FRAME, FIT, BLANK_FRAME, "shrink-0")}>
      <FilmGlyph />
    </div>
  );
}
