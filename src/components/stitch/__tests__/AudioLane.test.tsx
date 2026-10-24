import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { AssetView } from "@/lib/assets/types";

const api = vi.hoisted(() => ({ fetchAsset: vi.fn() }));
vi.mock("@/lib/assets/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets/client/api")>()),
  fetchAsset: api.fetchAsset,
}));
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

import { useWorkflowStore } from "@/store/workflowStore";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { assetFileUrl } from "@/lib/assets/client/api";
import { createAudioClip, MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import { __resetAssetInfoForTests, primeAssetInfo } from "@/lib/stitch/assetInfo";
import { fadeIn, fadeOut } from "@/lib/stitch/curve";
import { __resetMediaInfoForTests, __setMediaExtractorForTests, __setMediaInfoForTests, mediaKeyOf } from "@/lib/stitch/mediaInfo";
import { __resetWaveformForTests, __setWaveformDecoderForTests, __setWaveformForTests } from "@/lib/stitch/waveformCache";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import type { StitchAudioClip, VideoStitchNodeData, VolumePoint, WorkflowEdge, WorkflowNode } from "@/types";

// The audio section inside the real editor, against the real stores. jsdom
// lays nothing out (every rect is at 0), so lane x is the pointer's clientX
// and a block's y is its clientY. At 64 px/s a time t is at x = 20 + 64·t;
// an expanded block has 0 dB at y 16 and −∞ at y 106. The sequence is 9 s
// (A 5 s, B 4 s); the music is 20 s long.

const PPS = 64;
const ORIGIN = 20;
const x = (t: number) => ORIGIN + t * PPS;
/** y of a gain in the expanded block (√ level). */
const y = (gain: number) => 16 + (1 - Math.sqrt(gain)) * 90;
const TONE = "atone00000001";
const GONE = "agone00000001";
const BAD = "abadfile00001";
const wf = () => useWorkflowStore.getState();
const editor = () => useStitchEditorStore.getState();
const node = (id: string, type: string, data: Record<string, unknown>): WorkflowNode =>
  ({ id, type, data, position: { x: 0, y: 0 } }) as WorkflowNode;
const edge = (id: string, source: string, sourceHandle: string, targetHandle: string): WorkflowEdge => ({
  id,
  source,
  target: "stitch",
  sourceHandle,
  targetHandle,
});
const tone = (id: string, init: Partial<StitchAudioClip> = {}) => createAudioClip({ kind: "asset", assetId: TONE }, { id, ...init });

function seed({
  clips = true,
  music = true,
  stitch = {},
}: { clips?: boolean; music?: boolean; stitch?: Partial<VideoStitchNodeData> } = {}) {
  const nodes = [
    node("gen-a", "generateVideo", { outputVideo: "blob:a" }),
    node("gen-b", "generateVideo", { outputVideo: "blob:b" }),
    node("music", "audioInput", { audioFile: "blob:m", filename: "score.mp3", duration: 20, format: "audio/mpeg" }),
    node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle", ...stitch }),
  ];
  const edges = [
    ...(clips ? [edge("eA", "gen-a", "video", "video-0"), edge("eB", "gen-b", "video", "video-1")] : []),
    ...(music ? [edge("eM", "music", "audio", "audio")] : []),
  ];
  useWorkflowStore.setState({ nodes, edges, openModalCount: 0, isModalOpen: false });
  __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
  __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1920, height: 1080, fps: 24 });
  __setWaveformForTests(mediaKeyOf("blob:m"), { duration: 20, peaks: new Float32Array(64).fill(0.5) });
  __setWaveformForTests(mediaKeyOf(assetFileUrl(TONE)), { duration: 3, peaks: new Float32Array(64).fill(0.5) });
  __setWaveformForTests(mediaKeyOf(assetFileUrl(BAD)), { duration: null, peaks: null, status: "error" });
  const record = (id: string, filename: string, durationSec: number) =>
    ({ id, kind: "audio", filename, durationSec }) as unknown as AssetView;
  primeAssetInfo([record(TONE, "tone1320.m4a", 3), record(BAD, "broken.m4a", 2)]);
}

function openEditor(curve?: VolumePoint[]) {
  render(<StitchEditorModal />);
  act(() => {
    openStitchEditor("stitch");
    editor().setZoom(PPS);
  });
  // A curve on the music the editor opened with, so it is not an undo step
  if (curve) {
    const withCurve = (clips: StitchAudioClip[]) => clips.map((c) => (c.source.kind === "music" ? { ...c, curve } : c));
    act(() =>
      useStitchEditorStore.setState((s) => ({
        draft: { ...s.draft!, audioClips: withCurve(s.draft!.audioClips) },
        initial: { ...s.initial!, audioClips: withCurve(s.initial!.audioClips) },
      })),
    );
  }
}

const lane = () => screen.getByRole("listbox", { name: "Audio clips" });
const box = (name: string) => within(lane()).getByRole("option", { name: new RegExp(`^${name.replace(".", "\\.")}`) });
const musicBox = () => box("score.mp3");
const rows = () => screen.getAllByTestId("stitch-audio-row");
const rail = () => screen.getByRole("complementary", { name: "Audio clip" });
const timelineEl = () => screen.getByTestId("stitch-timeline");
const points = () => screen.queryAllByTestId("stitch-curve-point");
const music = () => editor().draft!.audioClips.find((c) => c.source.kind === "music")!;
const curve = () => music().curve;
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
const pointer = (type: "pointermove" | "pointerup", clientX: number, clientY: number, init: MouseEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new MouseEvent(type, { clientX, clientY, bubbles: true, ...init }));
  });
const down = (el: HTMLElement, clientX: number, clientY: number, init: Record<string, unknown> = {}) =>
  fireEvent.pointerDown(el, { button: 0, clientX, clientY, pointerId: 1, ...init });
/** A press and release on a box with no travel: a click. */
const click = (el: HTMLElement, clientX = x(4), clientY = 30) => {
  down(el, clientX, clientY);
  pointer("pointerup", clientX, clientY);
};
const toggle = (row = 0) =>
  fireEvent.click(
    screen.getAllByRole("button", { name: /^(Show|Hide) volume curve for Audio \d+$/ })[row] as HTMLElement,
  );
/** The music selected on an expanded row: its curve takes presses. */
const editMusic = () => {
  click(musicBox());
  toggle(0);
};
/** Two presses and the dblclick a browser sends after them. */
const doubleClickAt = (clientX: number, clientY: number) => {
  down(musicBox(), clientX, clientY);
  pointer("pointerup", clientX, clientY);
  down(musicBox(), clientX, clientY);
  pointer("pointerup", clientX, clientY);
  fireEvent.doubleClick(musicBox(), { clientX, clientY });
};
const content = () => screen.getByTestId("stitch-lanes").firstElementChild as HTMLElement;
const rect = (left: number, top: number): DOMRect =>
  ({ left, top, right: left, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
/** Every audio box's and row controls' place, as drawn. */
const placesOf = () =>
  [...screen.getAllByRole("option").filter((el) => el.dataset.audioClipId), ...document.querySelectorAll<HTMLElement>("[data-audio-row-controls]")].map(
    (el) => `${el.dataset.audioClipId ?? el.dataset.audioRowControls}:${el.style.left}:${el.style.top}:${el.style.width}:${el.style.height}`,
  );

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __resetWaveformForTests();
  __resetAssetInfoForTests();
  api.fetchAsset.mockImplementation(async () => null);
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  // jsdom has no 2D canvas; the waveform draws nothing, but its element is there
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
});

afterEach(() => {
  act(() => editor().close());
  __setMediaExtractorForTests(null);
  __resetMediaInfoForTests();
  __resetWaveformForTests();
  vi.restoreAllMocks();
});

describe("Audio section", () => {
  it("draws the music as a clip on Audio 1: its grey waveform alone at rest, its length on hover, hatched past the last frame", () => {
    seed();
    openEditor([
      { t: 0, gain: 0 },
      { t: 1, gain: 1 },
    ]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].style.height).toBe("52px");
    expect(musicBox().style.left).toBe(`${x(0)}px`);
    expect(musicBox().style.width).toBe(`${20 * PPS}px`);
    expect(musicBox().style.height).toBe("44px");
    expect(musicBox()).toHaveClass("bg-edit-clip");
    expect(musicBox()).toHaveAccessibleName("score.mp3, Audio 1, starts 0:00.00");
    // Only the length shows, on hover, as on a video clip; the name is the box's tooltip, the source the rail's
    const length = within(musicBox()).getByText("20.0 s");
    expect(length).toHaveClass("opacity-0", "group-hover:opacity-100", "group-focus-visible:opacity-100");
    expect(within(musicBox()).queryByText("score.mp3")).toBeNull();
    expect(musicBox()).toHaveAttribute("title", "score.mp3");
    expect(within(musicBox()).queryByText("Audio input")).toBeNull();
    expect(within(musicBox()).getByTestId("stitch-waveform")).toBeInTheDocument();
    // At rest the waveform alone, as on the boards: a curve that shapes the sound shows once the clip is selected
    expect(within(musicBox()).queryByTestId("stitch-curve")).toBeNull();
    expect(points()).toHaveLength(0);
    expect(musicBox().querySelector("[data-selected-ring]")).toBeNull();
    expect(screen.queryByTestId("stitch-db-guides")).toBeNull();
    // The 11 s past the 9 s sequence are not heard
    const hatch = within(musicBox()).getByTestId("stitch-audio-after-end");
    expect(hatch.style.left).toBe(`${9 * PPS}px`);
    expect(hatch).toHaveAttribute("title", "After the last frame: not heard");
    // Selected: the white ring, the curve in white, and its point (the one at the clip's In gets no dot, as on the
    // boards; the other is r 4)
    click(musicBox());
    expect(musicBox().querySelector("[data-selected-ring]")).toHaveClass("border-neutral-100");
    expect(within(musicBox()).getByTestId("stitch-curve").querySelector("polyline")).toHaveClass("stroke-neutral-100");
    expect(points()).toHaveLength(1);
    expect(points()[0]).toHaveAttribute("r", "4");
    // The length chip is drawn over the curve
    expect(screen.getByTestId("stitch-curve").compareDocumentPosition(length) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // On the open row a clip that is not selected shows its curve faintly, without its points
    toggle(0);
    act(() => editor().select(null));
    expect(within(musicBox()).getByTestId("stitch-curve").querySelector("polyline")).toHaveClass("stroke-white/35");
    expect(points()).toHaveLength(0);
  });

  it("draws no curve on a clip whose volume is flat at 0 dB until it is selected", () => {
    seed();
    openEditor();
    expect(within(musicBox()).queryByTestId("stitch-curve")).toBeNull();
    click(musicBox());
    expect(within(musicBox()).getByTestId("stitch-curve")).toBeInTheDocument();
  });

  it("grows a row only by its volume-curve toggle, never by a selection", () => {
    seed();
    openEditor();
    // Track: the edge, the ruler, the clips row, one audio row and the strip
    expect(timelineEl().style.height).toBe(`${1 + 28 + 80 + 52 + 28}px`);
    click(musicBox());
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID, point: null });
    expect(rows()[0].style.height).toBe("52px");
    expect(timelineEl().style.height).toBe("189px");
    expect(rail()).toBeInTheDocument();
    const show = screen.getByRole("button", { name: "Show volume curve for Audio 1" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(show);
    expect(editor().audioExpandedRow).toBe(0);
    expect(editor().past).toHaveLength(0);
    expect(rows()[0].style.height).toBe("128px");
    expect(musicBox().style.height).toBe("120px");
    expect(timelineEl().style.height).toBe("265px");
    // The 0 dB and −12 dB guides, labelled in the clip just over each line (−∞ is the block's foot)
    expect(screen.getByTestId("stitch-db-guides")).toBeInTheDocument();
    const labels = within(musicBox()).getAllByTestId("stitch-db-label");
    expect(labels.map((el) => el.textContent)).toEqual(["0 dB", "−12"]);
    const guideYs = [...within(musicBox()).getByTestId("stitch-db-guides").querySelectorAll("line")].map(
      (line) => Number(line.getAttribute("y1")) - 0.5,
    );
    // Each 12px label's foot 1px over its line
    expect(labels.map((el) => parseFloat(el.style.top) + 12 + 1)).toEqual(guideYs);
    // The same button, now the one that hides it
    expect(screen.getByRole("button", { name: "Hide volume curve for Audio 1" })).toBe(show);
    expect(show).toHaveAttribute("aria-expanded", "true");
    // Selecting a video clip leaves the row as it is
    click(screen.getByRole("option", { name: "Clip 1" }), 100, 0);
    expect(rows()[0].style.height).toBe("128px");
    expect(timelineEl().style.height).toBe("265px");
    fireEvent.click(show);
    expect(editor().audioExpandedRow).toBeNull();
    expect(rows()[0].style.height).toBe("52px");
  });

  it("keeps an open row's dB labels in view while the lanes scroll past a clip's start, inside the clip, and draws no guides a clip has no room to name", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    toggle(0);
    const labelLefts = () => within(musicBox()).getAllByTestId("stitch-db-label").map((el) => el.style.left);
    // The music runs from 0:00 for 20 s (1280 px): its labels 14 px in
    expect(labelLefts()).toEqual(["14px", "14px"]);
    // Scrolled 300 px, its start is out of view: the labels stay 14 px past the lanes' side padding, over the
    // guides they name
    const lanes = screen.getByTestId("stitch-lanes");
    lanes.scrollLeft = 300;
    fireEvent.scroll(lanes);
    expect(labelLefts()).toEqual([`${300 + ORIGIN - x(0) + 14}px`, `${300 + ORIGIN - x(0) + 14}px`]);
    expect(within(musicBox()).getByTestId("stitch-db-guides")).toBeInTheDocument();
    // Near its end they keep to the clip, clear of its Out handle, and leave the view with it
    lanes.scrollLeft = 1260;
    fireEvent.scroll(lanes);
    expect(labelLefts()).toEqual([`${20 * PPS - 50}px`, `${20 * PPS - 50}px`]);
    lanes.scrollLeft = 0;
    fireEvent.scroll(lanes);
    expect(labelLefts()).toEqual(["14px", "14px"]);

    // The 3 s tone on its open row: 192 px, named; at 16 px/s (48 px) it has no room for the labels, so no guides
    toggle(1);
    const toneBox = () => box("tone1320.m4a");
    expect(within(toneBox()).getAllByTestId("stitch-db-label")).toHaveLength(2);
    expect(within(toneBox()).getByTestId("stitch-db-guides")).toBeInTheDocument();
    act(() => editor().setZoom(16));
    expect(toneBox().style.width).toBe("48px");
    expect(within(toneBox()).queryByTestId("stitch-db-label")).toBeNull();
    expect(within(toneBox()).queryByTestId("stitch-db-guides")).toBeNull();
    // Its curve still shows when it is selected
    click(toneBox(), ORIGIN + 16 * 2.5, 30);
    expect(within(toneBox()).getByTestId("stitch-curve").querySelector("polyline")).toBeInTheDocument();
  });

  it("moves no box and no row controls when a clip on another row is clicked while row 0 is expanded", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    toggle(0);
    for (let run = 0; run < 5; run++) {
      const before = placesOf();
      click(box("tone1320.m4a"), x(3), 30);
      expect(editor().selection).toMatchObject({ kind: "audio", clipId: "t" });
      expect(placesOf()).toEqual(before);
      click(musicBox());
      expect(placesOf()).toEqual(before);
    }
  });

  it("edits the curve only on the single selected clip of the expanded row", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    toggle(0);
    // Not selected: a press on its line selects it, and adds nothing
    click(musicBox(), x(3), y(1));
    expect(curve()).toEqual([]);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID });
    // Selected with another: still nothing
    click(box("tone1320.m4a"), x(3), 30);
    down(musicBox(), x(4), 30, { shiftKey: true });
    pointer("pointerup", x(4), 30, { shiftKey: true });
    expect(editor().selection).toMatchObject({ kind: "audio", clipIds: [MUSIC_CLIP_ID, "t"] });
    click(musicBox(), x(3), y(1));
    expect(curve()).toEqual([]);
    // The single selection: a press on the line adds a point there
    click(musicBox(), x(3), y(1));
    expect(curve()).toEqual([{ t: 3, gain: 1 }]);
    expect(editor().past).toHaveLength(1);
  });

  it("adds no point on the single selected clip while its row is collapsed", () => {
    seed();
    openEditor();
    click(musicBox());
    for (const clientY of [20, 30, 40]) click(musicBox(), x(3), clientY);
    expect(curve()).toEqual([]);
    expect(editor().past).toHaveLength(0);
    expect(points()).toHaveLength(0);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID, point: null });
  });

  it("places a fade in and a fade out from the rail over the part that is heard, and Flat clears the curve", () => {
    seed();
    openEditor();
    click(musicBox());
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade in" }));
    // The untouched music under a 9 s sequence: exactly the sequence's fades
    expect(curve()).toEqual(fadeIn([], 9));
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade out" }));
    expect(curve()).toEqual(fadeOut(fadeIn([], 9), 9));
    expect(editor().past).toHaveLength(2);
    // Both shapes are pressed now
    for (const name of ["Fade in", "Fade out"]) {
      expect(within(rail()).getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
    }
    fireEvent.click(within(rail()).getByRole("button", { name: "Flat" }));
    expect(curve()).toEqual([]);
    expect(within(rail()).getByRole("button", { name: "Flat" })).toHaveAttribute("aria-pressed", "true");
    expect(within(rail()).getByRole("button", { name: "Fade in" })).toHaveAttribute("aria-pressed", "false");
  });

  it("mutes the music with M when no audio clip is selected, and from its row's controls", () => {
    seed();
    openEditor([{ t: 2, gain: 0.5 }]);
    press("m");
    expect(music().muted).toBe(true);
    // The muted badge is the video clips' icon square, no word; the box's name says it is muted
    const badge = within(musicBox()).getByTestId("stitch-audio-muted");
    expect(badge.textContent).toBe("");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(badge).toHaveClass("h-[18px]", "w-[18px]", "bg-black/60", "text-neutral-300", "top-1.5");
    expect(screen.queryByTestId("stitch-curve")).toBeNull();
    expect(musicBox()).toHaveAccessibleName("score.mp3, Audio 1, starts 0:00.00, muted");
    fireEvent.click(screen.getByRole("button", { name: "Unmute Audio 1" }));
    expect(music().muted).toBe(false);
    expect(editor().past).toHaveLength(2);
    click(musicBox());
    expect(within(rail()).getByRole("switch", { name: "Sound" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(within(rail()).getByRole("switch", { name: "Sound" }));
    expect(music().muted).toBe(true);
    expect(within(rail()).getByRole("button", { name: "Fade in" })).toBeDisabled();
  });

  it("writes the music's curve and mute to the node on Done, with no audioClips key", () => {
    seed();
    openEditor();
    click(musicBox());
    fireEvent.click(within(rail()).getByRole("button", { name: "Fade in" }));
    press("m");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const data = wf().nodes.find((n) => n.id === "stitch")!.data as VideoStitchNodeData;
    expect(data.audioCurve).toEqual(fadeIn([], 9));
    expect(data.audioMuted).toBe(true);
    expect("audioClips" in data).toBe(false);
  });

  it("draws an empty row when there is no audio, \"+ Audio\" under it adding some", () => {
    seed({ music: false });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
    openEditor();
    act(() => editor().setZoom(8));
    // An outline, not the add slots' fill: it cannot be pressed. The node's dialog says audio can come from the node
    const placeholder = screen.getByTestId("stitch-audio-placeholder");
    expect(placeholder).toHaveClass("border-dashed", "border-edit-line", "pointer-events-none");
    expect(placeholder).not.toHaveClass("bg-edit-slot");
    expect(placeholder.textContent).toBe("Connect audio to the node");
    expect(placeholder.style.width).toBe("260px");
    // An edit has no node: the row says nothing, and "+ Audio" is the one way in
    act(() => useStitchEditorStore.setState({ editId: "edit-1" }));
    expect(screen.getByTestId("stitch-audio-placeholder").textContent).toBe("");
    expect(screen.getByTestId("stitch-audio-placeholder")).toHaveAttribute("aria-hidden", "true");
    act(() => useStitchEditorStore.setState({ editId: null }));
    expect(screen.queryAllByRole("option").filter((el) => el.dataset.audioClipId)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^Mute Audio/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /volume curve/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add audio" })).toBeEnabled();
  });

  it("can still unmute a legacy node's muted music that was disconnected", () => {
    seed({ music: false, stitch: { audioMuted: true } });
    openEditor();
    expect(editor().draft!.legacyAudio.muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Unmute Audio 1" }));
    expect(editor().draft!.legacyAudio.muted).toBe(false);
    expect(screen.queryByRole("button", { name: /mute Audio 1/i })).toBeNull();
  });

  it("draws music that is not connected, a file gone from the library and one that cannot be read, dashed", () => {
    seed({
      music: false,
      stitch: {
        audioClips: [
          createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }),
          createAudioClip({ kind: "asset", assetId: GONE }, { id: "g", row: 1 }),
          createAudioClip({ kind: "asset", assetId: BAD }, { id: "b", row: 2 }),
        ],
      },
    });
    act(() => primeAssetInfo([]));
    openEditor();
    act(() => useStitchEditorStore.getState());
    const notConnected = box("No audio connected");
    expect(notConnected).toHaveClass("border-dashed", "border-white/15");
    expect(notConnected.style.width).toBe("160px");
    const broken = box("Can't read this audio");
    expect(broken).toHaveClass("border-dashed", "border-white/25");
    // What is wrong shows at rest
    const words = within(broken).getByText("Can't read this audio");
    expect(words.className).not.toMatch(/opacity-0/);
    expect(broken).not.toHaveAttribute("title");
    // A record length draws it; no handles until the file's own length is read
    expect(broken.style.width).toBe(`${2 * PPS}px`);
    expect(broken.querySelector("[data-trim-handle]")).toBeNull();
    // Each is selectable
    click(notConnected, x(1), 30);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID });
  });

  it("draws a gone library file as not in the library once its record is missing", async () => {
    seed({ stitch: { audioClips: [createAudioClip({ kind: "asset", assetId: GONE }, { id: "g" })] } });
    openEditor();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const gone = box("Not in the library");
    expect(gone).toHaveClass("border-dashed", "border-white/25");
  });

  it("draws boxes with no video yet at 64 px/s, all hatched, and they can be selected", () => {
    seed({ clips: false });
    render(<StitchEditorModal />);
    act(() => openStitchEditor("stitch"));
    expect(musicBox().style.left).toBe(`${x(0)}px`);
    expect(musicBox().style.width).toBe(`${20 * 64}px`);
    expect(within(musicBox()).getByTestId("stitch-audio-after-end").style.left).toBe("0px");
    click(musicBox(), x(1), 30);
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: MUSIC_CLIP_ID });
  });

  it("removes a point on a double-click and selects the one before it, so ⌫ removes points, never the clip", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
      { t: 6, gain: 1 },
    ]);
    editMusic();
    doubleClickAt(x(2), y(0.25));
    expect(curve()).toEqual([
      { t: 0, gain: 1 },
      { t: 6, gain: 1 },
    ]);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0, onCurve: true });
    expect(editor().past).toHaveLength(1);
    press("Backspace");
    expect(curve()).toEqual([{ t: 6, gain: 1 }]);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0 });
    press("Backspace");
    expect(curve()).toEqual([]);
    expect(editor().selection).toMatchObject({ kind: "audio", point: null, onCurve: true });
    // With no point left, ⌫ after a curve gesture removes nothing
    press("Backspace");
    expect(editor().draft!.audioClips).toHaveLength(1);
    // A press on the box's body leaves the curve: ⌫ then removes the clip
    down(musicBox(), x(12), 60);
    pointer("pointerup", x(12), 60);
    expect(editor().selection).toMatchObject({ kind: "audio", onCurve: false });
    press("Backspace");
    expect(editor().draft!.audioClips).toHaveLength(0);
  });

  it("adds one point on a double-click on the line, and does not take it away again", () => {
    seed();
    openEditor();
    editMusic();
    doubleClickAt(x(3), y(1));
    expect(curve()).toEqual([{ t: 3, gain: 1 }]);
    expect(editor().past).toHaveLength(1);
  });

  it("drags a point in one undo step with a readout, and leaves it selected; after ⌘Z, ⌫ removes nothing", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
      { t: 6, gain: 1 },
    ]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(3), y(1));
    // The drag is local: the draft has not moved, the readout follows the point
    expect(curve()[1]).toEqual({ t: 2, gain: 0.25 });
    const readout = screen.getByTestId("stitch-curve-readout");
    expect(readout).toHaveTextContent("0.0 dB");
    expect(readout).toHaveTextContent("0:03.00");
    pointer("pointerup", x(3), y(1));
    expect(curve()).toEqual([
      { t: 0, gain: 1 },
      { t: 3, gain: 1 },
      { t: 6, gain: 1 },
    ]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 1 });
    expect(screen.queryByTestId("stitch-curve-readout")).toBeNull();
    press("z", { metaKey: true });
    expect(curve()[1]).toEqual({ t: 2, gain: 0.25 });
    expect(editor().selection).toMatchObject({ kind: "audio", point: null });
    press("Backspace");
    expect(curve()).toHaveLength(3);
  });

  it("adds a point on the line where it is clicked, with an Add point hint on hover", () => {
    seed();
    openEditor();
    editMusic();
    fireEvent.pointerMove(musicBox(), { clientX: x(3), clientY: y(1) + 2 });
    expect(screen.getByTestId("stitch-add-point")).toHaveTextContent("Add point");
    fireEvent.pointerMove(musicBox(), { clientX: x(3), clientY: y(0.25) });
    expect(screen.queryByTestId("stitch-add-point")).toBeNull();
    click(musicBox(), x(1), y(1) + 3);
    expect(curve()).toEqual([{ t: 1, gain: 1 }]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0, onCurve: true });
  });

  it("moves the whole line with ⌥ held, leaving no point selected", () => {
    seed();
    openEditor();
    editMusic();
    down(musicBox(), x(2), 40, { altKey: true });
    pointer("pointermove", x(2), 40 + 45);
    pointer("pointerup", x(2), 40 + 45);
    // An empty curve becomes two points across the clip's window, both at the new level
    expect(curve()).toEqual([
      { t: 0, gain: expect.closeTo(0.25) },
      { t: 20, gain: expect.closeTo(0.25) },
    ]);
    expect(editor().past).toHaveLength(1);
    expect(editor().selection).toMatchObject({ kind: "audio", point: null, onCurve: true });
  });

  it("cancels a point drag on Escape, leaving the curve and the editor as they were", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(5), y(1));
    press("Escape");
    pointer("pointerup", x(5), y(1));
    expect(curve()).toEqual([{ t: 2, gain: 0.25 }]);
    expect(editor().past).toHaveLength(0);
    expect(editor().isOpen).toBe(true);
    expect(editor().discardOpen).toBe(false);
  });

  it("drops a release onto a curve that changed under the drag", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(4), y(1));
    act(() =>
      editor().apply((d) => ({
        ...d,
        audioClips: d.audioClips.map((c) => ({ ...c, curve: [{ t: 1, gain: 0.5 }] })),
      })),
    );
    pointer("pointerup", x(4), y(1));
    expect(curve()).toEqual([{ t: 1, gain: 0.5 }]);
  });

  it("takes a click on the steep part of an instant step as a press on its point, removing nothing", () => {
    seed();
    const step = [
      { t: 0, gain: 1 },
      { t: 5, gain: 1 },
      { t: 5.01, gain: 0.25 },
      { t: 9, gain: 0.25 },
    ];
    openEditor(step);
    editMusic();
    const midY = (y(1) + y(0.25)) / 2;
    fireEvent.pointerMove(musicBox(), { clientX: x(5.005), clientY: midY });
    expect(screen.queryByTestId("stitch-add-point")).toBeNull();
    click(musicBox(), x(5.005), midY);
    expect(curve()).toEqual(step);
    expect(editor().past).toHaveLength(0);
    expect(editor().selection).toMatchObject({ kind: "audio", point: expect.any(Number) });
  });

  it("keeps a dragged point under the pointer when the lanes scroll mid-drag", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(2) + 10, y(0.25));
    // The lanes scroll 2 s to the left with the pointer held still: it is now over t = 4 + 10px
    vi.spyOn(content(), "getBoundingClientRect").mockReturnValue(rect(-2 * PPS, 0));
    act(() => {
      screen.getByTestId("stitch-lanes").dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByTestId("stitch-curve-readout")).toHaveTextContent(/0:04\.1\d/);
    pointer("pointerup", x(2) + 10, y(0.25));
    expect(curve()[0].t).toBeCloseTo(4 + 10 / PPS);
  });

  it("does not move a point a click nudges by a pixel, and shows a grab cursor over a point", () => {
    seed();
    openEditor([{ t: 2, gain: 0.25 }]);
    editMusic();
    fireEvent.pointerMove(musicBox(), { clientX: x(2), clientY: y(0.25) });
    expect(musicBox()).toHaveClass("cursor-grab");
    fireEvent.pointerMove(musicBox(), { clientX: x(5), clientY: y(0.25) + 1 });
    expect(musicBox()).toHaveClass("cursor-pointer");
    expect(screen.getByTestId("stitch-add-point").style.left).toBe(`${x(5) + 6}px`);
    down(musicBox(), x(2), y(0.25));
    pointer("pointermove", x(2) + 1, y(0.25) + 1);
    pointer("pointerup", x(2) + 1, y(0.25) + 1);
    expect(curve()).toEqual([{ t: 2, gain: 0.25 }]);
    expect(editor().past).toHaveLength(0);
    expect(editor().selection).toMatchObject({ kind: "audio", point: 0 });
  });

  it("does not remove a point it no longer shows: ⌫ after M leaves the curve alone", () => {
    seed();
    openEditor([
      { t: 0, gain: 1 },
      { t: 2, gain: 0.25 },
    ]);
    editMusic();
    click(musicBox(), x(2), y(0.25));
    expect(editor().selection).toMatchObject({ kind: "audio", point: 1 });
    press("m");
    expect(editor().selection).toMatchObject({ kind: "audio", point: null });
    act(() => editor().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID }, 1, true)));
    press("Backspace");
    expect(curve()).toHaveLength(2);
    expect(editor().past).toHaveLength(1);
  });

  it("moves a clip onto the strip as a new row: no row changes before release, one undo step after", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    const heights = () => rows().map((row) => `${row.style.top}/${row.style.height}`);
    const before = heights();
    const foot = () => screen.getByTestId("stitch-timeline-foot");
    expect(foot()).not.toHaveClass("invisible");
    // Row 1's block centre is at 74 in the rows; the strip starts at 104
    down(box("tone1320.m4a"), x(3), 74);
    pointer("pointermove", x(3), 74 + 20);
    expect(heights()).toEqual(before);
    expect(foot()).not.toHaveClass("invisible");
    pointer("pointermove", x(3), 74 + 40);
    expect(heights()).toEqual(before);
    expect(screen.getByTestId("stitch-audio-new-row")).toHaveTextContent("New row");
    expect(screen.getByTestId("stitch-audio-move-chip")).toHaveTextContent("New row");
    // "+ Audio" gives the strip to "New row" while the clip would land there
    expect(foot()).toHaveClass("invisible");
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.row).toBe(1);
    pointer("pointerup", x(3), 74 + 40);
    expect(screen.queryByTestId("stitch-audio-new-row")).toBeNull();
    expect(foot()).not.toHaveClass("invisible");
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.row).toBe(2);
    expect(editor().past).toHaveLength(1);
    // The emptied row stays, so nothing moved up under the pointer
    expect(rows()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Mute Audio 2" })).toBeDisabled();
  });

  it("marks where an overlap inserts a row, and lands there", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 }), tone("u", { row: 2, startSec: 0 })] } });
    openEditor();
    const rowBoxes = () => rows().map((row) => [row.style.top, row.style.height]);
    const before = rowBoxes();
    const u = within(lane()).getAllByRole("option").find((el) => el.dataset.audioClipId === "u")!;
    // Row 2's block centre (126) up to row 0's (22)
    down(u, x(1), 126);
    pointer("pointermove", x(1), 126 - 104);
    const line = screen.getByTestId("stitch-audio-insertion");
    // Under row 0 (52px), in the 8px gap between its block and the next row
    expect(line.style.top).toBe(`${52 - 4 - 1.5}px`);
    // Nothing moves before the release
    expect(rowBoxes()).toEqual(before);
    pointer("pointerup", x(1), 126 - 104);
    const clips = editor().draft!.audioClips;
    expect(clips.find((c) => c.id === "u")!.row).toBe(1);
    expect(clips.find((c) => c.id === "t")!.row).toBe(2);
    expect(clips.find((c) => c.id === MUSIC_CLIP_ID)!.row).toBe(0);
    expect(editor().past).toHaveLength(1);
  });

  it("moves a clip in time by the drag, and Escape puts it back", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    down(box("tone1320.m4a"), x(3), 74);
    pointer("pointermove", x(3) + PPS, 74, { shiftKey: true });
    expect(screen.getByTestId("stitch-audio-move-chip")).toHaveTextContent("0:03.00–0:06.00 · +1.00 s");
    press("Escape");
    pointer("pointerup", x(3) + PPS, 74);
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.startSec).toBe(2);
    expect(editor().past).toHaveLength(0);
    down(box("tone1320.m4a"), x(3), 74);
    pointer("pointermove", x(3) + PPS, 74, { shiftKey: true });
    pointer("pointerup", x(3) + PPS, 74, { shiftKey: true });
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.startSec).toBeCloseTo(3);
    expect(editor().past).toHaveLength(1);
  });

  it("trims a clip's In with its sound kept in place", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    click(box("tone1320.m4a"), x(3), 74);
    const handle = box("tone1320.m4a").querySelector<HTMLElement>('[data-trim-handle="in"]')!;
    fireEvent.pointerDown(handle, { button: 0, clientX: x(2), clientY: 74, pointerId: 1, shiftKey: true });
    pointer("pointermove", x(2) + 32, 74, { shiftKey: true });
    expect(screen.getByTestId("stitch-audio-trim-chip")).toHaveTextContent("In 0:00.50");
    pointer("pointerup", x(2) + 32, 74, { shiftKey: true });
    expect(editor().draft!.audioClips.find((c) => c.id === "t")).toMatchObject({ inSec: 0.5, startSec: 2.5, outSec: null });
    expect(editor().past).toHaveLength(1);
  });

  it("moves the selection along the audio clips with the arrows, Home and End", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 }), tone("u", { row: 1, startSec: 6 })] } });
    openEditor();
    click(musicBox());
    act(() => musicBox().focus());
    const key = (k: string) => fireEvent.keyDown(lane(), { key: k });
    key("ArrowRight");
    expect(editor().selection).toMatchObject({ kind: "audio", clipId: "t" });
    expect(document.activeElement).toBe(box("tone1320.m4a, Audio 2, starts 0:02"));
    key("End");
    expect(editor().selection).toMatchObject({ clipId: "u" });
    key("Home");
    expect(editor().selection).toMatchObject({ clipId: MUSIC_CLIP_ID });
    // ↓: the clip on the row below whose start is nearest
    act(() => editor().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID })));
    key("ArrowDown");
    expect(editor().selection).toMatchObject({ clipId: "t" });
    key("ArrowUp");
    expect(editor().selection).toMatchObject({ clipId: MUSIC_CLIP_ID });
  });

  it("decodes the music for its waveform when the cache has none", async () => {
    seed();
    __resetWaveformForTests();
    const decode = vi.fn(async () => ({ channels: [new Float32Array(64).fill(0.5)], duration: 20 }));
    __setWaveformDecoderForTests(decode);
    openEditor();
    expect(decode).toHaveBeenCalledWith("blob:m");
    expect(screen.queryByTestId("stitch-waveform")).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(within(musicBox()).getByTestId("stitch-waveform")).toBeInTheDocument();
  });
});

describe("Audio row controls", () => {
  /** A row's floating group (its mute over its volume-curve toggle). */
  const group = (row: number) => document.querySelector<HTMLElement>(`[data-audio-row-controls="${row}"]`)!;
  const shown = (row: number) => group(row).classList.contains("opacity-100") && group(row).classList.contains("pointer-events-auto");
  /** jsdom lays nothing out: the controls' layer is given its place, the rows' view from y 200. */
  const placeLayer = () => {
    const layer = screen.getByTestId("stitch-audio-controls").parentElement!;
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
      ...rect(0, 200),
      right: 20,
      bottom: 304,
      width: 20,
      height: 104,
    } as DOMRect);
  };

  it("shows a row's group while the pointer is over the row, anywhere across the lanes, and none during a drag", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    placeLayer();
    expect(shown(0)).toBe(false);
    expect(shown(1)).toBe(false);
    fireEvent.pointerMove(timelineEl(), { clientX: 600, clientY: 200 + 10 });
    expect(shown(0)).toBe(true);
    expect(shown(1)).toBe(false);
    fireEvent.pointerMove(timelineEl(), { clientX: 900, clientY: 200 + 52 + 10 });
    expect(shown(0)).toBe(false);
    expect(shown(1)).toBe(true);
    // A drag that started elsewhere (a held button) shows none
    fireEvent.pointerMove(timelineEl(), { clientX: 900, clientY: 200 + 52 + 12, buttons: 1 });
    expect(shown(1)).toBe(false);
    fireEvent.pointerMove(timelineEl(), { clientX: 900, clientY: 200 + 52 + 12 });
    expect(shown(1)).toBe(true);
    fireEvent.pointerLeave(timelineEl());
    expect(shown(1)).toBe(false);
    // Hidden, a group keeps its labels and its tab stops: keyboard focus inside it shows it
    for (const row of [0, 1]) {
      expect(group(row)).toHaveClass("opacity-0", "focus-within:opacity-100", "focus-within:pointer-events-auto");
      for (const button of within(group(row)).getAllByRole("button")) expect(button).not.toHaveAttribute("tabindex");
    }
    expect(within(group(1)).getByRole("button", { name: "Mute Audio 2" })).toBeInTheDocument();
    // Named for its row, as the mute is, so a list of buttons tells the rows' toggles apart
    expect(within(group(1)).getByRole("button", { name: "Show volume curve for Audio 2" })).toBeInTheDocument();
    expect(within(group(0)).getByRole("button", { name: "Show volume curve for Audio 1" })).toBeInTheDocument();
  });

  it("keeps the group a press started on until its release, so a click whose pointer drifts still lands", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    placeLayer();
    fireEvent.pointerMove(timelineEl(), { clientX: 10, clientY: 200 + 52 + 20 });
    expect(shown(1)).toBe(true);
    const mute = within(group(1)).getByRole("button", { name: "Mute Audio 2" });
    fireEvent.pointerDown(mute, { button: 0, clientX: 10, clientY: 200 + 52 + 20, pointerId: 1 });
    // A 1px drift with the button held: the group stays, and with it its pointer events
    fireEvent.pointerMove(timelineEl(), { clientX: 11, clientY: 200 + 52 + 21, buttons: 1 });
    expect(shown(1)).toBe(true);
    pointer("pointerup", 11, 200 + 52 + 21);
    fireEvent.click(mute);
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.muted).toBe(true);
    // Released, a held button hides it again
    fireEvent.pointerMove(timelineEl(), { clientX: 11, clientY: 200 + 52 + 21, buttons: 1 });
    expect(shown(1)).toBe(false);
  });

  it("shows the group of the focused clip's row, following the clip when ⌥↓ moves it to another row", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    const t = () => box("tone1320.m4a");
    click(t(), x(3), 74);
    act(() => t().focus());
    expect(shown(1)).toBe(true);
    expect(shown(0)).toBe(false);
    act(() => {
      t().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    });
    expect(editor().draft!.audioClips.find((c) => c.id === "t")!.row).toBe(2);
    expect(document.activeElement).toBe(t());
    expect(shown(2)).toBe(true);
    expect(shown(1)).toBe(false);
    // Focus leaving the timeline hides it
    act(() => (document.activeElement as HTMLElement).blur());
    expect(shown(2)).toBe(false);
  });

  it("keeps the open row's group shown, at the foot of its block so the toggle stays under the pointer", () => {
    seed({ stitch: { audioClips: [tone("t", { row: 1, startSec: 2 })] } });
    openEditor();
    // Its bottom 8px over the row's foot: 52 − 8 − 34 (two 16px controls, 2px apart)
    expect(group(0).style.top).toBe("10px");
    expect(group(1).style.top).toBe(`${52 + 10}px`);
    // 2px in from the timeline's edge, so their focus rings clear the hairline beside it and the playhead at 0:00
    // (20px in): 2 + 16 leaves 2px
    expect(group(0).style.left).toBe("2px");
    for (const control of within(group(0)).getAllByRole("button")) {
      expect(control.style.width).toBe("16px");
      expect(control).toHaveClass("focus-visible:ring-inset");
    }
    toggle(0);
    expect(shown(0)).toBe(true);
    fireEvent.pointerLeave(timelineEl());
    expect(shown(0)).toBe(true);
    // The open row is 128px: its group moved down with the row's foot, and row 1's with its row
    expect(group(0).style.top).toBe(`${128 - 8 - 34}px`);
    expect(group(1).style.top).toBe(`${128 + 10}px`);
    toggle(0);
    expect(shown(0)).toBe(false);
    expect(group(0).style.top).toBe("10px");
  });
});
