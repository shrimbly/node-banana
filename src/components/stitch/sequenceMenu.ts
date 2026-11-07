import { isLegacyAudioShape } from "@/lib/stitch/audioClips";
import { useStitchEditorStore } from "@/store/stitchEditorStore";
import type { ActionMenuEntry, ActionMenuRadio } from "./ActionMenu";
import { setLoopCount } from "./editorActions";

/** The loop counts a sequence plays: the rail's 1×, 2×, 3× before it moved here, and the node's. */
const LOOP_COUNTS = [1, 2, 3] as const;

/** Under Loop while each loop restarts the audio clips (once the audio is more than the music alone, whole, from 0:00). */
export const LOOP_AUDIO_NOTE = "Each loop plays the audio clips again from their start.";

/** What a loop count is called in the menus: "Off" at 1× (nothing repeats), else the count ("2×"). */
export function loopValue(loopCount: number): string {
  return loopCount === 1 ? "Off" : `${loopCount}×`;
}

/**
 * The headers' Loop, in their ⋯ menu, the same in the view's and the
 * dialog's: one row that reads what it is set to ("Loop  Off", as the boards
 * draw it), opening Off, 2× and 3× as radios beside the menu; picking one
 * sets the loop count as one undo step. Off with no clips, as the rail's
 * footer was inert then; while a loop repeats the audio clips it says so
 * under the radios.
 */
export function useLoopMenuEntry(): ActionMenuEntry {
  const loopCount = useStitchEditorStore((s) => s.draft?.loopCount ?? 1);
  const empty = useStitchEditorStore((s) => !s.draft || s.draft.timeline.length === 0);
  // The loop rule is the new one once the audio is anything but the music alone, whole, from 0:00
  const repeatsAudio = useStitchEditorStore(
    (s) => s.draft !== null && s.draft.loopCount > 1 && !isLegacyAudioShape(s.draft.audioClips),
  );
  const radios = LOOP_COUNTS.map(
    (n): ActionMenuRadio => ({
      kind: "radio",
      label: loopValue(n),
      checked: n === loopCount,
      disabled: empty,
      onSelect: () => setLoopCount(n),
    }),
  );
  const footer = repeatsAudio ? LOOP_AUDIO_NOTE : undefined;
  return { kind: "submenu", label: "Loop", value: loopValue(loopCount), disabled: empty, entries: radios, footer };
}

/**
 * The ⋯ menu's last line, what the sequence is: "4 clips · 1280 × 720 · 24 fps"
 * (the size once a clip is ready with one, the rate only when the clips
 * agree). The headers showed it before; the transport shows the length.
 */
export function sequenceMetaLine(clipCount: number, size: string | null, fps: string | null): string {
  const clips = `${clipCount} clip${clipCount === 1 ? "" : "s"}`;
  if (clipCount === 0) return clips;
  return [clips, size, fps].filter((v): v is string => v !== null).join(" · ");
}
