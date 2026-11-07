import { VideoSample, VideoSampleSink } from "mediabunny";
import type { InputVideoTrack, VideoSampleInit, VideoSamplePixelFormat } from "mediabunny";
import { domOpacities } from "./placement";

/**
 * The picture side of a stacked crossfade: two decoded frames blended into
 * one, and a dissolve's frames read from both clips in step and handed to the
 * encoder; for a placed stack, any number of frames composited by weight, and
 * the black frame a gap shows. Runs in the page (mediabunny, canvas, pixel
 * buffers); the timing comes from dissolveFrames in stack.ts, or from
 * placedSchedule.ts.
 *
 * Frames that share a size and an 8-bit format are blended byte by byte in
 * their own planes: a linear blend in Y'CbCr equals one in R'G'B', so the
 * blended frames keep the colour of the frames passed straight through on
 * either side. A canvas is used only when that cannot be done.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const clamp01 = (value: number) => (Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), 1));

/** Pure: out[i] = round(a[i] + (b[i] − a[i])·alpha) for three buffers of one length. */
export function blendBytes(a: Uint8Array, b: Uint8Array, alpha: number, out: Uint8Array): void {
  const t = clamp01(alpha);
  const n = Math.min(a.length, b.length, out.length);
  // Every value is in [0, 255], so adding a half and truncating rounds
  for (let i = 0; i < n; i++) out[i] = (a[i] + (b[i] - a[i]) * t + 0.5) | 0;
}

/**
 * Pure: out[i] = clamp(round(Σ w_k · x_k[i]), 0, 255) for K buffers of one length; the weights are summed in floating
 * point and rounded once, so weights that sum a hair past 1 over 255s still give 255.
 */
export function blendBytesWeighted(inputs: readonly Uint8Array[], weights: readonly number[], out: Uint8Array): void {
  const count = Math.min(inputs.length, weights.length);
  let n = out.length;
  for (let k = 0; k < count; k++) n = Math.min(n, inputs[k].length);
  for (let i = 0; i < n; i++) {
    let value = 0.5;
    for (let k = 0; k < count; k++) value += weights[k] * inputs[k][i];
    out[i] = value >= 255 ? 255 : value <= 0 ? 0 : value | 0;
  }
}

/** 8-bit pixel formats a byte-wise blend is exact for (planar, semi-planar and packed alike). */
export const BYTE_BLEND_FORMATS: ReadonlySet<string> = new Set([
  "I420",
  "I420A",
  "I422",
  "I444",
  "NV12",
  "RGBA",
  "RGBX",
  "BGRA",
  "BGRX",
]);

/** Bytes of a tightly packed frame, so a frame whose visible area differs from its coded size never takes the bytes path. */
function packedSize(format: VideoSamplePixelFormat, width: number, height: number): number {
  const luma = width * height;
  const halfW = Math.ceil(width / 2);
  const halfH = Math.ceil(height / 2);
  switch (format) {
    case "I420":
    case "NV12":
      return luma + 2 * halfW * halfH;
    case "I420A":
      return 2 * luma + 2 * halfW * halfH;
    case "I422":
      return luma + 2 * halfW * height;
    case "I444":
      return 3 * luma;
    default:
      return 4 * luma;
  }
}

const samePlaneLayout = (a: PlaneLayout[], b: PlaneLayout[]) =>
  a.length === b.length && a.every((plane, i) => plane.offset === b[i].offset && plane.stride === b[i].stride);

export interface FrameBlender {
  /** a at 1 − alpha under b at alpha; a missing side: the other alone. Rotation 0. The caller closes the result. */
  blend(a: VideoSample | null, b: VideoSample | null, alpha: number, timestamp: number, duration: number): Promise<VideoSample>;
  /**
   * Layers bottom to top. Null samples are dropped first and the remaining weights are divided by their sum (a zero sum
   * gives the bottom present layer weight 1; no layer at all gives black). Rotation 0. The caller closes the result.
   * `inRefFormat`: a composite made on the canvas comes back in ref's own YUV format and colour space (as black does),
   * not as the canvas's RGB, so the encode's first frame cannot tag the file with the canvas's sRGB transfer.
   */
  composite(
    layers: ReadonlyArray<{ sample: VideoSample | null; weight: number }>,
    timestamp: number,
    duration: number,
    opts?: { inRefFormat?: boolean },
  ): Promise<VideoSample>;
  /**
   * A black frame at ref: in ref's own format, coded size and colour space when that format is 8-bit planar or
   * semi-planar YUV (I420, I420A, I422, I444, NV12): Y 16 (0 when the range is full), Cb = Cr = 128, alpha 255.
   * Otherwise RGBX zeros. Rotation 0. The caller closes it.
   */
  black(timestamp: number, duration: number): VideoSample;
}

/**
 * The encode's reference frame: mediabunny's box (the first frame it takes, coded size) and, when known, its pixel
 * format and colour space, which a black frame is made in so that it cannot set the file's colour tags.
 */
export interface BlenderRef {
  width: number;
  height: number;
  format?: VideoSamplePixelFormat | null;
  colorSpace?: VideoColorSpaceInit;
}

/** Tightly packed planes of a black YUV frame: offsets, strides and each plane's fill. */
function blackPlanes(
  format: VideoSamplePixelFormat,
  width: number,
  height: number,
  luma: number,
): Array<{ offset: number; stride: number; rows: number; fill: number }> | null {
  const halfW = Math.ceil(width / 2);
  const halfH = Math.ceil(height / 2);
  const ySize = width * height;
  switch (format) {
    case "I420":
    case "I420A": {
      const chroma = halfW * halfH;
      const planes = [
        { offset: 0, stride: width, rows: height, fill: luma },
        { offset: ySize, stride: halfW, rows: halfH, fill: 128 },
        { offset: ySize + chroma, stride: halfW, rows: halfH, fill: 128 },
      ];
      if (format === "I420A") planes.push({ offset: ySize + 2 * chroma, stride: width, rows: height, fill: 255 });
      return planes;
    }
    case "I422":
      return [
        { offset: 0, stride: width, rows: height, fill: luma },
        { offset: ySize, stride: halfW, rows: height, fill: 128 },
        { offset: ySize + halfW * height, stride: halfW, rows: height, fill: 128 },
      ];
    case "I444":
      return [
        { offset: 0, stride: width, rows: height, fill: luma },
        { offset: ySize, stride: width, rows: height, fill: 128 },
        { offset: 2 * ySize, stride: width, rows: height, fill: 128 },
      ];
    case "NV12":
      return [
        { offset: 0, stride: width, rows: height, fill: luma },
        { offset: ySize, stride: 2 * halfW, rows: halfH, fill: 128 },
      ];
    default:
      return null;
  }
}

/**
 * The 8-bit YUV format a frame made for `ref` (black, a canvas read back) takes: ref's own when blackPlanes lays it out;
 * I420 for a YUV format it does not (10- and 12-bit), or no format with a known colour space, so the frame keeps ref's
 * colour tags whatever its bit depth (the encoder takes 8-bit I420 from any source); null for an RGB or unknown one.
 */
function madeFormat(ref: BlenderRef): VideoSamplePixelFormat | null {
  if (ref.format && blackPlanes(ref.format, 2, 2, 0)) return ref.format;
  if (ref.format ? /^(I4|NV)/.test(ref.format) : ref.colorSpace !== undefined) return "I420";
  return null;
}

/** (Kr, Kb) of a colour space's Y'CbCr matrix: BT.709 when it names none; null for an RGB one. */
function lumaCoefficients(matrix: string | null | undefined): [number, number] | null {
  switch (matrix) {
    case "rgb":
      return null;
    case "bt470bg":
    case "smpte170m":
      return [0.299, 0.114];
    case "bt2020-ncl":
      return [0.2627, 0.0593];
    default:
      return [0.2126, 0.0722];
  }
}

const toByte = (value: number) => (value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value));

/**
 * Pure: an RGBA picture (a canvas's pixels, width × height) as Y'CbCr bytes, tightly packed in blackPlanes' layout for
 * `format`, by the colour space's matrix and range (limited unless fullRange). Each chroma sample is taken from the
 * mean of the pixels it covers; I420A's alpha is 255. Null for a format blackPlanes does not lay out, or an RGB matrix.
 */
export function rgbaToYuv(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  format: VideoSamplePixelFormat,
  colorSpace?: VideoColorSpaceInit,
): { data: Uint8Array; layout: PlaneLayout[] } | null {
  const planes = blackPlanes(format, width, height, 0);
  const coefficients = lumaCoefficients(colorSpace?.matrix);
  if (!planes || !coefficients) return null;
  const [kr, kb] = coefficients;
  const kg = 1 - kr - kb;
  const full = colorSpace?.fullRange === true;
  const yScale = full ? 255 : 219;
  const yOffset = full ? 0 : 16;
  const cScale = full ? 255 : 224;
  const data = new Uint8Array(packedSize(format, width, height));
  const lumaOf = (r: number, g: number, b: number) => kr * r + kg * g + kb * b;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = 4 * (y * width + x);
      data[planes[0].offset + y * planes[0].stride + x] = toByte(yOffset + (yScale * lumaOf(rgba[i], rgba[i + 1], rgba[i + 2])) / 255);
    }
  }
  const stepX = format === "I444" ? 1 : 2;
  const stepY = format === "I420" || format === "I420A" || format === "NV12" ? 2 : 1;
  for (let cy = 0; cy * stepY < height; cy++) {
    for (let cx = 0; cx * stepX < width; cx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = cy * stepY; y < Math.min(height, (cy + 1) * stepY); y++) {
        for (let x = cx * stepX; x < Math.min(width, (cx + 1) * stepX); x++) {
          const i = 4 * (y * width + x);
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n++;
        }
      }
      r /= 255 * n;
      g /= 255 * n;
      b /= 255 * n;
      const luma = lumaOf(r, g, b);
      const cb = toByte(128 + (cScale * (b - luma)) / (2 * (1 - kb)));
      const cr = toByte(128 + (cScale * (r - luma)) / (2 * (1 - kr)));
      if (format === "NV12") {
        const at = planes[1].offset + cy * planes[1].stride + 2 * cx;
        data[at] = cb;
        data[at + 1] = cr;
      } else {
        data[planes[1].offset + cy * planes[1].stride + cx] = cb;
        data[planes[2].offset + cy * planes[2].stride + cx] = cr;
      }
    }
  }
  if (format === "I420A") data.fill(255, planes[3].offset, planes[3].offset + planes[3].stride * planes[3].rows);
  return { data, layout: planes.map(({ offset, stride }) => ({ offset, stride })) };
}

export interface FrameBlenderDeps {
  /** Makes the fallback canvas's context at the reference size; a document canvas, else an OffscreenCanvas. */
  context2d?: (size: { width: number; height: number }, options: { alpha: boolean }) => Context2D;
  isFirefox?: boolean;
}

function defaultContext2d(size: { width: number; height: number }, options: { alpha: boolean }): Context2D {
  let context: Context2D | null;
  if (typeof document !== "undefined") {
    const canvas: HTMLCanvasElement = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    context = canvas.getContext("2d", { alpha: options.alpha });
  } else {
    context = new OffscreenCanvas(size.width, size.height).getContext("2d", options);
  }
  if (!context) throw new Error("No 2D canvas to blend the crossfade on");
  return context;
}

const detectFirefox = () => typeof navigator !== "undefined" && navigator.userAgent.includes("Firefox");

/**
 * Bytes path when both are non-null, share a format in BYTE_BLEND_FORMATS, have coded size === ref, and equal allocationSize():
 *   copyTo into two reused read buffers, blendBytes into a reused output buffer, then a new VideoSample of those bytes with a's
 *   colour space and rotation 0 (the sample copies the bytes it is given, so it owns its own and the buffer can be reused).
 * Otherwise (mixed sizes, a null or 10-bit format, a single side at another size, or copyTo throwing — after which the blender
 * stays on the canvas): one canvas at ref size, black fill, a drawn to cover at globalAlpha 1, b at alpha over it, rotation 0.
 * Its context is opaque except on Firefox, as mediabunny keeps its own (VideoFrame glitches with opaque canvases there).
 * A single side at ref size passes as a clone with the new timestamp.
 */
export function createFrameBlender(ref: BlenderRef, deps: FrameBlenderDeps = {}): FrameBlender {
  const isFirefox = deps.isFirefox ?? detectFirefox();
  let bytesFailed = false;
  let readA: Uint8Array | null = null;
  let readB: Uint8Array | null = null;
  let blendOut: Uint8Array | null = null;
  let context: Context2D | null = null;
  /** composite's read buffers past the first two, one per layer, reused. */
  const readMore: Uint8Array[] = [];
  let blackFrame: {
    data: Uint8Array;
    init: VideoSampleInit & { format: VideoSamplePixelFormat; codedWidth: number; codedHeight: number };
  } | null = null;

  const atRef = (sample: VideoSample) => sample.codedWidth === ref.width && sample.codedHeight === ref.height;

  const bytesPlan = (a: VideoSample, b: VideoSample): { format: VideoSamplePixelFormat; size: number } | null => {
    const format = a.format;
    if (bytesFailed || format === null || format !== b.format || !BYTE_BLEND_FORMATS.has(format)) return null;
    if (!atRef(a) || !atRef(b)) return null;
    const size = a.allocationSize();
    if (b.allocationSize() !== size || size !== packedSize(format, ref.width, ref.height)) return null;
    return { format, size };
  };

  const blendInBytes = async (
    a: VideoSample,
    b: VideoSample,
    { format, size }: { format: VideoSamplePixelFormat; size: number },
    alpha: number,
    timestamp: number,
    duration: number,
  ): Promise<VideoSample | null> => {
    if (readA?.length !== size) readA = new Uint8Array(size);
    if (readB?.length !== size) readB = new Uint8Array(size);
    const layoutA = await a.copyTo(readA);
    const layoutB = await b.copyTo(readB);
    if (!samePlaneLayout(layoutA, layoutB)) return null;
    if (blendOut?.length !== size) blendOut = new Uint8Array(size);
    blendBytes(readA, readB, alpha, blendOut);
    return new VideoSample(blendOut, {
      format,
      codedWidth: ref.width,
      codedHeight: ref.height,
      timestamp,
      duration,
      colorSpace: a.colorSpace,
      layout: layoutA,
      rotation: 0,
    });
  };

  const blendOnCanvas = (a: VideoSample | null, b: VideoSample | null, alpha: number, timestamp: number, duration: number) => {
    context ??= (deps.context2d ?? defaultContext2d)(ref, { alpha: isFirefox });
    context.globalAlpha = 1;
    context.fillStyle = "black";
    context.fillRect(0, 0, ref.width, ref.height);
    if (a) a.drawWithFit(context, { fit: "cover", rotation: 0 });
    if (b) {
      context.globalAlpha = a ? clamp01(alpha) : 1;
      b.drawWithFit(context, { fit: "cover", rotation: 0 });
      context.globalAlpha = 1;
    }
    return new VideoSample(context.canvas, { timestamp, duration, rotation: 0 });
  };

  const compositeInBytes = async (
    samples: readonly VideoSample[],
    weights: readonly number[],
    { format, size }: { format: VideoSamplePixelFormat; size: number },
    timestamp: number,
    duration: number,
  ): Promise<VideoSample | null> => {
    const reads: Uint8Array[] = [];
    const layouts: PlaneLayout[][] = [];
    for (let k = 0; k < samples.length; k++) {
      if (readMore[k]?.length !== size) readMore[k] = new Uint8Array(size);
      reads.push(readMore[k]);
      layouts.push(await samples[k].copyTo(readMore[k]));
    }
    if (!layouts.every((layout) => samePlaneLayout(layout, layouts[0]))) return null;
    if (blendOut?.length !== size) blendOut = new Uint8Array(size);
    blendBytesWeighted(reads, weights, blendOut);
    return new VideoSample(blendOut, {
      format,
      codedWidth: ref.width,
      codedHeight: ref.height,
      timestamp,
      duration,
      colorSpace: samples[0].colorSpace,
      layout: layouts[0],
      rotation: 0,
    });
  };

  const black = (timestamp: number, duration: number): VideoSample => {
    if (!blackFrame) {
      const { width, height } = ref;
      const luma = ref.colorSpace?.fullRange ? 0 : 16;
      const format = madeFormat(ref);
      const planes = format ? blackPlanes(format, width, height, luma) : null;
      if (format && planes) {
        const size = packedSize(format, width, height);
        const data = new Uint8Array(size);
        for (const plane of planes) data.fill(plane.fill, plane.offset, plane.offset + plane.stride * plane.rows);
        blackFrame = {
          data,
          init: {
            format,
            codedWidth: width,
            codedHeight: height,
            colorSpace: ref.colorSpace,
            layout: planes.map(({ offset, stride }) => ({ offset, stride })),
            rotation: 0,
          },
        };
      } else {
        blackFrame = {
          data: new Uint8Array(width * height * 4),
          init: { format: "RGBX", codedWidth: width, codedHeight: height, rotation: 0 },
        };
      }
    }
    return new VideoSample(blackFrame.data, { ...blackFrame.init, timestamp, duration });
  };

  /**
   * Black fill, the bottom at 1, each layer above at its DOM opacity, each drawn to cover. inRefFormat: read back and
   * returned in ref's colour space, in ref's YUV format or I420 (madeFormat).
   */
  const compositeOnCanvas = (
    samples: readonly VideoSample[],
    weights: readonly number[],
    timestamp: number,
    duration: number,
    inRefFormat: boolean,
  ) => {
    const ctx = (context ??= (deps.context2d ?? defaultContext2d)(ref, { alpha: isFirefox }));
    const opacities = domOpacities(weights);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, ref.width, ref.height);
    samples.forEach((sample, k) => {
      ctx.globalAlpha = k === 0 ? 1 : opacities[k];
      sample.drawWithFit(ctx, { fit: "cover", rotation: 0 });
    });
    ctx.globalAlpha = 1;
    const format = inRefFormat ? madeFormat(ref) : null;
    if (format) {
      const pixels = ctx.getImageData(0, 0, ref.width, ref.height).data;
      const yuv = rgbaToYuv(pixels, ref.width, ref.height, format, ref.colorSpace);
      if (yuv) {
        return new VideoSample(yuv.data, {
          format,
          codedWidth: ref.width,
          codedHeight: ref.height,
          colorSpace: ref.colorSpace,
          layout: yuv.layout,
          timestamp,
          duration,
          rotation: 0,
        });
      }
    }
    return new VideoSample(ctx.canvas, { timestamp, duration, rotation: 0 });
  };

  return {
    async blend(a, b, alpha, timestamp, duration) {
      if (a && b) {
        const plan = bytesPlan(a, b);
        if (plan) {
          try {
            const blended = await blendInBytes(a, b, plan, alpha, timestamp, duration);
            if (blended) return blended;
          } catch (error) {
            console.warn("[VideoStitch] Blending frame bytes failed; blending on a canvas from here on", error);
            bytesFailed = true;
          }
        }
      }
      const single = a && !b ? a : !a && b ? b : null;
      if (single && atRef(single)) {
        const copy = single.clone();
        copy.setTimestamp(timestamp);
        copy.setDuration(duration);
        return copy;
      }
      return blendOnCanvas(a, b, alpha, timestamp, duration);
    },

    async composite(layers, timestamp, duration, opts) {
      const present = layers.filter((layer): layer is { sample: VideoSample; weight: number } => layer.sample !== null);
      if (present.length === 0) return black(timestamp, duration);
      const raw = present.map((layer) => (Number.isFinite(layer.weight) && layer.weight > 0 ? layer.weight : 0));
      const sum = raw.reduce((total, w) => total + w, 0);
      const weights = sum > 0 ? raw.map((w) => w / sum) : raw.map((_, i) => (i === 0 ? 1 : 0));
      const samples = present.map((layer) => layer.sample);
      if (samples.length === 1) {
        const [only] = samples;
        if (atRef(only)) {
          const copy = only.clone();
          copy.setTimestamp(timestamp);
          copy.setDuration(duration);
          return copy;
        }
      } else {
        const plans = samples.slice(1).map((sample) => bytesPlan(samples[0], sample));
        const plan = plans[0];
        if (plan && plans.every((p) => p !== null)) {
          try {
            const blended =
              samples.length === 2
                ? await blendInBytes(samples[0], samples[1], plan, weights[1], timestamp, duration)
                : await compositeInBytes(samples, weights, plan, timestamp, duration);
            if (blended) return blended;
          } catch (error) {
            console.warn("[VideoStitch] Blending frame bytes failed; blending on a canvas from here on", error);
            bytesFailed = true;
          }
        }
      }
      return compositeOnCanvas(samples, weights, timestamp, duration, opts?.inRefFormat === true);
    },

    black,
  };
}

export interface DissolveJob {
  outgoing: InputVideoTrack;
  incoming: InputVideoTrack;
  /** Output timestamps (slot / 60), already claimed from the FrameSlotter, ascending. */
  timestamps: number[];
  outgoingTimes: number[];
  incomingTimes: number[];
  alphas: number[];
  /** Each composite's duration: 1/60, as pass-through frames get. */
  frameDuration: number;
  signal?: AbortSignal;
}

async function closeIterator(iterator: AsyncGenerator<VideoSample | null, void, unknown>): Promise<void> {
  try {
    await iterator.return(undefined);
  } catch (error) {
    console.warn("[VideoStitch] Failed to stop a crossfade decoder", error);
  }
}

/**
 * Both sides through new VideoSampleSink(track).samplesAtTimestamps(times), advanced in lockstep (one next() each per frame).
 * blenderFor gets the first outgoing sample (null if none) and returns the encode's blender (created then if needed). Per frame:
 * hold the latest non-null sample of each side (closing the one it replaces), blend, await add(result), close the result. Abort is
 * checked per frame. finally: close both held samples and await return() on both iterators, which closes what they still queue.
 * (return() does not wait for the decoder to close, so a third decoder can briefly overlap the next solo pass.)
 */
export async function encodeDissolve(
  job: DissolveJob,
  blenderFor: (firstOutgoing: VideoSample | null) => FrameBlender,
  add: (sample: VideoSample) => Promise<void>,
): Promise<void> {
  const count = job.timestamps.length;
  if (count === 0) return;
  const outgoing = new VideoSampleSink(job.outgoing).samplesAtTimestamps(job.outgoingTimes);
  const incoming = new VideoSampleSink(job.incoming).samplesAtTimestamps(job.incomingTimes);
  let heldA: VideoSample | null = null;
  let heldB: VideoSample | null = null;
  let blender: FrameBlender | null = null;
  try {
    for (let i = 0; i < count; i++) {
      if (job.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      // Each result is held before the next await, so an error on the other side cannot leak it
      const nextA = await outgoing.next();
      if (!nextA.done && nextA.value) {
        heldA?.close();
        heldA = nextA.value;
      }
      const nextB = await incoming.next();
      if (!nextB.done && nextB.value) {
        heldB?.close();
        heldB = nextB.value;
      }
      blender ??= blenderFor(heldA);
      const blended = await blender.blend(heldA, heldB, job.alphas[i], job.timestamps[i], job.frameDuration);
      try {
        await add(blended);
      } finally {
        blended.close();
      }
    }
  } finally {
    heldA?.close();
    heldB?.close();
    await Promise.all([closeIterator(outgoing), closeIterator(incoming)]);
  }
}
