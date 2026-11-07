import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { MUSIC_CLIP_ID } from "@/lib/stitch/audioClips";
import {
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  __setMediaInfoForTests,
  mediaKeyOf,
} from "@/lib/stitch/mediaInfo";
import { __resetAssetInfoForTests } from "@/lib/stitch/assetInfo";
import type { FrameCapture, FrameCaptureJob } from "@/lib/stitch/frameCapture";
import type { WorkflowEdge, WorkflowNode } from "@/types";
import { StitchEditorModal } from "../StitchEditorModal";
import { openStitchEditor } from "../openStitchEditor";
import { setSequenceMode } from "../editorActions";
import { frameButtonState, type FrameButtonInput } from "../FrameToCanvasButton";
import { __resetFramePlacementForTests } from "../frameToCanvas";

const { capture } = vi.hoisted(() => ({ capture: vi.fn<(job: FrameCaptureJob) => Promise<FrameCapture>>() }));
vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));
vi.mock("@/lib/stitch/frameCapture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/stitch/frameCapture")>()),
  captureSequenceFrame: (job: FrameCaptureJob) => capture(job),
}));
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

const READY: FrameButtonInput = { busy: false, clipCount: 2, loading: false, hasVideo: true, gap: false };

describe("frameButtonState", () => {
  it("is ready with clips, loaded, a video and something under the playhead", () => {
    expect(frameButtonState(READY)).toEqual({ enabled: true, busy: false, reason: null });
  });

  it.each([
    [{ busy: true }, { enabled: false, busy: true, reason: "Adding the frame…" }],
    [{ clipCount: 0 }, { enabled: false, busy: false, reason: "Add clips to grab a frame" }],
    [{ loading: true }, { enabled: false, busy: false, reason: "Waiting for the clips to load" }],
    [{ hasVideo: false }, { enabled: false, busy: false, reason: "No clip has a video yet" }],
    [{ gap: true }, { enabled: false, busy: false, reason: "Nothing plays at the playhead" }],
  ])("%o → %o", (patch, state) => {
    expect(frameButtonState({ ...READY, ...patch })).toEqual(state);
  });

  it("takes the first row that applies", () => {
    // Busy over Gap: scrubbing into a gap mid-capture keeps the spinner and focus
    expect(frameButtonState({ ...READY, busy: true, gap: true }).busy).toBe(true);
    expect(frameButtonState({ ...READY, loading: true, hasVideo: false }).reason).toBe("Waiting for the clips to load");
    expect(frameButtonState({ ...READY, clipCount: 0, loading: true, hasVideo: false, gap: true }).reason).toBe(
      "Add clips to grab a frame",
    );
  });
});

// The button in the modal, against the real stores and media hooks; the capture is mocked.

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

function seed({
  clips = true,
  outputs = true,
  ready = ["a", "b"],
}: { clips?: boolean; outputs?: boolean; ready?: Array<"a" | "b"> } = {}) {
  useWorkflowStore.setState({
    nodes: [
      node("gen-a", "generateVideo", outputs ? { outputVideo: "blob:a" } : {}),
      node("gen-b", "generateVideo", outputs ? { outputVideo: "blob:b" } : {}),
      node("gen-m", "generateAudio", { outputAudio: "blob:m" }),
      node("stitch", "videoStitch", { clips: [], clipOrder: [], outputVideo: null, loopCount: 1, status: "idle" }),
    ],
    edges: [
      ...(clips ? [edge("eA", "gen-a", "video-0"), edge("eB", "gen-b", "video-1")] : []),
      { id: "eM", source: "gen-m", target: "stitch", sourceHandle: "audio", targetHandle: "audio" },
    ],
    openModalCount: 0,
    isModalOpen: false,
  });
  if (ready.includes("a")) __setMediaInfoForTests(mediaKeyOf("blob:a"), { duration: 5, width: 1920, height: 1080, fps: 24 });
  if (ready.includes("b")) __setMediaInfoForTests(mediaKeyOf("blob:b"), { duration: 4, width: 1280, height: 720, fps: 24 });
}

function openEditor() {
  render(<StitchEditorModal />);
  act(() => {
    openStitchEditor("stitch");
  });
  return screen.getByRole("dialog", { name: "Edit video" });
}

const frameButton = () => screen.getByRole("button", { name: /^(Frame to canvas|Adding frame…)$/ });

/** The button's hover label. */
const hoverLabel = () => frameButton().parentElement!.querySelector<HTMLElement>(":scope > [aria-hidden='true']")!;

/** Why the button is off: its accessible description, and its hover label after the button's name. */
function expectReason(reason: string) {
  expect(frameButton()).toHaveAccessibleDescription(reason);
  expect(hoverLabel().firstChild).toHaveTextContent(/^Frame to canvas$/);
  expect(within(hoverLabel()).getByText(reason)).toBeInTheDocument();
}

/** Stacked and placed: clip 1 at 0–5 s, clip 2 at 7–11 s, a gap between. */
function placeWithGap() {
  act(() => {
    setSequenceMode("stacked");
    editor().apply((d) => ({ ...d, timeline: d.timeline.map((c, i) => ({ ...c, startSec: i === 0 ? 0 : 7 })) }));
  });
}

const settled = (job: FrameCaptureJob): FrameCapture => ({
  blob: new Blob(["png"], { type: "image/png" }),
  width: job.size.width,
  height: job.size.height,
  plan: { slot: 0, route: "track", sources: [], show: { kind: "layers", layers: [] } },
  drawn: [],
});

beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  wf().clearWorkflow();
  editor().close();
  __resetMediaInfoForTests();
  __resetAssetInfoForTests();
  __resetFramePlacementForTests();
  __setMediaExtractorForTests({ probe: () => new Promise(() => {}), open: () => new Promise(() => {}) });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  capture.mockReset();
  capture.mockImplementation(async (job) => settled(job));
  useWorkflowStore.setState({ recordUiAsset: vi.fn(() => []) });
});

afterEach(() => {
  act(() => editor().close());
  __setMediaExtractorForTests(null);
  __resetMediaInfoForTests();
  vi.restoreAllMocks();
});

describe("FrameToCanvasButton", () => {
  it("is the same button whatever is selected", () => {
    seed();
    openEditor();
    const button = frameButton();
    const ids = editor().draft!.timeline.map((c) => c.id);
    const selections = [
      { kind: "clip" as const, clipId: ids[1] },
      audioSelectionOf({ clipId: MUSIC_CLIP_ID }),
      null,
      { kind: "clip" as const, clipId: ids[0], clipIds: ids, anchorId: ids[0] },
    ];
    for (const selection of selections) {
      act(() => editor().select(selection));
      expect(frameButton()).toBe(button);
      expect(button).toBeEnabled();
    }
    // Several clips and the audio track each had their own rail body meanwhile; the button is the control row's,
    // under the video, never the rail's
    const rail = screen.getByRole("complementary", { name: "Clip" });
    expect(within(rail).getByText("2 clips")).toBeInTheDocument();
    expect(rail).not.toContainElement(button);
    expect(screen.getByTestId("stitch-controls")).toContainElement(button);
    act(() => editor().select(audioSelectionOf({ clipId: MUSIC_CLIP_ID })));
    expect(screen.getByRole("complementary", { name: "Audio clip" })).not.toContainElement(button);
    expect(screen.getByTestId("stitch-controls")).toContainElement(button);
    // An icon button with its hover label
    expect(button).toHaveTextContent("");
    expect(button.parentElement!.querySelector(":scope > [aria-hidden='true']")).toHaveTextContent("Frame to canvas");
  });

  it("is ready while the preview plays, and the press pauses it", async () => {
    seed();
    openEditor();
    act(() => editor().setPlaying(true));
    expect(frameButton()).toBeEnabled();
    await act(async () => {
      fireEvent.click(frameButton());
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(editor().playing).toBe(false);
  });

  it("captures at the sequence's size, as the header's menu gives it", async () => {
    seed();
    openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Edit menu" }));
    expect(screen.getByRole("menu", { name: "Edit menu" })).toHaveAccessibleDescription(/ · 1920 × 1080 · 24 fps$/);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    await act(async () => {
      fireEvent.click(frameButton());
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(capture.mock.calls[0][0].size).toEqual({ width: 1920, height: 1080 });
    await vi.waitFor(() => expect(wf().nodes.filter((n) => n.type === "imageInput")).toHaveLength(1));
  });

  it("stays focused and ignores clicks while busy, also when the playhead moves into a gap", async () => {
    let finish: () => void = () => {};
    capture.mockImplementation(
      (job) =>
        new Promise<FrameCapture>((resolve) => {
          finish = () => resolve(settled(job));
        }),
    );
    seed();
    openEditor();
    placeWithGap();
    act(() => editor().setPlayhead(1));
    const button = frameButton();
    button.focus();
    fireEvent.click(button);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));

    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toHaveAttribute("disabled");
    expect(button).toHaveAccessibleName("Adding frame…");
    expect(button).toHaveAccessibleDescription("Adding the frame…");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);

    act(() => editor().setPlayhead(6));
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).not.toHaveAttribute("disabled");
    expect(document.activeElement).toBe(button);

    await act(async () => finish());
    await vi.waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(capture).toHaveBeenCalledTimes(1);
    // Back in the gap now that it is idle
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Nothing plays at the playhead");
  });

  it("lets Enter activate it and keeps Space for play", async () => {
    seed();
    openEditor();
    const button = frameButton();
    button.focus();

    // Space plays; its keyup is held back so the focused button never clicks
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(space);
    });
    expect(editor().playing).toBe(true);
    const spaceUp = new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true });
    button.dispatchEvent(spaceUp);
    expect(spaceUp.defaultPrevented).toBe(true);
    act(() => editor().setPlaying(false));
    // Stands in for the browser, which would click on an unprevented keyup; jsdom never does
    expect(capture).not.toHaveBeenCalled();

    // Enter is left to the button (jsdom does not turn it into a click, so the click follows by hand)
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    act(() => {
      button.dispatchEvent(enter);
    });
    expect(enter.defaultPrevented).toBe(false);
    expect(editor().playing).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
  });

  it("is off with no clips, in the inert control row under the empty stage that says how to add them", () => {
    seed({ clips: false });
    openEditor();
    expect(frameButton()).toBeDisabled();
    // Nothing in the row can be hovered or focused: the empty frame explains instead
    expect(frameButton().closest("[inert]")).toContainElement(screen.getByTestId("stitch-controls"));
    expect(screen.getByText("No clips yet")).toBeInTheDocument();
  });

  it("is off while a clip is still loading", () => {
    seed({ ready: ["a"] });
    openEditor();
    expect(frameButton()).toBeDisabled();
    expectReason("Waiting for the clips to load");
  });

  it("is off while no clip has a video", () => {
    seed({ outputs: false });
    openEditor();
    expect(frameButton()).toBeDisabled();
    expectReason("No clip has a video yet");
  });

  it("is off while every clip's video failed to read", async () => {
    seed({ ready: [] });
    __setMediaExtractorForTests({ probe: () => Promise.reject(new Error("bad")), open: () => Promise.reject(new Error("bad")) });
    openEditor();
    await vi.waitFor(() => expectReason("No clip has a video yet"));
    expect(frameButton()).toBeDisabled();
  });

  it("is off in a gap and on again past it", () => {
    seed();
    openEditor();
    placeWithGap();
    act(() => editor().setPlayhead(6));
    expect(frameButton()).toBeDisabled();
    expectReason("Nothing plays at the playhead");
    fireEvent.click(frameButton());
    expect(capture).not.toHaveBeenCalled();
    act(() => editor().setPlayhead(8));
    expect(frameButton()).toBeEnabled();
    expect(frameButton()).not.toHaveAttribute("aria-describedby");
    expect(hoverLabel()).toHaveTextContent(/^Frame to canvas$/);
  });
});
