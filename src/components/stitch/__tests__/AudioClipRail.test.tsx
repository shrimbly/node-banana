import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { audioSelectionOf, useStitchEditorStore } from "@/store/stitchEditorStore";
import { createAudioClip, MUSIC_CLIP_ID, type AudioSourceKey } from "@/lib/stitch/audioClips";
import type { StitchDraft } from "@/lib/stitch/draft";
import { DEFAULT_SEQUENCE_LAYOUT } from "@/lib/stitch/stack";
import { createClip, type SourceKey } from "@/lib/stitch/timeline";
import type { StitchAudioClip } from "@/types";
import { AudioClipRail } from "../AudioClipRail";
import type { AudioClipView } from "../useStitchEditorMedia";

vi.mock("@/components/Toast", () => ({ useToast: { getState: () => ({ show: vi.fn() }) } }));

// The rail for selected audio clips, against the real editor store. The views stand in for useStitchEditorMedia's.

const TONE = "atone00000001";
const editor = () => useStitchEditorStore.getState();
const tone = (id: string, init: Partial<StitchAudioClip> = {}) => createAudioClip({ kind: "asset", assetId: TONE }, { id, ...init });

function view(clip: StitchAudioClip, init: Partial<AudioClipView> = {}): AudioClipView {
  const music = clip.source.kind === "music";
  return {
    clipId: clip.id,
    key: (music ? "music" : `asset:${TONE}`) as AudioSourceKey,
    source: clip.source,
    src: music ? "blob:m" : `/api/assets/${TONE}/file`,
    mediaKey: null,
    fileName: music ? "score.mp3" : "tone1320.m4a",
    railSource: music ? { kind: "Audio input", detail: null } : { kind: "Library", detail: "Kling 3" },
    duration: music ? 20 : 3,
    recordDuration: music ? null : 3,
    status: "ready",
    missing: false,
    ...init,
  };
}

function open(audioClips: StitchAudioClip[], decoded = true) {
  // A 10 s video under the audio, so the clips are heard
  const draft: StitchDraft = {
    timeline: [createClip({ kind: "edge", edgeId: "e1" }, { id: "c1" })],
    audioClips,
    legacyAudio: { curve: [], muted: false },
    loopCount: 1,
    sequenceLayout: DEFAULT_SEQUENCE_LAYOUT,
  };
  act(() => {
    editor().open({ nodeId: "stitch", draft, canvasGeneration: 1 });
    editor().setDurations(new Map<SourceKey, number>([["edge:e1", 10]]));
    if (decoded) editor().setAudioDurations(new Map<AudioSourceKey, number>([["music", 20], [`asset:${TONE}`, 3]]));
  });
}

const clipsNow = () => editor().draft!.audioClips;
function renderRail(ids: string[], init: Partial<AudioClipView> = {}) {
  const clips = clipsNow().filter((c) => ids.includes(c.id));
  const views = new Map(clipsNow().map((c) => [c.id, view(c, init)]));
  return render(<AudioClipRail clips={clips} views={views} />);
}

beforeEach(() => {
  act(() => editor().close());
});
afterEach(() => {
  act(() => editor().close());
});

describe("AudioClipRail", () => {
  it("shows one clip's row, name, source and length, its Start and trim fields, its sound, the curve's shapes and its actions", () => {
    open([createAudioClip({ kind: "music" }, { id: MUSIC_CLIP_ID }), tone("t", { row: 1, startSec: 2, inSec: 0.5 })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    renderRail(["t"]);
    // The row is the title; under it the file, then the source and the trimmed length of the file's
    expect(screen.getByText("Audio 2")).toBeInTheDocument();
    expect(screen.getByText("tone1320.m4a")).toBeInTheDocument();
    expect(screen.getByText("Library · Kling 3 · 2.50 s of 3.00 s")).toBeInTheDocument();
    // Start, In and Out side by side, in that order
    const fields = screen.getByRole("textbox", { name: "Start on the timeline" }).closest("label")!.parentElement!;
    expect([...fields.querySelectorAll("input")].map((input) => input.value)).toEqual(["0:02.00", "0:00.50", "0:03.00"]);
    expect(screen.getByRole("switch", { name: "Sound" })).toHaveAttribute("aria-checked", "true");
    for (const name of ["Fade in", "Fade out", "Split at playhead", "Reset trim", "Remove clip"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    // The curve has no points: Flat is the pressed shape
    const curve = screen.getByRole("group", { name: "Volume curve" });
    expect(within(curve).getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["Flat", "true"],
      ["Fade in", "false"],
      ["Fade out", "false"],
    ]);
    // The playhead (0:00) is not inside the clip
    expect(screen.getByRole("button", { name: "Split at playhead" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset trim" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove clip" })).toHaveAttribute("aria-keyshortcuts", "Backspace");
  });

  it("presses the shapes the curve has, Flat leaves a flat curve as it is, and Reset trim shows only while trimmed", () => {
    open([tone("t", { startSec: 2, curve: [{ t: 0, gain: 0 }, { t: 1, gain: 1 }, { t: 2, gain: 1 }, { t: 3, gain: 0 }] })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    const { rerender } = renderRail(["t"]);
    const again = () => {
      const views = new Map(clipsNow().map((c) => [c.id, view(c)]));
      rerender(<AudioClipRail clips={clipsNow()} views={views} />);
    };
    const pressed = () =>
      within(screen.getByRole("group", { name: "Volume curve" }))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent);
    // A fade in and a fade out at once
    expect(pressed()).toEqual(["Fade in", "Fade out"]);
    expect(screen.getByText("Library · Kling 3 · 3.00 s")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset trim" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Flat" }));
    expect(clipsNow()[0].curve).toEqual([]);
    expect(editor().past).toHaveLength(1);
    again();
    expect(pressed()).toEqual(["Flat"]);
    // Pressed already: no step
    fireEvent.click(screen.getByRole("button", { name: "Flat" }));
    expect(editor().past).toHaveLength(1);
  });

  it("presses a fade only while it is heard: not on a split's right piece, nor once a trim has cut it away", () => {
    open([tone("t", { startSec: 2 })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    const { rerender } = renderRail(["t"]);
    // The selected clip's rail, as the editor shows it
    const showSelected = () => {
      const id = editor().selection!.kind === "audio" ? (editor().selection as { clipId: string }).clipId : "";
      const views = new Map(clipsNow().map((c) => [c.id, view(c)]));
      rerender(<AudioClipRail clips={clipsNow().filter((c) => c.id === id)} views={views} />);
    };
    const pressed = () =>
      within(screen.getByRole("group", { name: "Volume curve" }))
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true")
        .map((b) => b.textContent);
    fireEvent.click(screen.getByRole("button", { name: "Fade in" }));
    showSelected();
    expect(pressed()).toEqual(["Fade in"]);
    // Split 1.5 s in, past the 1 s ramp: both pieces keep the curve, but the right one starts at full volume
    act(() => editor().setPlayhead(3.5));
    showSelected();
    fireEvent.click(screen.getByRole("button", { name: "Split at playhead" }));
    const right = clipsNow().find((c) => c.startSec === 3.5)!;
    expect(right.curve).toEqual(clipsNow().find((c) => c.id === "t")!.curve);
    act(() => editor().select(audioSelectionOf({ clipId: right.id })));
    showSelected();
    expect(pressed()).toEqual([]);
    // The left piece still starts from silence; trimmed past the ramp, it no longer does
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    showSelected();
    expect(pressed()).toEqual(["Fade in"]);
    const well = screen.getByRole("textbox", { name: "In" });
    fireEvent.focus(well);
    fireEvent.change(well, { target: { value: "0:01.20" } });
    fireEvent.keyDown(well, { key: "Enter" });
    showSelected();
    expect(pressed()).toEqual([]);
    // Off, the switch's track is the board's dark grey
    expect(screen.getByRole("switch", { name: "Sound" })).toHaveClass("bg-neutral-100");
    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    showSelected();
    expect(screen.getByRole("switch", { name: "Sound" })).toHaveClass("bg-edit-switch-off");
  });

  it("acts on the clip: Start, mute, Fade in and Remove", () => {
    open([tone("t", { startSec: 2 })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    const { rerender } = renderRail(["t"]);
    const again = () => {
      const views = new Map(clipsNow().map((c) => [c.id, view(c)]));
      rerender(<AudioClipRail clips={clipsNow().filter((c) => c.id === "t")} views={views} />);
    };
    const start = screen.getByRole("textbox", { name: "Start on the timeline" });
    fireEvent.focus(start);
    fireEvent.change(start, { target: { value: "0:04.00" } });
    fireEvent.keyDown(start, { key: "Enter" });
    expect(clipsNow()[0].startSec).toBe(4);
    again();
    // In moves the start with it (the sound stays put); Out keeps it
    const commit = (name: string, value: string) => {
      const well = screen.getByRole("textbox", { name });
      fireEvent.focus(well);
      fireEvent.change(well, { target: { value } });
      fireEvent.keyDown(well, { key: "Enter" });
      again();
    };
    commit("In", "0:00.50");
    expect(clipsNow()[0]).toMatchObject({ inSec: 0.5, startSec: 4.5, outSec: null });
    commit("Out", "0:02.00");
    expect(clipsNow()[0]).toMatchObject({ inSec: 0.5, startSec: 4.5, outSec: 2 });
    // Inside the clip (4.5–6), Split is on
    act(() => editor().setPlayhead(5.5));
    again();
    expect(screen.getByRole("button", { name: /Split at playhead/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    expect(clipsNow()[0].muted).toBe(true);
    again();
    expect(screen.getByRole("button", { name: "Fade in" })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    again();
    fireEvent.click(screen.getByRole("button", { name: "Fade in" }));
    // A ramp from its In (0.5), in its source seconds, over half the 1.5 s clip
    expect(clipsNow()[0].curve).toEqual([
      { t: 0.5, gain: 0 },
      { t: 1.25, gain: 1 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Remove clip/ }));
    expect(clipsNow()).toHaveLength(0);
  });

  it("keeps the trim wells and Fade out off until the file's length is read", () => {
    open([tone("t", { startSec: 2 })], false);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    renderRail(["t"], { duration: null, status: "loading" });
    expect(screen.getByRole("textbox", { name: "In" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Out" })).toBeDisabled();
    // The library record's length stands in until the file is read
    expect(screen.getByText("Library · Kling 3 · 3.00 s")).toBeInTheDocument();
    const fadeOut = screen.getByRole("button", { name: "Fade out" });
    expect(fadeOut).toBeDisabled();
    expect(fadeOut).toHaveAttribute("title", "Reading the audio's length…");
    expect(screen.getByRole("button", { name: "Fade in" })).toBeEnabled();
    // Nothing trimmed, nothing to reset
    expect(screen.queryByRole("button", { name: "Reset trim" })).toBeNull();
  });

  it("keeps Reset trim off on a trimmed clip until the file's length is read", () => {
    open([tone("t", { startSec: 2, inSec: 0.5 })], false);
    act(() => editor().select(audioSelectionOf({ clipId: "t" })));
    renderRail(["t"], { duration: null, status: "loading" });
    expect(screen.getByRole("button", { name: "Reset trim" })).toBeDisabled();
  });

  it("shows several clips as a count with what applies to all of them", () => {
    open([tone("t", { startSec: 2 }), tone("u", { row: 1, startSec: 4, muted: true })]);
    act(() => editor().select(audioSelectionOf({ clipId: "t", clipIds: ["t", "u"] })));
    renderRail(["t", "u"]);
    expect(screen.getByText("2 audio clips")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Start on the timeline" })).toBeNull();
    // Named for the selection (as Remove is), with M for its key
    const mute = screen.getByRole("button", { name: "Mute 2 clips" });
    expect(mute).toHaveAttribute("aria-keyshortcuts", "M");
    fireEvent.click(mute);
    expect(clipsNow().every((c) => c.muted)).toBe(true);
    expect(screen.getByRole("button", { name: /Split at playhead/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Remove 2 clips/ }));
    expect(clipsNow()).toHaveLength(0);
  });
});
