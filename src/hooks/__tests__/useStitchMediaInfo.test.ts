import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useStitchMediaInfo, type StitchMediaEntry } from "@/hooks/useStitchMediaInfo";
import {
  POSTER_FRAME,
  __resetMediaInfoForTests,
  __setMediaExtractorForTests,
  getMediaInfo,
  requestMediaInfo,
  type MediaExtractor,
} from "@/lib/stitch/mediaInfo";

const revoke = vi.fn();
const originalRevoke = URL.revokeObjectURL;
URL.revokeObjectURL = revoke;
afterAll(() => {
  URL.revokeObjectURL = originalRevoke;
});

/** Every source is 6 s; each frame is `blob:<src>@<index>`. Logs probe:/open: calls. */
function fakeExtractor() {
  const calls: string[] = [];
  const extractor: MediaExtractor = {
    async probe(src) {
      calls.push(`probe:${src}`);
      return { duration: 6, width: 160, height: 90, fps: 24 };
    },
    async open(src) {
      calls.push(`open:${src}`);
      return {
        duration: 6,
        width: 160,
        height: 90,
        async frame(time) {
          return `blob:${src}@${Math.round((time * 12) / 6 - 0.5)}`;
        },
        close() {},
      };
    },
  };
  return { calls, extractor };
}

const entry = (key: string, level?: StitchMediaEntry["level"]): StitchMediaEntry => ({ key, src: `s-${key}`, level });

describe("useStitchMediaInfo", () => {
  beforeEach(() => {
    __resetMediaInfoForTests();
    revoke.mockClear();
  });

  it("re-renders as the cache fills after the first render", async () => {
    __setMediaExtractorForTests(fakeExtractor().extractor);
    const { result } = renderHook(() => useStitchMediaInfo([entry("k1")], "poster"));
    expect(result.current.get("k1")?.status).toBe("loading");
    await waitFor(() => expect(result.current.get("k1")?.level).toBe("poster"));
    expect(result.current.get("k1")).toMatchObject({ status: "ready", duration: 6 });
    expect(result.current.get("k1")!.frames[POSTER_FRAME]).toBe(`blob:s-k1@${POSTER_FRAME}`);
  });

  it("asks for an entry's own level over the hook's", async () => {
    const { calls, extractor } = fakeExtractor();
    __setMediaExtractorForTests(extractor);
    const { result } = renderHook(() => useStitchMediaInfo([entry("k1", "filmstrip"), entry("k2")], "poster"));
    await waitFor(() => expect(result.current.get("k1")?.level).toBe("filmstrip"));
    await waitFor(() => expect(result.current.get("k2")?.level).toBe("poster"));
    expect(result.current.get("k1")!.frames.every(Boolean)).toBe(true);
    expect(result.current.get("k2")!.frames.filter(Boolean)).toHaveLength(1);
    expect(calls.filter((c) => c === "probe:s-k1")).toHaveLength(1);
  });

  it("keeps a key the new set still shows retained across the change, so its frames are not revoked", async () => {
    const { calls, extractor } = fakeExtractor();
    __setMediaExtractorForTests(extractor);
    const { result, rerender } = renderHook(({ entries }) => useStitchMediaInfo(entries, "poster"), {
      initialProps: { entries: [entry("k1"), entry("k2")] },
    });
    await waitFor(() => expect(result.current.get("k1")?.level).toBe("poster"));
    await waitFor(() => expect(result.current.get("k2")?.level).toBe("poster"));
    // 47 newer entries nothing retains: one more unretained entry would evict the oldest
    for (let i = 0; i < 47; i++) requestMediaInfo(`other${i}`, `s-other${i}`, "metadata");

    rerender({ entries: [entry("k1"), entry("k3")] });
    rerender({ entries: [entry("k3"), entry("k1")] });
    expect(revoke).not.toHaveBeenCalledWith(`blob:s-k1@${POSTER_FRAME}`);
    expect(getMediaInfo("k1")?.frames[POSTER_FRAME]).toBe(`blob:s-k1@${POSTER_FRAME}`);
    expect(calls.filter((c) => c === "probe:s-k1")).toHaveLength(1);
    // k2 is no longer shown, so it is the one the next entry pushes out
    requestMediaInfo("one-more", "s-one-more", "metadata");
    expect(getMediaInfo("k2")).toBeUndefined();
    expect(getMediaInfo("k1")).toBeDefined();
  });

  it("lets its keys go once unmounted", async () => {
    __setMediaExtractorForTests(fakeExtractor().extractor);
    const { result, unmount } = renderHook(() => useStitchMediaInfo([entry("k1")], "poster"));
    await waitFor(() => expect(result.current.get("k1")?.level).toBe("poster"));
    for (let i = 0; i < 48; i++) requestMediaInfo(`other${i}`, `s-other${i}`, "metadata");
    expect(getMediaInfo("k1")).toBeDefined();

    unmount();
    await Promise.resolve();
    expect(getMediaInfo("k1")).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(`blob:s-k1@${POSTER_FRAME}`);
  });
});
