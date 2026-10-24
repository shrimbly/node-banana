import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InputVideoTrack, VideoSample } from "mediabunny";
import { blendBytes, blendBytesWeighted, createFrameBlender, encodeDissolve, rgbaToYuv, type FrameBlender } from "../crossfadeFrames";

/** Every VideoSample the module constructs: its data (copied, as mediabunny copies a buffer it is given) and init. */
const constructed: Array<{ data: unknown; input: unknown; init: Record<string, unknown>; close: ReturnType<typeof vi.fn> }> = [];

vi.mock("mediabunny", () => {
  class VideoSampleMock {
    data: unknown;
    /** What the module passed in, before the copy. */
    input: unknown;
    init: Record<string, unknown>;
    timestamp: number;
    close = vi.fn();
    constructor(data: unknown, init: Record<string, unknown>) {
      this.data = data instanceof Uint8Array ? data.slice() : data;
      this.input = data;
      this.init = init;
      this.timestamp = init.timestamp as number;
      constructed.push(this);
    }
  }
  /** The track decides what samplesAtTimestamps yields. */
  class VideoSampleSinkMock {
    samplesAtTimestamps: (times: number[]) => unknown;
    constructor(track: { iterate: (times: number[]) => unknown }) {
      this.samplesAtTimestamps = (times) => track.iterate(times);
    }
  }
  return { VideoSample: VideoSampleMock, VideoSampleSink: VideoSampleSinkMock };
});

interface FakeSample {
  format: string | null;
  codedWidth: number;
  codedHeight: number;
  colorSpace: { matrix: string };
  timestamp: number;
  close: ReturnType<typeof vi.fn>;
  clone: ReturnType<typeof vi.fn>;
  setTimestamp: ReturnType<typeof vi.fn>;
  setDuration: ReturnType<typeof vi.fn>;
  drawWithFit: ReturnType<typeof vi.fn>;
  allocationSize: () => number;
  copyTo: ReturnType<typeof vi.fn>;
}

/** A decoded frame whose every byte is `value`, NV12 at 4 × 2 unless told otherwise. */
function frame(
  value: number,
  opts: { format?: string | null; width?: number; height?: number; timestamp?: number; copyFails?: boolean } = {},
): FakeSample {
  const width = opts.width ?? 4;
  const height = opts.height ?? 2;
  const size = width * height + 2 * Math.ceil(width / 2) * Math.ceil(height / 2);
  const sample: FakeSample = {
    format: opts.format === undefined ? "NV12" : opts.format,
    codedWidth: width,
    codedHeight: height,
    colorSpace: { matrix: `bt709-${value}` },
    timestamp: opts.timestamp ?? 0,
    close: vi.fn(),
    clone: vi.fn(),
    setTimestamp: vi.fn(),
    setDuration: vi.fn(),
    drawWithFit: vi.fn(),
    allocationSize: () => size,
    copyTo: vi.fn(async (buffer: Uint8Array) => {
      if (opts.copyFails) throw new Error("copyTo failed");
      buffer.fill(value);
      return [
        { offset: 0, stride: width },
        { offset: width * height, stride: 2 * Math.ceil(width / 2) },
      ];
    }),
  };
  sample.clone.mockImplementation(() => ({ ...frame(value, opts), cloneOf: sample }));
  return sample;
}

const asSample = (s: FakeSample | null) => s as unknown as VideoSample | null;

/** A canvas context that records what is drawn at which globalAlpha. */
function fakeContext() {
  const log: string[] = [];
  const ctx = {
    canvas: { id: "canvas" },
    _alpha: 1,
    get globalAlpha() {
      return this._alpha;
    },
    set globalAlpha(value: number) {
      this._alpha = value;
      log.push(`alpha ${value}`);
    },
    fillStyle: "",
    fillRect: vi.fn(() => log.push(`fill ${ctx.fillStyle}`)),
  };
  return { ctx, log };
}

describe("blendBytes", () => {
  it("gives a at 0 and b at 1", () => {
    const a = new Uint8Array([0, 100, 255]);
    const b = new Uint8Array([255, 50, 0]);
    const out = new Uint8Array(3);
    blendBytes(a, b, 0, out);
    expect([...out]).toEqual([0, 100, 255]);
    blendBytes(a, b, 1, out);
    expect([...out]).toEqual([255, 50, 0]);
  });

  it("rounds the midpoint half up", () => {
    const out = new Uint8Array(2);
    blendBytes(new Uint8Array([0, 10]), new Uint8Array([1, 13]), 0.5, out);
    // 0.5 → 1, 11.5 → 12
    expect([...out]).toEqual([1, 12]);
  });

  it("clamps alpha", () => {
    const out = new Uint8Array(1);
    blendBytes(new Uint8Array([10]), new Uint8Array([20]), 2, out);
    expect(out[0]).toBe(20);
    blendBytes(new Uint8Array([10]), new Uint8Array([20]), -1, out);
    expect(out[0]).toBe(10);
    blendBytes(new Uint8Array([10]), new Uint8Array([20]), Number.NaN, out);
    expect(out[0]).toBe(10);
  });
});

describe("createFrameBlender", () => {
  const ref = { width: 4, height: 2 };

  beforeEach(() => {
    constructed.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("blends two NV12 frames at the reference size in their bytes, in one reused buffer each sample copies", async () => {
    const { ctx } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d });
    const a = frame(100);
    const b = frame(200);
    await blender.blend(asSample(a), asSample(b), 0.25, 4, 1 / 60);
    await blender.blend(asSample(a), asSample(b), 0.75, 4 + 1 / 60, 1 / 60);

    expect(a.copyTo).toHaveBeenCalledTimes(2);
    expect(b.copyTo).toHaveBeenCalledTimes(2);
    expect(context2d).not.toHaveBeenCalled();
    const [first, second] = constructed;
    expect(first.data).toBeInstanceOf(Uint8Array);
    expect([...(first.data as Uint8Array)].every((v) => v === 125)).toBe(true);
    expect([...(second.data as Uint8Array)].every((v) => v === 175)).toBe(true);
    // One output buffer serves every blend: the sample owns its copy
    expect(second.input).toBe(first.input);
    expect(second.data).not.toBe(first.data);
    expect(first.init).toEqual({
      format: "NV12",
      codedWidth: 4,
      codedHeight: 2,
      timestamp: 4,
      duration: 1 / 60,
      colorSpace: a.colorSpace,
      layout: [
        { offset: 0, stride: 4 },
        { offset: 8, stride: 4 },
      ],
      rotation: 0,
    });
  });

  it("blends on a canvas when the sizes differ: black, a to cover at 1, b at alpha, then back to 1", async () => {
    const { ctx, log } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d, isFirefox: false });
    const a = frame(100);
    const b = frame(200, { width: 8, height: 4 });
    await blender.blend(asSample(a), asSample(b), 0.4, 5, 1 / 60);

    expect(a.copyTo).not.toHaveBeenCalled();
    expect(context2d).toHaveBeenCalledWith(ref, { alpha: false });
    expect(log).toEqual(["alpha 1", "fill black", "alpha 0.4", "alpha 1"]);
    expect(a.drawWithFit).toHaveBeenCalledWith(ctx, { fit: "cover", rotation: 0 });
    expect(b.drawWithFit).toHaveBeenCalledWith(ctx, { fit: "cover", rotation: 0 });
    expect(a.drawWithFit.mock.invocationCallOrder[0]).toBeLessThan(b.drawWithFit.mock.invocationCallOrder[0]);
    expect(constructed[0]).toMatchObject({ data: ctx.canvas, init: { timestamp: 5, duration: 1 / 60, rotation: 0 } });
  });

  it("blends on a canvas when a frame has no known format, and keeps an alpha context on Firefox", async () => {
    const { ctx } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d, isFirefox: true });
    const a = frame(100, { format: null });
    const b = frame(200, { format: null });
    await blender.blend(asSample(a), asSample(b), 0.5, 0, 1 / 60);
    expect(context2d).toHaveBeenCalledWith(ref, { alpha: true });
    expect(a.drawWithFit).toHaveBeenCalled();
    expect(b.drawWithFit).toHaveBeenCalled();
  });

  it("stays on the canvas once copyTo has thrown", async () => {
    const { ctx } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d });
    await blender.blend(asSample(frame(100, { copyFails: true })), asSample(frame(200)), 0.5, 0, 1 / 60);
    expect(constructed[0].data).toBe(ctx.canvas);
    const a = frame(100);
    const b = frame(200);
    await blender.blend(asSample(a), asSample(b), 0.5, 1 / 60, 1 / 60);
    expect(a.copyTo).not.toHaveBeenCalled();
    expect(constructed[1].data).toBe(ctx.canvas);
    // One canvas for the whole encode
    expect(context2d).toHaveBeenCalledTimes(1);
  });

  it("passes a single side at the reference size as a clone with the new timestamp", async () => {
    const context2d = vi.fn();
    const blender = createFrameBlender(ref, { context2d });
    const b = frame(200);
    const result = (await blender.blend(null, asSample(b), 0.3, 7, 1 / 60)) as unknown as FakeSample;
    expect(b.clone).toHaveBeenCalledTimes(1);
    expect(result.setTimestamp).toHaveBeenCalledWith(7);
    expect(result.setDuration).toHaveBeenCalledWith(1 / 60);
    expect(context2d).not.toHaveBeenCalled();
    expect(constructed).toHaveLength(0);
  });

  it("draws a single side at another size alone, at full opacity", async () => {
    const { ctx, log } = fakeContext();
    const blender = createFrameBlender(ref, { context2d: () => ctx as unknown as CanvasRenderingContext2D });
    const a = frame(100, { width: 8, height: 4 });
    await blender.blend(asSample(a), null, 0.3, 0, 1 / 60);
    expect(a.drawWithFit).toHaveBeenCalledWith(ctx, { fit: "cover", rotation: 0 });
    expect(log).toEqual(["alpha 1", "fill black"]);
  });
});

describe("blendBytesWeighted", () => {
  it("gives each input at its own full weight", () => {
    const inputs = [new Uint8Array([0, 100, 255]), new Uint8Array([255, 50, 0]), new Uint8Array([7, 7, 7])];
    const out = new Uint8Array(3);
    blendBytesWeighted(inputs, [1, 0, 0], out);
    expect([...out]).toEqual([0, 100, 255]);
    blendBytesWeighted(inputs, [0, 0, 1], out);
    expect([...out]).toEqual([7, 7, 7]);
  });

  it("rounds once, half up, on the weighted sum of three inputs", () => {
    const out = new Uint8Array(2);
    // 0.25·10 + 0.25·11 + 0.5·12 = 11.25 → 11; 0.25·1 + 0.25·0 + 0.5·0 = 0.25 → 0, and 0.5·1 + 0.25·0 + 0.25·0 = 0.5 → 1
    blendBytesWeighted([new Uint8Array([10, 1]), new Uint8Array([11, 0]), new Uint8Array([12, 0])], [0.25, 0.25, 0.5], out);
    expect([...out]).toEqual([11, 0]);
    blendBytesWeighted([new Uint8Array([1]), new Uint8Array([0]), new Uint8Array([0])], [0.5, 0.25, 0.25], out);
    expect(out[0]).toBe(1);
  });

  it("clamps: weights summing a hair past 1 over 255s give 255, not 0", () => {
    const full = new Uint8Array([255, 255]);
    const out = new Uint8Array(2);
    blendBytesWeighted([full, full, full], [0.5, 0.25, 0.25 + 1e-12], out);
    expect([...out]).toEqual([255, 255]);
    blendBytesWeighted([full, full, full], [0.5, 0.5, 0.5], out);
    expect([...out]).toEqual([255, 255]);
  });
});

describe("createFrameBlender: composite and black", () => {
  const ref = { width: 4, height: 2 };
  const layer = (sample: FakeSample | null, weight: number) => ({ sample: asSample(sample), weight });

  beforeEach(() => {
    constructed.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("composites two layers on the bytes path exactly as blend does", async () => {
    const a = frame(100);
    const b = frame(200);
    const blender = createFrameBlender(ref, { context2d: vi.fn() });
    await blender.blend(asSample(a), asSample(b), 0.3, 1, 1 / 60);
    await blender.composite([layer(a, 0.7), layer(b, 0.3)], 1, 1 / 60);
    const [blended, composited] = constructed;
    expect(composited.data).toEqual(blended.data);
    expect(composited.init).toEqual(blended.init);
  });

  it("composites three layers by weight in their bytes, in the bottom layer's colour space", async () => {
    const [a, b, c] = [frame(100), frame(200), frame(40)];
    const context2d = vi.fn();
    const blender = createFrameBlender(ref, { context2d });
    await blender.composite([layer(a, 0.5), layer(b, 0.25), layer(c, 0.25)], 2, 1 / 60);
    expect(context2d).not.toHaveBeenCalled();
    const [out] = constructed;
    // 50 + 50 + 10
    expect([...(out.data as Uint8Array)].every((v) => v === 110)).toBe(true);
    expect(out.init).toMatchObject({ format: "NV12", codedWidth: 4, codedHeight: 2, timestamp: 2, colorSpace: a.colorSpace, rotation: 0 });
  });

  it("renormalises the weights of the layers present: a missing top keeps the bottom at full brightness", async () => {
    const a = frame(100);
    const blender = createFrameBlender(ref, { context2d: vi.fn() });
    const result = (await blender.composite([layer(a, 0.4), layer(null, 0.6)], 3, 1 / 60)) as unknown as FakeSample;
    // One layer left: a clone at the new time
    expect(a.clone).toHaveBeenCalledTimes(1);
    expect(result.setTimestamp).toHaveBeenCalledWith(3);
    expect(constructed).toHaveLength(0);
    // A missing bottom: the two above share the picture
    const [b, c] = [frame(200), frame(40)];
    await blender.composite([layer(null, 0.5), layer(b, 0.25), layer(c, 0.25)], 4, 1 / 60);
    expect([...(constructed[0].data as Uint8Array)].every((v) => v === 120)).toBe(true);
  });

  it("gives the bottom layer present weight 1 when every weight is 0", async () => {
    const [a, b] = [frame(100), frame(200)];
    const blender = createFrameBlender(ref, { context2d: vi.fn() });
    await blender.composite([layer(a, 0), layer(b, 0)], 0, 1 / 60);
    expect([...(constructed[0].data as Uint8Array)].every((v) => v === 100)).toBe(true);
  });

  it("composites mixed sizes on a canvas: black, the bottom at 1, then each layer at its DOM opacity", async () => {
    const { ctx, log } = fakeContext();
    const context2d = vi.fn(() => ctx as unknown as CanvasRenderingContext2D);
    const blender = createFrameBlender(ref, { context2d, isFirefox: false });
    const [a, b, c] = [frame(100), frame(200, { width: 8, height: 4 }), frame(40)];
    await blender.composite([layer(a, 0.5), layer(b, 0.25), layer(c, 0.25)], 5, 1 / 60);
    // DOM opacities of (0.5, 0.25, 0.25): 1, 1/3, 1/4
    expect(log).toEqual(["alpha 1", "fill black", "alpha 1", `alpha ${0.25 / 0.75}`, "alpha 0.25", "alpha 1"]);
    for (const s of [a, b, c]) expect(s.drawWithFit).toHaveBeenCalledWith(ctx, { fit: "cover", rotation: 0 });
    expect(a.drawWithFit.mock.invocationCallOrder[0]).toBeLessThan(b.drawWithFit.mock.invocationCallOrder[0]);
    expect(b.drawWithFit.mock.invocationCallOrder[0]).toBeLessThan(c.drawWithFit.mock.invocationCallOrder[0]);
    expect(constructed[0]).toMatchObject({ data: ctx.canvas, init: { timestamp: 5, duration: 1 / 60, rotation: 0 } });
  });

  it("returns a canvas composite in the reference's own YUV format and colour space when asked (the file's first frame)", async () => {
    const { ctx } = fakeContext();
    // 4 × 2 canvas: the left half white, the right half pure red
    const pixels = new Uint8ClampedArray(4 * 2 * 4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) pixels.set(x < 2 ? [255, 255, 255, 255] : [255, 0, 0, 255], 4 * (y * 4 + x));
    }
    const getImageData = vi.fn(() => ({ data: pixels }));
    Object.assign(ctx, { getImageData });
    const colorSpace: VideoColorSpaceInit = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
    const blender = createFrameBlender(
      { width: 4, height: 2, format: "NV12", colorSpace },
      { context2d: vi.fn(() => ctx as unknown as CanvasRenderingContext2D), isFirefox: false },
    );
    const [a, b] = [frame(100), frame(200, { width: 8, height: 4 })];
    await blender.composite([layer(a, 0.5), layer(b, 0.5)], 1, 1 / 60, { inRefFormat: true });
    expect(getImageData).toHaveBeenCalledWith(0, 0, 4, 2);
    expect(constructed[0].init).toEqual({
      format: "NV12",
      codedWidth: 4,
      codedHeight: 2,
      colorSpace,
      layout: [
        { offset: 0, stride: 4 },
        { offset: 8, stride: 4 },
      ],
      timestamp: 1,
      duration: 1 / 60,
      rotation: 0,
    });
    // BT.709 limited: white is Y 235, Cb Cr 128; red is Y 63, Cb 102, Cr 240
    expect([...(constructed[0].data as Uint8Array)]).toEqual([235, 235, 63, 63, 235, 235, 63, 63, 128, 128, 102, 240]);
    // Later frames stay on the canvas
    await blender.composite([layer(a, 0.5), layer(b, 0.5)], 2, 1 / 60);
    expect(constructed[1].data).toBe(ctx.canvas);
  });

  it("returns a 10-bit reference's canvas composite and black as 8-bit I420 in its colour space, so its tags hold", async () => {
    const { ctx } = fakeContext();
    const getImageData = vi.fn(() => ({ data: new Uint8ClampedArray(4 * 2 * 4).fill(255) }));
    Object.assign(ctx, { getImageData });
    const colorSpace: VideoColorSpaceInit = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
    const blender = createFrameBlender(
      { width: 4, height: 2, format: "I420P10", colorSpace },
      { context2d: vi.fn(() => ctx as unknown as CanvasRenderingContext2D), isFirefox: false },
    );
    // 10-bit frames are not blended byte by byte: the canvas does it
    const [a, b] = [frame(100, { format: "I420P10" }), frame(200, { format: "I420P10" })];
    await blender.composite([layer(a, 0.5), layer(b, 0.5)], 1, 1 / 60, { inRefFormat: true });
    expect(getImageData).toHaveBeenCalled();
    expect(constructed[0].init).toMatchObject({ format: "I420", codedWidth: 4, codedHeight: 2, colorSpace });
    expect([...(constructed[0].data as Uint8Array)]).toEqual([235, 235, 235, 235, 235, 235, 235, 235, 128, 128, 128, 128]);
    blender.black(2, 1 / 60);
    expect(constructed[1].init).toMatchObject({ format: "I420", colorSpace });
    expect([...(constructed[1].data as Uint8Array)]).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 128, 128, 128, 128]);
  });

  it("converts RGBA to Y'CbCr by the matrix and range, chroma from the pixels it covers", () => {
    const px = (...rgb: number[][]) => new Uint8ClampedArray(rgb.flatMap((c) => [...c, 255]));
    // Full range BT.601, I444: black and white
    const full = rgbaToYuv(px([0, 0, 0], [255, 255, 255]), 2, 1, "I444", { matrix: "smpte170m", fullRange: true })!;
    expect([...full.data]).toEqual([0, 255, 128, 128, 128, 128]);
    // I420 averages a 2 × 2 block: two red and two blue pixels give magenta's chroma
    const block = rgbaToYuv(px([255, 0, 0], [0, 0, 255], [255, 0, 0], [0, 0, 255]), 2, 2, "I420", { matrix: "bt709" })!;
    expect(block.layout).toEqual([
      { offset: 0, stride: 2 },
      { offset: 4, stride: 1 },
      { offset: 5, stride: 1 },
    ]);
    expect([...block.data.slice(4)]).toEqual([
      Math.round(128 + (224 * (0.5 - (0.2126 + 0.0722) / 2)) / (2 * (1 - 0.0722))),
      Math.round(128 + (224 * (0.5 - (0.2126 + 0.0722) / 2)) / (2 * (1 - 0.2126))),
    ]);
    // I420A's alpha is opaque; an RGB matrix or an RGB format has no YUV to make
    expect([...rgbaToYuv(px([0, 0, 0], [0, 0, 0]), 2, 1, "I420A")!.data.slice(-2)]).toEqual([255, 255]);
    expect(rgbaToYuv(px([0, 0, 0]), 1, 1, "I420", { matrix: "rgb" })).toBeNull();
    expect(rgbaToYuv(px([0, 0, 0]), 1, 1, "BGRA")).toBeNull();
  });

  it("makes black in an NV12 reference's own format, coded size and colour space: Y 16, chroma 128", () => {
    const colorSpace: VideoColorSpaceInit = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false };
    const blender = createFrameBlender({ width: 4, height: 2, format: "NV12", colorSpace }, { context2d: vi.fn() });
    blender.black(6, 1 / 60);
    blender.black(7, 1 / 60);
    const [first, second] = constructed;
    expect([...(first.data as Uint8Array)]).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 128, 128, 128, 128]);
    expect(first.init).toEqual({
      format: "NV12",
      codedWidth: 4,
      codedHeight: 2,
      colorSpace,
      layout: [
        { offset: 0, stride: 4 },
        { offset: 8, stride: 4 },
      ],
      rotation: 0,
      timestamp: 6,
      duration: 1 / 60,
    });
    expect(second.init.timestamp).toBe(7);
  });

  it("makes black with Y 0 in a full-range reference, and alpha 255 in I420A", () => {
    createFrameBlender({ width: 2, height: 2, format: "I420", colorSpace: { fullRange: true } }).black(0, 1 / 60);
    expect([...(constructed[0].data as Uint8Array)]).toEqual([0, 0, 0, 0, 128, 128]);
    createFrameBlender({ width: 2, height: 2, format: "I420A" }).black(0, 1 / 60);
    expect([...(constructed[1].data as Uint8Array)]).toEqual([16, 16, 16, 16, 128, 128, 255, 255, 255, 255]);
    expect(constructed[1].init.layout).toEqual([
      { offset: 0, stride: 2 },
      { offset: 4, stride: 1 },
      { offset: 5, stride: 1 },
      { offset: 6, stride: 2 },
    ]);
  });

  it("makes RGBX zeros at the reference's coded size when its format is RGB or unknown", () => {
    createFrameBlender({ width: 4, height: 2, format: "BGRA" }).black(1, 1 / 60);
    createFrameBlender({ width: 4, height: 2 }).black(2, 1 / 60);
    for (const made of constructed) {
      expect(made.init).toEqual({ format: "RGBX", codedWidth: 4, codedHeight: 2, rotation: 0, timestamp: made.init.timestamp, duration: 1 / 60 });
      expect((made.data as Uint8Array).length).toBe(32);
      expect([...(made.data as Uint8Array)].every((v) => v === 0)).toBe(true);
    }
  });

  it("gives black when no layer has a frame", async () => {
    const blender = createFrameBlender({ width: 4, height: 2, format: "NV12" }, { context2d: vi.fn() });
    await blender.composite([layer(null, 1)], 8, 1 / 60);
    expect(constructed[0].init).toMatchObject({ format: "NV12", timestamp: 8 });
  });
});

/** An iterator that yields the given items in order, recording next() and an awaited return(). */
function iteratorOf(items: Array<FakeSample | null>, opts: { throwAt?: number } = {}) {
  let i = 0;
  const state = { returned: false, returnSettled: false, nextCalls: 0 };
  const iterator = {
    next: vi.fn(async () => {
      state.nextCalls++;
      if (opts.throwAt === i) throw new Error("decode failed");
      if (i >= items.length) return { done: true, value: undefined };
      return { done: false, value: items[i++] };
    }),
    return: vi.fn(async () => {
      state.returned = true;
      await Promise.resolve();
      state.returnSettled = true;
      return { done: true, value: undefined };
    }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return { iterator, state };
}

const trackOf = (iterator: unknown, timesSeen: number[][]) =>
  ({
    iterate: (times: number[]) => {
      timesSeen.push([...times]);
      return iterator;
    },
  }) as unknown as InputVideoTrack;

describe("encodeDissolve", () => {
  beforeEach(() => {
    constructed.length = 0;
  });

  /** A blender that records its calls and returns a closable result. */
  function recordingBlender() {
    const calls: Array<{ a: FakeSample | null; b: FakeSample | null; alpha: number; timestamp: number; duration: number }> = [];
    const results: Array<{ timestamp: number; close: ReturnType<typeof vi.fn> }> = [];
    const blender: FrameBlender = {
      blend: vi.fn(async (a, b, alpha, timestamp, duration) => {
        calls.push({ a: a as unknown as FakeSample | null, b: b as unknown as FakeSample | null, alpha, timestamp, duration });
        const result = { timestamp, close: vi.fn() };
        results.push(result);
        return result as unknown as VideoSample;
      }),
      composite: vi.fn(),
      black: vi.fn(),
    };
    return { blender, calls, results };
  }

  it("blends in order with the given alphas, holding a side's previous frame over a null, and closes everything", async () => {
    const a = [frame(10), frame(11), null];
    const b = [null, frame(20), frame(21)];
    const out = iteratorOf(a);
    const inc = iteratorOf(b);
    const times: number[][] = [];
    const { blender, calls, results } = recordingBlender();
    const blenderFor = vi.fn(() => blender);
    const added: number[] = [];
    await encodeDissolve(
      {
        outgoing: trackOf(out.iterator, times),
        incoming: trackOf(inc.iterator, times),
        timestamps: [4, 4 + 1 / 60, 4 + 2 / 60],
        outgoingTimes: [4.01, 4.02, 4.03],
        incomingTimes: [0, 0.01, 0.02],
        alphas: [0.1, 0.5, 0.9],
        frameDuration: 1 / 60,
      },
      blenderFor,
      async (sample) => {
        added.push(sample.timestamp);
      },
    );

    expect(times).toEqual([
      [4.01, 4.02, 4.03],
      [0, 0.01, 0.02],
    ]);
    expect(blenderFor).toHaveBeenCalledTimes(1);
    expect(blenderFor).toHaveBeenCalledWith(a[0]);
    expect(calls.map((c) => [c.a, c.b, c.alpha, c.timestamp, c.duration])).toEqual([
      [a[0], null, 0.1, 4, 1 / 60],
      [a[1], b[1], 0.5, 4 + 1 / 60, 1 / 60],
      [a[1], b[2], 0.9, 4 + 2 / 60, 1 / 60],
    ]);
    expect(added).toEqual([4, 4 + 1 / 60, 4 + 2 / 60]);
    for (const result of results) expect(result.close).toHaveBeenCalledTimes(1);
    for (const sample of [...a, ...b]) if (sample) expect(sample.close).toHaveBeenCalledTimes(1);
    expect(out.state.returnSettled).toBe(true);
    expect(inc.state.returnSettled).toBe(true);
    // Lockstep: one next() each per frame
    expect(out.state.nextCalls).toBe(3);
    expect(inc.state.nextCalls).toBe(3);
  });

  it("gives the blender null when the outgoing side has no first frame", async () => {
    const out = iteratorOf([null, frame(1)]);
    const inc = iteratorOf([frame(2), frame(3)]);
    const { blender } = recordingBlender();
    const blenderFor = vi.fn(() => blender);
    await encodeDissolve(
      {
        outgoing: trackOf(out.iterator, []),
        incoming: trackOf(inc.iterator, []),
        timestamps: [0, 1 / 60],
        outgoingTimes: [0, 0],
        incomingTimes: [0, 0],
        alphas: [0.25, 0.75],
        frameDuration: 1 / 60,
      },
      blenderFor,
      async () => {},
    );
    expect(blenderFor).toHaveBeenCalledWith(null);
  });

  it("stops on abort: both iterators' return() awaited and the held samples closed", async () => {
    const controller = new AbortController();
    const a = [frame(10), frame(11), frame(12)];
    const b = [frame(20), frame(21), frame(22)];
    const out = iteratorOf(a);
    const inc = iteratorOf(b);
    const { blender, results } = recordingBlender();
    const added = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      encodeDissolve(
        {
          outgoing: trackOf(out.iterator, []),
          incoming: trackOf(inc.iterator, []),
          timestamps: [0, 1, 2],
          outgoingTimes: [0, 1, 2],
          incomingTimes: [0, 1, 2],
          alphas: [0.2, 0.5, 0.8],
          frameDuration: 1 / 60,
          signal: controller.signal,
        },
        () => blender,
        added,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(added).toHaveBeenCalledTimes(1);
    expect(results[0].close).toHaveBeenCalledTimes(1);
    expect(a[0].close).toHaveBeenCalledTimes(1);
    expect(b[0].close).toHaveBeenCalledTimes(1);
    expect(a[1].close).not.toHaveBeenCalled();
    expect(out.iterator.return).toHaveBeenCalledTimes(1);
    expect(inc.iterator.return).toHaveBeenCalledTimes(1);
    expect(out.state.returnSettled).toBe(true);
    expect(inc.state.returnSettled).toBe(true);
  });

  it("closes the outgoing frame when the incoming decoder throws", async () => {
    const a = [frame(10)];
    const out = iteratorOf(a);
    const inc = iteratorOf([frame(20)], { throwAt: 0 });
    const { blender } = recordingBlender();
    await expect(
      encodeDissolve(
        {
          outgoing: trackOf(out.iterator, []),
          incoming: trackOf(inc.iterator, []),
          timestamps: [0],
          outgoingTimes: [0],
          incomingTimes: [0],
          alphas: [0.5],
          frameDuration: 1 / 60,
        },
        () => blender,
        async () => {},
      ),
    ).rejects.toThrow("decode failed");
    expect(a[0].close).toHaveBeenCalledTimes(1);
    expect(out.state.returnSettled).toBe(true);
    expect(inc.state.returnSettled).toBe(true);
  });

  it("closes a result the encoder refused", async () => {
    const out = iteratorOf([frame(10)]);
    const inc = iteratorOf([frame(20)]);
    const { blender, results } = recordingBlender();
    await expect(
      encodeDissolve(
        {
          outgoing: trackOf(out.iterator, []),
          incoming: trackOf(inc.iterator, []),
          timestamps: [0],
          outgoingTimes: [0],
          incomingTimes: [0],
          alphas: [0.5],
          frameDuration: 1 / 60,
        },
        () => blender,
        async () => {
          throw new Error("encoder failed");
        },
      ),
    ).rejects.toThrow("encoder failed");
    expect(results[0].close).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for an empty dissolve", async () => {
    const iterate = vi.fn();
    const track = { iterate } as unknown as InputVideoTrack;
    await encodeDissolve(
      { outgoing: track, incoming: track, timestamps: [], outgoingTimes: [], incomingTimes: [], alphas: [], frameDuration: 1 / 60 },
      () => recordingBlender().blender,
      async () => {},
    );
    expect(iterate).not.toHaveBeenCalled();
  });
});
