import { afterEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import { CONTROLS_MIN_PX, EditorStage, stageLayout } from "../EditorStage";
import { GEOMETRY } from "../editorStyles";
import { useEditorComposition } from "../useEditorComposition";

// The stage's geometry (the frame and the control row under it) and what it draws, without the editor around it.

const noop = () => {};

function renderStage(empty = false, aspect = 16 / 9) {
  return render(
    <EditorStage
      empty={empty}
      aspect={aspect}
      layers={empty ? [] : [{ key: "c1", src: "blob:a" }]}
      registerVideo={noop}
      registerCanvas={noop}
      audioLayers={[]}
      registerAudio={noop}
    >
      <div data-testid="row" />
    </EditorStage>,
  );
}

/** jsdom lays nothing out: give every element the stage's size for a render. */
function sized(width: number, height: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(height);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the stage's floor", () => {
  it("is the stage with its padding and control row, so the timeline gets what is left of the column below it", () => {
    // At the floor the frame is 240px tall: 344 less 24px above and below and the row's 56
    expect(GEOMETRY.stageFloor).toBe(344);
    expect(stageLayout({ width: 2000, height: GEOMETRY.stageFloor }, 16 / 9)!.frame.height).toBe(240);
    const root = document.createElement("div");
    Object.defineProperty(root, "clientHeight", { value: 800 });
    // A 56px header over the stage: nothing else is reserved (the row is inside the stage)
    const { result } = renderHook(() => useEditorComposition({ current: root }, 56));
    expect(result.current.maxTimeline).toBe(800 - 56 - 344);
  });
});

describe("stageLayout", () => {
  it("is nothing until the stage has a size", () => {
    expect(stageLayout(null, 16 / 9)).toBeNull();
    expect(stageLayout({ width: 0, height: 0 }, 16 / 9)).toBeNull();
  });

  it("fits the frame across the stage less 32px each side, the row as wide (the Clip board's stage)", () => {
    // 884 × 610: 820 wide, and 820 / (16/9) = 461.25 fits under 610 − 48 − 56
    const layout = stageLayout({ width: 884, height: 610 }, 16 / 9)!;
    expect(layout.frame.width).toBe(820);
    expect(layout.frame.height).toBeCloseTo(461.25, 5);
    expect(layout.row).toBe(820);
  });

  it("fits the frame to the height left above the row when the stage is wide (the Focus board's)", () => {
    // 1428 × 610: 610 − 24 × 2 − 56 = 506 high, 899.6 wide
    const layout = stageLayout({ width: 1428, height: 610 }, 16 / 9)!;
    expect(layout.frame.height).toBe(506);
    expect(layout.frame.width).toBeCloseTo(899.56, 2);
    expect(layout.row).toBeCloseTo(899.56, 2);
  });

  it("keeps the row wide enough for its controls under a portrait frame, and inside the stage", () => {
    const tall = stageLayout({ width: 1000, height: 600 }, 9 / 16)!;
    expect(tall.frame.width).toBeCloseTo((496 * 9) / 16, 5);
    expect(tall.row).toBe(CONTROLS_MIN_PX);
    // A stage narrower than that: the row takes what there is
    const narrow = stageLayout({ width: 400, height: 600 }, 9 / 16)!;
    expect(narrow.row).toBe(336);
  });

  it("gives a stage with no room a frame of no size", () => {
    expect(stageLayout({ width: 900, height: 100 }, 16 / 9)!.frame).toEqual({ width: 0, height: 0 });
  });
});

describe("EditorStage", () => {
  it("draws the frame at its fitted size with the row under it at its width, on black with 8px corners and no ring", () => {
    sized(884, 610);
    renderStage();
    const frame = screen.getByTestId("stitch-preview");
    expect(frame.style.width).toBe("820px");
    expect(frame.style.height).toBe("461.25px");
    expect(frame).toHaveClass("rounded-lg", "bg-black");
    expect(frame.className).not.toContain("ring");
    const column = screen.getByTestId("stitch-stage-column");
    expect(column.style.width).toBe("820px");
    expect(column.firstElementChild).toBe(frame);
    expect(column.lastElementChild).toContainElement(screen.getByTestId("row"));
    expect(frame.querySelectorAll("video")).toHaveLength(1);
  });

  it("shows an empty frame that says why, with the row still under it", () => {
    sized(884, 610);
    renderStage(true);
    expect(screen.queryByTestId("stitch-preview")).toBeNull();
    const message = screen.getByText("No clips yet");
    const frame = message.parentElement!;
    expect(frame.style.width).toBe("820px");
    expect(frame).toHaveClass("bg-editor-well", "border-edit-line", "rounded-lg");
    expect(screen.getByText(/Connect videos to the node's inputs/)).toBeInTheDocument();
    expect(screen.getByTestId("stitch-stage-column")).toContainElement(screen.getByTestId("row"));
  });

  it("fills the column at the output's aspect until the stage is measured", () => {
    sized(0, 0);
    renderStage();
    const frame = screen.getByTestId("stitch-preview");
    expect(frame.style.width).toBe("100%");
    expect(frame.style.aspectRatio).not.toBe("");
    expect(screen.getByTestId("stitch-stage-column").style.width).toBe("100%");
  });
});
