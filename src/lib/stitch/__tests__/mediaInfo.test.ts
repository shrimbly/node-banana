import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FILMSTRIP_FRAMES,
  POSTER_FRAME,
  __probeWithMediabunnyForTests,
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  assetMediaKey,
  frameTime,
  getMediaInfo,
  mediaKeyOf,
  nearestFrame,
  requestMediaInfo,
  rereadMediaInfo,
  retainMediaInfo,
  retryMediaInfo,
  type MediaExtractor,
  type StitchMediaInfo,
} from "../mediaInfo";
import { videoTrackDuration } from "../sequencePlan";

// The browser probe, against a mocked mediabunny: a 24 fps track whose last
// packet (119/24 s) was stored without a duration, as WebM from MediaRecorder is.
const mb = vi.hoisted(() => ({
  disposed: 0,
  sources: [] as string[],
  /** The retry rule each UrlSource was given. */
  retryDelays: [] as Array<((attempts: number, error: unknown, url: string) => number | null) | undefined>,
  /** The input has no video track. */
  noTrack: false,
}));
vi.mock("mediabunny", () => {
  const track = {
    displayWidth: 1920,
    displayHeight: 1080,
    computeDuration: async () => 119 / 24,
    computePacketStats: async (count?: number) => ({ averagePacketRate: count === undefined ? 24 : 23.9 }),
  };
  return {
    ALL_FORMATS: [],
    BlobSource: class {
      constructor() {
        mb.sources.push("blob");
      }
    },
    UrlSource: class {
      constructor(url: string, options?: { getRetryDelay?: (typeof mb.retryDelays)[number] }) {
        mb.sources.push(`url:${url}`);
        mb.retryDelays.push(options?.getRetryDelay);
      }
    },
    Input: class {
      async getVideoTracks() {
        return mb.noTrack ? [] : [track];
      }
      async computeDuration() {
        return 119 / 24;
      }
      dispose() {
        mb.disposed++;
      }
    },
    EncodedPacketSink: class {
      async getPacket() {
        return { timestamp: 119 / 24, duration: 0 };
      }
    },
  };
});

const revoke = vi.fn();
const originalRevoke = URL.revokeObjectURL;
URL.revokeObjectURL = revoke;
afterAll(() => {
  URL.revokeObjectURL = originalRevoke;
});

/** A fake extractor that logs every call: probe → `probe:<src>`, open → `open:<src>`, each frame `blob:<src>#<i>`. */
function fakeExtractor(overrides: Partial<MediaExtractor> = {}) {
  const calls: string[] = [];
  const extractor: MediaExtractor = {
    async probe(src) {
      calls.push(`probe:${src}`);
      return { duration: 6, width: 1920, height: 1080, fps: 24 };
    },
    async open(src) {
      calls.push(`open:${src}`);
      return {
        duration: 6,
        width: 1920,
        height: 1080,
        async frame(time) {
          return `blob:${src}#${Math.round((time * FILMSTRIP_FRAMES) / 6 - 0.5)}`;
        },
        close() {},
      };
    },
    ...overrides,
  };
  return { calls, extractor };
}

const settled = (key: string, level: StitchMediaInfo["level"]) =>
  vi.waitFor(() => expect(getMediaInfo(key)?.level).toBe(level));

describe("mediaInfo", () => {
  beforeEach(() => {
    __resetMediaInfoForTests();
    revoke.mockClear();
    mb.disposed = 0;
    mb.sources.length = 0;
    mb.retryDelays.length = 0;
    mb.noTrack = false;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads every source's metadata before drawing any frame", async () => {
    const { calls, extractor } = fakeExtractor();
    __setMediaExtractorForTests(extractor);
    requestMediaInfo("a", "src-a", "poster");
    requestMediaInfo("b", "src-b", "poster");
    await settled("b", "poster");
    await settled("a", "poster");
    expect(calls).toEqual(["probe:src-a", "probe:src-b", "open:src-a", "open:src-b"]);
    const info = getMediaInfo("a")!;
    expect(info).toMatchObject({ status: "ready", duration: 6, width: 1920, height: 1080, fps: 24 });
    expect(info.frames.filter(Boolean)).toEqual([`blob:src-a#${POSTER_FRAME}`]);
  });

  it("asks once per level and upgrades to the filmstrip", async () => {
    const { calls, extractor } = fakeExtractor();
    __setMediaExtractorForTests(extractor);
    requestMediaInfo("a", "src-a", "metadata");
    await settled("a", "metadata");
    requestMediaInfo("a", "src-a", "metadata");
    await Promise.resolve();
    expect(calls).toEqual(["probe:src-a"]);

    // The poster first (every source's poster comes before any filmstrip), then the rest of the strip
    requestMediaInfo("a", "src-a", "filmstrip");
    await settled("a", "filmstrip");
    expect(calls).toEqual(["probe:src-a", "open:src-a", "open:src-a"]);
    expect(getMediaInfo("a")!.frames).toEqual(
      Array.from({ length: FILMSTRIP_FRAMES }, (_, i) => `blob:src-a#${i}`),
    );
  });

  it("evicts the least recently asked entry past 48 and revokes its frames", async () => {
    __setMediaExtractorForTests(fakeExtractor().extractor);
    requestMediaInfo("first", "src-first", "poster");
    await settled("first", "poster");
    for (let i = 0; i < 47; i++) requestMediaInfo(`k${i}`, `src-${i}`, "metadata");
    expect(getMediaInfo("first")).toBeDefined();
    requestMediaInfo("k47", "src-47", "metadata");
    expect(getMediaInfo("first")).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(`blob:src-first#${POSTER_FRAME}`);
  });

  it("never evicts a retained key, and lets it go once released", async () => {
    __setMediaExtractorForTests(fakeExtractor().extractor);
    const release = retainMediaInfo(["keep"]);
    requestMediaInfo("keep", "src-keep", "poster");
    await settled("keep", "poster");
    for (let i = 0; i < 60; i++) requestMediaInfo(`k${i}`, `src-${i}`, "metadata");
    expect(getMediaInfo("keep")?.frames[POSTER_FRAME]).toBe(`blob:src-keep#${POSTER_FRAME}`);
    expect(revoke).not.toHaveBeenCalledWith(`blob:src-keep#${POSTER_FRAME}`);

    release();
    expect(getMediaInfo("keep")).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(`blob:src-keep#${POSTER_FRAME}`);
  });

  it("falls back to the element's duration when the probe fails, without a frame rate", async () => {
    const { extractor } = fakeExtractor({
      probe: async () => {
        throw new Error("Unsupported container");
      },
    });
    __setMediaExtractorForTests(extractor);
    requestMediaInfo("a", "src-a", "metadata");
    await settled("a", "metadata");
    expect(getMediaInfo("a")).toMatchObject({ status: "ready", duration: 6, fps: null });
  });

  it("marks a source unreadable when the element's duration is not finite either", async () => {
    const { extractor } = fakeExtractor({
      probe: async () => {
        throw new Error("Unsupported container");
      },
      open: async () => ({ duration: Infinity, width: 0, height: 0, frame: async () => null, close() {} }),
    });
    __setMediaExtractorForTests(extractor);
    requestMediaInfo("a", "src-a", "poster");
    await vi.waitFor(() => expect(getMediaInfo("a")?.status).toBe("error"));
    expect(getMediaInfo("a")!.duration).toBeNull();
  });

  it("does not read a failed source again by itself, but retryMediaInfo does", async () => {
    let fail = true;
    let probes = 0;
    const { extractor } = fakeExtractor({
      probe: async () => {
        probes++;
        if (fail) throw new Error("Not found");
        return { duration: 6, width: 1920, height: 1080, fps: 24 };
      },
      open: async () => {
        if (fail) throw new Error("Not found");
        return { duration: 6, width: 1920, height: 1080, frame: async () => null, close() {} };
      },
    });
    __setMediaExtractorForTests(extractor);
    const key = assetMediaKey("a1");
    requestMediaInfo(key, "/api/assets/a1/file", "metadata");
    await vi.waitFor(() => expect(getMediaInfo(key)?.status).toBe("error"));
    fail = false;
    requestMediaInfo(key, "/api/assets/a1/file", "metadata");
    await Promise.resolve();
    expect({ probes, status: getMediaInfo(key)?.status }).toEqual({ probes: 1, status: "error" });

    retryMediaInfo(key);
    await settled(key, "metadata");
    expect(getMediaInfo(key)).toMatchObject({ status: "ready", duration: 6 });
    expect(probes).toBe(2);
    // A source that reads is left alone
    retryMediaInfo(key);
    await Promise.resolve();
    expect(probes).toBe(2);
  });

  it("reads a source that did read again with rereadMediaInfo, and drops what the earlier read drew", async () => {
    let probes = 0;
    let drawn = 0;
    const draws: Array<() => void> = [];
    const { extractor } = fakeExtractor({
      probe: async () => {
        probes++;
        return { duration: 6, width: 1920, height: 1080, fps: 24 };
      },
      open: async () => ({
        duration: 6,
        width: 1920,
        height: 1080,
        frame: () => new Promise<string>((resolve) => draws.push(() => resolve(`blob:frame${++drawn}`))),
        close() {},
      }),
    });
    __setMediaExtractorForTests(extractor);
    const key = assetMediaKey("a1");
    requestMediaInfo(key, "/api/assets/a1/file", "poster");
    await vi.waitFor(() => expect(draws).toHaveLength(1));

    // The file went while its poster was being drawn
    rereadMediaInfo(key);
    expect(getMediaInfo(key)).toMatchObject({ status: "loading", duration: null, level: null });
    draws[0]();
    await vi.waitFor(() => expect(draws).toHaveLength(2));
    expect(revoke).toHaveBeenCalledWith("blob:frame1");
    expect(getMediaInfo(key)!.frames.filter(Boolean)).toEqual([]);
    draws[1]();
    await settled(key, "poster");
    expect(getMediaInfo(key)!.frames.filter(Boolean)).toEqual(["blob:frame2"]);
    expect(probes).toBe(2);

    // Frames already drawn are let go
    rereadMediaInfo(key);
    expect(revoke).toHaveBeenCalledWith("blob:frame2");
    expect(getMediaInfo(key)!.frames.filter(Boolean)).toEqual([]);
  });

  it("leaves a source that failed, or is still being read, alone in rereadMediaInfo", async () => {
    const { extractor } = fakeExtractor({
      probe: async () => {
        throw new Error("Not found");
      },
      open: async () => {
        throw new Error("Not found");
      },
    });
    __setMediaExtractorForTests(extractor);
    const key = assetMediaKey("a1");
    requestMediaInfo(key, "/api/assets/a1/file", "metadata");
    const loading = getMediaInfo(key);
    rereadMediaInfo(key);
    expect(getMediaInfo(key)).toBe(loading);
    await vi.waitFor(() => expect(getMediaInfo(key)?.status).toBe("error"));
    const failed = getMediaInfo(key);
    rereadMediaInfo(key);
    expect(getMediaInfo(key)).toBe(failed);
  });

  it("abandons a probe that never answers for the element, and goes on with the queue", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const { calls, extractor } = fakeExtractor({
      probe: (src, s) => {
        if (src === "src-b") return Promise.resolve({ duration: 3, width: 640, height: 360, fps: 30 });
        signal = s;
        return new Promise<never>(() => {});
      },
    });
    __setMediaExtractorForTests(extractor);
    requestMediaInfo("a", "src-a", "metadata");
    requestMediaInfo("b", "src-b", "metadata");
    await vi.advanceTimersByTimeAsync(19_000);
    expect(getMediaInfo("a")?.status).toBe("loading");
    expect(getMediaInfo("b")?.status).toBe("loading");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal?.aborted).toBe(true);
    expect(getMediaInfo("a")).toMatchObject({ status: "ready", duration: 6, fps: null });
    expect(getMediaInfo("b")).toMatchObject({ status: "ready", duration: 3, fps: 30 });
    expect(calls).toContain("open:src-a");
  });

  it("counts a file mediabunny opens without a video track as unreadable, as the encode does", async () => {
    const { calls, extractor } = fakeExtractor({
      probe: async () => ({ duration: 0, width: null, height: null, fps: null }),
    });
    __setMediaExtractorForTests(extractor);
    requestMediaInfo("a", "src-a", "poster");
    await vi.waitFor(() => expect(getMediaInfo("a")?.status).toBe("error"));
    expect(getMediaInfo("a")!.duration).toBeNull();
    // The element (which would say 6 s) is not asked
    expect(calls).toEqual([]);
  });

  it("probes a file without a video track as no length", async () => {
    mb.noTrack = true;
    const probe = await __probeWithMediabunnyForTests("/api/assets/audio-only/file");
    expect(probe.duration).toBe(0);
    expect(mb.disposed).toBe(1);
  });

  it("reads a URL without retrying, so a source that cannot be fetched fails at once", async () => {
    await __probeWithMediabunnyForTests("/api/assets/x/file");
    expect(mb.retryDelays).toHaveLength(1);
    expect(mb.retryDelays[0]?.(0, new TypeError("Failed to fetch"), "/api/assets/x/file")).toBeNull();
  });

  it("measures a last frame stored without a duration the engine's way", async () => {
    const probe = await __probeWithMediabunnyForTests("/api/assets/x/file");
    const engine = videoTrackDuration(119 / 24, { timestamp: 119 / 24, duration: 0 }, 24);
    expect(engine).toBeCloseTo(5, 9);
    expect(probe.duration).toBe(engine);
    expect(probe).toMatchObject({ width: 1920, height: 1080, fps: 23.9 });
    expect(mb.sources).toEqual(["url:/api/assets/x/file"]);
    expect(mb.disposed).toBe(1);
  });

  it("picks the extracted frame nearest a source time", () => {
    const frames = Array<string | null>(FILMSTRIP_FRAMES).fill(null);
    frames[1] = "f1";
    frames[6] = "f6";
    const info: StitchMediaInfo = {
      status: "ready",
      duration: 12,
      width: null,
      height: null,
      fps: null,
      frames,
      level: "filmstrip",
    };
    expect(frameTime(1, 12)).toBe(1.5);
    expect(nearestFrame(info, 0)).toBe("f1");
    expect(nearestFrame(info, 4)).toBe("f1");
    expect(nearestFrame(info, 5)).toBe("f6");
    expect(nearestFrame(info, 11)).toBe("f6");
    expect(nearestFrame({ ...info, frames: Array(FILMSTRIP_FRAMES).fill(null) }, 3)).toBeNull();
  });

  it("keys data: URLs by a fingerprint and anything else by itself", () => {
    const data = `data:video/mp4;base64,${"A".repeat(100)}xyz`;
    expect(mediaKeyOf(data)).toMatch(new RegExp(`^d:${data.length}:[0-9a-z]+$`));
    expect(mediaKeyOf(data)).toBe(mediaKeyOf(`${data}`));
    expect(mediaKeyOf("http://example.com/v.mp4")).toBe("http://example.com/v.mp4");
    expect(mediaKeyOf("blob:abc")).toBe("blob:abc");
    expect(assetMediaKey("x1")).toBe("a:x1");
  });

  it("tells apart two data: URLs of one length and one tail that differ in the middle", () => {
    // Two takes of fixed-length audio: same size, both ending in the same silence
    const take = (fill: string) => `data:audio/wav;base64,UklGR${fill.repeat(200_000)}${"A".repeat(2_000)}`;
    const a = take("q83");
    const b = take("x7Z");
    expect(a.length).toBe(b.length);
    expect(a.slice(-1_000)).toBe(b.slice(-1_000));
    expect(mediaKeyOf(a)).not.toBe(mediaKeyOf(b));
    // A stretch of 2000 characters changed in the middle (the sampling reads one in about 73)
    const c = a.slice(0, 300_000) + "Z".repeat(2_000) + a.slice(302_000);
    expect(mediaKeyOf(c)).not.toBe(mediaKeyOf(a));
  });
});
