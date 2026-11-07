import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { createAudioClip } from "@/lib/stitch/audioClips";
import type { StitchDraft } from "@/lib/stitch/draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip } from "@/lib/stitch/timeline";
import type { HitBox } from "@/lib/stitch/selection";
import { useMarqueeSelect, type MarqueeOptions } from "../timeline/useMarqueeSelect";

// The selection box's gesture with the audio rows' options: their kind, commit and clear.

const store = () => useStitchEditorStore.getState();
const BOXES: HitBox[] = [
  { x: 0, width: 50, top: 0, height: 40 },
  { x: 100, width: 50, top: 0, height: 40 },
];

function Lane(props: Partial<MarqueeOptions>) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { marquee, onLanePointerDown } = useMarqueeSelect(contentRef, {
    stacked: true,
    hitBoxes: () => BOXES,
    order: () => ["x", "y"],
    rowsView: () => null,
    bounds: () => ({ top: 0, bottom: 100 }),
    ...props,
  });
  return (
    <div ref={contentRef}>
      <div data-testid="lane" onPointerDown={onLanePointerDown} />
      {marquee && <span data-testid="drawn">{[...marquee.selectedIds].join(",")}</span>}
    </div>
  );
}

const press = (x: number, y: number) => fireEvent.pointerDown(screen.getByTestId("lane"), { button: 0, clientX: x, clientY: y, pointerId: 1 });
const move = (x: number, y: number) => fireEvent.pointerMove(window, { clientX: x, clientY: y, pointerId: 1 });
const up = () => fireEvent.pointerUp(window, { pointerId: 1 });

beforeEach(() => {
  const draft: StitchDraft = {
    timeline: [createClip({ kind: "edge", edgeId: "e1" }, { id: "a" })],
    audioClips: ["x", "y"].map((id, i) => createAudioClip({ kind: "asset", assetId: "atone00000001" }, { id, row: i })),
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
  };
  store().open({ nodeId: "n1", draft, canvasGeneration: 1 });
});
afterEach(() => store().close());

describe("useMarqueeSelect's options", () => {
  it("hands the release's hits to commit, and adds to a selection of its own kind only", () => {
    const commit = vi.fn();
    render(<Lane kind="audio" commit={commit} />);
    store().select(audioSelectionOf({ clipId: "y" }));
    press(10, 10);
    move(60, 30);
    // ⇧ was not held: what is drawn is the hits alone
    expect(screen.getByTestId("drawn").textContent).toBe("x");
    up();
    expect(commit).toHaveBeenCalledWith(["x"], false);

    commit.mockClear();
    fireEvent.pointerDown(screen.getByTestId("lane"), { button: 0, clientX: 10, clientY: 10, pointerId: 1, shiftKey: true });
    move(60, 30);
    expect(screen.getByTestId("drawn").textContent).toBe("y,x");
    up();
    expect(commit).toHaveBeenCalledWith(["x"], true);
    // The default would have written a clip selection; commit wrote nothing here
    expect(store().selection).toMatchObject({ kind: "audio", clipId: "y" });
  });

  it("does not add a selection of the other kind to an additive box", () => {
    render(<Lane kind="audio" commit={vi.fn()} />);
    store().select({ kind: "clip", clipId: "a" });
    fireEvent.pointerDown(screen.getByTestId("lane"), { button: 0, clientX: 10, clientY: 10, pointerId: 1, shiftKey: true });
    move(160, 30);
    expect(screen.getByTestId("drawn").textContent).toBe("x,y");
    up();
  });

  it("calls clear for a press that does not travel, and the default clears a selection of either kind", () => {
    const clear = vi.fn();
    const { unmount } = render(<Lane kind="audio" clear={clear} />);
    press(10, 10);
    up();
    expect(clear).toHaveBeenCalledTimes(1);
    unmount();

    render(<Lane />);
    store().select(audioSelectionOf({ clipId: "x" }));
    press(10, 10);
    up();
    expect(store().selection).toBeNull();
  });
});
