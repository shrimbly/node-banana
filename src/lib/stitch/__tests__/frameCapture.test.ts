import { afterEach, describe, expect, it, vi } from "vitest";
import { Input, type InputVideoTrack, type VideoSample } from "mediabunny";
import type { StitchSequenceLayout, StitchTimelineClip } from "@/types";
import type { ClipReader } from "../clipReader";
import { probeClip } from "../clipProbe";
import {
  captureSequenceFrame,
  FrameCaptureError,
  isCrossOriginUrl,
  openFrameSource,
  type FrameCaptureDeps,
  type FrameCaptureJob,
} from "../frameCapture";
import { chooseFrameSlot, frameClips, frameOptions, planFrameAt, shownAt, type FrameSourceFacts } from "../framePlan";
import { domOpacities } from "../placement";
import { layoutSpans, sourceKey, type SourceKey } from "../timeline";

vi.mock("../clipProbe", () => ({ probeClip: vi.fn() }));

const edgeClip = (id: string, extra: Partial<StitchTimelineClip> = {}): StitchTimelineClip => ({
  id,
  source: { kind: "edge", edgeId: id },
  inSec: 0,
  outSec: null,
  muted: false,
  volume: 1,
  ...extra,
});

const TRACK: StitchSequenceLayout = { mode: "track", overlapSec: 1, crossfade: true };
const STACKED: StitchSequenceLayout = { mode: "stacked", overlapSec: 1, crossfade: true };

/** A capture job for a draft at t, each source measured at its given length; srcs default to same-origin paths. */
function job(
  timeline: StitchTimelineClip[],
  lengths: Record<string, number>,
  layout: StitchSequenceLayout,
  t: number,
  extra: Partial<FrameCaptureJob> & { srcs?: Record<string, string> } = {},
): FrameCaptureJob {
  const durations = new Map<SourceKey, number>(timeline.map((clip) => [sourceKey(clip.source), lengths[clip.id]]));
  const placed = layout.mode === "stacked" && timeline.some((clip) => clip.startSec !== undefined);
  const stack = layout.mode === "stacked" ? { crossfade: layout.crossfade, placed } : null;
  const spans = layoutSpans(timeline, durations, layout);
  const { srcs, ...rest } = extra;
  return {
    clips: frameClips(timeline, durations, () => "src", placed),
    options: frameOptions(layout, timeline),
    t,
    shown: shownAt(spans, t, stack),
    srcOf: (source) => srcs?.[source.slice("edge:".length)] ?? `/api/assets/${source}/file`,
    clipNumberOf: (clipId) => timeline.findIndex((clip) => clip.id === clipId) + 1,
    size: { width: 64, height: 36 },
    ...rest,
  };
}

type Op = { op: "fill"; style: unknown; alpha: number } | { op: "draw"; name: string; alpha: number; options: unknown };

interface FakeSample {
  name: string;
  timestamp: number;
  closed: boolean;
}

/** Fake deps: one track per source, readers and samples that record what is drawn and closed. */
function fakes(
  opts: {
    /** What a reader of this source gives for frameOn: no frame, never settles, or fails; undefined = a frame. */
    frameOn?: Record<string, "none" | "hang" | Error>;
    firstFrame?: Record<string, "none">;
    /** What a time lookup in this source gives; undefined = a frame. */
    sampleAt?: Record<string, "none" | "hang">;
    open?: (src: string, signal?: AbortSignal) => Promise<void> | void;
    toBlob?: () => Promise<Blob>;
    facts?: FrameSourceFacts;
  } = {},
) {
  const ops: Op[] = [];
  const samples: FakeSample[] = [];
  const readers: Array<{ source: string; closed: boolean; window: unknown; inSec: number; range: unknown }> = [];
  const opened: Array<{ src: string; disposed: number }> = [];
  const sourceOf = (track: InputVideoTrack) => (track as unknown as { source: string }).source;
  const sample = (name: string, timestamp: number): VideoSample => {
    const s: FakeSample & { close(): void; drawWithFit(ctx: { globalAlpha: number }, options: unknown): void } = {
      name,
      timestamp,
      closed: false,
      close() {
        s.closed = true;
      },
      drawWithFit(ctx, options) {
        ops.push({ op: "draw", name, alpha: ctx.globalAlpha, options });
      },
    };
    samples.push(s);
    return s as unknown as VideoSample;
  };
  const deps: FrameCaptureDeps = {
    async open(src, signal) {
      const record = { src, disposed: 0 };
      await opts.open?.(src, signal);
      opened.push(record);
      const source = src.split("/").find((part) => part.startsWith("edge:")) ?? src;
      return {
        track: { source } as unknown as InputVideoTrack,
        facts: opts.facts ?? { firstTimestamp: 0, frameRate: null },
        dispose: () => {
          record.disposed++;
        },
      };
    },
    canvas() {
      const ctx = {
        globalAlpha: 1,
        fillStyle: "" as unknown,
        fillRect() {
          ops.push({ op: "fill", style: ctx.fillStyle, alpha: ctx.globalAlpha });
        },
      };
      return { ctx: ctx as unknown as CanvasRenderingContext2D, toBlob: opts.toBlob ?? (async () => new Blob(["png"], { type: "image/png" })) };
    },
    reader(track, range, window, inSec) {
      const source = sourceOf(track);
      const record = { source, closed: false, window, inSec, range };
      readers.push(record);
      const reader = {
        frameOn: vi.fn(async (slot: number) => {
          const how = opts.frameOn?.[source];
          if (how instanceof Error) throw how;
          if (how === "hang") return new Promise<never>(() => undefined);
          return how === "none" ? null : sample(`${source}@${slot}`, slot / 60);
        }),
        firstFrame: vi.fn(async () => (opts.firstFrame?.[source] === "none" ? null : sample(`${source}@first`, 0))),
        close: vi.fn(async () => {
          record.closed = true;
        }),
      };
      return reader as unknown as ClipReader;
    },
    async sampleAt(track, time) {
      const how = opts.sampleAt?.[sourceOf(track)];
      if (how === "hang") return new Promise<never>(() => undefined);
      return how === "none" ? null : sample(`${sourceOf(track)}@t${time}`, time);
    },
  };
  /** Every reader and sample closed, every source disposed once. */
  const allReleased = () =>
    readers.every((r) => r.closed) && samples.every((s) => s.closed || /@\d|@first/.test(s.name)) && opened.every((o) => o.disposed === 1);
  return { deps, ops, samples, readers, opened, allReleased };
}

const ab = [edgeClip("a"), edgeClip("b")];
const five = { a: 5, b: 5 };

describe("captureSequenceFrame", () => {
  it("draws one layer over black, covered, at its own rotation", async () => {
    const f = fakes();
    const result = await captureSequenceFrame(job(ab, five, TRACK, 7), f.deps);
    expect(f.ops).toEqual([
      { op: "fill", style: "black", alpha: 1 },
      { op: "draw", name: "edge:b@420", alpha: 1, options: { fit: "cover" } },
    ]);
    expect(result).toMatchObject({ width: 64, height: 36, drawn: [{ clipId: "b", sourceSec: 7, weight: 1 }] });
    expect(result.plan.slot).toBe(420);
    expect(result.blob.type).toBe("image/png");
    expect(f.allReleased()).toBe(true);
  });

  it("draws a dissolve outgoing then incoming, at 1 and alpha", async () => {
    const f = fakes();
    const j = job(ab, five, STACKED, 4.5);
    const result = await captureSequenceFrame(j, f.deps);
    const layers = result.plan.show.kind === "layers" ? result.plan.show.layers : [];
    const alpha = layers[1].weight;
    expect(alpha).toBeGreaterThan(0.4);
    expect(f.ops.map((op) => (op.op === "draw" ? [op.name.split("@")[0], op.alpha] : op.op))).toEqual([
      "fill",
      ["edge:a", 1],
      ["edge:b", alpha],
    ]);
    expect(result.drawn.map((d) => [d.clipId, d.weight])).toEqual([
      ["a", 1 - alpha],
      ["b", alpha],
    ]);
    expect(result.drawn.map((d) => d.sourceSec)).toEqual(layers.map((l) => (l.read.by === "time" ? l.read.time : NaN)));
    expect(f.samples.every((s) => s.closed)).toBe(true);
  });

  it("composites a placed blend of three by the DOM opacities of its weights", async () => {
    // c (row 2) under b (row 1, fading in across [1, 2)) under a (row 0, fading in across [1.5, 3))
    const timeline = [edgeClip("a", { startSec: 1.5 }), edgeClip("b", { startSec: 1 }), edgeClip("c", { startSec: 0 })];
    const f = fakes();
    const result = await captureSequenceFrame(job(timeline, { a: 6, b: 8, c: 10 }, STACKED, 1.75), f.deps);
    const weights = result.drawn.map((d) => d.weight);
    expect(result.drawn.map((d) => d.clipId)).toEqual(["c", "b", "a"]);
    expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1, 12);
    expect(f.ops.flatMap((op) => (op.op === "draw" ? [op.alpha] : []))).toEqual(
      domOpacities(weights).map((opacity, k) => (k === 0 ? 1 : opacity)),
    );
  });

  it("falls back to the held clip, then to the reader's first frame", async () => {
    const held = fakes({ frameOn: { "edge:b": "none" }, facts: { firstTimestamp: 0.1, frameRate: 24 } });
    const result = await captureSequenceFrame(job(ab, five, TRACK, 7), held.deps);
    // The frame drawn is clip a's, so the record names a
    expect(result.drawn).toEqual([{ clipId: "a", sourceSec: 299 / 60, weight: 1 }]);
    expect(held.ops[1]).toMatchObject({ name: "edge:a@299" });
    // a is opened only once b gave nothing, and read from its own first timestamp
    expect(held.opened.map((o) => o.src)).toEqual(["/api/assets/edge:b/file", "/api/assets/edge:a/file"]);
    expect(held.readers[1]).toMatchObject({ source: "edge:a", window: { origin: 0.1 } });
    expect(held.allReleased()).toBe(true);

    const first = fakes({ frameOn: { "edge:a": "none", "edge:b": "none" } });
    await captureSequenceFrame(job(ab, five, TRACK, 7), first.deps);
    expect(first.ops[1]).toMatchObject({ name: "edge:b@first" });
    expect(first.allReleased()).toBe(true);
  });

  it("falls back to the clip before in a lined-up stack, through its solo window", async () => {
    const f = fakes({ frameOn: { "edge:b": "none" } });
    const result = await captureSequenceFrame(job(ab, five, STACKED, 6.5), f.deps);
    expect(result.drawn).toEqual([{ clipId: "a", sourceSec: 239 / 60, weight: 1 }]);
    expect(f.ops[1]).toMatchObject({ name: "edge:a@239" });
    expect(f.allReleased()).toBe(true);
  });

  it("reads a Track clip without opening the clip before it", async () => {
    // Clip a's site refuses it; a press in b never needs a
    const f = fakes({ open: (src) => (src.includes("a.mp4") ? Promise.reject(new TypeError("Failed to fetch")) : undefined) });
    const result = await captureSequenceFrame(job(ab, five, TRACK, 7, { srcs: { a: "https://cross.example/a.mp4" } }), f.deps);
    expect(result.drawn).toEqual([{ clipId: "b", sourceSec: 7, weight: 1 }]);
    expect(f.opened.map((o) => o.src)).toEqual(["/api/assets/edge:b/file"]);
    expect(f.allReleased()).toBe(true);
  });

  it("names the held clip when its source is needed and cannot be opened", async () => {
    const f = fakes({
      frameOn: { "edge:b": "none" },
      open: (src) => (src.includes("a.mp4") ? Promise.reject(new TypeError("Failed to fetch")) : undefined),
    });
    await expect(
      captureSequenceFrame(job(ab, five, TRACK, 7, { srcs: { a: "https://cross.example/a.mp4" } }), f.deps),
    ).rejects.toMatchObject({ kind: "crossOrigin", clipNumber: 1, message: "Failed to fetch" });
    expect(f.allReleased()).toBe(true);
  });

  it("leaves out a layer with no frame, and gives the others its weight", async () => {
    const f = fakes({ sampleAt: { "edge:a": "none" } });
    const result = await captureSequenceFrame(job(ab, five, STACKED, 4.5), f.deps);
    expect(result.drawn).toEqual([{ clipId: "b", sourceSec: expect.any(Number), weight: 1 }]);
    expect(f.ops.filter((op) => op.op === "draw")).toEqual([expect.objectContaining({ alpha: 1 })]);
    expect(f.allReleased()).toBe(true);
  });

  it("fails unreadable when no layer has a frame", async () => {
    const f = fakes({ frameOn: { "edge:a": "none", "edge:b": "none" }, firstFrame: { "edge:b": "none" } });
    await expect(captureSequenceFrame(job(ab, five, TRACK, 7), f.deps)).rejects.toMatchObject({ kind: "unreadable", clipNumber: 2 });
    expect(f.allReleased()).toBe(true);
  });

  it("names the clip whose frame failed to decode, the held one included", async () => {
    const own = fakes({ frameOn: { "edge:b": new Error("decode") } });
    await expect(captureSequenceFrame(job(ab, five, TRACK, 7), own.deps)).rejects.toMatchObject({
      kind: "unreadable",
      clipNumber: 2,
      message: "decode",
    });
    expect(own.allReleased()).toBe(true);

    const held = fakes({ frameOn: { "edge:b": "none", "edge:a": new Error("decode") } });
    await expect(captureSequenceFrame(job(ab, five, TRACK, 7), held.deps)).rejects.toMatchObject({
      kind: "unreadable",
      clipNumber: 1,
    });
    expect(held.allReleased()).toBe(true);
  });

  it.each([
    ["a time lookup", fakes({ sampleAt: { "edge:b": "hang" } }), STACKED, 4.5, 2, 2],
    ["a frame read", fakes({ frameOn: { "edge:b": "hang" } }), TRACK, 7, 1, 2],
    ["the held clip's frame read", fakes({ frameOn: { "edge:b": "none", "edge:a": "hang" } }), TRACK, 7, 2, 1],
  ])("gives up on a timeout during %s, naming the clip being read", async (_name, f, layout, t, opens, clipNumber) => {
    const controller = new AbortController();
    const settled = captureSequenceFrame(job(ab, five, layout, t, { signal: controller.signal }), f.deps).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.opened).toHaveLength(opens));
    // Let the reads start
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new DOMException("Took too long", "TimeoutError"));
    const error = await settled;
    expect(error).toBeInstanceOf(FrameCaptureError);
    expect(error).toMatchObject({ kind: "timeout", clipNumber });
    expect(f.allReleased()).toBe(true);
    expect(f.samples.every((s) => s.closed || /@\d|@first/.test(s.name))).toBe(true);
  });

  it("opens each source the slot reads once, and nothing else", async () => {
    // Two pieces of one video, overlapping on two rows, and a third clip that is not playing
    const timeline = [
      edgeClip("top", { source: { kind: "edge", edgeId: "v" }, startSec: 2 }),
      edgeClip("under", { source: { kind: "edge", edgeId: "v" }, startSec: 0 }),
      edgeClip("later", { startSec: 20 }),
    ];
    const f = fakes();
    const result = await captureSequenceFrame(job(timeline, { top: 3, under: 5, later: 2 }, STACKED, 2.25), f.deps);
    expect(result.drawn.map((d) => d.clipId)).toEqual(["under", "top"]);
    expect(f.opened.map((o) => o.src)).toEqual(["/api/assets/edge:v/file"]);
    expect(f.readers).toHaveLength(2);
    expect(f.allReleased()).toBe(true);
  });

  it("refuses a black slot without opening anything", async () => {
    const f = fakes();
    const open = vi.spyOn(f.deps, "open");
    const gap = [edgeClip("a", { startSec: 0 }), edgeClip("b", { startSec: 6 })];
    await expect(captureSequenceFrame(job(gap, five, STACKED, 5.5), f.deps)).rejects.toMatchObject({ kind: "empty" });
    expect(open).not.toHaveBeenCalled();
  });

  it("calls a source on another site that fails cross-origin, and one on this site unreadable", async () => {
    const failing = () => fakes({ open: () => Promise.reject(new TypeError("Failed to fetch")) });
    const other = failing();
    const error = await captureSequenceFrame(
      job(ab, five, TRACK, 2, { srcs: { a: "http://other.example/a.mp4" } }),
      other.deps,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FrameCaptureError);
    expect(error).toMatchObject({ kind: "crossOrigin", clipNumber: 1 });

    expect(other.allReleased()).toBe(true);

    const same = failing();
    await expect(captureSequenceFrame(job(ab, five, TRACK, 2), same.deps)).rejects.toMatchObject({
      kind: "unreadable",
      clipNumber: 1,
      message: "Failed to fetch",
    });
    expect(same.allReleased()).toBe(true);
  });

  it("disposes a source that opened before another failed", async () => {
    let fail!: () => void;
    const f = fakes({
      open: (src) => (src.includes("edge:b") ? new Promise<void>((_, reject) => (fail = () => reject(new TypeError("boom")))) : undefined),
    });
    const settled = captureSequenceFrame(job(ab, five, STACKED, 4.5), f.deps).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.opened).toHaveLength(1));
    fail();
    expect(await settled).toMatchObject({ kind: "unreadable", clipNumber: 2, message: "boom" });
    expect(f.allReleased()).toBe(true);
  });

  it("disposes a source that opens after another failed", async () => {
    let release!: () => void;
    const f = fakes({
      open: (src) => (src.includes("edge:a") ? new Promise<void>((resolve) => (release = resolve)) : Promise.reject(new TypeError("boom"))),
    });
    await expect(captureSequenceFrame(job(ab, five, STACKED, 4.5), f.deps)).rejects.toMatchObject({
      kind: "unreadable",
      clipNumber: 2,
      message: "boom",
    });
    release();
    await vi.waitFor(() => expect(f.opened).toHaveLength(1));
    await vi.waitFor(() => expect(f.opened[0].disposed).toBe(1));
  });

  it("calls a tainted canvas cross-origin, and releases everything", async () => {
    const f = fakes({ toBlob: () => Promise.reject(new DOMException("Tainted", "SecurityError")) });
    await expect(
      captureSequenceFrame(job(ab, five, TRACK, 7, { srcs: { b: "https://cdn.example/b.mp4" } }), f.deps),
    ).rejects.toMatchObject({ kind: "crossOrigin", clipNumber: 2 });
    expect(f.allReleased()).toBe(true);
  });

  it("gives up on a timeout, naming the clip still opening, and disposes what opened at once", async () => {
    const controller = new AbortController();
    const f = fakes({ open: (src) => (src.includes("edge:b") ? new Promise<void>(() => undefined) : undefined) });
    const pending = captureSequenceFrame(job(ab, five, STACKED, 4.5, { signal: controller.signal }), f.deps);
    const settled = pending.catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.opened).toHaveLength(1));
    expect(f.opened[0].disposed).toBe(0);
    controller.abort(new DOMException("Took too long", "TimeoutError"));
    expect(f.opened[0].disposed).toBe(1);
    const error = await settled;
    expect(error).toBeInstanceOf(FrameCaptureError);
    expect(error).toMatchObject({ kind: "timeout", clipNumber: 2 });
    expect(f.allReleased()).toBe(true);
  });

  it("turns any other abort into an AbortError, with everything released", async () => {
    const controller = new AbortController();
    const f = fakes({ open: (src) => (src.includes("edge:b") ? new Promise<void>(() => undefined) : undefined) });
    const settled = captureSequenceFrame(job(ab, five, STACKED, 4.5, { signal: controller.signal }), f.deps).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.opened).toHaveLength(1));
    controller.abort();
    const error = await settled;
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(f.allReleased()).toBe(true);
  });

  it("captures the slot chooseFrameSlot picks, planned with the opened sources' facts", async () => {
    const d = job([edgeClip("a", { outSec: 4.99 }), edgeClip("b")], five, STACKED, 3.99);
    const facts = { firstTimestamp: 0, frameRate: 24 };
    const result = await captureSequenceFrame(d, fakes({ facts }).deps);
    const slot = chooseFrameSlot(d.clips, d.options, d.t, d.shown);
    const byFacts = new Map<SourceKey, FrameSourceFacts>([
      ["edge:a", facts],
      ["edge:b", facts],
    ]);
    expect(result.plan).toEqual(planFrameAt(d.clips, d.options, slot, byFacts));
    // Before the dissolve's first 24 fps frame, the outgoing clip alone
    expect(result.drawn.map((x) => x.clipId)).toEqual(["a"]);
  });
});

describe("openFrameSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(probeClip).mockReset();
  });

  const stubFetch = () => {
    const fetch = vi.fn(async () => ({ blob: async () => new Blob(["v"], { type: "video/mp4" }) }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("fetches a data: source whole, with the signal, and reads a library file by range", async () => {
    const fetch = stubFetch();
    const track = {} as InputVideoTrack;
    vi.mocked(probeClip).mockResolvedValue({ videoTrack: track, firstTimestamp: 0.04, frameRate: 24 } as Awaited<ReturnType<typeof probeClip>>);
    const signal = new AbortController().signal;
    const source = await openFrameSource("data:video/mp4;base64,AAAA", signal);
    expect(fetch).toHaveBeenCalledWith("data:video/mp4;base64,AAAA", { signal });
    expect(source).toMatchObject({ track, facts: { firstTimestamp: 0.04, frameRate: 24 } });

    fetch.mockClear();
    await openFrameSource("/api/assets/x/file");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a file with no video track, and lets the input go", async () => {
    stubFetch();
    const dispose = vi.spyOn(Input.prototype, "dispose");
    vi.mocked(probeClip).mockResolvedValue(null);
    await expect(openFrameSource("data:video/mp4;base64,AAAA")).rejects.toThrow("The file has no video track");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("lets the input go at once on an abort while probing", async () => {
    stubFetch();
    const dispose = vi.spyOn(Input.prototype, "dispose");
    vi.mocked(probeClip).mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    void openFrameSource("data:video/mp4;base64,AAAA", controller.signal).catch(() => undefined);
    await vi.waitFor(() => expect(probeClip).toHaveBeenCalled());
    controller.abort();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe("isCrossOriginUrl", () => {
  const origin = "http://localhost:3417";
  it("is false for data:, blob:, relative and same-origin sources", () => {
    expect(isCrossOriginUrl("data:video/mp4;base64,AAAA", origin)).toBe(false);
    expect(isCrossOriginUrl("blob:http://localhost:3417/1234", origin)).toBe(false);
    expect(isCrossOriginUrl("/api/assets/x/file", origin)).toBe(false);
    expect(isCrossOriginUrl("http://localhost:3417/media/a.mp4", origin)).toBe(false);
  });

  it("is true for another host or port", () => {
    expect(isCrossOriginUrl("https://cdn.example/a.mp4", origin)).toBe(true);
    expect(isCrossOriginUrl("http://localhost:3000/a.mp4", origin)).toBe(true);
  });
});
