import { ALL_FORMATS, BlobSource, Input, UrlSource, VideoSampleSink } from "mediabunny";
import type { InputVideoTrack, VideoSample } from "mediabunny";
import { openClipReader, type ClipReader, type ClipReaderWindow } from "./clipReader";
import { probeClip } from "./clipProbe";
import type { StitchOptions } from "./engineTypes";
import {
  chooseFrameSlot,
  EMPTY_FACTS,
  planFrameAt,
  type FrameClip,
  type FrameLayer,
  type FramePlan,
  type FrameSourceFacts,
} from "./framePlan";
import { domOpacities, LAYER_WARNING } from "./placement";
import type { SourceKey } from "./timeline";

/**
 * Frame to canvas, in the page: the frame planned for the playhead (framePlan.ts), decoded from the clips' files
 * with the engine's own readers, composited as Render's canvas path composites it, and encoded as PNG.
 */

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export type FrameCaptureFailure = "crossOrigin" | "unreadable" | "empty" | "timeout";

export class FrameCaptureError extends Error {
  constructor(
    readonly kind: FrameCaptureFailure,
    message: string,
    /** 1-based, as the rail's "Clip N". */
    readonly clipNumber?: number,
  ) {
    super(message);
    this.name = "FrameCaptureError";
  }
}

/** An opened source: its video track, the facts the encode reads from it, and how to let it go. */
export interface FrameSource {
  track: InputVideoTrack;
  facts: FrameSourceFacts;
  dispose(): void;
}

export interface FrameCaptureDeps {
  open(src: string, signal?: AbortSignal): Promise<FrameSource>;
  canvas(size: { width: number; height: number }): { ctx: Context2D; toBlob(): Promise<Blob> };
  reader(track: InputVideoTrack, range: { from: number; to: number }, window: ClipReaderWindow, inSec: number): ClipReader;
  sampleAt(track: InputVideoTrack, time: number): Promise<VideoSample | null>;
}

export interface FrameCaptureJob {
  clips: FrameClip[];
  options: StitchOptions;
  t: number;
  /** shownAt(spans, t, stack) at the press: the clip ids the preview showed. */
  shown: ReadonlySet<string>;
  /** The raw src (the view's src), never the playable blob: copy. */
  srcOf(source: SourceKey): string | null;
  /** 1-based, as the rail's "Clip N". */
  clipNumberOf(clipId: string): number;
  size: { width: number; height: number };
  signal?: AbortSignal;
}

export interface FrameCapture {
  blob: Blob;
  width: number;
  height: number;
  plan: FramePlan;
  /** Per layer drawn, bottom first: its clip, the source time of the frame drawn, its weight. */
  drawn: { clipId: string; sourceSec: number; weight: number }[];
}

/** Whether src is an absolute http(s) URL on another origin than the page's. data:, blob: and relative URLs are not. */
export function isCrossOriginUrl(src: string, origin: string | undefined = globalThis.location?.origin): boolean {
  if (src.startsWith("data:") || src.startsWith("blob:")) return false;
  let url: URL;
  try {
    url = origin ? new URL(src, origin) : new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin !== origin;
}

/**
 * The source as mediaInfo's probe opens it: data: and blob: are fetched whole, anything else is read by range
 * without retries. An abort disposes the input, which rejects its pending reads.
 */
export async function openFrameSource(src: string, signal?: AbortSignal): Promise<FrameSource> {
  signal?.throwIfAborted();
  const source =
    src.startsWith("data:") || src.startsWith("blob:")
      ? new BlobSource(await (await fetch(src, { signal })).blob())
      : new UrlSource(src, { getRetryDelay: () => null });
  const input = new Input({ source, formats: ALL_FORMATS });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    input.dispose();
  };
  signal?.addEventListener("abort", dispose, { once: true });
  try {
    signal?.throwIfAborted();
    const probe = await probeClip(input);
    if (!probe) throw new Error("The file has no video track");
    return {
      track: probe.videoTrack,
      facts: { firstTimestamp: probe.firstTimestamp, frameRate: probe.frameRate },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    signal?.removeEventListener("abort", dispose);
  }
}

function defaultCanvas(size: { width: number; height: number }): { ctx: Context2D; toBlob(): Promise<Blob> } {
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas to draw the frame on");
    return {
      ctx,
      toBlob: () =>
        new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The frame could not be encoded as PNG"))), "image/png"),
        ),
    };
  }
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas to draw the frame on");
  return { ctx, toBlob: () => canvas.convertToBlob({ type: "image/png" }) };
}

const DEFAULT_DEPS: FrameCaptureDeps = {
  open: openFrameSource,
  canvas: defaultCanvas,
  reader: openClipReader,
  sampleAt: (track, time) => new VideoSampleSink(track).getSample(time),
};

const isTimeout = (reason: unknown) =>
  typeof reason === "object" && reason !== null && (reason as { name?: unknown }).name === "TimeoutError";

const isSecurityError = (error: unknown) => error instanceof DOMException && error.name === "SecurityError";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The frame under the playhead at job.size, as PNG. Opens only the sources the slot's layers read, each once (a held
 * read's only when the layer's own read gives no frame), and closes every reader and sample and disposes every source before it returns or throws. An abort whose reason is a
 * TimeoutError becomes a "timeout" naming the clip that was still being read; any other abort is an AbortError.
 */
export async function captureSequenceFrame(job: FrameCaptureJob, deps: Partial<FrameCaptureDeps> = {}): Promise<FrameCapture> {
  const d: FrameCaptureDeps = { ...DEFAULT_DEPS, ...deps };
  const { signal } = job;
  const slot = chooseFrameSlot(job.clips, job.options, job.t, job.shown);
  const plan0 = planFrameAt(job.clips, job.options, slot, EMPTY_FACTS);
  if (plan0.show.kind !== "layers") throw new FrameCaptureError("empty", "Nothing plays at the playhead");
  const layers0 = plan0.show.layers;

  const opened = new Map<SourceKey, FrameSource>();
  const readers: ClipReader[] = [];
  const samples: VideoSample[] = [];
  let disposed = false;
  const disposeSources = () => {
    if (disposed) return;
    disposed = true;
    for (const source of opened.values()) source.dispose();
  };
  /** The layer whose source or frame is being read: a timeout names its clip. */
  let current: Pick<FrameLayer, "clipId" | "source"> | null = layers0[0];
  const clipNumber = (layer: Pick<FrameLayer, "clipId"> | null) => (layer ? job.clipNumberOf(layer.clipId) : undefined);
  const failureOf = (layer: Pick<FrameLayer, "clipId" | "source">, error: unknown) => {
    const src = job.srcOf(layer.source);
    const kind = src !== null && isCrossOriginUrl(src) ? "crossOrigin" : "unreadable";
    return new FrameCaptureError(kind, messageOf(error), clipNumber(layer));
  };

  // A read the abort stops: a hung fetch or decode never settles, so the capture does not wait on it
  let stopped: Promise<never> | null = null;
  let onAbort: (() => void) | null = null;
  if (signal) {
    stopped = new Promise<never>((_, reject) => {
      onAbort = () => {
        disposeSources();
        reject(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    stopped.catch(() => undefined);
  }
  const untilStopped = <T>(promise: Promise<T>): Promise<T> => (stopped ? Promise.race([promise, stopped]) : promise);

  /** Opens a source once; a failure names `layer`, the clip that reads it. */
  const openSource = async (key: SourceKey, layer: Pick<FrameLayer, "clipId" | "source">): Promise<FrameSource> => {
    const known = opened.get(key);
    if (known) return known;
    const src = job.srcOf(key);
    if (!src) throw new FrameCaptureError("unreadable", "The clip has no video", clipNumber(layer));
    const pending = d.open(src, signal);
    // Opened after an abort or a failure: let it go at once
    pending.then(
      (source) => {
        if (disposed) source.dispose();
      },
      () => undefined,
    );
    let source: FrameSource;
    try {
      source = await untilStopped(pending);
    } catch (error) {
      if (signal?.aborted || error instanceof FrameCaptureError) throw error;
      throw failureOf(layer, error);
    }
    opened.set(key, source);
    return source;
  };
  const openedFacts = () => new Map<SourceKey, FrameSourceFacts>([...opened].map(([key, source]) => [key, source.facts]));

  try {
    try {
      await Promise.all(
        plan0.sources.map(async (key) => {
          await openSource(key, layers0.find((l) => l.source === key) ?? layers0[0]);
          if (current?.source === key) current = layers0.find((l) => !opened.has(l.source)) ?? layers0[0];
        }),
      );
    } catch (error) {
      if (!signal?.aborted) throw error;
      // Name the first layer whose source had not opened
      current = layers0.find((l) => !opened.has(l.source)) ?? current;
      throw signal.reason;
    }

    let plan = planFrameAt(job.clips, job.options, slot, openedFacts());
    if (plan.show.kind !== "layers") throw new FrameCaptureError("empty", "Nothing plays at the playhead");
    const layers = plan.show.layers;
    if (layers.length > LAYER_WARNING) {
      console.warn(`[VideoStitch] ${layers.length} clips blend at once; this takes about ${layers.length * 50} MB at 1080p`);
    }

    const sourceFor = (layer: Pick<FrameLayer, "clipId" | "source">): FrameSource => {
      const source = opened.get(layer.source);
      if (!source) throw new FrameCaptureError("unreadable", "The clip's video was not opened", clipNumber(layer));
      return source;
    };
    /** The layer's frame, and its reader when it reads by slot (the reader keeps its frames; a time read's is ours). */
    const readLayer = async (
      layer: Omit<FrameLayer, "held" | "weight">,
    ): Promise<{ sample: VideoSample | null; reader: ClipReader | null }> => {
      const { read } = layer;
      const { track } = sourceFor(layer);
      if (read.by === "time") {
        const sample = await untilStopped(d.sampleAt(track, read.time));
        if (sample) samples.push(sample);
        return { sample, reader: null };
      }
      const reader = d.reader(track, read.range, read.window, read.inSec);
      readers.push(reader);
      return { sample: await untilStopped(reader.frameOn(read.slot)), reader };
    };
    /**
     * The held read, its source opened only now that it is needed, and planned again with that source's facts
     * (its window starts at its own first timestamp).
     */
    const heldRead = async (k: number, held: Omit<FrameLayer, "held" | "weight">) => {
      if (opened.has(held.source)) return held;
      await openSource(held.source, held);
      plan = planFrameAt(job.clips, job.options, slot, openedFacts());
      const again = plan.show.kind === "layers" ? plan.show.layers[k] : undefined;
      return again?.unit === layers[k].unit && again.held ? again.held : held;
    };

    /** Per layer drawn: the frame, and the clip it came from (the held clip's when the layer's own read gave none). */
    const read: Array<{ layer: FrameLayer; from: Pick<FrameLayer, "clipId" | "source">; sample: VideoSample }> = [];
    for (const [k, layer] of layers.entries()) {
      if (signal?.aborted) throw signal.reason;
      current = layer;
      let from: Pick<FrameLayer, "clipId" | "source"> = layer;
      let sample: VideoSample | null;
      try {
        const own = await readLayer(layer);
        sample = own.sample;
        if (!sample && layer.held) {
          current = layer.held;
          const held = await heldRead(k, layer.held);
          sample = (await readLayer(held)).sample;
          if (sample) from = held;
          current = layer;
        }
        // Nothing on or before the slot: the clip's first frame
        if (!sample && own.reader) sample = await untilStopped(own.reader.firstFrame());
      } catch (error) {
        if (signal?.aborted || error instanceof FrameCaptureError) throw error;
        throw failureOf(current ?? layer, error);
      }
      if (sample) read.push({ layer, from, sample });
    }
    if (signal?.aborted) throw signal.reason;
    if (read.length === 0) throw new FrameCaptureError("unreadable", "No frame could be read at the playhead", clipNumber(layers0[0]));
    current = null;

    // Render's composite: the layers present, their weights divided by their sum (a zero sum gives the bottom 1)
    const raw = read.map(({ layer }) => (Number.isFinite(layer.weight) && layer.weight > 0 ? layer.weight : 0));
    const sum = raw.reduce((total, w) => total + w, 0);
    const weights = sum > 0 ? raw.map((w) => w / sum) : raw.map((_, k) => (k === 0 ? 1 : 0));
    const opacities = domOpacities(weights);

    const { width, height } = job.size;
    let blob: Blob;
    try {
      const { ctx, toBlob } = d.canvas({ width, height });
      ctx.globalAlpha = 1;
      ctx.fillStyle = "black";
      ctx.fillRect(0, 0, width, height);
      read.forEach(({ sample }, k) => {
        ctx.globalAlpha = k === 0 ? 1 : opacities[k];
        // Upright by the sample's own rotation
        sample.drawWithFit(ctx, { fit: "cover" });
      });
      ctx.globalAlpha = 1;
      blob = await untilStopped(toBlob());
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (isSecurityError(error)) {
        const blocked = read.find(({ from }) => {
          const src = job.srcOf(from.source);
          return src !== null && isCrossOriginUrl(src);
        });
        throw new FrameCaptureError("crossOrigin", messageOf(error), clipNumber(blocked?.from ?? read[0].from));
      }
      throw new FrameCaptureError("unreadable", messageOf(error), clipNumber(read[0].from));
    }

    return {
      blob,
      width,
      height,
      plan,
      drawn: read.map(({ from, sample }, k) => ({ clipId: from.clipId, sourceSec: sample.timestamp, weight: weights[k] })),
    };
  } catch (error) {
    // Once aborted, a read the abort broke fails with its own error: the abort is what happened
    if (signal?.aborted) {
      if (isTimeout(signal.reason)) {
        throw new FrameCaptureError("timeout", "Reading the clip took too long", clipNumber(current ?? layers0[0]));
      }
      throw new DOMException("Aborted", "AbortError");
    }
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    for (const sample of samples) sample.close();
    await Promise.all(readers.map((reader) => reader.close()));
    disposeSources();
  }
}
