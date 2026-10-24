"use client";

import { RotateCcw, Scissors, Trash, Volume1, VolumeX } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import { audioClipLength } from "@/lib/stitch/audioClips";
import type { StitchAudioClip } from "@/types";
import {
  applyAudioFadeIn,
  applyAudioFadeOut,
  canFadeOutAudio,
  canSplitAudioAtPlayhead,
  flattenAudioCurve,
  nudgeAudioStartWell,
  removeAudioClipsById,
  resetSelectedAudioTrim,
  selectedAudioCurveShape,
  setAudioClipStart,
  setSelectedAudioMuted,
  splitSelectedAudioAtPlayhead,
  trimSelectedAudio,
} from "./editorActions";
import {
  RailAction,
  RailActions,
  RailField,
  RailFields,
  RailRow,
  RailSegments,
  RailSwitch,
  RailTitle,
  railDetail,
  START_KEYS,
} from "./railParts";
import { TimecodeField } from "./TimecodeField";
import { audioRowName } from "./timeline/AudioLane";
import type { AudioClipView } from "./useStitchEditorMedia";

/** The rail's ⌫ for audio clips: they go, and none of them stays tagged "cut". */
function removeClips(ids: readonly string[]): void {
  useStitchEditorStore.getState().untagCut(removeAudioClipsById(ids));
}

/**
 * The rail while audio clips are selected. One clip: its row ("Audio 1"),
 * its file and where it comes from, with its length; where it starts on the
 * timeline and its trim as Start, In and Out side by side (In and Out off
 * until the file's length is read); its Sound; the volume curve's shapes (a
 * fade in, a fade out over the part that is heard, back to flat), pressed by
 * what the curve now does; then the clip actions at the foot. Several: how
 * many, and what applies to all of them.
 */
export function AudioClipRail({
  clips,
  views,
}: {
  /** The selected audio clips, in audio order (the lead first when it is one). */
  clips: readonly StitchAudioClip[];
  views: ReadonlyMap<string, AudioClipView>;
}) {
  const canSplit = useStitchEditorStore(canSplitAudioAtPlayhead);
  const canFadeOut = useStitchEditorStore(canFadeOutAudio);
  // Pressed by what the curve does over the part that is heard: a fade a trim or split cut away is not one
  const shape = useStitchEditorStore(useShallow(selectedAudioCurveShape));
  const endGesture = useStitchEditorStore((s) => s.endGesture);
  const inEdit = useStitchEditorStore((s) => s.editId !== null);

  if (clips.length > 1) {
    const allMuted = clips.every((c) => c.muted);
    return (
      <>
        <RailTitle
          title={`${clips.length} audio clips`}
          lines={[clips.map((c) => views.get(c.id)?.fileName ?? "Audio").join(", ")]}
        />
        <RailActions>
          <RailAction
            icon={allMuted ? <Volume1 size={16} strokeWidth={1.5} /> : <VolumeX size={16} strokeWidth={1.5} />}
            // Named for the selection, as Remove is: the control row's Mute all is the preview's sound
            label={`${allMuted ? "Unmute" : "Mute"} ${clips.length} clips`}
            shortcut="M"
            onClick={() => setSelectedAudioMuted(!allMuted)}
          />
          <RailAction
            icon={<Scissors size={16} strokeWidth={1.5} />}
            label="Split at playhead"
            shortcut="S"
            disabled={!canSplit}
            onClick={splitSelectedAudioAtPlayhead}
          />
          <RailAction
            icon={<Trash size={16} strokeWidth={1.5} />}
            label={`Remove ${clips.length} clips`}
            shortcut="⌫"
            keyshortcuts="Backspace"
            onClick={() => removeClips(clips.map((c) => c.id))}
          />
        </RailActions>
      </>
    );
  }

  const clip = clips[0];
  if (!clip) return null;
  const view = views.get(clip.id);
  const duration = view?.duration ?? null;
  // The subtitle's length: the decoded file's, else the library record's (what the timeline draws until the decode)
  const full = duration ?? view?.recordDuration ?? null;
  const trimmed = clip.inSec > 0 || clip.outSec !== null;
  const waitsForLength = clip.outSec === null && duration === null;

  return (
    <>
      <RailTitle
        title={audioRowName(clip.row)}
        lines={[
          view?.fileName ?? "Audio",
          railDetail(view?.railSource, full, full === null ? null : audioClipLength(clip, full), inEdit),
        ]}
      />

      <RailFields>
        {/* Leaving the well ends a run of ↑/↓ steps: the next one is a new undo step */}
        <RailField label="Start" hint="Start or end at the playhead" shortcut={START_KEYS} onBlur={endGesture}>
          <TimecodeField
            label="Start on the timeline"
            value={clip.startSec}
            onCommit={(sec) => setAudioClipStart(clip.id, sec)}
            onNudge={nudgeAudioStartWell}
          />
        </RailField>
        <RailField label="In" hint="In at the playhead" shortcut="I">
          <TimecodeField
            label="In"
            value={clip.inSec}
            disabled={duration === null}
            onCommit={(inSec) => trimSelectedAudio({ inSec })}
          />
        </RailField>
        <RailField label="Out" hint="Out at the playhead" shortcut="O" last>
          <TimecodeField
            label="Out"
            value={duration !== null ? Math.min(clip.outSec ?? duration, duration) : (clip.outSec ?? 0)}
            disabled={duration === null}
            onCommit={(outSec) => trimSelectedAudio({ outSec })}
          />
        </RailField>
      </RailFields>

      <div className="mt-7">
        <RailRow label="Sound">
          <RailSwitch label="Sound" checked={!clip.muted} onChange={(on) => setSelectedAudioMuted(!on)} />
        </RailRow>
      </div>

      <div className="mt-3">
        <div className="mb-2 text-xs leading-3 text-ink-3">Volume</div>
        <RailSegments
          label="Volume curve"
          segments={[
            {
              label: "Flat",
              pressed: shape.flat,
              disabled: clip.muted,
              // Already flat: nothing to undo
              onClick: () => {
                if (!shape.flat) flattenAudioCurve();
              },
            },
            { label: "Fade in", pressed: shape.fadeIn, disabled: clip.muted, onClick: applyAudioFadeIn },
            {
              label: "Fade out",
              pressed: shape.fadeOut,
              disabled: clip.muted || !canFadeOut,
              title: !clip.muted && waitsForLength ? "Reading the audio's length…" : undefined,
              onClick: applyAudioFadeOut,
            },
          ]}
        />
      </div>

      <RailActions>
        <RailAction
          icon={<Scissors size={16} strokeWidth={1.5} />}
          label="Split at playhead"
          shortcut="S"
          disabled={!canSplit}
          onClick={splitSelectedAudioAtPlayhead}
        />
        {trimmed && (
          <RailAction
            icon={<RotateCcw size={16} strokeWidth={1.5} />}
            label="Reset trim"
            disabled={duration === null}
            vanishes
            onClick={resetSelectedAudioTrim}
          />
        )}
        <RailAction
          icon={<Trash size={16} strokeWidth={1.5} />}
          label="Remove clip"
          shortcut="⌫"
          keyshortcuts="Backspace"
          onClick={() => removeClips([clip.id])}
        />
      </RailActions>
    </>
  );
}
