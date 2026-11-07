import { afterEach, describe, expect, it, vi } from "vitest";

const { prepareAudioAsync, decodeAudioPieces } = vi.hoisted(() => ({ prepareAudioAsync: vi.fn(), decodeAudioPieces: vi.fn() }));
vi.mock("@/hooks/useAudioMixing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useAudioMixing")>()),
  prepareAudioAsync,
  decodeAudioPieces,
}));
import {
  __resetWaveformForTests,
  __setWaveformDecoderForTests,
  getWaveform,
  requestWaveform,
  subscribeWaveform,
  type WaveformDecoder,
  WAVEFORM_DECODES,
  WAVEFORM_LRU_LIMIT,
} from "../waveformCache";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("keeps 16 sources, so a node's audio clips do not decode in a loop as rows scroll", () => {
  expect(WAVEFORM_LRU_LIMIT).toBe(16);
});

afterEach(() => {
  __resetWaveformForTests();
  vi.unstubAllGlobals();
  prepareAudioAsync.mockReset();
  decodeAudioPieces.mockReset();
});

type Each = { piece: (buffer: unknown) => void; restart: () => void };
/** The decoder handing over `pieces` (after `before`, which a fallback then restarts from). */
const handsOver = (pieces: unknown[], before: unknown[] = []) =>
  decodeAudioPieces.mockImplementation(async (_blob: Blob, each: Each) => {
    for (const p of before) each.piece(p);
    if (before.length) each.restart();
    for (const p of pieces) each.piece(p);
  });

/** A decoded piece, as the decoder gives it. */
const piece = (channels: number[][], sampleRate = 10) => ({
  length: channels[0].length,
  sampleRate,
  numberOfChannels: channels.length,
  getChannelData: (c: number) => new Float32Array(channels[c]),
});

/** A decoded two-channel buffer, as prepareAudioAsync gives it. */
const decoded = (channels: number[][], duration: number) =>
  ({
    buffer: {
      numberOfChannels: channels.length,
      getChannelData: (c: number) => new Float32Array(channels[c]),
    },
    duration,
  });

describe("waveformCache", () => {
  it("decodes a key once and keeps its peaks, not its samples", async () => {
    const decode = vi.fn<WaveformDecoder>(async () => ({
      channels: [new Float32Array([0.5, -1, 0.25, 0])],
      duration: 2,
    }));
    __setWaveformDecoderForTests(decode);
    const listener = vi.fn();
    const unsubscribe = subscribeWaveform(listener);
    requestWaveform("k", "blob:m");
    expect(getWaveform("k")).toEqual({ status: "loading", duration: null, peaks: null });
    requestWaveform("k", "blob:m");
    await flush();
    expect(decode).toHaveBeenCalledTimes(1);
    const waveform = getWaveform("k")!;
    expect(waveform.status).toBe("ready");
    expect(waveform.duration).toBe(2);
    expect(Array.from(waveform.peaks!)).toEqual([0.5, 1, 0.25, 0]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("marks a source that does not decode, or decodes to nothing, as an error", async () => {
    __setWaveformDecoderForTests(async (src) => {
      if (src === "bad") throw new Error("nope");
      return { channels: [], duration: 0 };
    });
    requestWaveform("a", "bad");
    requestWaveform("b", "empty");
    await flush();
    expect(getWaveform("a")?.status).toBe("error");
    expect(getWaveform("b")?.status).toBe("error");
  });

  it("keeps the eight keys used last, and a decode that finishes after its key went writes nothing", async () => {
    let finish: (() => void) | null = null;
    __setWaveformDecoderForTests(
      (src) =>
        new Promise((resolve) => {
          const done = () => resolve({ channels: [new Float32Array([0.1])], duration: 1 });
          if (src === "slow") finish = done;
          else done();
        }),
    );
    requestWaveform("slow", "slow");
    for (let i = 0; i < WAVEFORM_LRU_LIMIT; i++) requestWaveform(`k${i}`, `src${i}`);
    expect(getWaveform("slow")).toBeUndefined();
    expect(getWaveform("k0")).toBeDefined();
    await flush();
    const listener = vi.fn();
    const unsubscribe = subscribeWaveform(listener);
    finish!();
    await flush();
    expect(getWaveform("slow")).toBeUndefined();
    // Nobody is told about a decode nobody shows
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    // Asking again counts as a use: k0 outlives k1
    requestWaveform("k0", "src0");
    requestWaveform(`k${WAVEFORM_LRU_LIMIT}`, `src${WAVEFORM_LRU_LIMIT}`);
    expect(getWaveform("k0")).toBeDefined();
    expect(getWaveform("k1")).toBeUndefined();
  });

  it("decodes as the stitch does: the data: URL's type on an untyped response, from the start, every channel", async () => {
    const fetchMock = vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array([1, 2, 3])]) }));
    vi.stubGlobal("fetch", fetchMock);
    // Two pieces at 1 Hz: 3 s, the length prepareAudioAsync(blob, 0) gives
    // MediaBunny gave one piece, then failed: the Web Audio fallback starts again
    handsOver([piece([[0.25, 0], [0, -0.75]], 1), piece([[0.1], [0.5]], 1)], [piece([[1, 1, 1, 1]], 1)]);
    const src = "data:audio/wav;base64,AAAA";
    requestWaveform("w", src);
    await vi.waitFor(() => expect(getWaveform("w")?.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledWith(src);
    expect(decodeAudioPieces).toHaveBeenCalledTimes(1);
    expect((decodeAudioPieces.mock.calls[0][0] as Blob).type).toBe("audio/wav");
    expect(prepareAudioAsync).not.toHaveBeenCalled();
    // The peak of each sample is the louder of the two channels
    expect(Array.from(getWaveform("w")!.peaks!)).toEqual([0.25, 0.75, 0.5]);
    expect(getWaveform("w")!.duration).toBe(3);
  });

  it("reads a file shorter than the stitch's minimum through prepareAudioAsync, which repeats it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array([1])], { type: "audio/wav" }) })));
    // 0.05 s at 100 Hz: prepareAudioAsync fills 0.1 s
    handsOver([piece([[0.5, 0.25, 0.1, 0, 0]], 100)]);
    prepareAudioAsync.mockResolvedValue(decoded([[0.5, 0.25, 0.1, 0, 0, 0.5, 0.25, 0.1, 0, 0]], 0.1));
    requestWaveform("s", "blob:short");
    await vi.waitFor(() => expect(getWaveform("s")?.status).toBe("ready"));
    expect(prepareAudioAsync.mock.calls[0][1]).toBe(0);
    expect(getWaveform("s")!.duration).toBe(0.1);
    expect(getWaveform("s")!.peaks).toHaveLength(10);
  });

  it("falls back to MP3 for an untyped response that is not a data: URL, and to an error when nothing decodes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array([1])]) })));
    handsOver([]);
    requestWaveform("m", "blob:music");
    await vi.waitFor(() => expect(getWaveform("m")?.status).toBe("error"));
    expect((decodeAudioPieces.mock.calls[0][0] as Blob).type).toBe("audio/mpeg");
  });

  it("decodes at most WAVEFORM_DECODES sources at a time, and never one evicted while it waited", async () => {
    const pending = new Map<string, () => void>();
    const decode = vi.fn<WaveformDecoder>(
      (src) =>
        new Promise((resolve) => {
          pending.set(src, () => resolve({ channels: [new Float32Array([0.5])], duration: 1 }));
        }),
    );
    __setWaveformDecoderForTests(decode);
    for (let i = 0; i < 4; i++) requestWaveform(`k${i}`, `src${i}`);
    await flush();
    expect(decode.mock.calls.map(([src]) => src)).toEqual(["src0", "src1"].slice(0, WAVEFORM_DECODES));
    pending.get("src0")!();
    await flush();
    expect(getWaveform("k0")?.status).toBe("ready");
    expect(decode.mock.calls.map(([src]) => src)).toEqual(["src0", "src1", "src2"]);
    // k3 waits; pushed out of the cache before its turn, it is never decoded
    for (let i = 4; i < 4 + WAVEFORM_LRU_LIMIT; i++) {
      requestWaveform(`k${i}`, `src${i}`);
      // Keep k1 and k2, which are decoding, the newest
      requestWaveform("k1", "src1");
      requestWaveform("k2", "src2");
    }
    expect(getWaveform("k3")).toBeUndefined();
    pending.get("src1")!();
    pending.get("src2")!();
    await flush();
    expect(decode.mock.calls.map(([src]) => src)).not.toContain("src3");
  });
});
