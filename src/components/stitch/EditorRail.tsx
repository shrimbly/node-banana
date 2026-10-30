"use client";

import { useEffect, useMemo, useRef } from "react";
import { Crosshair, RotateCcw, Scissors, Trash } from "lucide-react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { draftSpans } from "@/lib/stitch/draft";
import { clipName } from "@/lib/stitch/labels";
import { clipIdsOf } from "@/lib/stitch/selection";
import { clipLength, isTrimmed } from "@/lib/stitch/timeline";
import type { StitchTimelineClip } from "@/types";
import {
  canRevealSource,
  canSplitSelectedAtPlayhead,
  nudgeStartWell,
  removeSelection,
  resetSelectedTrim,
  revealSelectedSource,
  setClipMuted,
  setClipStart,
  setClipVolume,
  setSelectedClipsMuted,
  splitAtPlayhead,
  splitBlockedReason,
  trimSelected,
} from "./editorActions";
import { AudioClipRail } from "./AudioClipRail";
import {
  RailAction,
  RailActions,
  RailField,
  RailFields,
  RailNote,
  RailRow,
  RailSegments,
  RailSlider,
  RailSwitch,
  RailTitle,
  railDetail,
  START_KEYS,
} from "./railParts";
import { TimecodeField } from "./TimecodeField";
import type { AudioClipView, ClipMediaView } from "./useStitchEditorMedia";
import { EDITOR_PANEL_SELECTOR } from "./editorStyles";

/** "Clip 1 and Clip 3", "Clip 1, Clip 3 and Clip 4", past three "Clip 1, Clip 2 and 3 more". */
function clipNamesLine(indices: readonly number[]): string {
  const names = indices.map(clipName);
  if (names.length > 3) return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  if (names.length < 2) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The 280px rail beside the stage, on the pane with a hairline at its left
 * edge. It keeps its column whatever is selected, so the video never changes
 * size on a click. One clip: "Clip 2 of 4", its source and length; its In and
 * Out side by side (in Stacked Start first: where it starts on the timeline);
 * its own Sound and Volume; then, at the foot, Split at playhead, Reset trim
 * (only while trimmed), Reveal source node (the dialog's) and Remove clip.
 * With audio clips selected it shows them instead (AudioClipRail), and with
 * several video clips what applies to all of them (MultiClipRail). The keys
 * are in the fields' and the actions' hover labels. Frame to canvas is in the
 * control row under the video; Loop is in the header's ⋯ menu.
 */
export function EditorRail({
  media,
  audio,
}: {
  media: ReadonlyMap<string, ClipMediaView>;
  /** Each audio clip's view. */
  audio: ReadonlyMap<string, AudioClipView>;
}) {
  const draft = useStitchEditorStore((s) => s.draft);
  const durations = useStitchEditorStore((s) => s.durations);
  const selection = useStitchEditorStore((s) => s.selection);
  const selectedIndices = useMemo(() => {
    if (selection?.kind !== "clip" || !draft) return [];
    const ids = new Set(clipIdsOf(selection, draft.timeline.map((c) => c.id)));
    return draft.timeline.flatMap((c, i) => (ids.has(c.id) ? [i] : []));
  }, [selection, draft]);
  const multi = selectedIndices.length > 1;
  const canSplit = useStitchEditorStore(canSplitSelectedAtPlayhead);
  const splitBlocked = useStitchEditorStore(splitBlockedReason);
  const stacked = useStitchEditorStore((s) => s.draft?.sequenceLayout.mode === "stacked");
  const endGesture = useStitchEditorStore((s) => s.endGesture);
  // An edit project's clips come from the library: there is no source node to reveal
  const inEdit = useStitchEditorStore((s) => s.editId !== null);
  const railRef = useRef<HTMLElement>(null);

  const clipId = selection?.kind === "clip" ? selection.clipId : null;
  const index = draft && clipId ? draft.timeline.findIndex((c) => c.id === clipId) : -1;
  const clip = index >= 0 ? draft!.timeline[index] : null;
  const view = clip ? media.get(clip.id) : undefined;
  const duration = view?.duration ?? null;
  const hasClip = clip !== null;
  // A timeline time, beside the source times In and Out: where the trimmed clip starts (an empty clip's slot too)
  const start = useMemo(() => {
    if (!stacked || !draft || !clipId) return null;
    return draftSpans(draft, durations).find((span) => span.clip.id === clipId)?.start ?? null;
  }, [stacked, draft, durations, clipId]);
  const selectedAudio = useMemo(() => {
    if (selection?.kind !== "audio" || !draft) return [];
    const ids = new Set(clipIdsOf(selection, draft.audioClips.map((c) => c.id)));
    // The lead first: the single-clip rail is the lead's
    return draft.audioClips.filter((c) => ids.has(c.id));
  }, [selection, draft]);
  const audioSelected = selectedAudio.length > 0;

  // A swap of the rail's body (the last clip removed, the track for a clip or back, Start or Crossfade coming or going
  // with the layout) unmounts a focused control: focus the dialog, not <body>, so Tab stays inside
  useEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      railRef.current?.closest<HTMLElement>(EDITOR_PANEL_SELECTOR)?.focus({ preventScroll: true });
    }
  }, [hasClip, audioSelected, stacked, multi]);

  return (
    <aside
      ref={railRef}
      aria-label={audioSelected ? "Audio clip" : "Clip"}
      className="w-[280px] shrink-0 overflow-y-auto border-l border-edit-line"
    >
      <div className="flex min-h-full flex-col p-5">
        {audioSelected ? (
          <AudioClipRail clips={selectedAudio} views={audio} />
        ) : multi && draft ? (
          <MultiClipRail
            timeline={draft.timeline}
            indices={selectedIndices}
            canSplit={canSplit}
            splitBlocked={splitBlocked}
          />
        ) : !clip ? (
          // An empty editor has nothing to select; the stage says why
          draft &&
          draft.timeline.length > 0 && <p className="text-[13px] leading-5 text-ink-3">Select a clip to edit it.</p>
        ) : (
          <>
            <RailTitle
              title={`${clipName(index)} of ${draft!.timeline.length}`}
              lines={[
                railDetail(
                  view?.railSource,
                  duration,
                  duration === null ? null : clipLength(clip, duration),
                  inEdit,
                ),
              ]}
            />

            <RailFields>
              {start !== null && (
                // Leaving the well ends a run of ↑/↓ steps: the next one is a new undo step
                <RailField label="Start" hint="Start or end at the playhead" shortcut={START_KEYS} onBlur={endGesture}>
                  <TimecodeField
                    label="Start on the timeline"
                    value={start}
                    onCommit={(sec) => setClipStart(clip.id, sec)}
                    onNudge={nudgeStartWell}
                  />
                </RailField>
              )}
              <RailField label="In" hint="In at the playhead" shortcut="I">
                <TimecodeField
                  label="In"
                  value={clip.inSec}
                  disabled={duration === null}
                  onCommit={(inSec) => trimSelected({ inSec })}
                />
              </RailField>
              <RailField label="Out" hint="Out at the playhead" shortcut="O" last>
                <TimecodeField
                  label="Out"
                  value={duration !== null ? Math.min(clip.outSec ?? duration, duration) : (clip.outSec ?? 0)}
                  disabled={duration === null}
                  onCommit={(outSec) => trimSelected({ outSec })}
                />
              </RailField>
            </RailFields>
            {duration !== null && clip.inSec >= duration && <RailNote>The trim starts past the end of this video.</RailNote>}
            {duration !== null && duration > 0 && clip.inSec < duration && clipLength(clip, duration) === 0 && (
              <RailNote>The trim is shorter than a frame, so this clip is left out.</RailNote>
            )}

            <div className="mt-7">
              <RailRow label="Sound">
                <RailSwitch label="Sound" checked={!clip.muted} onChange={(on) => setClipMuted(clip.id, !on)} />
              </RailRow>
              <div onPointerUp={endGesture} onKeyUp={endGesture} onBlur={endGesture}>
                <RailSlider
                  label="Volume"
                  ariaLabel="Clip volume"
                  value={Math.round(clip.volume * 100)}
                  disabled={clip.muted}
                  onChange={(pct) => setClipVolume(clip.id, pct / 100)}
                />
              </div>
            </div>

            <RailActions>
              <RailAction
                icon={<Scissors size={16} strokeWidth={1.5} />}
                label="Split at playhead"
                shortcut="S"
                disabled={!canSplit}
                title={canSplit ? undefined : (splitBlocked ?? undefined)}
                onClick={splitAtPlayhead}
              />
              {isTrimmed(clip) && (
                <RailAction
                  icon={<RotateCcw size={16} strokeWidth={1.5} />}
                  label="Reset trim"
                  vanishes
                  onClick={resetSelectedTrim}
                />
              )}
              {!inEdit && (
                <RailAction
                  icon={<Crosshair size={16} strokeWidth={1.5} />}
                  label="Reveal source node"
                  disabled={!canRevealSource(clip, view)}
                  onClick={revealSelectedSource}
                />
              )}
              <RailAction
                icon={<Trash size={16} strokeWidth={1.5} />}
                label="Remove clip"
                shortcut="⌫"
                keyshortcuts="Backspace"
                onClick={removeSelection}
              />
            </RailActions>
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * The rail with several clips selected: how many and which, their sound as one control (neither On nor Off pressed
 * while some are muted and some not), and the actions that apply to all of them. Trims, Start and Volume are one
 * clip's, so they are not here.
 */
function MultiClipRail({
  timeline,
  indices,
  canSplit,
  splitBlocked,
}: {
  timeline: readonly StitchTimelineClip[];
  /** The selected clips' timeline indices, in order. */
  indices: readonly number[];
  canSplit: boolean;
  splitBlocked: string | null;
}) {
  const clips = indices.map((i) => timeline[i]);
  const allOff = clips.every((c) => c.muted);
  const allOn = clips.every((c) => !c.muted);
  const sound = allOn ? "on" : allOff ? "off" : "mixed";
  return (
    <>
      <RailTitle title={`${clips.length} clips`} lines={[clipNamesLine(indices)]} />

      <div className="mt-7">
        <RailRow label="Sound">
          <div className="flex items-center gap-2">
            {sound === "mixed" && <span className="text-xs text-ink-3">Mixed</span>}
            <RailSegments
              label="Sound"
              className="w-[104px]"
              segments={[
                { label: "On", pressed: sound === "on", onClick: () => setSelectedClipsMuted(false) },
                { label: "Off", pressed: sound === "off", onClick: () => setSelectedClipsMuted(true) },
              ]}
            />
          </div>
        </RailRow>
      </div>

      <RailActions>
        <RailAction
          icon={<Scissors size={16} strokeWidth={1.5} />}
          label="Split at playhead"
          shortcut="S"
          disabled={!canSplit}
          title={canSplit ? undefined : (splitBlocked ?? undefined)}
          onClick={splitAtPlayhead}
        />
        {clips.some(isTrimmed) && (
          <RailAction
            icon={<RotateCcw size={16} strokeWidth={1.5} />}
            label="Reset trim"
            vanishes
            onClick={resetSelectedTrim}
          />
        )}
        <RailAction
          icon={<Trash size={16} strokeWidth={1.5} />}
          label={`Remove ${clips.length} clips`}
          shortcut="⌫"
          keyshortcuts="Backspace"
          onClick={removeSelection}
        />
      </RailActions>
    </>
  );
}
