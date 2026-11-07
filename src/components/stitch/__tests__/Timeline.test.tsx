import { Profiler, type ProfilerOnRenderCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  mediaKeyOf,
  nearestFrame,
} from "@/lib/stitch/mediaInfo";
import { createAudioClip } from "@/lib/stitch/audioClips";
import { primeAssetInfo } from "@/lib/stitch/assetInfo";
import type { AssetView } from "@/lib/assets/types";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import { moveClipTo, removeSelection, setClipStart, setCrossfade, setOverlapSec } from "../editorActions";
import type { StitchAudioClip, StitchTimelineClip, VideoStitchNodeData, WorkflowEdge, WorkflowNode } from "@/types";
import { restoreStoreActions } from "@/test/storeActions";
import { libraryDrop } from "../timeline/libraryDrop";
import { MAX_PX_PER_SEC, MIN_PX_PER_SEC } from "@/lib/stitch/timeAxis";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    getCurrentSession: vi.fn().mockReturnValue(null),
  },
}));
const storage: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    storage[key] = value;
  }),
  removeItem: vi.fn((key: string) => {
    delete storage[key];
  }),
  clear: vi.fn(),
});

// The timeline inside the real editor, against the real stores. jsdom lays
// nothing out (every rect is at 0), so lane x is the pointer's clientX.

const PPS = 64;
const ORIGIN = 20;
const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle: "video",
  targetHandle,
});

function seed({ bRan = true, stitch = {} }: { bRan?: boolean; stitch?: Partial<VideoStitchNodeData> } = {}) {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", {
        outputVideo: "blob:a",
        selectedModel: { provider: "kie", modelId: "veo", displayName: "Veo 3.1" },
      }),
      node("gen-b", "generateVideo", bRan ? { outputVideo: "blob:b" } : {}),
      node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle", ...stitch }),
    ],
    edges: [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")],
    openModalCount: 0,
    isModalOpen: false,
  });
  __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
  __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1920, height: 1080, fps: 24 });
}

function openEditor(onRender?: ProfilerOnRenderCallback) {
  render(
    onRender ? (
      <Profiler id="modal" onRender={onRender}>
        <StitchEditorModal />
      </Profiler>
    ) : (
      <StitchEditorModal />
    ),
  );
  act(() => {
    openStitchEditor("stitch");
    editor().setZoom(PPS);
  });
  return screen.getByRole("dialog", { name: "Edit video" });
}

const lane = () => screen.getByRole("listbox", { name: "Clips" });
const clipBox = (name: string) => within(lane()).getByRole("option", { name });
const rail = () => screen.getByRole("complementary", { name: "Clip" });
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
/** A key pressed where focus is (a focused field hears it first). */
const pressOnFocus = (key: string) =>
  act(() => {
    (document.activeElement ?? window).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
/** A selected box's white ring, drawn over its frames (null when it is not selected). */
const ring = (box: HTMLElement) => box.querySelector<HTMLElement>("[data-selected-ring]");
/** A clip's hover mute button or muted badge (pointer shortcuts, out of the accessibility tree). */
const soundButton = (name: string, label: string) => clipBox(name).querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const handleOf = (name: string, edge: "in" | "out") =>
  clipBox(name).querySelector<HTMLElement>(`[data-trim-handle="${edge}"]`)!;
const clipItem = (id: string, init: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id: `clip:${id}`,
  source: { kind: "edge", edgeId: id },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...init,
});
const pointer = (type: "pointermove" | "pointerup", clientX: number, init: MouseEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true, ...init }));
  });
/** A press and release on a clip's body, with no travel: a click. */
const click = (el: HTMLElement, clientX = 100) => {
  fireEvent.pointerDown(el, { button: 0, clientX, pointerId: 1 });
  pointer("pointerup", clientX);
};

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  act(() => editor().close());
  __setMediaExtractorForTests(null);
  __resetMediaInfoForTests();
  vi.restoreAllMocks();
  restoreStoreActions(useStitchEditorStore);
});

describe("Timeline", () => {
  it("lays the clips out as their frames alone, each named by its accessible name, its length on hover", () => {
    seed();
    openEditor();
    const first = clipBox("Clip 1");
    // No name or source drawn at rest: the box is its frames on the field ground, the length a hover chip
    expect(within(first).queryByText("Clip 1")).toBeNull();
    expect(within(first).queryByText("Veo 3.1")).toBeNull();
    expect(first).toHaveClass("bg-edit-field", "rounded-md");
    // On hover, and on keyboard focus (the box is the chip's group): a keyboard user sees it too
    expect(first).toHaveClass("group");
    expect(within(first).getByText("5.0 s")).toHaveClass("opacity-0", "group-hover:opacity-100", "group-focus-visible:opacity-100");
    expect(within(clipBox("Clip 2")).getByText("4.0 s")).toBeInTheDocument();
    // 5 s at 64 px/s from the origin (20px into the lanes), the next one after the boards' 2px gap; 64px tall, 8px
    // under the ruler
    expect(first.style.left).toBe(`${ORIGIN}px`);
    expect(first.style.width).toBe(`${5 * PPS - 1}px`);
    expect(first.style.top).toBe("8px");
    expect(first.style.height).toBe("64px");
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 5 * PPS + 1}px`);
    // No track headers: the lanes are the timeline's only column
    expect(screen.queryByTestId("stitch-clip-count")).toBeNull();
    expect(screen.getByTestId("stitch-lanes").parentElement).toBe(screen.getByTestId("stitch-timeline"));
    // The ruler's labels (jsdom has no width, so only the overscan past the origin is drawn)
    expect(within(screen.getByTestId("stitch-ruler")).getByText("0:00")).toBeInTheDocument();
  });

  it("draws the ruler as the boards do: a tick by each label, one short mark between, a short tick where a label has no room", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(950);
    seed();
    openEditor();
    const ruler = screen.getByTestId("stitch-ruler");
    const marks = (kind: string) =>
      [...ruler.querySelectorAll<HTMLElement>(`[data-ruler-mark="${kind}"]`)].map((el) => parseFloat(el.style.left));
    const x = (t: number) => ORIGIN + t * PPS;
    // 950px of lanes at 64 px/s: a label every 2 s up to 0:12; 0:14's would pass the lanes' end, so its tick is short
    expect(marks("labelled")).toEqual([0, 2, 4, 6, 8, 10, 12].map(x));
    expect(within(ruler).getAllByText(/^0:\d\d$/).map((el) => el.textContent)).toEqual([
      "0:00",
      "0:02",
      "0:04",
      "0:06",
      "0:08",
      "0:10",
      "0:12",
    ]);
    expect(marks("major")).toEqual([x(14)]);
    // One mark half-way between each two, and nothing else
    expect(marks("minor")).toEqual([1, 3, 5, 7, 9, 11, 13].map(x));
    expect(ruler.children).toHaveLength(7 + 1 + 7 + 7);
    const tall = ruler.querySelector('[data-ruler-mark="labelled"]')!;
    const short = ruler.querySelector('[data-ruler-mark="major"]')!;
    const minor = ruler.querySelector('[data-ruler-mark="minor"]')!;
    expect(tall).toHaveClass("top-2", "bg-edit-tick");
    expect(short).toHaveClass("h-2", "bg-edit-tick");
    expect(minor).toHaveClass("h-1.5", "bg-neutral-800");
  });

  it("ends the playhead's line at the strip under the audio rows, clear of \"+ Audio\"", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(1));
    const line = screen.getByTestId("stitch-playhead-line");
    expect(line.style.left).toBe(`${ORIGIN + PPS}px`);
    expect(line.style.top).toBe("0px");
    expect(line.style.bottom).toBe("28px");
    // Stacked: in a box pinned to the bottom of the rows' view (189 − 1 − 52 − 28 + 104 = 212 tall), from its top
    fireEvent.click(within(screen.getByRole("group", { name: "Timeline layout" })).getByRole("button", { name: "Stacked" }));
    expect(screen.getAllByTestId("stitch-playhead-line")).toHaveLength(1);
    const stacked = screen.getByTestId("stitch-playhead-line");
    expect(stacked.parentElement).toHaveClass("sticky", "bottom-0", "h-0");
    expect(stacked.style.top).toBe("-212px");
    expect(stacked.style.bottom).toBe("28px");
  });

  it("covers the lanes under the side padding once they scroll sideways, and takes the presses there", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    expect(screen.queryByTestId("stitch-gutter")).toBeNull();
    click(clipBox("Clip 2"));
    const selected = editor().selection;
    lanes.scrollLeft = 100;
    fireEvent.scroll(lanes);
    const gutter = screen.getByTestId("stitch-gutter");
    expect(gutter).toHaveClass("bg-pane", "z-5");
    expect(gutter).not.toHaveClass("pointer-events-none");
    expect(gutter.style.width).toBe(`${ORIGIN}px`);
    // Drawn under the row controls and "+ Audio", which stay on top of it
    for (const over of [screen.getByTestId("stitch-audio-controls").parentElement!, screen.getByTestId("stitch-timeline-foot")]) {
      expect(gutter.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // A press on it reaches nothing under it: no selection box, the selection kept
    fireEvent.pointerDown(gutter, { button: 0, clientX: 10, clientY: 40, pointerId: 1 });
    pointer("pointermove", 300, { clientY: 60 });
    expect(screen.queryByTestId("stitch-marquee")).toBeNull();
    pointer("pointerup", 300, { clientY: 60 });
    expect(editor().selection).toEqual(selected);
    lanes.scrollLeft = 0;
    fireEvent.scroll(lanes);
    expect(screen.queryByTestId("stitch-gutter")).toBeNull();
  });

  it("draws a library drop's landing box as a dashed outline, never as a selected clip's ring", () => {
    seed();
    openEditor();
    try {
      act(() =>
        libraryDrop.set(
          { lane: "audio", startSec: 1, row: 0, newRow: false },
          { assetId: "atone00000001", kind: "audio", durationSec: 2 },
        ),
      );
      const ghost = screen.getByTestId("library-drop-marker");
      expect(ghost).toHaveClass("border", "border-dashed", "border-white/40", "bg-white/6");
      expect(ghost).not.toHaveClass("ring-2", "border-2", "border-neutral-100");
      expect(ghost.style.left).toBe(`${ORIGIN + PPS}px`);
      expect(ghost.style.width).toBe(`${2 * PPS}px`);
    } finally {
      act(() => libraryDrop.set(null));
    }
  });

  it("selects a clip on a click, and the rail shows it", () => {
    seed();
    openEditor();
    expect(within(rail()).getByText("Clip 1 of 2")).toBeInTheDocument();
    click(clipBox("Clip 2"), 400);
    expect(within(rail()).getByText("Clip 2 of 2")).toBeInTheDocument();
    expect(clipBox("Clip 2")).toHaveAttribute("aria-selected", "true");
    click(clipBox("Clip 1"), 100);
    expect(within(rail()).getByText("Clip 1 of 2")).toBeInTheDocument();
    // A click is no edit
    expect(editor().past).toHaveLength(0);
  });

  it("opens the clip menu on a right-click, and Remove clip removes the clip", () => {
    seed();
    openEditor();
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 500 });
    const menu = screen.getByRole("menu", { name: "Clip 2" });
    expect(within(rail()).getByText("Clip 2 of 2")).toBeInTheDocument();
    for (const name of ["Mute clip audio", "Split at playhead", "Reset trim", "Reveal source node", "Remove clip"]) {
      expect(within(menu).getByRole("menuitem", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(within(menu).getByText("⌥M")).toBeInTheDocument();
    // Untrimmed: nothing to reset
    expect(within(menu).getByRole("menuitem", { name: /Reset trim/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Remove clip/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA"]);
    expect(within(lane()).queryByRole("option", { name: "Clip 2" })).toBeNull();
  });

  it("mutes a clip from its menu, and Escape closes the menu without leaving the editor", () => {
    seed();
    openEditor();
    fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 500 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Mute clip audio/ }));
    expect(editor().draft?.timeline[0].muted).toBe(true);
    expect(within(clipBox("Clip 1")).getByTitle("Clip audio muted")).toBeInTheDocument();
    fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 500 });
    expect(screen.getByRole("menuitem", { name: /Unmute clip audio/ })).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("splits the clip under the playhead with S into two pieces of the same source", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2.5));
    press("s");
    const timeline = editor().draft!.timeline;
    expect(timeline).toHaveLength(3);
    expect(timeline[0].source).toEqual({ kind: "edge", edgeId: "eA" });
    expect(timeline[1].source).toEqual({ kind: "edge", edgeId: "eA" });
    expect(within(clipBox("Clip 1")).getByText("2.5 s")).toBeInTheDocument();
    expect(within(clipBox("Clip 2")).getByText("2.5 s")).toBeInTheDocument();
    expect(within(clipBox("Clip 3")).getByText("4.0 s")).toBeInTheDocument();
  });

  it("trims an Out by its handle in one undo step, showing the frame under the handle", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(0));
    const handle = clipBox("Clip 1").querySelector<HTMLElement>('[data-trim-handle="out"]')!;
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handle, { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);

    // While dragging: the frame popover seeks its own <video> to the edge's source time, and the chip shows the change
    const popover = screen.getByTestId("stitch-trim-popover");
    const video = within(popover).getByTestId<HTMLVideoElement>("stitch-edge-frame");
    expect(video.currentTime).toBeCloseTo(5 - 51 / PPS, 3);
    expect(within(popover).getByText("Out")).toBeInTheDocument();
    expect(within(popover).getByText("0:04.20")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-trim-delta")).toHaveTextContent("−0.80 s");
    expect(screen.getByTestId("stitch-trim-ghost")).toBeInTheDocument();
    expect(within(clipBox("Clip 1")).getByText("4.20 s")).toBeInTheDocument();
    // Nothing is applied until release, and the next clip holds its place behind the ghost
    expect(editor().past).toHaveLength(0);
    expect(editor().draft?.timeline[0].outSec).toBeNull();
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 5 * PPS + 1}px`);

    pointer("pointerup", edgeX - 51);
    expect(editor().past).toHaveLength(1);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(5 - 51 / PPS, 3);
    // It closes up on release
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + (5 - 51 / PPS) * PPS + 1}px`);
    expect(screen.queryByTestId("stitch-trim-popover")).toBeNull();
    const out = within(rail()).getByRole("textbox", { name: "Out" }) as HTMLInputElement;
    expect(out.value).toBe("0:04.20");
    // The workflow store is untouched until Done
    const data = wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
    expect(data.timeline).toBeUndefined();
  });

  it("snaps a dragged edge to the playhead, and Shift trims without snapping", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(4.2));
    const handle = clipBox("Clip 1").querySelector<HTMLElement>('[data-trim-handle="out"]')!;
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handle, { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 0.8 * PPS + 4);
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
    // The dashed guide stands in for the playhead's line, which would hide it
    expect(screen.queryByTestId("stitch-playhead-line")).toBeNull();
    pointer("pointermove", edgeX - 0.8 * PPS + 4, { shiftKey: true });
    expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
    expect(screen.getByTestId("stitch-playhead-line")).toBeInTheDocument();
    pointer("pointermove", edgeX - 0.8 * PPS + 4);
    pointer("pointerup", edgeX - 0.8 * PPS + 4);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(4.2, 6);
  });

  it("cancels a trim on Escape, leaving the draft and the editor as they were", () => {
    seed();
    openEditor();
    const handle = clipBox("Clip 1").querySelector<HTMLElement>('[data-trim-handle="out"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 336, pointerId: 1 });
    pointer("pointermove", 250);
    press("Escape");
    expect(screen.queryByTestId("stitch-trim-popover")).toBeNull();
    pointer("pointerup", 250);
    expect(editor().past).toHaveLength(0);
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("seeks the popover to the edge's source time, not its sequence time", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(0));
    // Clip 2 runs 5–9 in the sequence and 0–4 in its source
    const edgeX = ORIGIN + 9 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);
    const popover = screen.getByTestId("stitch-trim-popover");
    expect(within(popover).getByTestId<HTMLVideoElement>("stitch-edge-frame").currentTime).toBeCloseTo(4 - 51 / PPS, 3);
    expect(within(popover).getByText("0:03.20")).toBeInTheDocument();
    pointer("pointerup", edgeX - 51);
    expect(editor().draft?.timeline[1].outSec).toBeCloseTo(4 - 51 / PPS, 3);
  });

  it("commits an In drag, and the clips after it close up", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(9));
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, clientX: ORIGIN, pointerId: 1 });
    pointer("pointermove", ORIGIN + 32);
    expect(screen.getByTestId("stitch-trim-ghost")).toBeInTheDocument();
    pointer("pointerup", ORIGIN + 32);
    expect(editor().draft?.timeline[0].inSec).toBeCloseTo(0.5, 6);
    expect(editor().past).toHaveLength(1);
    expect((within(rail()).getByRole("textbox", { name: "In" }) as HTMLInputElement).value).toBe("0:00.50");
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 4.5 * PPS + 1}px`);
  });

  it("pushes the clips after a lengthening edge live, with no ghost and no jump on release", () => {
    // Clip 1: In 1, Out 3 of its 5 s source (2 s); Clip 2 starts at 2 s
    seed({ stitch: { timeline: [clipItem("eA", { inSec: 1, outSec: 3 }), clipItem("eB")], clipOrder: ["eA", "eB"] } });
    openEditor();
    act(() => editor().setPlayhead(9));
    const outX = ORIGIN + 2 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: outX, pointerId: 1 });
    pointer("pointermove", outX + PPS);
    expect(screen.queryByTestId("stitch-trim-ghost")).toBeNull();
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3 * PPS + 1}px`);
    pointer("pointerup", outX + PPS);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(4, 6);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3 * PPS + 1}px`);

    // A lengthening In keeps the clip's left (its start does not move) and pushes the rest
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, clientX: ORIGIN, pointerId: 1 });
    pointer("pointermove", ORIGIN - 32);
    expect(clipBox("Clip 1").style.left).toBe(`${ORIGIN}px`);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3.5 * PPS + 1}px`);
    expect(screen.queryByTestId("stitch-trim-ghost")).toBeNull();
    pointer("pointerup", ORIGIN - 32);
    expect(editor().draft?.timeline[0].inSec).toBeCloseTo(0.5, 6);
    expect(clipBox("Clip 1").style.left).toBe(`${ORIGIN}px`);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 3.5 * PPS + 1}px`);
  });

  it("moves the add slot with a lengthening Out on the last clip, and leaves it after the ghost of a shortening one", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(0));
    const slot = () => screen.getByTestId("stitch-add-slot");
    // Clip 2 runs 5–9 s of the sequence and ends its 4 s source
    const restEnd = ORIGIN + 9 * PPS;
    expect(slot().style.left).toBe(`${restEnd + 6}px`);
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: restEnd, pointerId: 1 });
    pointer("pointermove", restEnd - PPS);
    expect(screen.getByTestId("stitch-trim-ghost")).toBeInTheDocument();
    expect(slot().style.left).toBe(`${restEnd + 6}px`);
    pointer("pointerup", restEnd - PPS);
    expect(editor().draft?.timeline[1].outSec).toBeCloseTo(3, 6);
    expect(slot().style.left).toBe(`${restEnd - PPS + 6}px`);
    // Lengthening it back pushes the slot along
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: restEnd - PPS, pointerId: 1 });
    pointer("pointermove", restEnd - PPS / 2);
    expect(slot().style.left).toBe(`${restEnd - PPS / 2 + 6}px`);
    pointer("pointerup", restEnd - PPS / 2);
  });

  it("changes nothing when a handle is pressed and released without moving", () => {
    // Clip 2 has a numeric Out: rebuilding it from the sequence would add float noise
    seed({ stitch: { timeline: [clipItem("eA"), clipItem("eB", { outSec: 1.3 })], clipOrder: ["eA", "eB"] } });
    openEditor();
    const outX = ORIGIN + 6.3 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: outX, pointerId: 1 });
    pointer("pointerup", outX);
    expect(editor().draft?.timeline[1].outSec).toBe(1.3);
    // An outer edge near the playhead (0.08 s, within 8px) does not snap to it on a press
    act(() => editor().setPlayhead(0.08));
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, clientX: ORIGIN, pointerId: 1 });
    expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
    pointer("pointerup", ORIGIN);
    expect(editor().draft?.timeline[0].inSec).toBe(0);
    expect(editor().past).toHaveLength(0);
    expect(editor().cancelGesture).toBeNull();
  });

  it("holds the editor's keys while a trim runs, so the release applies to the draft it measured", () => {
    seed();
    openEditor();
    act(() => editor().setPlayhead(2));
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);
    press("s");
    press("Backspace");
    press("z", { metaKey: true });
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA", "clip:eB"]);
    pointer("pointerup", edgeX - 51);
    expect(editor().draft?.timeline).toHaveLength(2);
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(5 - 51 / PPS, 3);
    expect(editor().past).toHaveLength(1);
    // Afterwards they work again
    press("s");
    expect(editor().draft?.timeline).toHaveLength(3);
  });

  it("opens no clip menu while a trim runs, so Escape still cancels it", () => {
    seed();
    openEditor();
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 40);
    fireEvent.contextMenu(clipBox("Clip 1"), { button: 2, clientX: edgeX - 40, clientY: 300 });
    expect(editor().menu).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    press("Escape");
    expect(editor().cancelGesture).toBeNull();
    pointer("pointerup", edgeX - 40);
    expect(editor().draft?.timeline[0].outSec).toBeNull();
    expect(editor().past).toHaveLength(0);
  });

  it("drops a trim whose draft changed under it", () => {
    seed();
    openEditor();
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    pointer("pointermove", edgeX - 51);
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.slice(1) })));
    pointer("pointerup", edgeX - 51);
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eB"]);
    expect(editor().past).toHaveLength(1);
  });

  it("lets a focused In/Out field go when a handle is pressed, so Escape cancels the drag", () => {
    seed();
    openEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit video" });
    const out = within(rail()).getByRole("textbox", { name: "Out" });
    act(() => out.focus());
    expect(document.activeElement).toBe(out);
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    expect(document.activeElement).toBe(dialog);
    pointer("pointermove", edgeX - 51);
    pressOnFocus("Escape");
    expect(screen.queryByTestId("stitch-trim-popover")).toBeNull();
    pointer("pointerup", edgeX - 51);
    expect(editor().past).toHaveLength(0);
    expect(editor().discardOpen).toBe(false);

    // The ruler too: I then reaches the editor, not the field
    act(() => out.focus());
    fireEvent.pointerDown(screen.getByTestId("stitch-ruler"), { button: 0, clientX: ORIGIN + 1 * PPS, pointerId: 1 });
    expect(document.activeElement).toBe(dialog);
  });

  it("cancels a reorder on Escape: the clip stays, the editor stays open", () => {
    seed();
    openEditor();
    fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, clientX: 450, pointerId: 1 });
    pointer("pointermove", 100);
    expect(screen.getByTestId("stitch-insertion-bar")).toBeInTheDocument();
    press("Escape");
    expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
    pointer("pointerup", 100);
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA", "clip:eB"]);
    expect(editor().past).toHaveLength(0);
  });

  it("closes the clip menu on any press outside it, and an item acts on the menu's own clip", () => {
    seed();
    openEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit video" });
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 500 });
    expect(screen.getByRole("menu", { name: "Clip 2" })).toBeInTheDocument();
    // A handle press cancels its pointerdown (no mousedown follows): the menu still closes
    const handle = handleOf("Clip 1", "out");
    expect(fireEvent.pointerDown(handle, { button: 0, clientX: 336, pointerId: 1 })).toBe(false);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(dialog);
    pointer("pointerup", 336);

    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 500 });
    act(() => editor().select({ kind: "clip", clipId: "clip:eA" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Remove clip/ }));
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA"]);
  });

  it("returns focus to the panel when the menu closes on Escape", () => {
    seed();
    openEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit video" });
    fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 500 });
    expect(document.activeElement).toHaveAttribute("role", "menuitem");
    press("Escape");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(dialog);
  });

  it("moves the selection with the arrows and opens the clip menu from the keyboard", () => {
    seed();
    openEditor();
    const first = clipBox("Clip 1");
    // The selected clip is the lane's one tab stop
    expect(first).toHaveAttribute("tabindex", "0");
    expect(clipBox("Clip 2")).toHaveAttribute("tabindex", "-1");
    act(() => first.focus());
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(within(rail()).getByText("Clip 2 of 2")).toBeInTheDocument();
    expect(document.activeElement).toBe(clipBox("Clip 2"));
    expect(clipBox("Clip 2")).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(clipBox("Clip 2"), { key: "Home" });
    expect(within(rail()).getByText("Clip 1 of 2")).toBeInTheDocument();
    fireEvent.keyDown(clipBox("Clip 1"), { key: "End" });
    fireEvent.keyDown(clipBox("Clip 2"), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Clip 2" })).toBeInTheDocument();
  });

  it("shows in each filmstrip cell the frame at its own source time, sliding with the In", () => {
    seed();
    const frames = Array.from({ length: 12 }, (_, i) => `data:image/png;base64,frame${i}`);
    __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, frames });
    openEditor();
    const info = { frames, duration: 5 };
    const cells = () => Array.from(clipBox("Clip 1").querySelectorAll("img")).map((img) => img.getAttribute("src"));
    // jsdom has no width: the overscan draws cells 0–2
    expect(cells()).toEqual([0, 1, 2].map((k) => nearestFrame(info, (k * 56 + 28) / PPS)));
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.map((c, i) => (i === 0 ? { ...c, inSec: 1 } : c)) })));
    expect(cells()[0]).toBe(nearestFrame(info, 1 + 28 / PPS));
    expect(cells()[0]).not.toBe(nearestFrame(info, 28 / PPS));
  });

  it("keeps a very short clip pressable at a low zoom", () => {
    seed({ stitch: { timeline: [clipItem("eA"), clipItem("eB", { inSec: 1, outSec: 1.1 })], clipOrder: ["eA", "eB"] } });
    openEditor();
    act(() => editor().setZoom(30));
    expect(clipBox("Clip 2").style.width).toBe("4px");
  });

  it("does not leave a zoom the limits held to scroll the lanes back later", () => {
    seed();
    openEditor();
    act(() => editor().setZoom(480));
    const lanes = screen.getByTestId("stitch-lanes");
    // Already at the most: a ⌘ wheel in changes nothing
    fireEvent.wheel(lanes, { ctrlKey: true, deltaY: -100, clientX: 400 });
    expect(editor().pxPerSec).toBe(480);
    lanes.scrollLeft = 2000;
    // An edit rebuilds the axis
    fireEvent.click(soundButton("Clip 2", "Mute clip audio"));
    expect(lanes.scrollLeft).toBe(2000);
  });

  it("keeps the pointer's place inside an empty slot across a ⌘ wheel zoom", () => {
    seed({ bRan: false });
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    Object.defineProperty(lanes, "clientWidth", { value: 600, configurable: true });
    // Clip 2 has not run: a slot at 5 s, its left at x 336; the pointer 120px into it
    const slotLeft = ORIGIN + 5 * PPS;
    fireEvent.wheel(lanes, { ctrlKey: true, deltaY: -100, clientX: slotLeft + 120 });
    const pps = editor().pxPerSec!;
    expect(pps).toBeGreaterThan(PPS);
    // The slot does not slide under the pointer: its left is still at view x 336
    expect(ORIGIN + 5 * pps - lanes.scrollLeft).toBeCloseTo(slotLeft, 6);
  });

  it("does not zoom with the ⌘ wheel while a drag runs", () => {
    seed();
    openEditor();
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    fireEvent.wheel(screen.getByTestId("stitch-lanes"), { ctrlKey: true, deltaY: -100, clientX: 400 });
    expect(editor().pxPerSec).toBe(PPS);
    pointer("pointerup", edgeX);
  });

  it("drags a clip to a new place, dimming the others to their frames, in one undo step", () => {
    seed();
    openEditor();
    const second = clipBox("Clip 2");
    fireEvent.pointerDown(second, { button: 0, clientX: 450, pointerId: 1 });
    pointer("pointermove", 100);
    // The others show their frames only; the lifted one keeps its name
    expect(within(clipBox("Clip 1")).queryByText("Clip 1")).toBeNull();
    expect(within(clipBox("Clip 1")).queryByText("5.0 s")).toBeNull();
    expect(within(clipBox("Clip 2")).getByText("Clip 2")).toBeInTheDocument();
    expect(screen.getByTestId("stitch-insertion-bar")).toBeInTheDocument();
    pointer("pointerup", 100);
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eB", "clip:eA"]);
    expect(editor().past).toHaveLength(1);
    expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
    // The moved clip is now Clip 1, and selected
    expect(within(rail()).getByText("Clip 1 of 2")).toBeInTheDocument();
    expect(within(clipBox("Clip 1")).getByText("4.0 s")).toBeInTheDocument();
  });

  it("mutes a clip from its hover button and unmutes it from its badge", () => {
    seed();
    openEditor();
    // Pointer shortcuts (⌥M and the menu are the keyboard's way): out of the accessibility tree, taking no focus
    const mute = soundButton("Clip 2", "Mute clip audio");
    expect(mute).toHaveAttribute("aria-hidden", "true");
    expect(mute).toHaveAttribute("tabindex", "-1");
    expect(fireEvent.mouseDown(mute)).toBe(false);
    fireEvent.click(mute);
    expect(editor().draft?.timeline[1].muted).toBe(true);
    fireEvent.click(soundButton("Clip 2", "Unmute clip audio"));
    expect(editor().draft?.timeline[1].muted).toBe(false);
    expect(editor().past).toHaveLength(2);
  });

  it("keeps a slot for a source that has not run yet", () => {
    seed({ bRan: false });
    openEditor();
    const slot = clipBox("Clip 2");
    expect(slot).toHaveTextContent("Clip 2 · not generated yet");
    // Why, in ink-3 (neutral-500 fell under 4.5:1 on the pane), and as the slot's description
    expect(slot).toHaveClass("text-ink-3");
    expect(slot).toHaveAccessibleDescription("not generated yet");
    expect(slot.style.width).toBe("159px");
  });

  it("says when a trim starts past the end of its source, and the slot can be selected and reset", () => {
    const timeline: StitchTimelineClip[] = [
      { id: "clip:eA", source: { kind: "edge", edgeId: "eA" }, inSec: 6, outSec: null, muted: false, volume: 1 },
      { id: "clip:eB", source: { kind: "edge", edgeId: "eB" }, inSec: 0, outSec: null, muted: false, volume: 1 },
    ];
    seed({ stitch: { timeline, clipOrder: ["eA", "eB"] } });
    openEditor();
    expect(clipBox("Clip 1")).toHaveTextContent("Clip 1 · trim starts past the end");
    click(clipBox("Clip 2"), 300);
    click(clipBox("Clip 1"), 50);
    fireEvent.click(within(rail()).getByRole("button", { name: /Reset trim/ }));
    expect(within(clipBox("Clip 1")).getByText("5.0 s")).toBeInTheDocument();
  });

  it("gives a trim under one frame no time, as the encode leaves it out, and says why", () => {
    const timeline: StitchTimelineClip[] = [
      { id: "clip:eA", source: { kind: "edge", edgeId: "eA" }, inSec: 4.99, outSec: null, muted: false, volume: 1 },
      { id: "clip:eB", source: { kind: "edge", edgeId: "eB" }, inSec: 0, outSec: null, muted: false, volume: 1 },
    ];
    seed({ stitch: { timeline, clipOrder: ["eA", "eB"] } });
    openEditor();
    expect(clipBox("Clip 1")).toHaveTextContent("Clip 1 · trim is shorter than a frame");
  });

  it("shows a dashed placeholder and unlabelled ticks when there are no clips", () => {
    useWorkflowStore.setState({
      nodes: [node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" })],
      edges: [],
    });
    openEditor();
    expect(screen.getByTestId("stitch-empty-lane")).toBeInTheDocument();
    const ruler = screen.getByTestId("stitch-ruler");
    expect(within(ruler).queryByText("0:00")).toBeNull();
    // Only short marks where the labels would be: no tall tick without its label, no marks between
    expect(ruler.querySelectorAll('[data-ruler-mark="major"]').length).toBeGreaterThan(0);
    expect(ruler.querySelectorAll('[data-ruler-mark="labelled"], [data-ruler-mark="minor"]')).toHaveLength(0);
    expect(screen.queryByTestId("stitch-playhead-line")).toBeNull();
  });

  it("moves the playhead from the ruler, and pauses", () => {
    seed();
    openEditor();
    act(() => editor().setPlaying(true));
    fireEvent.pointerDown(screen.getByTestId("stitch-ruler"), { button: 0, clientX: ORIGIN + 2 * PPS, pointerId: 1 });
    expect(editor().playing).toBe(false);
    expect(editor().playhead).toBeCloseTo(2);
    fireEvent.pointerMove(screen.getByTestId("stitch-ruler"), { clientX: ORIGIN + 3 * PPS, pointerId: 1 });
    expect(editor().playhead).toBeCloseTo(3);
    // Clamped to the sequence
    fireEvent.pointerMove(screen.getByTestId("stitch-ruler"), { clientX: 5000, pointerId: 1 });
    expect(editor().playhead).toBeCloseTo(9);
  });

  it("snaps and zooms to the playhead where it is drawn, not past a sequence that got shorter", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    Object.defineProperty(lanes, "clientWidth", { value: 600, configurable: true });
    // At the end (9 s), then Clip 2 loses a second: the playhead is stored at 9 and drawn at 8
    act(() => editor().setPlayhead(9));
    act(() => editor().apply((d) => ({ ...d, timeline: d.timeline.map((c, i) => (i === 1 ? { ...c, outSec: 3 } : c)) })));
    const edgeX = ORIGIN + 8 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    // One second out is where the stored playhead is, and nothing is drawn there: no snap
    pointer("pointermove", edgeX + PPS);
    expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
    // Near the drawn playhead, it snaps
    pointer("pointermove", edgeX + 4);
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
    press("Escape");
    pointer("pointerup", edgeX + 4);

    // Zoom in keeps the drawn playhead (8 s, at view x 528) in place
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(lanes.scrollLeft).toBeCloseTo(ORIGIN + 8 * PPS * 1.5 - (ORIGIN + 8 * PPS), 6);
  });

  it("draws the ticks for a scroll the zoom makes in the same render", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    Object.defineProperty(lanes, "clientWidth", { value: 600, configurable: true });
    act(() => editor().setPlayhead(8));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const scrolled = lanes.scrollLeft;
    expect(scrolled).toBeGreaterThan(200);
    // jsdom fires no scroll event: the ticks follow because the zoom published its own scroll
    const lefts = Array.from(screen.getByTestId("stitch-ruler").querySelectorAll<HTMLElement>("span")).map((el) =>
      parseFloat(el.style.left),
    );
    expect(Math.max(...lefts)).toBeGreaterThan(scrolled);
  });

  it("puts the playhead where release leaves it while a trim pushes a slot along", () => {
    // Clip 1 (0–3), Clip 2 not run yet (a slot at 3 s), Clip 3 (another piece of Clip 1's source, 3–7)
    seed({
      bRan: false,
      stitch: {
        timeline: [clipItem("eA", { outSec: 3 }), clipItem("eB"), clipItem("eA", { id: "clip:c", inSec: 1 })],
        clipOrder: ["eA", "eB"],
      },
    });
    openEditor();
    act(() => editor().setPlayhead(4.5));
    const line = () => screen.getByTestId("stitch-playhead-line");
    // After the slot
    expect(line().style.left).toBe(`${ORIGIN + 4.5 * PPS + 160}px`);
    const edgeX = ORIGIN + 3 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    // Lengthened to 4.5 s, the edge meets the playhead and snaps: the slot moves on with Clip 3
    pointer("pointermove", edgeX + 1.5 * PPS);
    expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
    // Without the snap, the line is drawn on the edge too: release would leave the playhead there
    pointer("pointermove", edgeX + 1.5 * PPS, { shiftKey: true });
    expect(line().style.left).toBe(`${ORIGIN + 4.5 * PPS}px`);
    press("Escape");
    pointer("pointerup", edgeX + 1.5 * PPS);
    expect(line().style.left).toBe(`${ORIGIN + 4.5 * PPS + 160}px`);
  });

  it("measures a trim with the Fit zoom that the field's commit leads to", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(1258);
    seed();
    render(<StitchEditorModal />);
    act(() => openStitchEditor("stitch"));
    // Fit: (1258 − 20 − 70) / 9 s (the origin; the add slot, its gap and the end margin)
    const fitBefore = (1258 - 20 - 70) / 9;
    const fitAfter = (1258 - 20 - 70) / 7;
    const out = within(rail()).getByRole("textbox", { name: "Out" }) as HTMLInputElement;
    act(() => out.focus());
    fireEvent.change(out, { target: { value: "0:03.00" } });
    // The press commits Clip 1's Out (the sequence is now 7 s), then measures
    const edgeX = ORIGIN + 9 * fitBefore;
    fireEvent.pointerDown(handleOf("Clip 2", "out"), { button: 0, clientX: edgeX, pointerId: 1 });
    expect(editor().draft?.timeline[0].outSec).toBeCloseTo(3, 6);
    pointer("pointermove", edgeX - 100);
    expect(screen.getByTestId("stitch-trim-delta")).toHaveTextContent(`−${(100 / fitAfter).toFixed(2)} s`);
    pointer("pointerup", edgeX - 100);
    expect(editor().draft?.timeline[1].outSec).toBeCloseTo(4 - 100 / fitAfter, 3);
  });

  it("keeps the clip under the pointer when the lanes scroll during a reorder", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    const content = lanes.firstElementChild as HTMLElement;
    fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, clientX: 450, pointerId: 1 });
    pointer("pointermove", 300);
    const restX = ORIGIN + 5 * PPS + 1;
    expect(clipBox("Clip 2").style.left).toBe(`${restX - 150}px`);
    // A wheel scrolls the lanes 100px under the still pointer
    vi.spyOn(content, "getBoundingClientRect").mockReturnValue({ left: -100, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: -100, y: 0, toJSON: () => ({}) });
    act(() => {
      lanes.scrollLeft = 100;
      lanes.dispatchEvent(new Event("scroll"));
    });
    expect(clipBox("Clip 2").style.left).toBe(`${restX - 50}px`);
    press("Escape");
    pointer("pointerup", 300);
  });

  it("leaves a narrow clip a body to press: its handles shrink to a third each", () => {
    seed({ stitch: { timeline: [clipItem("eA"), clipItem("eB", { inSec: 1, outSec: 1.25 })], clipOrder: ["eA", "eB"] } });
    openEditor();
    expect(handleOf("Clip 1", "out").style.width).toBe("10px");
    // 0.25 s at 64 px/s, less the 1px join inset: 15px wide
    expect(clipBox("Clip 2").style.width).toBe("15px");
    expect(parseFloat(handleOf("Clip 2", "in").style.width)).toBeCloseTo(15 / 3, 6);
    expect(parseFloat(handleOf("Clip 2", "out").style.width)).toBeCloseTo(15 / 3, 6);
  });

  it("keeps focus in the lane when the focused clip is removed, and on the panel when none is left", () => {
    seed();
    const dialog = openEditor();
    act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
    act(() => clipBox("Clip 2").focus());
    press("Backspace");
    expect(editor().draft?.timeline.map((c) => c.id)).toEqual(["clip:eA"]);
    expect(document.activeElement).toBe(clipBox("Clip 1"));
    // An undo brings Clip 2 back; a redo takes it away again (focus stays on Clip 1)
    press("z", { metaKey: true });
    press("z", { metaKey: true, shiftKey: true });
    expect(document.activeElement).toBe(clipBox("Clip 1"));
    // "+ Audio" under the audio rows is the panel's last tab stop (the clips' mute buttons are out of the tab
    // order): Tab from it wraps inside the dialog
    const addAudio = screen.getByRole("button", { name: "Add audio" });
    // Its ring is drawn inside it: the line it sits in ends 2px under it, at the dialog's bottom edge
    expect(addAudio).toHaveClass("focus-visible:ring-inset");
    act(() => addAudio.focus());
    fireEvent.keyDown(addAudio, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(addAudio);
    act(() => clipBox("Clip 1").focus());
    press("Backspace");
    expect(editor().draft?.timeline).toHaveLength(0);
    expect(document.activeElement).toBe(dialog);
  });

  it("keeps focus in the lane when an undo brings clips back under the focused placeholder", () => {
    seed();
    const dialog = openEditor();
    act(() => {
      editor().apply((d) => ({ ...d, timeline: [] }));
      editor().select(null);
    });
    const placeholder = screen.getByTestId("stitch-empty-lane");
    act(() => placeholder.focus());
    // The clips come back with nothing selected: the rail's own focus rescue does not run
    press("z", { metaKey: true });
    expect(editor().draft?.timeline).toHaveLength(2);
    expect(editor().selection).toBeNull();
    expect(placeholder.isConnected).toBe(false);
    expect(document.activeElement).toBe(clipBox("Clip 1"));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("zooms with the transport's buttons and Fit", () => {
    seed();
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(editor().pxPerSec).toBeCloseTo(PPS * 1.5);
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(editor().pxPerSec).toBeCloseTo(PPS);
    fireEvent.click(screen.getByRole("button", { name: "Fit the timeline" }));
    expect(editor().pxPerSec).toBeNull();
  });

  it("keeps a zoom button focusable at its limit, so Enter there leaves focus on it, inside the dialog", () => {
    seed();
    const dialog = openEditor();
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    act(() => editor().setZoom(MAX_PX_PER_SEC / 1.2));
    act(() => zoomIn.focus());
    // One step reaches the most: the button says it can go no further, without dropping focus
    fireEvent.click(zoomIn);
    expect(editor().pxPerSec).toBe(MAX_PX_PER_SEC);
    expect(zoomIn).not.toBeDisabled();
    expect(zoomIn).toHaveAttribute("aria-disabled", "true");
    expect(zoomIn).toHaveFocus();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Another press does nothing
    fireEvent.click(zoomIn);
    expect(editor().pxPerSec).toBe(MAX_PX_PER_SEC);
    // And Zoom out at the least
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    act(() => editor().setZoom(MIN_PX_PER_SEC));
    expect(zoomOut).not.toBeDisabled();
    expect(zoomOut).toHaveAttribute("aria-disabled", "true");
    expect(zoomIn).not.toHaveAttribute("aria-disabled");
    fireEvent.click(zoomOut);
    expect(editor().pxPerSec).toBe(MIN_PX_PER_SEC);
  });
});

describe("Timeline, the clip menu", () => {
  it("leaves the lanes where they are on a wheel over the open menu", () => {
    seed();
    openEditor();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 60 });
    const menu = screen.getByRole("menu");
    fireEvent.wheel(menu, { deltaY: 40 });
    expect(lanes.scrollLeft).toBe(0);
    expect(lanes.scrollTop).toBe(0);
    expect(editor().menu).toEqual({ kind: "clip", clipId: "clip:eB", x: 400, y: 60 });
    // Over the lanes, the wheel still scrolls them
    fireEvent.wheel(lanes, { deltaY: 40 });
    expect(lanes.scrollLeft).toBe(40);
  });
});


describe("Timeline, Stacked", () => {
  const ROW = 52;
  const BOX_TOP = 6;
  /** Clips of these lengths from their own generate nodes, in order (clip ids clip:e0, clip:e1, …). */
  function seedClips(lengths: number[]) {
    useWorkflowStore.setState({
      nodes: [
        ...lengths.map((_, i) =>
          node(`gen-${i}`, "generateVideo", {
            outputVideo: `blob:s${i}`,
            selectedModel: { provider: "kie", modelId: "veo", displayName: `Model ${i + 1}` },
          }),
        ),
        node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" }),
      ],
      edges: lengths.map((_, i) => edge(`e${i}`, `gen-${i}`, `video-${i}`)),
      openModalCount: 0,
      isModalOpen: false,
    });
    lengths.forEach((duration, i) =>
      __setMediaInfoForTests(mediaKeyOf(`blob:s${i}`), { duration, width: 1920, height: 1080, fps: 24 }),
    );
  }
  /** seedClips, already Stacked, each clip at its start (undefined: not placed) and with its own fields. */
  function seedPlaced(
    lengths: number[],
    starts: Array<number | undefined>,
    { crossfade = true, overlapSec = 1, clips = {} }: { crossfade?: boolean; overlapSec?: number; clips?: Record<number, Partial<StitchTimelineClip>> } = {},
  ) {
    seedClips(lengths);
    const timeline = lengths.map((_, i) =>
      clipItem(`e${i}`, { ...(starts[i] === undefined ? {} : { startSec: starts[i] }), ...clips[i] }),
    );
    useWorkflowStore.setState({
      nodes: wf().nodes.map((n) =>
        n.id === "stitch"
          ? {
              ...n,
              data: {
                ...n.data,
                timeline,
                clipOrder: lengths.map((_, i) => `e${i}`),
                sequenceLayout: { mode: "stacked", overlapSec, crossfade },
              },
            }
          : n,
      ),
    });
  }
  const toggle = () => screen.getByRole("group", { name: "Timeline layout" });
  const openStacked = (onRender?: ProfilerOnRenderCallback) => {
    openEditor(onRender);
    fireEvent.click(within(toggle()).getByRole("button", { name: "Stacked" }));
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
  };
  // A Stacked box's name says where it starts ("Clip 2, starts 0:04.00")
  const clipBox = (name: string) => within(lane()).getByRole("option", { name: new RegExp(`^${name}(,|$)`) });
  const handleOf = (name: string, edge: "in" | "out") =>
    clipBox(name).querySelector<HTMLElement>(`[data-trim-handle="${edge}"]`)!;
  /** A row's grip in the left padding: what the row header was (a drag up or down, a right press for the menu). */
  const grip = (id: string) => document.querySelector<HTMLElement>(`[data-row-grip="${id}"]`)!;
  const at = (x: number, y: number) => ({ clientX: x, clientY: y });
  const move = (x: number, y: number, init: MouseEventInit = {}) => pointer("pointermove", x, { clientY: y, ...init });
  const release = (x: number, y: number) => pointer("pointerup", x, { clientY: y });
  const order = () => editor().draft!.timeline.map((c) => c.id);
  const starts = () => editor().draft!.timeline.map((c) => c.startSec);
  const timelineEl = () => screen.getByTestId("stitch-lanes").parentElement!;
  /** The quiet line under the audio rows: "+ Audio", and Line up in Stacked. */
  const foot = () => screen.getByTestId("stitch-timeline-foot");
  const shift = (type: "keydown" | "keyup") =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent(type, { key: "Shift", shiftKey: type === "keydown", bubbles: true }));
    });
  /** Each mark drawn inside a box: what it is, where, and its title. */
  const marksOf = (name: string) =>
    [
      ...clipBox(name).querySelectorAll<HTMLElement>(
        '[data-testid="stitch-crossfade-in"], [data-testid="stitch-crossfade-out"], [data-testid="stitch-hidden"], [data-testid="stitch-weight-curve"]',
      ),
    ].map((el) => ({
      kind: el.getAttribute("data-testid"),
      left: parseFloat(el.style.left || "0"),
      width: parseFloat(el.style.width),
      title: el.getAttribute("title"),
    }));
  /** Runs the animation frames asked for so far (the drag's among them), one frame at a time, by hand. */
  const frames = () => {
    const queued: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      queued.push(cb);
      return queued.length;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
    return () =>
      act(() => {
        for (const cb of queued.splice(0)) cb(performance.now());
      });
  };
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  it("puts Track | Stacked outside the timeline, Track pressed by default", () => {
    seed();
    openEditor();
    const track = within(toggle()).getByRole("button", { name: "Track" });
    const stacked = within(toggle()).getByRole("button", { name: "Stacked" });
    expect(track).toHaveAttribute("aria-pressed", "true");
    expect(stacked).toHaveAttribute("aria-pressed", "false");
    // The app's own tooltips, as the editor's other controls have, not the system's
    expect(track).not.toHaveAttribute("title");
    expect(within(track.parentElement!).getByText("Track: clips end to end on one row")).toHaveAttribute("aria-hidden", "true");
    expect(within(stacked.parentElement!).getByText("Stacked: one row per clip, placed anywhere in time")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    // Not in the timeline: it is in the control row under the video
    expect(timelineEl().contains(toggle())).toBe(false);
    // Track: no headers; under the audio rows only "+ Audio", and the slot after the last clip adds videos
    expect(within(foot()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Add audio",
    ]);
    expect(screen.getAllByRole("button", { name: "Add media" })).toEqual([
      screen.getByTestId("stitch-add-slot"),
    ]);
    fireEvent.click(stacked);
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
    expect(within(toggle()).getByRole("button", { name: "Stacked" })).toHaveAttribute("aria-pressed", "true");
    expect(timelineEl().contains(toggle())).toBe(false);
    // Stacked adds Line up after "+ Audio" (off: nothing has been placed yet); the slot in the last row still adds
    const lineUp = within(foot()).getByRole("button", { name: "Line up" });
    expect(within(foot()).getAllByRole("button")).toEqual([within(foot()).getByRole("button", { name: "Add audio" }), lineUp]);
    expect(lineUp).toBeDisabled();
    expect(lineUp).toHaveAttribute("title", "The clips are lined up");
    expect(screen.getAllByRole("button", { name: "Add media" })).toEqual([
      screen.getByTestId("stitch-add-slot"),
    ]);
    expect(editor().past).toHaveLength(1);
  });

  it("lays out one row per clip, each box at its own start, compact, with a grip per row", () => {
    seedClips([5, 5, 6]);
    openStacked();
    expect(lane()).toHaveAttribute("aria-orientation", "vertical");
    expect(within(lane()).getAllByRole("option")).toHaveLength(3);
    // Overlap 1.0 s: starts 0, 4 and 8 s at 64 px/s from the origin, one 52px row each
    const starts = [0, 4, 8];
    const lengths = [5, 5, 6];
    ["Clip 1", "Clip 2", "Clip 3"].forEach((name, i) => {
      const box = clipBox(name);
      expect(box.style.left).toBe(`${ORIGIN + starts[i] * PPS}px`);
      expect(box.style.width).toBe(`${lengths[i] * PPS}px`);
      expect(box.style.top).toBe(`${i * ROW + BOX_TOP}px`);
      expect(box.style.height).toBe("40px");
    });
    // Frames only: no name or source, the length on hover
    expect(within(clipBox("Clip 1")).queryByText("Clip 1")).toBeNull();
    expect(within(clipBox("Clip 1")).queryByText("Model 1")).toBeNull();
    expect(within(clipBox("Clip 1")).getByText("5.0 s")).toHaveClass("opacity-0", "group-hover:opacity-100");
    // A grip per row, level with its box, hidden until the row is hovered and out of the accessibility tree
    const grips = screen.getByTestId("stitch-row-grips");
    expect(Array.from(grips.children).map((el) => (el as HTMLElement).dataset.rowGrip)).toEqual([
      "clip:e0",
      "clip:e1",
      "clip:e2",
    ]);
    expect(grip("clip:e1").style.top).toBe(`${ROW + BOX_TOP}px`);
    expect(grip("clip:e1")).toHaveAttribute("aria-hidden", "true");
    expect(grip("clip:e1")).toHaveClass("opacity-0");
    // The add slot after the last row's box, in that row
    const slot = screen.getByTestId("stitch-add-slot");
    expect(slot.style.left).toBe(`${ORIGIN + 14 * PPS + 6}px`);
    expect(slot.style.top).toBe(`${2 * ROW + BOX_TOP}px`);
    // 3 rows as they need: the edge, the ruler, 156, then one audio row and the strip (52 + 28)
    expect(timelineEl().style.height).toBe(`${1 + 28 + 156 + 80}px`);
    expect(screen.getByTestId("stitch-lanes")).toHaveClass("overflow-y-hidden");
  });

  it("names each box with where it starts", () => {
    seedClips([5, 4.2, 6]);
    openStacked();
    // Lined up: 0, 4.0 and 7.2 s
    expect(within(lane()).getByRole("option", { name: "Clip 3, starts 0:07.20" })).toBe(clipBox("Clip 3"));
    expect(within(lane()).getByRole("option", { name: "Clip 1, starts 0:00.00" })).toBe(clipBox("Clip 1"));
  });

  it("draws a 1 s crossfade as a wedge over each side of the join", () => {
    seed();
    openStacked();
    const head = clipBox("Clip 2").querySelector<SVGElement>('[data-testid="stitch-crossfade-in"]')!;
    const tail = clipBox("Clip 1").querySelector<SVGElement>('[data-testid="stitch-crossfade-out"]')!;
    expect(head.style.width).toBe(`${PPS}px`);
    expect(tail.style.width).toBe(`${PPS}px`);
    expect(clipBox("Clip 1").querySelector('[data-testid="stitch-crossfade-in"]')).toBeNull();
    expect(clipBox("Clip 2").querySelector('[data-testid="stitch-crossfade-out"]')).toBeNull();
  });

  it("with the crossfade off, darkens the head the clip above hides, without the trim hatch", () => {
    seed();
    openStacked();
    act(() => setCrossfade(false));
    const covered = clipBox("Clip 2").querySelector<HTMLElement>('[data-testid="stitch-covered-head"]')!;
    expect(covered).toHaveAttribute("title", "Hidden under Clip 1. Its sound plays.");
    expect(covered.style.width).toBe(`${PPS}px`);
    expect(clipBox("Clip 2").querySelector(".editor-ghost-hatch")).toBeNull();
    expect(screen.queryByTestId("stitch-crossfade-in")).toBeNull();
    expect(clipBox("Clip 1").querySelector('[data-testid="stitch-covered-head"]')).toBeNull();
  });

  it("moves the selection down the rows with the arrows", () => {
    seedClips([5, 5, 6]);
    openStacked();
    click(clipBox("Clip 1"));
    fireEvent.keyDown(clipBox("Clip 1"), { key: "ArrowDown" });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
    fireEvent.keyDown(clipBox("Clip 2"), { key: "End" });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e2" });
    fireEvent.keyDown(clipBox("Clip 3"), { key: "ArrowUp" });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
  });

  it("drags a clip by its row's grip down two rows in one undo step, drawn at the start it will have, with the line", () => {
    seedClips([5, 5, 6]);
    openStacked();
    const before = editor().past.length;
    fireEvent.pointerDown(grip("clip:e0"), { button: 0, pointerId: 1, ...at(10, 26) });
    move(10, 26 + 2 * ROW);
    // Lifted down two rows, at x of its start in the order B, C, A: 5 + 6 − 2 overlaps = 9 s
    const lifted = clipBox("Clip 1");
    expect(lifted.style.top).toBe(`${BOX_TOP + 2 * ROW}px`);
    expect(lifted.style.left).toBe(`${ORIGIN + 9 * PPS}px`);
    // A lifted box says which clip it is
    expect(within(lifted).getByText("Clip 1")).toBeInTheDocument();
    // Below the last row, across the lanes
    expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${3 * ROW - 1.5}px`);
    expect(screen.getByTestId("stitch-insertion-bar")).toHaveClass("bg-neutral-100");
    release(10, 26 + 2 * ROW);
    expect(order()).toEqual(["clip:e1", "clip:e2", "clip:e0"]);
    // Lined up, it stays lined up: nothing is placed
    expect(starts()).toEqual([undefined, undefined, undefined]);
    expect(editor().past).toHaveLength(before + 1);
    expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
  });

  it("drags a clip by its row's grip, and a click on the grip selects it; in a placed stack the start stays", () => {
    seedClips([5, 5, 6]);
    openStacked();
    fireEvent.pointerDown(grip("clip:e1"), { button: 0, pointerId: 1, ...at(10, 78) });
    release(10, 78);
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
    expect(order()).toEqual(["clip:e0", "clip:e1", "clip:e2"]);
    fireEvent.pointerDown(grip("clip:e2"), { button: 0, pointerId: 1, ...at(10, 130) });
    move(10, 130 - 2 * ROW);
    expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe("-1.5px");
    release(10, 130 - 2 * ROW);
    expect(order()).toEqual(["clip:e2", "clip:e0", "clip:e1"]);

    act(() => editor().undo());
    act(() => setClipStart("clip:e2", 9));
    fireEvent.pointerDown(grip("clip:e2"), { button: 0, pointerId: 1, ...at(10, 130) });
    move(10, 130 - 2 * ROW);
    // Lifted at its own x: a placed stack keeps every start
    expect(clipBox("Clip 3").style.left).toBe(`${ORIGIN + 9 * PPS}px`);
    release(10, 130 - 2 * ROW);
    expect(order()).toEqual(["clip:e2", "clip:e0", "clip:e1"]);
    expect(starts()).toEqual([9, 0, 4]);
  });

  it("titles the menu's Split when the playhead is inside an overlap", () => {
    seed();
    openStacked();
    act(() => editor().setPlayhead(4.5));
    fireEvent.contextMenu(clipBox("Clip 2"), { clientX: 400, clientY: 60 });
    const split = screen.getByRole("menuitem", { name: /Split at playhead/ });
    expect(split).toBeDisabled();
    expect(split).toHaveAttribute("title", "Move the playhead out of the overlap to split");
  });

  it("gives a clip with no length a 160px slot in its own row", () => {
    seed({ bRan: false });
    openStacked();
    const slot = clipBox("Clip 2");
    expect(slot).toHaveAttribute("data-empty-reason", "empty");
    expect(slot).toHaveAttribute("aria-label", "Clip 2, starts 0:05.00");
    expect(slot.style.width).toBe("160px");
    expect(slot.style.top).toBe(`${ROW + BOX_TOP}px`);
    expect(slot.style.left).toBe(`${ORIGIN + 5 * PPS}px`);
    expect(within(slot).getByText("Clip 2 · not generated yet")).toBeInTheDocument();
    // The add slot comes after the empty slot, in its row
    expect(screen.getByTestId("stitch-add-slot").style.left).toBe(`${ORIGIN + 5 * PPS + 160 + 6}px`);
  });

  it("caps the rows at three and a half and scrolls them under the ruler, the grips following", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    const onRender = vi.fn();
    openStacked(onRender);
    // 1 + 28 + 182 + 52 + 28
    expect(timelineEl().style.height).toBe("291px");
    const lanes = screen.getByTestId("stitch-lanes");
    expect(lanes).toHaveClass("overflow-y-auto");
    const optionsBefore = within(lane()).getAllByRole("option");
    lanes.scrollTop = 40;
    // The profiler sees the modal's renders
    expect(onRender).toHaveBeenCalled();
    onRender.mockClear();
    fireEvent.scroll(lanes);
    // Written straight to the grips: nothing renders
    expect(onRender).not.toHaveBeenCalled();
    expect(screen.getByTestId("stitch-row-grips").style.transform).toBe("translateY(-40px)");
    // The boxes stay where they were: the scroll is the scroller's own
    const optionsAfter = within(lane()).getAllByRole("option");
    expect(optionsAfter.every((el, i) => el === optionsBefore[i] && el.style.top === `${i * ROW + BOX_TOP}px`)).toBe(true);
  });

  it("fades the rows into the ruler and the audio rows where more of them are out of view that way", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    const onRender = vi.fn();
    openStacked(onRender);
    const lanes = screen.getByTestId("stitch-lanes");
    const top = screen.getByTestId("stitch-rows-fade-top");
    const bottom = screen.getByTestId("stitch-rows-fade-bottom");
    expect(top).toHaveAttribute("aria-hidden", "true");
    // At the top the half row over the audio section fades into it: the rows go on below
    expect(top).not.toHaveAttribute("data-shown");
    expect(bottom).toHaveAttribute("data-shown");
    onRender.mockClear();
    lanes.scrollTop = 40;
    fireEvent.scroll(lanes);
    expect(top).toHaveAttribute("data-shown");
    expect(bottom).toHaveAttribute("data-shown");
    // Six rows in the 182px view scroll 130px: at the end only the top fades
    lanes.scrollTop = 6 * ROW - 182;
    fireEvent.scroll(lanes);
    expect(top).toHaveAttribute("data-shown");
    expect(bottom).not.toHaveAttribute("data-shown");
    // Written straight to the fades, as to the grips: nothing renders
    expect(onRender).not.toHaveBeenCalled();
  });

  it("draws no fade while the rows fit", () => {
    seedClips([5, 5, 6]);
    openStacked();
    expect(screen.getByTestId("stitch-rows-fade-top")).not.toHaveAttribute("data-shown");
    expect(screen.getByTestId("stitch-rows-fade-bottom")).not.toHaveAttribute("data-shown");
  });

  it("scrolls the rows with a plain wheel when they overflow, and along the timeline with ⇧", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.wheel(lanes, { deltaY: 50 });
    expect(lanes.scrollTop).toBe(50);
    expect(lanes.scrollLeft).toBe(0);
    fireEvent.wheel(lanes, { deltaY: 30, shiftKey: true });
    expect(lanes.scrollLeft).toBe(30);
    expect(lanes.scrollTop).toBe(50);
  });

  it("keeps the wheel sideways when the rows fit", () => {
    seed();
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.wheel(lanes, { deltaY: 50 });
    expect(lanes.scrollLeft).toBe(50);
    expect(lanes.scrollTop).toBe(0);
  });

  it("scrolls the rows with a wheel over their grips too", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    fireEvent.wheel(grip("clip:e1"), { deltaY: 50 });
    expect(lanes.scrollTop).toBe(50);
    // The browser's scroll event (jsdom sends none) moves the grips with them
    fireEvent.scroll(lanes);
    expect(screen.getByTestId("stitch-row-grips").style.transform).toBe("translateY(-50px)");
  });

  it("shows a row's grip while the pointer is over the row, anywhere across the lanes", () => {
    seedClips([5, 5, 6]);
    openStacked();
    // The grips' layer starts under the ruler; jsdom lays nothing out, so it is given its place
    const layer = screen.getByTestId("stitch-row-grips").parentElement!;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(rect(0, 28, 20, 156));
    const timeline = screen.getByTestId("stitch-timeline");
    fireEvent.pointerMove(timeline, { clientX: 600, clientY: 28 + ROW + 10 });
    expect(grip("clip:e1")).toHaveClass("opacity-100", "pointer-events-auto");
    expect(grip("clip:e0")).toHaveClass("opacity-0");
    fireEvent.pointerMove(timeline, { clientX: 600, clientY: 10 });
    expect(grip("clip:e1")).toHaveClass("opacity-0");
    fireEvent.pointerMove(timeline, { clientX: 600, clientY: 28 + 10 });
    expect(grip("clip:e0")).toHaveClass("opacity-100");
    // A held button (a drag) shows none
    fireEvent.pointerMove(timeline, { clientX: 600, clientY: 28 + 10, buttons: 1 });
    expect(grip("clip:e0")).toHaveClass("opacity-0");
    fireEvent.pointerLeave(timeline);
    expect(grip("clip:e0")).toHaveClass("opacity-0");
  });

  it("keeps a row's grip through a press on it, so a right press that drifts still opens its menu; a drag hides the grips", () => {
    seedClips([5, 5, 6]);
    openStacked();
    const layer = screen.getByTestId("stitch-row-grips").parentElement!;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(rect(0, 28, 20, 156));
    const timeline = screen.getByTestId("stitch-timeline");
    vi.spyOn(timeline, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1000, 291));
    const y = 28 + ROW + 20;
    fireEvent.pointerMove(timeline, { clientX: 10, clientY: y });
    expect(grip("clip:e1")).toHaveClass("opacity-100", "pointer-events-auto");
    // A right press, the pointer drifting a pixel with the button held: the grip stays under it through the release
    fireEvent.pointerDown(grip("clip:e1"), { button: 2, buttons: 2, clientX: 10, clientY: y, pointerId: 1 });
    fireEvent.pointerMove(timeline, { clientX: 11, clientY: y + 1, buttons: 2 });
    expect(grip("clip:e1")).toHaveClass("opacity-100", "pointer-events-auto");
    pointer("pointerup", 11, { clientY: y + 1 });
    expect(grip("clip:e1")).toHaveClass("opacity-100", "pointer-events-auto");
    fireEvent.contextMenu(grip("clip:e1"), { clientX: 11, clientY: y + 1 });
    expect(editor().menu).toMatchObject({ kind: "clip", clipId: "clip:e1" });
    press("Escape");
    expect(editor().menu).toBeNull();
    // A left press that becomes a drag: the grip stays until the drag starts, then the grips give way to the clip
    fireEvent.pointerDown(grip("clip:e1"), { button: 0, buttons: 1, clientX: 10, clientY: y, pointerId: 1 });
    move(10, y + 1, { buttons: 1 });
    expect(grip("clip:e1")).toHaveClass("opacity-100");
    move(10, y + ROW, { buttons: 1 });
    expect(grip("clip:e1")).toHaveClass("opacity-0");
    press("Escape");
    release(10, y + ROW);
    expect(order()).toEqual(["clip:e0", "clip:e1", "clip:e2"]);
  });

  it("opens the clip menu from a right press on a row's grip", () => {
    seedClips([5, 5, 6]);
    openStacked();
    const notCancelled = fireEvent.contextMenu(grip("clip:e1"), { clientX: 10, clientY: 78 });
    expect(notCancelled).toBe(false);
    expect(editor().menu).toEqual({ kind: "clip", clipId: "clip:e1", x: 10, y: 78 });
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e1" });
  });

  it("moves an In trim's box with its edge, the cut frames left where they were", () => {
    seedClips([5, 5, 6]);
    openStacked();
    // Clip 2 (4–9 s) loses its first second: its frames stay where they are, so it starts at 5 s, 4 s long
    const edgeX = ORIGIN + 4 * PPS;
    fireEvent.pointerDown(handleOf("Clip 2", "in"), { button: 0, pointerId: 1, ...at(edgeX, 78) });
    move(edgeX + PPS, 78);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 5 * PPS}px`);
    expect(clipBox("Clip 2").style.width).toBe(`${4 * PPS}px`);
    const ghost = screen.getByTestId("stitch-trim-ghost");
    expect(ghost.style.left).toBe(`${ORIGIN + 4 * PPS}px`);
    expect(ghost.style.width).toBe(`${PPS}px`);
    expect(ghost).toHaveClass("rounded-l-md");
    release(edgeX + PPS, 78);
    expect(editor().draft!.timeline[1].inSec).toBeCloseTo(1, 6);
    expect(starts()).toEqual([0, 5, 8]);
    expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 5 * PPS}px`);
  });

  it("draws a trim as release leaves it, and nothing else moves", () => {
    seedClips([5, 5, 6]);
    openStacked();
    act(() => editor().setPlayhead(0));
    // Clip 1 down to 1.5 s: Clip 2 and Clip 3 keep their starts (no half-clip cap pulls Clip 2 in)
    const edgeX = ORIGIN + 5 * PPS;
    fireEvent.pointerDown(handleOf("Clip 1", "out"), { button: 0, pointerId: 1, ...at(edgeX, 26) });
    move(edgeX - 3.5 * PPS, 26);
    const live = { width: clipBox("Clip 1").style.width, next: clipBox("Clip 2").style.left, last: clipBox("Clip 3").style.left };
    expect(live.width).toBe(`${1.5 * PPS}px`);
    expect(live.next).toBe(`${ORIGIN + 4 * PPS}px`);
    expect(live.last).toBe(`${ORIGIN + 8 * PPS}px`);
    expect(screen.getByTestId("stitch-trim-ghost").style.left).toBe(`${ORIGIN + 1.5 * PPS}px`);
    release(edgeX - 3.5 * PPS, 26);
    expect(editor().draft!.timeline[0].outSec).toBeCloseTo(1.5, 6);
    expect(starts()).toEqual([0, 4, 8]);
    expect(clipBox("Clip 1").style.width).toBe(live.width);
    expect(clipBox("Clip 2").style.left).toBe(live.next);
    expect(clipBox("Clip 3").style.left).toBe(live.last);
  });

  it("starts Clip 1 at 1.0 s after a +1 s In trim, its cut head at the lane's origin", () => {
    seedClips([5, 5, 6]);
    openStacked();
    fireEvent.pointerDown(handleOf("Clip 1", "in"), { button: 0, pointerId: 1, ...at(ORIGIN, 26) });
    move(ORIGIN + PPS, 26);
    expect(clipBox("Clip 1").style.left).toBe(`${ORIGIN + PPS}px`);
    const ghost = screen.getByTestId("stitch-trim-ghost");
    expect(ghost.style.left).toBe(`${ORIGIN}px`);
    expect(ghost.style.width).toBe(`${PPS}px`);
    release(ORIGIN + PPS, 26);
    expect(editor().draft!.timeline[0].inSec).toBeCloseTo(1, 6);
    expect(editor().draft!.timeline[0].startSec).toBeCloseTo(1, 6);
  });

  it("keeps the row of the clip that drives the preview in view while playing", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    // Starts 0, 4, 8, 13, 17, 21: at 25 s only clip 6 plays. Its row (260–312) under a 182px viewport
    act(() => editor().setPlayhead(25));
    expect(lanes.scrollTop).toBe(0);
    act(() => editor().setPlaying(true));
    expect(lanes.scrollTop).toBe(5 * ROW + ROW - 182);
    act(() => editor().setPlaying(false));
  });

  it("scrolls the selected clip into view when an undo moves it to another row", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    act(() => editor().select({ kind: "clip", clipId: "clip:e5" }));
    act(() => moveClipTo("clip:e5", 0));
    lanes.scrollTop = 0;
    act(() => editor().undo());
    expect(order()[5]).toBe("clip:e5");
    expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:e5" });
    // Row 6 (260–312) under the 182px viewport
    expect(lanes.scrollTop).toBe(6 * ROW - 182);
  });

  it("fits an empty clip's slot that reaches past the sequence's end", () => {
    vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
    seedClips([5, 5, 2]);
    useWorkflowStore.setState({
      nodes: wf().nodes.map((n) => (n.id === "gen-1" ? { ...n, data: {} } : n)),
    });
    openStacked();
    act(() => editor().setZoom(null));
    const slot = clipBox("Clip 2");
    expect(slot).toHaveAttribute("data-empty-reason", "empty");
    // Clips 5 s, empty, 2 s: the slot sits at 5 s, and its 160px would end past the sequence's 6 s at the plain fit
    expect(parseFloat(slot.style.left) + parseFloat(slot.style.width)).toBeLessThanOrEqual(800);
    // No sideways scroll in Fit: the lane content is the lane's own width
    const content = screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement;
    expect(content.style.width).toBe("800px");
  });

  it("scrolls a clip selected by a key into view", () => {
    seedClips([5, 5, 6, 5, 5, 6]);
    openStacked();
    const lanes = screen.getByTestId("stitch-lanes");
    click(clipBox("Clip 1"));
    fireEvent.keyDown(clipBox("Clip 1"), { key: "End" });
    expect(lanes.scrollTop).toBe(6 * ROW - 182);
    fireEvent.keyDown(clipBox("Clip 6"), { key: "Home" });
    expect(lanes.scrollTop).toBe(0);
  });

  describe("moving a clip by its box", () => {
    it("places a box at its own start", () => {
      seedPlaced([5, 4], [0, 7.2]);
      openEditor();
      expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 7.2 * PPS}px`);
      expect(clipBox("Clip 2")).toHaveAttribute("aria-label", "Clip 2, starts 0:07.20");
    });

    it("moves a clip sideways in one undo step, drawn during the drag where release leaves it", () => {
      seed();
      openStacked();
      const before = editor().past.length;
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(496, 78);
      // 1.5 s later: 4.0 → 5.5 s, in its own row
      const drawn = clipBox("Clip 2");
      expect(drawn.style.left).toBe(`${ORIGIN + 5.5 * PPS}px`);
      expect(drawn.style.top).toBe(`${ROW + BOX_TOP}px`);
      expect(drawn).toHaveClass("ring-neutral-100", "cursor-grabbing");
      // The others are snap targets: not dimmed
      expect(clipBox("Clip 1")).not.toHaveClass("opacity-40");
      expect(screen.getByTestId("stitch-move-chip")).toHaveTextContent("0:05.50–0:09.50 · +1.50 s");
      // The move chip sits 10px into the moving box, right of it
      expect(screen.getByTestId("stitch-move-chip").style.top).toBe(`${28 + ROW + BOX_TOP + 10}px`);
      expect(screen.getByTestId("stitch-move-chip").style.left).toBe(`${ORIGIN + 5.5 * PPS + 4 * PPS + 12}px`);
      expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
      expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
      release(496, 78);
      expect(starts()).toEqual([0, 5.5]);
      expect(order()).toEqual(["clip:eA", "clip:eB"]);
      expect(editor().past).toHaveLength(before + 1);
      expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:eB" });
      expect(clipBox("Clip 2").style.left).toBe(drawn.style.left);
      expect(screen.queryByTestId("stitch-move-chip")).toBeNull();
      act(() => editor().undo());
      expect(starts()).toEqual([undefined, undefined]);
    });

    it("keeps the moving box's length chip and muted mark, without its buttons and handles", () => {
      seedPlaced([5, 4], [0, 4], { clips: { 1: { muted: true } } });
      openEditor();
      expect(clipBox("Clip 2")).toHaveTextContent("4.0 s");
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(496, 78);
      const moving = clipBox("Clip 2");
      expect(moving).toHaveClass("cursor-grabbing");
      expect(moving).toHaveTextContent("4.0 s");
      expect(moving.querySelector("[data-muted-mark]")).not.toBeNull();
      expect(moving.querySelector("button")).toBeNull();
      expect(moving.querySelector("[data-trim-handle]")).toBeNull();
      release(496, 78);
    });

    it("keeps the Fit zoom when a drag lengthens the sequence, so the box lands where it was drawn", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
      seed();
      openStacked();
      act(() => editor().setZoom(null));
      const fitBefore = parseFloat(clipBox("Clip 2").style.width) / 4;
      const pressX = parseFloat(clipBox("Clip 2").style.left) + 20;
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(pressX, 78) });
      move(pressX + 150, 78);
      const drawn = clipBox("Clip 2").style.left;
      release(pressX + 150, 78);
      expect(editor().pxPerSec).toBeCloseTo(fitBefore, 9);
      expect(clipBox("Clip 2").style.left).toBe(drawn);
    });

    it("selects on a click and keeps playing; a lift pauses", () => {
      seed();
      openStacked();
      act(() => editor().setPlaying(true));
      click(clipBox("Clip 2"), 400);
      expect(editor().selection).toEqual({ kind: "clip", clipId: "clip:eB" });
      expect(editor().playing).toBe(true);
      expect(editor().past).toHaveLength(1);
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(403, 78);
      expect(editor().playing).toBe(true);
      move(410, 78);
      expect(editor().playing).toBe(false);
      press("Escape");
      release(410, 78);
    });

    it("takes the playhead as a target where the lift stopped it", () => {
      seed();
      openStacked();
      act(() => editor().setPlayhead(1));
      act(() => editor().setPlaying(true));
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      // The preview plays on while the button is down
      act(() => editor().setPlayhead(2.5));
      // 4.0 − 1.47 s = 2.53 s: 2px from the paused playhead
      move(400 - 1.47 * PPS, 78);
      expect(editor().playing).toBe(false);
      expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to the playhead");
      release(400 - 1.47 * PPS, 78);
      expect(starts()).toEqual([0, 2.5]);
    });

    it("snaps to another clip's end with the chip and the guide; ⇧ lets it go, also while the pointer rests", () => {
      seedClips([5, 5, 6]);
      openStacked();
      // Clip 3 (8 s) to 5.05 s: 3.2px from Clip 1's end
      const pressX = 600;
      const to = pressX - (8 - 5.05) * PPS;
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, pointerId: 1, ...at(pressX, 130) });
      move(to, 130);
      expect(clipBox("Clip 3").style.left).toBe(`${ORIGIN + 5 * PPS}px`);
      const chip = screen.getByTestId("stitch-snap-chip");
      expect(chip).toHaveTextContent("Snapped to Clip 1's end");
      // The guide at the snapped time, down to the lower of the two boxes; the chip 9px right, 12px under the box
      const guide = chip.previousElementSibling as HTMLElement;
      expect(guide.style.left).toBe(`${ORIGIN + 5 * PPS}px`);
      // From the foot of the playhead's 12px head, as its line would run
      expect(guide.style.top).toBe("12px");
      expect(guide.style.height).toBe(`${28 + 2 * ROW + BOX_TOP + 40 - 12 + 1}px`);
      expect(chip.style.left).toBe(`${ORIGIN + 5 * PPS + 9}px`);
      expect(chip.style.top).toBe(`${28 + 2 * ROW + BOX_TOP + 40 + 12}px`);
      shift("keydown");
      expect(clipBox("Clip 3").style.left).toBe(`${ORIGIN + 5.05 * PPS}px`);
      expect(screen.queryByTestId("stitch-snap-chip")).toBeNull();
      shift("keyup");
      expect(clipBox("Clip 3").style.left).toBe(`${ORIGIN + 5 * PPS}px`);
      move(to, 130, { shiftKey: true });
      expect(clipBox("Clip 3").style.left).toBe(`${ORIGIN + 5.05 * PPS}px`);
      release(to, 130);
      expect(editor().draft!.timeline[2].startSec).toBeCloseTo(5.05, 9);
    });

    it("snaps its end edge, and to an overlap with a clip", () => {
      seedClips([5, 5, 6]);
      openStacked();
      // Clip 3 (6 s) to 3.02 s: its end at 9.02, 1.3px from Clip 2's end
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, pointerId: 1, ...at(600, 130) });
      move(600 - (8 - 3.02) * PPS, 130);
      expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("End snapped to Clip 2's end");
      expect(clipBox("Clip 3").style.left).toBe(`${ORIGIN + 3 * PPS}px`);
      press("Escape");
      release(600, 130);
      // Clip 1 to 13.03 s: 1.9px from where a 1.0 s overlap with Clip 3 starts
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100 + 13.03 * PPS, 26);
      expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to a 1.0 s overlap with Clip 3");
      release(100 + 13.03 * PPS, 26);
      expect(starts()).toEqual([13, 4, 8]);
    });

    it("cancels on Escape with no step, the lanes back where the press found them", () => {
      seed();
      openStacked();
      const before = editor().past.length;
      const lanes = screen.getByTestId("stitch-lanes");
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(500, 78);
      // An auto-scroll took the lanes along
      act(() => {
        lanes.scrollLeft = 120;
      });
      press("Escape");
      expect(lanes.scrollLeft).toBe(0);
      expect(screen.queryByTestId("stitch-move-chip")).toBeNull();
      expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 4 * PPS}px`);
      release(500, 78);
      expect(editor().past).toHaveLength(before);
      expect(starts()).toEqual([undefined, undefined]);
    });

    it("applies nothing when the draft changed under the drag", () => {
      seedClips([5, 5, 6]);
      openStacked();
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(500, 78);
      act(() => moveClipTo("clip:e2", 0));
      const after = editor().past.length;
      release(500, 78);
      expect(editor().past).toHaveLength(after);
      expect(starts()).toEqual([undefined, undefined, undefined]);
    });

    it("moves a clip down two rows and 1 s later in one undo step, the line across the rows", () => {
      seedClips([5, 5, 6]);
      openStacked();
      const before = editor().past.length;
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100 + PPS, 26 + 2 * ROW);
      // It floats with the pointer; the line says where it lands
      expect(clipBox("Clip 1").style.top).toBe(`${BOX_TOP + 2 * ROW}px`);
      expect(clipBox("Clip 1").style.left).toBe(`${ORIGIN + PPS}px`);
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${3 * ROW - 1.5}px`);
      expect(screen.getByTestId("stitch-move-chip").style.top).toBe(`${28 + BOX_TOP + 2 * ROW + 10}px`);
      release(100 + PPS, 26 + 2 * ROW);
      expect(order()).toEqual(["clip:e1", "clip:e2", "clip:e0"]);
      expect(starts()).toEqual([4, 8, 1]);
      expect(editor().past).toHaveLength(before + 1);
      expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
      act(() => editor().undo());
      expect(order()).toEqual(["clip:e0", "clip:e1", "clip:e2"]);
      expect(starts()).toEqual([undefined, undefined, undefined]);
    });

    it("stops a box dragged past the rows where it rests on the first or last row", () => {
      seedClips([5, 5, 6]);
      openStacked();
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100, 26 + 400);
      expect(clipBox("Clip 1").style.top).toBe(`${2 * ROW + BOX_TOP}px`);
      expect(screen.getByTestId("stitch-move-chip").style.top).toBe(`${28 + 2 * ROW + BOX_TOP + 10}px`);
      move(100, 26 - 400);
      expect(clipBox("Clip 1").style.top).toBe(`${BOX_TOP}px`);
      move(100, 26 + 400);
      release(100, 26 + 400);
      expect(order()).toEqual(["clip:e1", "clip:e2", "clip:e0"]);
    });

    it("changes the row past half a row and 4px, and keeps it coming back", () => {
      seedClips([5, 5, 6]);
      openStacked();
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100, 26 + 29);
      expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
      move(100, 26 + 30);
      expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
      move(100, 26 + 31);
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${2 * ROW - 1.5}px`);
      move(100, 26 + 22);
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${2 * ROW - 1.5}px`);
      release(100, 26 + 22);
      expect(order()).toEqual(["clip:e1", "clip:e0", "clip:e2"]);
    });

    it("keeps its time on a drag straight up, by where it was, and re-sequences nothing in a lined-up stack", () => {
      seedClips([5, 5, 6]);
      openStacked();
      // Clip 3 up one row, 3px sideways
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, pointerId: 1, ...at(600, 130) });
      move(603, 130 - 40);
      expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to where it was");
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${ROW - 1.5}px`);
      release(603, 130 - 40);
      expect(order()).toEqual(["clip:e0", "clip:e2", "clip:e1"]);
      // Pinned where each was: the grip would have re-sequenced them
      expect(starts()).toEqual([0, 8, 4]);
    });

    it("puts the row and the rows' scroll back on Escape", () => {
      seedClips([5, 5, 6, 5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100, 26 + 2 * ROW);
      act(() => {
        lanes.scrollTop = 40;
      });
      press("Escape");
      expect(lanes.scrollTop).toBe(0);
      release(100, 26 + 2 * ROW);
      expect(order()).toEqual(["clip:e0", "clip:e1", "clip:e2", "clip:e3", "clip:e4", "clip:e5"]);
      expect(editor().past).toHaveLength(1);
    });

    it("scrolls the rows while the pointer is near their bottom edge", () => {
      const next = frames();
      seedClips([5, 5, 6, 5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      // The visible rows end at 28 + 182 = 210: 6px from there
      move(100, 204);
      next();
      expect(lanes.scrollTop).toBe(6);
      next();
      expect(lanes.scrollTop).toBe(12);
      press("Escape");
      expect(lanes.scrollTop).toBe(0);
      release(100, 204);
    });

    it("lands in the row the auto-scroll carried it to", () => {
      const next = frames();
      seedClips([5, 5, 6, 5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      const content = lanes.firstElementChild as HTMLElement;
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      // 178px down: row 3
      move(100, 204);
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${4 * ROW - 1.5}px`);
      next();
      next();
      expect(lanes.scrollTop).toBe(12);
      // The rows scrolled 12px under the still pointer: 190px of travel, past half a row and 4px into row 4
      vi.spyOn(content, "getBoundingClientRect").mockReturnValue(rect(0, -12, 0, 0));
      fireEvent.scroll(lanes);
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${5 * ROW - 1.5}px`);
      release(100, 204);
      expect(order()[4]).toBe("clip:e0");
      expect(editor().past).toHaveLength(2);
    });

    it("keeps the row on a sideways drag of a box pressed by the rows' bottom edge, and scrolls once it heads there", () => {
      const next = frames();
      seedClips([5, 5, 6, 5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      // Clip 4 (row 3, 13 s) shows down to the rows' bottom at 210: pressed 6px above it, then dragged sideways only
      fireEvent.pointerDown(clipBox("Clip 4"), { button: 0, pointerId: 1, ...at(900, 204) });
      move(940, 204);
      next();
      next();
      expect(lanes.scrollTop).toBe(0);
      expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
      release(940, 204);
      expect(order()).toEqual(["clip:e0", "clip:e1", "clip:e2", "clip:e3", "clip:e4", "clip:e5"]);
      expect(starts()[3]).toBeCloseTo(13 + 40 / PPS, 9);
      // Selected, its row is shown whole, as a click shows it
      expect(lanes.scrollTop).toBe(4 * ROW - 182);
      // Heading down toward the edge, the rows scroll
      fireEvent.pointerDown(clipBox("Clip 4"), { button: 0, pointerId: 1, ...at(940, 204) });
      move(940, 210);
      next();
      expect(lanes.scrollTop).toBe(4 * ROW - 182 + 6);
      press("Escape");
      release(940, 210);
    });

    it("keeps the time on a drag straight up of a box pressed by the lanes' right side", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
      const next = frames();
      seedClips([5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      vi.spyOn(lanes, "getBoundingClientRect").mockReturnValue(rect(0, 0, 600, 200));
      // Clip 3 (8 s) pressed 10px inside the lanes' right side, then moved up a row with no sideways travel
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, pointerId: 1, ...at(590, 130) });
      move(590, 130 - 40);
      next();
      next();
      expect(lanes.scrollLeft).toBe(0);
      expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to where it was");
      release(590, 130 - 40);
      expect(order()).toEqual(["clip:e0", "clip:e2", "clip:e1"]);
      expect(starts()).toEqual([0, 8, 4]);
    });

    it("re-places the box on a scroll of the rows during the drag, and lands in the row it was drawn over", () => {
      seedClips([5, 5, 6, 5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      const content = lanes.firstElementChild as HTMLElement;
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100, 26 + 31);
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${2 * ROW - 1.5}px`);
      // A wheel scrolls the rows a row's height under the still pointer
      act(() => {
        lanes.scrollTop = ROW;
      });
      vi.spyOn(content, "getBoundingClientRect").mockReturnValue(rect(0, -ROW, 0, 0));
      fireEvent.scroll(lanes);
      expect(screen.getByTestId("stitch-insertion-bar").style.top).toBe(`${3 * ROW - 1.5}px`);
      expect(clipBox("Clip 1").style.top).toBe(`${BOX_TOP + 31 + ROW}px`);
      release(100, 26 + 31);
      expect(order()[2]).toBe("clip:e0");
      expect(editor().past).toHaveLength(2);
    });

    it("drops a press whose draft a key changed before the lift, drawing nothing", () => {
      seedClips([5, 5, 6]);
      openStacked();
      act(() => editor().select({ kind: "clip", clipId: "clip:e1" }));
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      // [ while the button is down
      act(() => setClipStart("clip:e1", 2));
      const after = editor().past.length;
      move(400 + PPS, 78);
      expect(screen.queryByTestId("stitch-move-chip")).toBeNull();
      expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 2 * PPS}px`);
      release(400 + PPS, 78);
      expect(starts()[1]).toBe(2);
      expect(editor().past).toHaveLength(after);
      // ⌫ removes the pressed clip: the moves that follow do nothing, and throw nothing
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      act(() => removeSelection());
      expect(() => {
        move(400 + PPS, 78);
        move(400 + 2 * PPS, 78);
      }).not.toThrow();
      release(400 + 2 * PPS, 78);
      expect(order()).toEqual(["clip:e0", "clip:e2"]);
    });

    it("scrolls the lanes while the pointer is near their right edge, widening them past the end", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
      const next = frames();
      seed();
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      const content = lanes.firstElementChild as HTMLElement;
      vi.spyOn(lanes, "getBoundingClientRect").mockReturnValue(rect(0, 0, 600, 200));
      // At rest: B ends at 8 s (x 532), then the add slot's 70px (its gap, itself and the end margin)
      expect(content.style.width).toBe("602px");
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(590, 30);
      next();
      expect(lanes.scrollLeft).toBe(6);
      // The box at 20 + 490 = 510 and 5 s long ends at 830: the lanes reach past it by the add slot's room
      expect(content.style.width).toBe(`${ORIGIN + 490 + 5 * PPS + 70}px`);
      press("Escape");
      release(590, 30);
    });

    it("re-places the box on a plain wheel during the drag, and release applies what was drawn last", () => {
      seed();
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      const content = lanes.firstElementChild as HTMLElement;
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(450, 78);
      expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 4 * PPS + 50}px`);
      // The rows fit: the wheel scrolls the lanes 50px under the still pointer
      fireEvent.wheel(lanes, { deltaY: 50 });
      expect(lanes.scrollLeft).toBe(50);
      vi.spyOn(content, "getBoundingClientRect").mockReturnValue(rect(-50, 0, 0, 0));
      fireEvent.scroll(lanes);
      expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 4 * PPS + 100}px`);
      release(450, 78);
      expect(editor().draft!.timeline[1].startSec).toBeCloseTo(4 + 100 / PPS, 9);
    });

    it("zooms with no ⌘ wheel from the press to the release, and a ctrl-click still opens the clip menu", () => {
      seed();
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      fireEvent.wheel(lanes, { ctrlKey: true, deltaY: -100, clientX: 400 });
      expect(editor().pxPerSec).toBe(PPS);
      move(450, 78);
      fireEvent.wheel(lanes, { metaKey: true, deltaY: -100, clientX: 400 });
      expect(editor().pxPerSec).toBe(PPS);
      release(450, 78);
      fireEvent.wheel(lanes, { ctrlKey: true, deltaY: -100, clientX: 400 });
      expect(editor().pxPerSec).toBeGreaterThan(PPS);
      // A Mac's ctrl-click: a left press with ctrl, then the context menu, then the release
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, ctrlKey: true, pointerId: 1, ...at(100, 26) });
      fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 26, ctrlKey: true });
      expect(editor().menu).toEqual({ kind: "clip", clipId: "clip:eA", x: 100, y: 26 });
      release(100, 26);
    });

    it("reveals the row it lands in when that row shows only in part, and leaves the rows alone otherwise", () => {
      seedClips([5, 5, 6, 5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100, 26 + ROW);
      release(100, 26 + ROW);
      expect(order()[1]).toBe("clip:e0");
      expect(lanes.scrollTop).toBe(0);
      // Row 4 (156–208) shows 26px of 52 in the 182px viewport
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      move(100, 26 + 3 * ROW);
      release(100, 26 + 3 * ROW);
      expect(order()[3]).toBe("clip:e1");
      expect(lanes.scrollTop).toBe(4 * ROW - 182);
    });

    it("keeps the Fit zoom when an empty clip's slot moves, so it lands where it was drawn", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(800);
      seedClips([5, 5, 2]);
      useWorkflowStore.setState({
        nodes: wf().nodes.map((n) => (n.id === "gen-1" ? { ...n, data: {} } : n)),
      });
      openStacked();
      act(() => editor().setZoom(null));
      expect(clipBox("Clip 2")).toHaveAttribute("data-empty-reason", "empty");
      const width1 = clipBox("Clip 1").style.width;
      const pressX = parseFloat(clipBox("Clip 2").style.left) + 20;
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(pressX, 78) });
      move(pressX + 200, 78);
      const drawn = clipBox("Clip 2").style.left;
      release(pressX + 200, 78);
      // Fit's px/s depends on the slot's start too: it is kept, and nothing rescales
      expect(editor().pxPerSec).not.toBeNull();
      expect(clipBox("Clip 2").style.left).toBe(drawn);
      expect(clipBox("Clip 1").style.width).toBe(width1);
      act(() => editor().setZoom(null));
      const fit = clipBox("Clip 1").style.width;
      act(() => setClipStart("clip:e1", 8));
      expect(clipBox("Clip 1").style.width).toBe(fit);
    });

    it("moves an empty clip's slot by its body", () => {
      seed({ bRan: false });
      openStacked();
      const before = editor().past.length;
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(400 + PPS, 78);
      expect(clipBox("Clip 2")).toHaveClass("ring-neutral-100", "cursor-grabbing");
      expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 6 * PPS}px`);
      expect(screen.getByTestId("stitch-move-chip")).toHaveTextContent("0:06.00 · +1.00 s");
      release(400 + PPS, 78);
      expect(starts()).toEqual([0, 6]);
      expect(editor().past).toHaveLength(before + 1);
    });

    it("draws a first drag in a lined-up stack with the layering release gives", () => {
      seedClips([5, 4.2, 6, 3.2]);
      openStacked();
      // Lined up: 0, 4.0, 7.2 and 12.2 s; Clip 3 and Clip 4 dissolve over [12.2, 13.2)
      expect(marksOf("Clip 3")).toContainEqual({ kind: "stitch-crossfade-out", left: 0, width: PPS, title: null });
      fireEvent.pointerDown(clipBox("Clip 4"), { button: 0, pointerId: 1, ...at(850, 182) });
      // Clip 4 2 s earlier, under Clip 3: hidden over [10.2, 13.0), then fading in as Clip 3 fades out over its last 0.2 s
      const expected4 = [
        { kind: "stitch-hidden", left: 0, width: 2.8 * PPS, title: "Hidden under Clip 3." },
        { kind: "stitch-crossfade-in", left: 2.8 * PPS, width: 0.2 * PPS, title: null },
      ];
      const expected3 = [
        { kind: "stitch-crossfade-in", left: 0, width: PPS, title: null },
        { kind: "stitch-crossfade-out", left: 5.8 * PPS, width: 0.2 * PPS, title: null },
      ];
      const close = (marks: ReturnType<typeof marksOf>) => marks.map((m) => ({ ...m, left: +m.left.toFixed(6), width: +m.width.toFixed(6) }));
      const want = (marks: typeof expected4) => marks.map((m) => ({ ...m, left: +m.left.toFixed(6), width: +m.width.toFixed(6) }));
      for (const x of [850 - 2 * PPS - 30, 850 - 2 * PPS + 30, 850 - 2 * PPS]) {
        move(x, 182);
        if (x !== 850 - 2 * PPS) continue;
        expect(close(marksOf("Clip 4"))).toEqual(want(expected4));
        expect(close(marksOf("Clip 3"))).toEqual(want(expected3));
      }
      release(850 - 2 * PPS, 182);
      [0, 4, 7.2, 10.2].forEach((start, i) => expect(starts()[i]).toBeCloseTo(start, 9));
      expect(close(marksOf("Clip 4"))).toEqual(want(expected4));
      expect(close(marksOf("Clip 3"))).toEqual(want(expected3));
    });

    it("draws a row change's layering before release, the covering clip named by its row at the press", () => {
      // Clip 4 wholly under Clip 3, which is the higher row
      seedPlaced([5, 4.2, 6, 3.2], [0, 6, 9.2, 11]);
      openEditor();
      const round = (marks: ReturnType<typeof marksOf>) =>
        marks.map((m) => ({ ...m, left: +m.left.toFixed(4), width: +m.width.toFixed(4) }));
      expect(round(marksOf("Clip 4"))).toEqual([{ kind: "stitch-hidden", left: 0, width: 204.8, title: "Hidden under Clip 3." }]);
      fireEvent.pointerDown(clipBox("Clip 4"), { button: 0, pointerId: 1, ...at(800, 182) });
      move(803, 182 - 40);
      expect(screen.getByTestId("stitch-snap-chip")).toHaveTextContent("Snapped to where it was");
      const during = { three: round(marksOf("Clip 3")), four: round(marksOf("Clip 4")) };
      // Clip 4 in front of Clip 3 and inside it: in over [11.0, 12.8), out over [13.2, 14.2)
      expect(during.four).toEqual([
        { kind: "stitch-crossfade-in", left: 0, width: 115.2, title: null },
        { kind: "stitch-crossfade-out", left: 140.8, width: 64, title: null },
      ]);
      // Clip 3: in under Clip 2, out under Clip 4, hidden over [12.8, 13.2) under Clip 4 (its name at the press), back in
      expect(during.three).toEqual([
        { kind: "stitch-crossfade-in", left: 0, width: 64, title: null },
        { kind: "stitch-crossfade-out", left: 115.2, width: 115.2, title: null },
        { kind: "stitch-hidden", left: 230.4, width: 25.6, title: "Hidden under Clip 4." },
        { kind: "stitch-crossfade-in", left: 256, width: 64, title: null },
      ]);
      release(803, 182 - 40);
      expect(order()).toEqual(["clip:e0", "clip:e1", "clip:e3", "clip:e2"]);
      expect(starts()).toEqual([0, 6, 11, 9.2]);
      // After release the rows are named again: the same marks, Clip 4 is now Clip 3
      expect(round(marksOf("Clip 3"))).toEqual(during.four);
      expect(round(marksOf("Clip 4"))).toEqual(
        during.three.map((m) => (m.title ? { ...m, title: "Hidden under Clip 3." } : m)),
      );
    });
  });

  describe("a placed stack's marks and gaps", () => {
    it("draws a gap as a black band with its length, and a strip on the ruler", () => {
      seedPlaced([5, 5], [0, 6]);
      openEditor();
      const band = screen.getByTestId("stitch-gap");
      expect(band).toHaveClass("bg-black", "border-dashed", "pointer-events-none");
      expect(band.style.left).toBe(`${ORIGIN + 5 * PPS}px`);
      expect(band.style.width).toBe(`${PPS}px`);
      expect(band).toHaveTextContent("Gap 1.0 s");
      const strip = screen.getByTestId("stitch-ruler-gap");
      expect(strip.style.left).toBe(band.style.left);
      expect(strip.style.width).toBe(band.style.width);
      // Line up is on once a clip has been placed
      expect(within(foot()).getByRole("button", { name: "Line up" })).toBeEnabled();
    });

    it("leaves a gap its label would spill out of unlabelled", () => {
      seedPlaced([5, 5], [0, 5.5]);
      openEditor();
      expect(screen.getByTestId("stitch-gap").style.width).toBe(`${0.5 * PPS}px`);
      expect(screen.getByTestId("stitch-gap")).toHaveTextContent("");
      // 1.0 s at 60 px/s: 60px, under the label's 63px and the borders
      act(() => editor().setZoom(60));
      act(() => setClipStart("clip:e1", 6));
      expect(screen.getByTestId("stitch-gap").style.width).toBe("60px");
      expect(screen.getByTestId("stitch-gap")).toHaveTextContent("");
      // A longer label asks for a wider band: 10.0 s at 8 px/s is 80px, past the 71px "Gap 10.0 s" takes
      act(() => editor().setZoom(8));
      act(() => setClipStart("clip:e1", 15));
      expect(screen.getByTestId("stitch-gap")).toHaveTextContent("Gap 10.0 s");
    });

    it("draws a clip inside a lower one with an up and a down ramp, and the curve where two fades meet", () => {
      // B (2 s) in front, inside A: in over its first second, out over its second
      seedPlaced([2, 5], [1.5, 0]);
      openEditor();
      expect(marksOf("Clip 1")).toEqual([
        { kind: "stitch-crossfade-in", left: 0, width: PPS, title: null },
        { kind: "stitch-crossfade-out", left: PPS, width: PPS, title: null },
      ]);
      expect(marksOf("Clip 2")).toEqual([
        { kind: "stitch-crossfade-out", left: 1.5 * PPS, width: PPS, title: null },
        { kind: "stitch-crossfade-in", left: 2.5 * PPS, width: PPS, title: null },
      ]);
    });

    it("draws a weight that two fades shape as a curve", () => {
      // A [0, 5) fades out over [2, 5) and B [2, 7) over [4.5, 7): B's share rises under A's fade, is shaped by both
      // over [4.5, 5), then falls with its own
      seedPlaced([5, 5, 6], [0, 2, 3.5]);
      openEditor();
      const pieces = [...clipBox("Clip 2").querySelectorAll<HTMLElement>('[data-testid="stitch-weight-curve"]')];
      // Cut where C starts (3.5 s), where B's fade starts (4.5 s) and where A ends (5 s)
      expect(pieces.map((el) => [parseFloat(el.style.left), parseFloat(el.style.width)])).toEqual([
        [0, 1.5 * PPS],
        [1.5 * PPS, PPS],
        [2.5 * PPS, 0.5 * PPS],
        [3 * PPS, 2 * PPS],
      ]);
      // A ramp is its two ends; the curve one point per 4px (32px: 9)
      const points = (el: Element) => el.querySelector("polyline")!.getAttribute("points")!.split(" ").length;
      expect(pieces.map(points)).toEqual([2, 2, 9, 2]);
    });

    it("hides a lower clip wholly under a higher one, heard with the crossfade off", () => {
      seedPlaced([5, 2], [0, 1.5]);
      openEditor();
      expect(marksOf("Clip 2")).toEqual([{ kind: "stitch-hidden", left: 0, width: 2 * PPS, title: "Hidden under Clip 1." }]);
      act(() => setCrossfade(false));
      expect(marksOf("Clip 2")).toEqual([
        { kind: "stitch-hidden", left: 0, width: 2 * PPS, title: "Hidden under Clip 1. Its sound plays." },
      ]);
      expect(marksOf("Clip 1")).toEqual([]);
    });

    it("draws a grip drag's hidden bands before release, the lifted box at its own x", () => {
      seedPlaced([5, 4.2, 6, 3.2], [0, 6, 9.2, 11], { crossfade: false });
      openEditor();
      fireEvent.pointerDown(grip("clip:e3"), { button: 0, pointerId: 1, ...at(10, 182) });
      move(10, 182 - ROW);
      expect(clipBox("Clip 4").style.left).toBe(`${ORIGIN + 11 * PPS}px`);
      // Clip 3 is under Clip 2 over [9.2, 10.2) and would be under Clip 4 over [11.0, 14.2)
      const round = (marks: ReturnType<typeof marksOf>) =>
        marks.map((m) => ({ ...m, left: +m.left.toFixed(4), width: +m.width.toFixed(4) }));
      expect(round(marksOf("Clip 3"))).toEqual([
        { kind: "stitch-hidden", left: 0, width: 64, title: "Hidden under Clip 2. Its sound plays." },
        { kind: "stitch-hidden", left: 115.2, width: 204.8, title: "Hidden under Clip 4. Its sound plays." },
      ]);
      expect(marksOf("Clip 4")).toEqual([]);
      release(10, 182 - ROW);
      expect(starts()).toEqual([0, 6, 11, 9.2]);
      expect(round(marksOf("Clip 4"))[1]).toEqual({
        kind: "stitch-hidden",
        left: 115.2,
        width: 204.8,
        title: "Hidden under Clip 3. Its sound plays.",
      });

      // With the crossfade on, the same drag back shows the hidden band of an inside clip in front
      act(() => editor().undo());
      act(() => setCrossfade(true));
      fireEvent.pointerDown(grip("clip:e3"), { button: 0, pointerId: 1, ...at(10, 182) });
      move(10, 182 - ROW);
      expect(round(marksOf("Clip 3"))).toContainEqual({
        kind: "stitch-hidden",
        left: 230.4,
        width: 25.6,
        title: "Hidden under Clip 4.",
      });
      press("Escape");
      release(10, 182 - ROW);
    });

    it("puts the add slot after the latest end, in the last row", () => {
      seedPlaced([5, 4], [6, 0]);
      openEditor();
      const slot = screen.getByTestId("stitch-add-slot");
      expect(slot.style.left).toBe(`${ORIGIN + 11 * PPS + 6}px`);
      expect(slot.style.top).toBe(`${ROW + BOX_TOP}px`);
    });

    it("lines the clips up from the line under the rows in one step, and says when they are", () => {
      seedPlaced([5, 4], [0, 6]);
      openEditor();
      const lineUp = within(foot()).getByRole("button", { name: "Line up" });
      expect(lineUp).toHaveAttribute("title", "Line up: each clip starts 1.0 s before the one above ends");
      fireEvent.click(lineUp);
      expect(starts()).toEqual([undefined, undefined]);
      expect(editor().past).toHaveLength(1);
      expect(clipBox("Clip 2").style.left).toBe(`${ORIGIN + 4 * PPS}px`);
      expect(lineUp).toBeDisabled();
      expect(lineUp).toHaveAttribute("title", "The clips are lined up");
      act(() => editor().undo());
      expect(starts()).toEqual([0, 6]);
      act(() => setOverlapSec(0));
      expect(within(foot()).getByRole("button", { name: "Line up" })).toHaveAttribute(
        "title",
        "Line up: each clip starts where the one above ends",
      );
    });

    it("offers the placing items in the clip menu in Stacked only, on the edit menus' skin, and when they cannot act", () => {
      seed();
      openEditor();
      fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 60 });
      expect(screen.queryByRole("menuitem", { name: /Start at playhead/ })).toBeNull();
      press("Escape");
      fireEvent.click(within(toggle()).getByRole("button", { name: "Stacked" }));
      act(() => editor().setPlayhead(2));
      fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 60 });
      const item = (name: RegExp) => screen.getByRole("menuitem", { name });
      expect(item(/Start at playhead/)).toBeEnabled();
      expect(item(/End at playhead/)).toBeDisabled();
      expect(item(/End at playhead/)).toHaveAttribute("title", "The clip is longer than the time before the playhead");
      expect(item(/Move up a row/)).toBeDisabled();
      expect(item(/Move down a row/)).toBeEnabled();
      expect(item(/Move down a row/)).not.toHaveAttribute("title");
      // The headers' ⋯ skin: 32px rows in 13px type, no icons, no red, 220px on neutral-900 with 10px corners
      for (const row of screen.getAllByRole("menuitem")) {
        expect(row).toHaveClass("h-8", "text-[13px]");
        expect(row.querySelector("svg")).toBeNull();
        expect(row.className).not.toMatch(/text-red/);
      }
      expect(screen.getByRole("menu")).toHaveClass("w-[220px]", "rounded-[10px]", "bg-neutral-900");
      // In the menu's order, under Split
      const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
      expect(labels.slice(1, 6)).toEqual([
        "Split at playheadS",
        "Start at playhead[",
        "End at playhead]",
        "Move up a row⌥↑",
        "Move down a row⌥↓",
      ]);
      fireEvent.click(item(/Start at playhead/));
      expect(starts()).toEqual([2, 4]);
      act(() => editor().setPlayhead(9));
      fireEvent.contextMenu(clipBox("Clip 1"), { clientX: 100, clientY: 60 });
      expect(item(/End at playhead/)).toBeEnabled();
      fireEvent.click(item(/Move down a row/));
      expect(order()).toEqual(["clip:eB", "clip:eA"]);
    });

    it("shows the compact hover mute button only on boxes 96px and wider", () => {
      // 64px and 100px
      seedClips([1, 100 / PPS]);
      openStacked();
      const mute = (name: string) => clipBox(name).querySelector('button[aria-label="Mute clip audio"]');
      expect(mute("Clip 1")).toBeNull();
      expect(mute("Clip 2")).not.toBeNull();
    });

    it("lets a press on a narrow box's muted badge drag the box; a wide box's badge unmutes", () => {
      seedPlaced([1, 100 / PPS], [0, 2], { clips: { 0: { muted: true }, 1: { muted: true } } });
      openEditor();
      act(() => editor().select({ kind: "clip", clipId: "clip:e0" }));
      const mark = clipBox("Clip 1").querySelector<HTMLElement>("[data-muted-mark]")!;
      expect(mark).toHaveClass("pointer-events-none");
      expect(clipBox("Clip 1").querySelector('button[aria-label="Unmute clip audio"]')).toBeNull();
      fireEvent.pointerDown(mark, { button: 0, pointerId: 1, ...at(30, 26) });
      move(30 + PPS, 26);
      expect(clipBox("Clip 1")).toHaveClass("cursor-grabbing");
      release(30 + PPS, 26);
      expect(editor().draft!.timeline[0].startSec).toBeCloseTo(1, 9);
      expect(editor().draft!.timeline[0].muted).toBe(true);
      const unmute = clipBox("Clip 2").querySelector<HTMLButtonElement>('button[aria-label="Unmute clip audio"]')!;
      fireEvent.click(unmute);
      expect(editor().draft!.timeline[1].muted).toBe(false);
    });

    it("leaves the lanes where the drag left them when a selected clip lands past their edge", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
      seed();
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
      // Released with the pointer past the lanes' right side: the box is drawn wholly out of view
      fireEvent.pointerDown(clipBox("Clip 2"), { button: 0, pointerId: 1, ...at(400, 78) });
      move(800, 78);
      const drawn = clipBox("Clip 2").style.left;
      expect(parseFloat(drawn)).toBeGreaterThan(600);
      release(800, 78);
      expect(lanes.scrollLeft).toBe(0);
      expect(clipBox("Clip 2").style.left).toBe(drawn);
    });

    it("leaves the lanes where they are when a grip drag of the selected clip re-sequences it out of view", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(300);
      seedClips([5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      act(() => editor().select({ kind: "clip", clipId: "clip:e0" }));
      fireEvent.pointerDown(grip("clip:e0"), { button: 0, pointerId: 1, ...at(10, 26) });
      move(10, 26 + 2 * ROW);
      const drawn = clipBox("Clip 1").style.left;
      expect(parseFloat(drawn)).toBeGreaterThan(300);
      release(10, 26 + 2 * ROW);
      expect(order()).toEqual(["clip:e1", "clip:e2", "clip:e0"]);
      expect(lanes.scrollLeft).toBe(0);
      // Its row is the third now, and so is its name
      expect(clipBox("Clip 3").style.left).toBe(drawn);
      // The release is taken once: a later move by a key still reveals
      act(() => setClipStart("clip:e0", 20));
      expect(lanes.scrollLeft).toBe(ORIGIN + 20 * PPS - 64);
    });

    it("leaves the lanes where they are when an In trim's release moves the selected box out of view", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(300);
      seedClips([5, 12]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      act(() => editor().select({ kind: "clip", clipId: "clip:e1" }));
      const inX = parseFloat(clipBox("Clip 2").style.left);
      fireEvent.pointerDown(handleOf("Clip 2", "in"), { button: 0, pointerId: 1, ...at(inX, 78) });
      pointer("pointermove", inX + 400, { clientY: 78 });
      pointer("pointerup", inX + 400, { clientY: 78 });
      expect(parseFloat(clipBox("Clip 2").style.left)).toBeGreaterThan(300);
      expect(lanes.scrollLeft).toBe(0);
    });

    it("keeps the lanes' width on a release that shortens the sequence until they scroll back from it", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
      seedClips([5, 5, 6]);
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      const content = lanes.firstElementChild as HTMLElement;
      const before = parseFloat(content.style.width);
      expect(before).toBeGreaterThan(600);
      // Scrolled to the end
      act(() => {
        lanes.scrollLeft = before - 600;
        lanes.dispatchEvent(new Event("scroll"));
      });
      // Clip 3, the one that ends last, 2 s earlier: the sequence is 2 s shorter
      const pressX = parseFloat(clipBox("Clip 3").style.left) - lanes.scrollLeft + 20;
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, pointerId: 1, ...at(pressX, 130) });
      move(pressX - 2 * PPS, 130);
      const drawn = clipBox("Clip 3").style.left;
      release(pressX - 2 * PPS, 130);
      expect(clipBox("Clip 3").style.left).toBe(drawn);
      expect(content.style.width).toBe(`${before}px`);
      // Scrolled back to the start, the lanes shrink to what the sequence needs
      act(() => {
        lanes.scrollLeft = 0;
        lanes.dispatchEvent(new Event("scroll"));
      });
      expect(parseFloat(content.style.width)).toBeCloseTo(before - 2 * PPS, 6);
    });

    it("does not scroll the lanes from under a press that commits a typed Start", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
      seed();
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
      const field = screen.getByRole("textbox", { name: "Start on the timeline" }) as HTMLInputElement;
      field.focus();
      fireEvent.focus(field);
      fireEvent.change(field, { target: { value: "20" } });
      // No Enter: the press on Clip 1 lets the field go, which commits 20 s
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 26) });
      expect(starts()).toEqual([0, 20]);
      expect(lanes.scrollLeft).toBe(0);
      move(100 + PPS, 26);
      release(100 + PPS, 26);
      expect(lanes.scrollLeft).toBe(0);
      expect(starts()).toEqual([1, 20]);
      // A commit made with no press down still reveals
      act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
      act(() => setClipStart("clip:eB", 30));
      expect(lanes.scrollLeft).toBe(ORIGIN + 30 * PPS - 64);
    });

    it("scrolls a clip that a typed Start puts out of view to 64px inside the lanes", () => {
      vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(600);
      seed();
      openStacked();
      const lanes = screen.getByTestId("stitch-lanes");
      act(() => editor().select({ kind: "clip", clipId: "clip:eB" }));
      act(() => setClipStart("clip:eB", 20));
      expect(lanes.scrollLeft).toBe(ORIGIN + 20 * PPS - 64);
      // One still in view leaves the lanes where they are
      act(() => setClipStart("clip:eB", 21));
      expect(lanes.scrollLeft).toBe(ORIGIN + 20 * PPS - 64);
    });
  });
});

describe("Timeline, several clips", () => {
  const ROW = 52;
  const BOX_TOP = 6;
  /** Clips of these lengths from their own generate nodes (clip ids clip:e0, clip:e1, …); stacked: placed at starts. */
  function seedLengths(lengths: number[], starts?: number[]) {
    useWorkflowStore.setState({
      nodes: [
        ...lengths.map((_, i) => node(`gen-${i}`, "generateVideo", { outputVideo: `blob:m${i}` })),
        node("stitch", "videoStitch", {
          clips: [],
          clipOrder: lengths.map((_, i) => `e${i}`),
          outputVideo: null,
          loopCount: 1,
          status: "idle",
          ...(starts
            ? {
                timeline: lengths.map((_, i) => clipItem(`e${i}`, { startSec: starts[i] })),
                sequenceLayout: { mode: "stacked", overlapSec: 1, crossfade: true },
              }
            : {}),
        }),
      ],
      edges: lengths.map((_, i) => edge(`e${i}`, `gen-${i}`, `video-${i}`)),
      openModalCount: 0,
      isModalOpen: false,
    });
    lengths.forEach((duration, i) =>
      __setMediaInfoForTests(mediaKeyOf(`blob:m${i}`), { duration, width: 1920, height: 1080, fps: 24 }),
    );
  }
  const id = (i: number) => `clip:e${i}`;
  const ids = () => {
    const s = editor().selection;
    return s?.kind === "clip" ? (s.clipIds ?? [s.clipId]) : [];
  };
  const selectClips = (...indices: number[]) =>
    act(() =>
      editor().select({ kind: "clip", clipId: id(indices[0]), ...(indices.length > 1 ? { clipIds: indices.map(id) } : {}) }),
    );
  const order = () => editor().draft!.timeline.map((c) => c.id);
  const starts = () => editor().draft!.timeline.map((c) => c.startSec);
  const platform = (value: string) => vi.spyOn(navigator, "platform", "get").mockReturnValue(value);
  const stackedBox = (name: string) => within(lane()).getByRole("option", { name: new RegExp(`^${name},`) });
  /** A Stacked row's grip in the left padding. */
  const grip = (clipId: string) => document.querySelector<HTMLElement>(`[data-row-grip="${clipId}"]`)!;
  /** A Stacked row's band in the lanes, tinted while its clip is selected. */
  const rowBand = (clipId: string) => document.querySelector<HTMLElement>(`[data-stacked-row="${clipId}"]`)!;
  const at = (x: number, y: number) => ({ clientX: x, clientY: y });
  const move = (x: number, y: number, init: MouseEventInit = {}) => pointer("pointermove", x, { clientY: y, ...init });
  const release = (x: number, y: number, init: MouseEventInit = {}) => pointer("pointerup", x, { clientY: y, ...init });
  /** Holds the animation frames a drag asks for, so no auto-scroll runs. */
  const holdFrames = () => {
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  };
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  const ctrlClick = (el: HTMLElement, clientX: number, init: MouseEventInit = {}) => {
    fireEvent.pointerDown(el, { button: 0, clientX, pointerId: 1, ctrlKey: true, ...init });
    pointer("pointerup", clientX, { ctrlKey: true, ...init });
  };

  // Track at 64 px/s, lengths 5, 4 and 6: Clip 1 20–340, Clip 2 340–596, Clip 3 596–980 (2px inset at each join)

  describe("selecting", () => {
    it("adds and takes out a clip with ⌘-click on a Mac, and with Ctrl-click elsewhere", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      platform("MacIntel");
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, clientX: 700, pointerId: 1, metaKey: true });
      pointer("pointerup", 700, { metaKey: true });
      // The clip that joins leads, and ranges start from it
      expect(editor().selection).toEqual({ kind: "clip", clipId: id(2), clipIds: [id(0), id(2)] });
      // On a Mac a Ctrl-press is the menu's: no toggle
      platform("Win32");
      ctrlClick(clipBox("Clip 2"), 400);
      expect(ids()).toEqual([id(0), id(1), id(2)]);
      ctrlClick(clipBox("Clip 1"), 100);
      expect(ids()).toEqual([id(1), id(2)]);
      expect(editor().past).toHaveLength(0);
    });

    it("selects the range from the last clicked clip with ⇧-click, and a plain click collapses the group", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      click(clipBox("Clip 1"), 100);
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, clientX: 700, pointerId: 1, shiftKey: true });
      pointer("pointerup", 700, { shiftKey: true });
      expect(editor().selection).toEqual({ kind: "clip", clipId: id(2), clipIds: [id(0), id(1), id(2)], anchorId: id(0) });
      expect(within(rail()).getByText("3 clips")).toBeInTheDocument();
      expect(within(rail()).getByText("Clip 1, Clip 2 and Clip 3")).toBeInTheDocument();
      // Every selected box is ringed in white; the lane says it takes several
      expect(lane()).toHaveAttribute("aria-multiselectable", "true");
      for (const name of ["Clip 1", "Clip 2", "Clip 3"]) {
        expect(ring(clipBox(name))).toHaveClass("border-2", "border-neutral-100");
        expect(clipBox(name)).toHaveAttribute("aria-selected", "true");
      }
      click(clipBox("Clip 2"), 400);
      expect(editor().selection).toEqual({ kind: "clip", clipId: id(1) });
      expect(ring(clipBox("Clip 1"))).toBeNull();
    });

    it("selects a range by row in Stacked, tinting every selected row", () => {
      seedLengths([5, 4, 6, 3], [0, 6, 9, 11]);
      openEditor();
      fireEvent.pointerDown(stackedBox("Clip 4"), { button: 0, pointerId: 1, ...at(750, 190) });
      release(750, 190);
      fireEvent.pointerDown(stackedBox("Clip 2"), { button: 0, pointerId: 1, shiftKey: true, ...at(420, 90) });
      release(420, 90, { shiftKey: true });
      expect(editor().selection).toEqual({ kind: "clip", clipId: id(1), clipIds: [id(1), id(2), id(3)], anchorId: id(3) });
      expect(rowBand(id(0))).not.toHaveClass("bg-white/4");
      for (const i of [1, 2, 3]) {
        expect(rowBand(id(i))).toHaveClass("bg-white/4");
        expect(ring(stackedBox(`Clip ${i + 1}`))).not.toBeNull();
      }
    });

    it("keeps a group under a Mac's Ctrl-click: on a box, on its handle and on empty space", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      platform("MacIntel");
      selectClips(0, 2);
      // A Mac's Ctrl-click: a left press with ctrl, then the context menu, then the release
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, clientX: 700, pointerId: 1, ctrlKey: true });
      fireEvent.contextMenu(clipBox("Clip 3"), { clientX: 700, clientY: 50, ctrlKey: true });
      pointer("pointerup", 700, { ctrlKey: true });
      expect(ids()).toEqual([id(0), id(2)]);
      const menu = screen.getByRole("menu");
      expect(within(menu).getByText("2 clips")).toBeInTheDocument();
      press("Escape");

      fireEvent.pointerDown(handleOf("Clip 3", "in"), { button: 0, clientX: 596, pointerId: 1, ctrlKey: true });
      fireEvent.contextMenu(handleOf("Clip 3", "in"), { clientX: 596, clientY: 50, ctrlKey: true });
      pointer("pointermove", 640, { ctrlKey: true });
      pointer("pointerup", 640, { ctrlKey: true });
      expect(ids()).toEqual([id(0), id(2)]);
      expect(within(screen.getByRole("menu")).getByText("2 clips")).toBeInTheDocument();
      expect(screen.queryByTestId("stitch-trim-ghost")).toBeNull();
      expect(editor().past).toHaveLength(0);
      press("Escape");

      fireEvent.pointerDown(lane(), { button: 0, clientX: 400, clientY: 30, pointerId: 1, ctrlKey: true });
      pointer("pointermove", 800, { clientY: 30, ctrlKey: true });
      expect(screen.queryByTestId("stitch-marquee")).toBeNull();
      pointer("pointerup", 800, { clientY: 30, ctrlKey: true });
      expect(ids()).toEqual([id(0), id(2)]);
    });

    it("takes a ⌘- or ⇧-press on a trim handle for a click, and trims once it travels", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      platform("MacIntel");
      selectClips(0, 1);
      fireEvent.pointerDown(handleOf("Clip 3", "in"), { button: 0, clientX: 596, pointerId: 1, metaKey: true });
      // Keys and the ⌘ wheel wait from the press
      expect(editor().cancelGesture).not.toBeNull();
      pointer("pointermove", 598, { metaKey: true });
      expect(screen.queryByTestId("stitch-trim-ghost")).toBeNull();
      pointer("pointerup", 598, { metaKey: true });
      expect(ids()).toEqual([id(0), id(1), id(2)]);
      expect(editor().past).toHaveLength(0);
      expect(editor().cancelGesture).toBeNull();

      // ⇧ held: past 4px it trims, without snapping (the playhead at 9.35 s is within reach), and the clip is the only
      // selection
      act(() => editor().setPlayhead(9.35));
      fireEvent.pointerDown(handleOf("Clip 3", "in"), { button: 0, clientX: 596, pointerId: 1, shiftKey: true });
      pointer("pointermove", 616, { shiftKey: true });
      expect(editor().selection).toEqual({ kind: "clip", clipId: id(2) });
      pointer("pointerup", 616, { shiftKey: true });
      expect(editor().draft!.timeline[2].inSec).toBeCloseTo(20 / PPS, 5);
      expect(editor().past).toHaveLength(1);

      // ⌘ held: the same drag snaps to the playhead
      act(() => editor().undo());
      act(() => editor().setPlayhead(9.35));
      selectClips(0, 1);
      fireEvent.pointerDown(handleOf("Clip 3", "in"), { button: 0, clientX: 596, pointerId: 1, metaKey: true });
      pointer("pointermove", 616, { metaKey: true });
      pointer("pointerup", 616, { metaKey: true });
      expect(editor().draft!.timeline[2].inSec).toBeCloseTo(0.35, 5);
    });

    it("trims on a plain handle press, which selects that clip alone; a group's handles show on hover only", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      selectClips(0, 2);
      expect(handleOf("Clip 1", "out")).toHaveClass("opacity-0");
      expect(handleOf("Clip 3", "in")).toHaveClass("opacity-0");
      fireEvent.pointerDown(handleOf("Clip 3", "in"), { button: 0, clientX: 596, pointerId: 1 });
      expect(editor().selection).toEqual({ kind: "clip", clipId: id(2) });
      pointer("pointermove", 628);
      pointer("pointerup", 628);
      expect(editor().past).toHaveLength(1);
      // Selected alone now: its handles show white on hover
      expect(handleOf("Clip 3", "in")).toHaveClass("bg-neutral-100", "opacity-0", "group-hover:opacity-100");
    });

    it("lets a ⌘-press on a box's hover mute button select, and leaves the clip's sound alone", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      platform("MacIntel");
      const mute = soundButton("Clip 2", "Mute clip audio");
      fireEvent.pointerDown(mute, { button: 0, clientX: 560, pointerId: 1, metaKey: true });
      pointer("pointerup", 560, { metaKey: true });
      fireEvent.click(mute, { metaKey: true });
      expect(ids()).toEqual([id(0), id(1)]);
      expect(editor().draft!.timeline[1].muted).toBe(false);
      expect(editor().past).toHaveLength(0);
      // A plain click still mutes that one clip
      fireEvent.click(soundButton("Clip 2", "Mute clip audio"));
      expect(editor().draft!.timeline[1].muted).toBe(true);
      expect(ids()).toEqual([id(0), id(1)]);
    });

    it("clears a text selection on a press in the lane, so ⌘C copies clips, not old rail text", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      const text = within(rail()).getByText("Clip 1 of 3").firstChild!;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 3);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      expect(window.getSelection()!.isCollapsed).toBe(false);
      click(clipBox("Clip 2"), 400);
      expect(window.getSelection()!.isCollapsed).toBe(true);
    });

    it("re-renders a group's timeline once per store change", () => {
      seedLengths([5, 4, 6]);
      const onRender = vi.fn();
      openEditor(onRender);
      selectClips(0, 2);
      onRender.mockClear();
      act(() => editor().setPlayhead(1));
      expect(onRender.mock.calls.length).toBeLessThanOrEqual(2);
    });
  });

  describe("the selection box", () => {
    it("selects the clips it crosses in Track, writes the store once, and adds with ⇧", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      const select = vi.spyOn(editor(), "select");
      // In the band above the clips, across Clip 2 and Clip 3 (Track hits by x only)
      fireEvent.pointerDown(lane(), { button: 0, clientX: 400, clientY: 30, pointerId: 1 });
      pointer("pointermove", 700, { clientY: 30 });
      const box = screen.getByTestId("stitch-marquee");
      expect(box.style.left).toBe("400px");
      expect(box.style.width).toBe("300px");
      // A level drag still draws over the whole clips row (ruler 28, row 80): Track selects by x alone
      expect(box.style.top).toBe("28px");
      expect(box.style.height).toBe("80px");
      // Neutral: a faint white fill in a white/40 edge
      expect(box).toHaveClass("border-white/40", "bg-white/8");
      // Drawn selected while it runs, with the group look release gives (handles on hover only); the store is untouched
      expect(ring(clipBox("Clip 2"))).not.toBeNull();
      expect(ring(clipBox("Clip 1"))).toBeNull();
      expect(handleOf("Clip 2", "in")).toHaveClass("opacity-0");
      expect(handleOf("Clip 3", "out")).toHaveClass("opacity-0");
      expect(select).not.toHaveBeenCalled();
      pointer("pointerup", 700, { clientY: 30 });
      expect(select).toHaveBeenCalledTimes(1);
      expect(ids()).toEqual([id(1), id(2)]);
      expect(screen.queryByTestId("stitch-marquee")).toBeNull();
      expect(editor().past).toHaveLength(0);

      click(clipBox("Clip 1"), 100);
      fireEvent.pointerDown(lane(), { button: 0, clientX: 800, clientY: 110, pointerId: 1, shiftKey: true });
      pointer("pointermove", 900, { clientY: 110, shiftKey: true });
      pointer("pointerup", 900, { clientY: 110, shiftKey: true });
      expect(ids()).toEqual([id(0), id(2)]);
      expect(editor().selection).toMatchObject({ clipId: id(0) });
    });

    it("puts the selection back on Escape, and a click on empty space clears it", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      selectClips(0);
      fireEvent.pointerDown(lane(), { button: 0, clientX: 400, clientY: 30, pointerId: 1 });
      pointer("pointermove", 900, { clientY: 30 });
      press("Escape");
      expect(screen.queryByTestId("stitch-marquee")).toBeNull();
      pointer("pointerup", 900, { clientY: 30 });
      expect(editor().selection).toEqual({ kind: "clip", clipId: id(0) });
      expect(editor().isOpen).toBe(true);

      fireEvent.pointerDown(lane(), { button: 0, clientX: 400, clientY: 110, pointerId: 1 });
      pointer("pointerup", 402, { clientY: 110 });
      expect(editor().selection).toBeNull();
      expect(within(rail()).getByText("Select a clip to edit it.")).toBeInTheDocument();
    });

    it("waits with the ⌘ wheel from the press, and takes neither clip in the join between two", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      const lanes = screen.getByTestId("stitch-lanes");
      selectClips(2);
      // Clip 1 is drawn to 339, Clip 2 from 341
      fireEvent.pointerDown(lane(), { button: 0, clientX: 340, clientY: 26, pointerId: 1 });
      fireEvent.wheel(lanes, { ctrlKey: true, deltaY: -100, clientX: 340 });
      expect(editor().pxPerSec).toBe(PPS);
      pointer("pointermove", 340, { clientY: 110 });
      expect(screen.getByTestId("stitch-marquee")).toBeInTheDocument();
      pointer("pointerup", 340, { clientY: 110 });
      expect(editor().selection).toBeNull();
    });

    it("selects the boxes it touches in Stacked, and is drawn only over the rows in view", () => {
      holdFrames();
      seedLengths([5, 4, 6, 3, 5, 4], [0, 6, 9, 11, 2, 14]);
      openEditor();
      // From 12 s on the first row to 8 s on the third: Clip 2 (6–10 s) and Clip 3 (9–15 s); Clip 1 ends at 5 s
      fireEvent.pointerDown(lane(), { button: 0, pointerId: 1, ...at(ORIGIN + 12 * PPS, 28 + 26) });
      pointer("pointermove", ORIGIN + 8 * PPS, { clientY: 28 + 2 * ROW + 26 });
      pointer("pointerup", ORIGIN + 8 * PPS, { clientY: 28 + 2 * ROW + 26 });
      expect(ids()).toEqual([id(1), id(2)]);

      // The rows scrolled 100px down: the rectangle takes in the second row, out of view above, but is drawn from the
      // visible rows' top
      selectClips(5);
      const content = screen.getByTestId("stitch-rows").parentElement!;
      vi.spyOn(content, "getBoundingClientRect").mockReturnValue(rect(0, -100, 2000, 600));
      fireEvent.pointerDown(lane(), { button: 0, pointerId: 1, ...at(ORIGIN + 9.5 * PPS, 150) });
      pointer("pointermove", ORIGIN + 8 * PPS, { clientY: 10 });
      const box = screen.getByTestId("stitch-marquee");
      expect(parseFloat(box.style.top)).toBe(100 + 28);
      pointer("pointerup", ORIGIN + 8 * PPS, { clientY: 10 });
      // Content y 110–250 over 8–9.5 s: Clip 2's box (86–126, mostly scrolled away) and Clip 3's (138–178)
      expect(ids()).toEqual([id(1), id(2)]);
    });
  });

  describe("dragging a group", () => {
    it("moves a group in Stacked by one time and one row delta, in one undo step; Escape writes nothing", () => {
      seedLengths([5, 4, 6, 3], [0, 6, 9, 11]);
      openEditor();
      selectClips(1, 2);
      fireEvent.pointerDown(stackedBox("Clip 2"), { button: 0, pointerId: 1, ...at(420, 90) });
      move(420 + 2 * PPS, 90 + ROW, { shiftKey: true });
      // Both drawn where release leaves them: +2 s, one row down
      expect(stackedBox("Clip 2").style.left).toBe(`${ORIGIN + 8 * PPS}px`);
      expect(stackedBox("Clip 2").style.top).toBe(`${2 * ROW + BOX_TOP}px`);
      expect(stackedBox("Clip 3").style.left).toBe(`${ORIGIN + 11 * PPS}px`);
      expect(stackedBox("Clip 3").style.top).toBe(`${3 * ROW + BOX_TOP}px`);
      expect(stackedBox("Clip 1").style.left).toBe(`${ORIGIN}px`);
      expect(screen.getByTestId("stitch-move-chip")).toHaveTextContent("2 clips · 0:08.00–0:17.00 · +2.00 s");
      expect(screen.getAllByTestId("stitch-insertion-bar")).toHaveLength(1);
      release(420 + 2 * PPS, 90 + ROW, { shiftKey: true });
      expect(order()).toEqual([id(0), id(3), id(1), id(2)]);
      expect(starts()).toEqual([0, 11, 8, 11]);
      expect(editor().past).toHaveLength(1);
      expect(editor().selection).toMatchObject({ clipId: id(1), clipIds: [id(1), id(2)] });

      act(() => editor().undo());
      selectClips(1, 2);
      fireEvent.pointerDown(stackedBox("Clip 2"), { button: 0, pointerId: 1, ...at(420, 90) });
      move(420 + 2 * PPS, 90 + ROW, { shiftKey: true });
      press("Escape");
      release(420 + 2 * PPS, 90 + ROW);
      expect(order()).toEqual([id(0), id(1), id(2), id(3)]);
      expect(editor().past).toHaveLength(0);
    });

    it("stops a Stacked group together at the bottom row, keeping its spacing", () => {
      holdFrames();
      seedLengths([5, 4, 6, 3], [0, 6, 9, 11]);
      openEditor();
      selectClips(0, 2);
      const apply = vi.spyOn(editor(), "apply");
      fireEvent.pointerDown(stackedBox("Clip 1"), { button: 0, pointerId: 1, ...at(100, 40) });
      move(100, 40 + 260, { shiftKey: true });
      // Clip 3 stops where it rests on the last row, so both are one row down, 104px apart, where release puts them
      expect(stackedBox("Clip 1").style.top).toBe(`${ROW + BOX_TOP}px`);
      expect(stackedBox("Clip 3").style.top).toBe(`${3 * ROW + BOX_TOP}px`);
      release(100, 40 + 260, { shiftKey: true });
      expect(order()).toEqual([id(1), id(0), id(3), id(2)]);
      expect(starts()).toEqual([6, 0, 11, 9]);
      expect(apply).toHaveBeenCalledTimes(1);
    });

    it("moves a group's rows only by a row's grip", () => {
      seedLengths([5, 4, 6, 3], [0, 6, 9, 11]);
      openEditor();
      selectClips(1, 2);
      fireEvent.pointerDown(grip(id(1)), { button: 0, pointerId: 1, ...at(10, 90) });
      move(10, 90 + ROW);
      expect(stackedBox("Clip 2").style.top).toBe(`${2 * ROW + BOX_TOP}px`);
      expect(stackedBox("Clip 3").style.top).toBe(`${3 * ROW + BOX_TOP}px`);
      release(10, 90 + ROW);
      expect(order()).toEqual([id(0), id(3), id(1), id(2)]);
      expect(starts()).toEqual([0, 11, 6, 9]);
      expect(editor().past).toHaveLength(1);
      expect(ids()).toEqual([id(1), id(2)]);
    });

    it("moves a group in Track as one block, in its order, in one undo step", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      selectClips(0, 1);
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, clientX: 100, pointerId: 1 });
      // Past Clip 3's midpoint (592 + 192)
      pointer("pointermove", 800);
      expect(clipBox("Clip 1")).toHaveClass("-rotate-[1.5deg]");
      expect(clipBox("Clip 2")).toHaveClass("-rotate-[1.5deg]");
      expect(clipBox("Clip 3")).toHaveClass("opacity-40");
      expect(screen.getByTestId("stitch-insertion-bar")).toBeInTheDocument();
      pointer("pointerup", 800);
      expect(order()).toEqual([id(2), id(0), id(1)]);
      expect(editor().past).toHaveLength(1);
      expect(editor().selection).toMatchObject({ clipId: id(0), clipIds: [id(0), id(1)] });
    });

    it("never gathers a Track group on a wobble, and moves it once the bar has shown, even back where it was", () => {
      seedLengths([5, 4, 6]);
      openEditor();
      selectClips(0, 2);
      fireEvent.pointerDown(clipBox("Clip 1"), { button: 0, clientX: 100, pointerId: 1 });
      pointer("pointermove", 106);
      expect(screen.queryByTestId("stitch-insertion-bar")).toBeNull();
      pointer("pointerup", 106);
      expect(order()).toEqual([id(0), id(1), id(2)]);
      expect(editor().past).toHaveLength(0);

      // Clip 3 pressed: left past Clip 2's midpoint (464) and back
      fireEvent.pointerDown(clipBox("Clip 3"), { button: 0, clientX: 700, pointerId: 1 });
      pointer("pointermove", 400);
      expect(screen.getByTestId("stitch-insertion-bar")).toBeInTheDocument();
      pointer("pointermove", 500);
      expect(screen.getByTestId("stitch-insertion-bar")).toBeInTheDocument();
      pointer("pointerup", 500);
      expect(order()).toEqual([id(1), id(0), id(2)]);
      expect(editor().past).toHaveLength(1);
    });
  });
});

describe("Timeline, heights and the audio section", () => {
  const TONE = "atone00000001";
  const timelineEl = () => screen.getByTestId("stitch-timeline");
  const toggleGroup = () => screen.getByRole("group", { name: "Timeline layout" });
  const audioLane = () => screen.getByRole("listbox", { name: "Audio clips" });
  const audioBox = (id: string) => audioLane().querySelector<HTMLElement>(`[data-audio-clip-id="${id}"]`)!;
  const toneClip = (id: string, init: Partial<StitchAudioClip> = {}) =>
    createAudioClip({ kind: "asset", assetId: TONE }, { id, ...init });

  /** Clips of these lengths, and the node's audio clips as stored (each a 3 s library file). */
  function seedWith(lengths: number[], audioClips?: StitchAudioClip[]) {
    useWorkflowStore.setState({
      nodes: [
        ...lengths.map((_, i) => node(`gen-${i}`, "generateVideo", { outputVideo: `blob:s${i}` })),
        node("stitch", "videoStitch", {
          clips: [],
          clipOrder: [],
          outputVideo: null,
          loopCount: 1,
          status: "idle",
          ...(audioClips ? { audioClips } : {}),
        }),
      ],
      edges: lengths.map((_, i) => edge(`e${i}`, `gen-${i}`, `video-${i}`)),
      openModalCount: 0,
      isModalOpen: false,
    });
    lengths.forEach((duration, i) =>
      __setMediaInfoForTests(mediaKeyOf(`blob:s${i}`), { duration, width: 1920, height: 1080, fps: 24 }),
    );
    primeAssetInfo([{ id: TONE, kind: "audio", filename: "tone1320.m4a", durationSec: 3 } as unknown as AssetView]);
  }

  it.each([2, 3, 6])("takes what each layout's rows need through Track, Stacked, ⌘Z and ⇧⌘Z with %i clips", (count) => {
    seedWith(Array.from({ length: count }, () => 5));
    openEditor();
    // Track: the edge, the ruler, the clips row, one audio row and the strip; no room kept for Stacked's rows
    const track = `${1 + 28 + 80 + 52 + 28}px`;
    const stacked = `${1 + 28 + Math.min(count * 52, 182) + 52 + 28}px`;
    expect(timelineEl().style.height).toBe(track);
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Stacked" }));
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
    expect(timelineEl().style.height).toBe(stacked);
    press("z", { metaKey: true });
    expect(editor().draft!.sequenceLayout.mode).toBe("track");
    expect(timelineEl().style.height).toBe(track);
    press("z", { metaKey: true, shiftKey: true });
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
    expect(timelineEl().style.height).toBe(stacked);
  });

  it("holds its height while the pointer is on the control row, so a switch never moves the toggle, and settles after", () => {
    seedWith([5, 5, 5]);
    openEditor();
    const controls = screen.getByTestId("stitch-controls").parentElement!;
    const lanes = screen.getByTestId("stitch-lanes");
    expect(timelineEl().style.height).toBe("189px");
    fireEvent.pointerEnter(controls);
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Stacked" }));
    expect(editor().draft!.sequenceLayout.mode).toBe("stacked");
    // Held at Track's height: Stacked's three rows scroll in the clips row's room meanwhile
    expect(timelineEl().style.height).toBe("189px");
    expect(lanes).toHaveClass("overflow-y-auto");
    // And back again, still held
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Track" }));
    expect(timelineEl().style.height).toBe("189px");
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Stacked" }));
    fireEvent.pointerLeave(controls);
    expect(timelineEl().style.height).toBe(`${1 + 28 + 156 + 52 + 28}px`);
    expect(lanes).toHaveClass("overflow-y-hidden");
    // Coming in again holds the height it has now: back to Track keeps Stacked's until the pointer leaves
    fireEvent.pointerEnter(controls);
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Track" }));
    expect(timelineEl().style.height).toBe("265px");
    fireEvent.pointerLeave(controls);
    expect(timelineEl().style.height).toBe("189px");
  });

  it("drags taller or shorter by its top edge, keeps that height through a switch, and fits its rows on a double-click", () => {
    seedWith([5, 5, 5]);
    openEditor();
    const edge = screen.getByRole("separator", { name: "Timeline height" });
    expect(timelineEl().style.height).toBe("189px");
    fireEvent.pointerDown(edge, { button: 0, buttons: 1, pointerId: 1, clientY: 600 });
    fireEvent.pointerMove(edge, { buttons: 1, pointerId: 1, clientY: 480 });
    expect(timelineEl().style.height).toBe("309px");
    expect(edge).toHaveAttribute("aria-valuenow", "309");
    // Never under the least the timeline takes
    fireEvent.pointerMove(edge, { buttons: 1, pointerId: 1, clientY: 900 });
    expect(timelineEl().style.height).toBe("189px");
    fireEvent.pointerMove(edge, { buttons: 1, pointerId: 1, clientY: 480 });
    fireEvent.pointerUp(edge, { pointerId: 1, clientY: 480 });
    // A move after the release changes nothing
    fireEvent.pointerMove(edge, { pointerId: 1, clientY: 300 });
    expect(timelineEl().style.height).toBe("309px");
    // Stacked keeps the height chosen; its three rows (156) sit in it
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Stacked" }));
    expect(timelineEl().style.height).toBe("309px");
    // ↑ and ↓ on the edge move it, and leave the selected clip's row alone
    const second = editor().draft!.timeline[1].id;
    act(() => editor().select({ kind: "clip", clipId: second }));
    act(() => edge.focus());
    pressOnFocus("ArrowUp");
    expect(timelineEl().style.height).toBe("317px");
    act(() => {
      edge.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(timelineEl().style.height).toBe("253px");
    expect(editor().selection).toMatchObject({ kind: "clip", clipId: second });
    expect(editor().draft!.timeline[1].id).toBe(second);
    fireEvent.doubleClick(edge);
    expect(timelineEl().style.height).toBe(`${1 + 28 + 156 + 52 + 28}px`);
  });

  it("shows the rows above once the height settles: a switch to Stacked with Clip 2 selected leaves Clip 1 whole", () => {
    seedWith([5, 5, 5, 5]);
    openEditor();
    const controls = screen.getByTestId("stitch-controls").parentElement!;
    const lanes = screen.getByTestId("stitch-lanes");
    act(() => editor().select({ kind: "clip", clipId: editor().draft!.timeline[1].id }));
    fireEvent.pointerEnter(controls);
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Stacked" }));
    // Held at Track's height the rows' view is 80px: Clip 2's row (52–104) is shown by a 24px scroll
    expect(timelineEl().style.height).toBe("189px");
    expect(lanes.scrollTop).toBe(24);
    fireEvent.pointerLeave(controls);
    // Settled, the view is 182px and grew upward: the rows above come into view, Clip 1's row whole above Clip 2's
    expect(timelineEl().style.height).toBe(`${1 + 28 + 182 + 52 + 28}px`);
    expect(lanes.scrollTop).toBe(0);
  });

  it("keeps the room of a scrollbar drawn beside the lanes under the rows, shown or not: zooming in past Fit moves nothing", () => {
    const globals = globalThis as { ResizeObserver?: unknown };
    const original = globals.ResizeObserver;
    const callbacks: Array<() => void> = [];
    globals.ResizeObserver = class {
      constructor(private callback: () => void) {
        callbacks.push(callback);
      }
      observe() {
        this.callback();
      }
      disconnect() {}
    };
    // An 8px scrollbar beside the content: the probe always has one, the lanes once they overflow
    let lanesBar = 0;
    const lanesBox = (el: HTMLElement) =>
      parseFloat(el.parentElement!.style.height) - 1 - parseFloat(el.style.marginBottom || "0");
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "stitch-scrollbar-probe") return 40;
      return this.dataset.testid === "stitch-lanes" ? lanesBox(this) : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "stitch-scrollbar-probe") return 32;
      return this.dataset.testid === "stitch-lanes" ? lanesBox(this) - lanesBar : 0;
    });
    try {
      seedWith([5, 5]);
      openEditor();
      const lanes = screen.getByTestId("stitch-lanes");
      // 8px taller than the rows need, the room under the lanes while the scrollbar is hidden; the rows as they were
      expect(timelineEl().style.height).toBe(`${189 + 8}px`);
      expect(lanes.style.marginBottom).toBe("8px");
      expect(screen.getByTestId("stitch-audio-view").style.height).toBe("52px");
      expect(screen.getByTestId("stitch-timeline-foot").style.bottom).toBe("8px");
      expect(screen.getByTestId("stitch-audio-controls").parentElement!.style.bottom).toBe(`${8 + 28}px`);
      // Zoomed in, the lanes overflow and the scrollbar shows in that room: no height changes
      lanesBar = 8;
      act(() => editor().setZoom(PPS * 4));
      act(() => callbacks.forEach((callback) => callback()));
      expect(timelineEl().style.height).toBe(`${189 + 8}px`);
      expect(lanes.style.marginBottom).toBe("0px");
      expect(screen.getByTestId("stitch-audio-view").style.height).toBe("52px");
      expect(screen.getByTestId("stitch-timeline-foot").style.bottom).toBe("8px");
      // Held from the control row, a scrollbar coming or going changes nothing either
      const controls = screen.getByTestId("stitch-controls").parentElement!;
      fireEvent.pointerEnter(controls);
      lanesBar = 0;
      act(() => callbacks.forEach((callback) => callback()));
      expect(timelineEl().style.height).toBe(`${189 + 8}px`);
      fireEvent.pointerLeave(controls);
      expect(timelineEl().style.height).toBe(`${189 + 8}px`);
    } finally {
      globals.ResizeObserver = original;
    }
  });

  it("keeps the board's height where scrollbars are drawn over the content", () => {
    seedWith([5, 5]);
    openEditor();
    expect(timelineEl().style.height).toBe("189px");
    expect(screen.getByTestId("stitch-lanes").style.marginBottom).toBe("0px");
  });

  it("keeps one height whatever is selected: a clip, several, an audio clip, nothing", () => {
    seedWith([5, 4, 6], [toneClip("t", { startSec: 1 }), toneClip("u", { row: 1 })]);
    openEditor();
    const ids = editor().draft!.timeline.map((c) => c.id);
    // Collapsed, and with a row expanded (its own height, still none from the selection)
    for (const expanded of [null, 0, 1]) {
      act(() => editor().setAudioExpandedRow(expanded));
      const height = timelineEl().style.height;
      for (const selection of [
        { kind: "clip" as const, clipId: ids[1] },
        { kind: "clip" as const, clipId: ids[0], clipIds: ids, anchorId: ids[0] },
        audioSelectionOf({ clipId: "t" }),
        audioSelectionOf({ clipId: "u", clipIds: ["t", "u"] }),
        audioSelectionOf({ clipId: "t" }, 0, true),
        null,
      ]) {
        act(() => editor().select(selection));
        expect(timelineEl().style.height).toBe(height);
      }
    }
  });

  it("takes the room the editor leaves it: Stacked's rows give way first, then the audio rows", () => {
    // The dialog is 752px tall (a 1280 × 800 window): under its 56px header the stage keeps 344 with its control row,
    // the timeline gets at most 352
    const globals = globalThis as { ResizeObserver?: unknown };
    const original = globals.ResizeObserver;
    globals.ResizeObserver = class {
      constructor(private callback: () => void) {}
      observe() {
        this.callback();
      }
      disconnect() {}
    };
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("flex-col") && this.classList.contains("h-full") && this.parentElement?.getAttribute("role") !== "listbox"
        ? 752
        : 0;
    });
    try {
      seedWith([5, 5, 5, 5], [toneClip("t", { startSec: 1 }), toneClip("u", { row: 1 }), toneClip("v", { row: 2 })]);
      openEditor();
      act(() => editor().setAudioExpandedRow(0));
      // Track fits: the clips row and two audio rows, one of them open
      expect(timelineEl().style.height).toBe(`${1 + 28 + 80 + 180 + 28}px`);
      expect(screen.getByTestId("stitch-audio-view").style.height).toBe("180px");
      // Stacked's four rows would want 182px: they give way to 115, the audio rows keep their view
      fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Stacked" }));
      expect(timelineEl().style.height).toBe("352px");
      expect(screen.getByTestId("stitch-audio-view").style.height).toBe("180px");
      expect(screen.getByTestId("stitch-lanes")).toHaveClass("overflow-y-auto");
    } finally {
      globals.ResizeObserver = original;
    }
  });

  it("scrolls the audio rows with a wheel over them, and Stacked's rows only with one over theirs", () => {
    seedWith([5, 5, 5, 5, 5, 5], [toneClip("t"), toneClip("u", { row: 1 }), toneClip("v", { row: 2 })]);
    openEditor();
    fireEvent.click(within(toggleGroup()).getByRole("button", { name: "Stacked" }));
    const lanes = screen.getByTestId("stitch-lanes");
    const rowsBlock = () => screen.getByTestId("stitch-audio-rows");
    const controls = () => screen.getByTestId("stitch-audio-controls");
    expect(rowsBlock().style.transform).toBe("translateY(0px)");
    lanes.scrollTop = 0;
    act(() => {
      screen.getByTestId("stitch-audio-view").dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true }));
    });
    expect(rowsBlock().style.transform).toBe("translateY(-40px)");
    expect(controls().style.transform).toBe("translateY(-40px)");
    expect(lanes.scrollTop).toBe(0);
    // Past the end it stops at the last row: three rows in a two-row view scroll 52px; a wheel over the rows'
    // controls in the left padding scrolls them too
    act(() => {
      controls().dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true }));
    });
    expect(rowsBlock().style.transform).toBe("translateY(-52px)");
    // Over Stacked's rows, only they scroll
    act(() => {
      screen.getByTestId("stitch-rows").dispatchEvent(new WheelEvent("wheel", { deltaY: 30, bubbles: true, cancelable: true }));
    });
    expect(lanes.scrollTop).toBe(30);
    expect(rowsBlock().style.transform).toBe("translateY(-52px)");
  });

  it("scrolls the selected audio clip's row into view when it is selected other than by a press", () => {
    seedWith([5, 5], [toneClip("t"), toneClip("u", { row: 1 }), toneClip("v", { row: 2 })]);
    openEditor();
    const rowsBlock = () => screen.getByTestId("stitch-audio-rows");
    expect(rowsBlock().style.transform).toBe("translateY(0px)");
    // Three rows in a two-row view: the last row shows once the rows scroll 52px, and no further
    act(() => editor().select(audioSelectionOf({ clipId: "v" })));
    expect(rowsBlock().style.transform).toBe("translateY(-52px)");
    act(() => editor().select(audioSelectionOf({ clipId: "u" })));
    expect(rowsBlock().style.transform).toBe("translateY(-52px)");
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    expect(rowsBlock().style.transform).toBe("translateY(0px)");
  });

  it("counts the audio rows out of view in the line under them", () => {
    seedWith([5, 5], [toneClip("t"), toneClip("u", { row: 1 }), toneClip("v", { row: 2 })]);
    openEditor();
    expect(screen.getByTestId("stitch-audio-hidden-rows")).toHaveTextContent(/^1 audio row below1$/);
    act(() => {
      screen.getByTestId("stitch-audio-view").dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true }));
    });
    expect(screen.getByTestId("stitch-audio-hidden-rows")).toHaveTextContent(/^1 audio row above1$/);
  });

  it("turns a view's own scroll (focus in a hidden row) into the translate both sides share", () => {
    seedWith([5, 5], [toneClip("t"), toneClip("u", { row: 1 }), toneClip("v", { row: 2 })]);
    openEditor();
    const controlsView = screen.getByTestId("stitch-audio-controls").parentElement as HTMLElement;
    for (const view of [controlsView, screen.getByTestId("stitch-audio-view")]) {
      act(() => editor().select(audioSelectionOf({ clipId: "t" })));
      expect(screen.getByTestId("stitch-audio-rows").style.transform).toBe("translateY(0px)");
      view.scrollTop = 52;
      fireEvent.scroll(view);
      expect(view.scrollTop).toBe(0);
      expect(screen.getByTestId("stitch-audio-rows").style.transform).toBe("translateY(-52px)");
      expect(screen.getByTestId("stitch-audio-controls").style.transform).toBe("translateY(-52px)");
      act(() => editor().select(null));
    }
  });

  it("leaves the audio rows where they are on an edit that keeps the lead and its row (a row's mute)", () => {
    seedWith([5, 5], [toneClip("t"), toneClip("u", { row: 1 }), toneClip("v", { row: 2 })]);
    openEditor();
    const rowsBlock = () => screen.getByTestId("stitch-audio-rows");
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    act(() => {
      screen.getByTestId("stitch-audio-view").dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true }));
    });
    expect(rowsBlock().style.transform).toBe("translateY(-52px)");
    // The lead's row is out of view; the last row's mute must not bring it back under the pointer
    fireEvent.click(screen.getByRole("button", { name: "Mute Audio 3" }));
    expect(editor().draft!.audioClips.find((c) => c.id === "v")!.muted).toBe(true);
    expect(rowsBlock().style.transform).toBe("translateY(-52px)");
    // A key that moves the lead to another row still reveals it
    act(() => editor().select(audioSelectionOf({ clipId: "u" })));
    expect(rowsBlock().style.transform).toBe("translateY(-52px)");
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    expect(rowsBlock().style.transform).toBe("translateY(0px)");
  });

  it("widens the lanes to an audio clip placed past the last frame", () => {
    seedWith([5, 4], [toneClip("t", { startSec: 30 })]);
    openEditor();
    const content = screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement;
    expect(parseFloat(content.style.width)).toBeGreaterThanOrEqual(ORIGIN + 33 * PPS);
    expect(audioBox("t").style.left).toBe(`${ORIGIN + 30 * PPS}px`);
  });

  it("opens an audio clip's menu, whose items act on it", () => {
    seedWith([5, 4], [toneClip("t", { startSec: 1 }), toneClip("u", { startSec: 5 })]);
    openEditor();
    fireEvent.contextMenu(audioBox("u"), { clientX: 200, clientY: 300 });
    const menu = screen.getByRole("menu", { name: "tone1320.m4a · Audio 1" });
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: "u" });
    for (const name of ["Split at playhead", "Start at playhead", "End at playhead", "Move up a row", "Move down a row", "Mute clip", "Copy", "Cut", "Paste", "Duplicate", "Remove clip"]) {
      expect(within(menu).getByRole("menuitem", { name: new RegExp(name) })).toBeInTheDocument();
    }
    expect(within(menu).getByRole("menuitem", { name: /Move up a row/ })).toBeDisabled();
    // The edit menus' skin, as the clip menu: 220px on neutral-900, 32px rows in 13px type, no icons, no red, hairlines
    expect(menu).toHaveClass("w-[220px]", "rounded-[10px]", "bg-neutral-900");
    for (const row of within(menu).getAllByRole("menuitem")) {
      expect(row).toHaveClass("h-8", "text-[13px]");
      expect(row.querySelector("svg")).toBeNull();
      expect(row.className).not.toMatch(/text-red/);
    }
    expect(within(menu).getAllByRole("separator")).toHaveLength(2);
    for (const line of within(menu).getAllByRole("separator")) expect(line).toHaveClass("my-1", "border-neutral-800");
    // Its rows sit straight in the menu, under its heading
    expect(within(menu).getAllByRole("menuitem").every((row) => row.parentElement === menu)).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Move down a row/ }));
    expect(editor().draft!.audioClips.find((c) => c.id === "u")!.row).toBe(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
