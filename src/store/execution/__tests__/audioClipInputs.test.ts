import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StitchAudioClip } from "@/types";
import { gatherAudioClipInputs } from "../audioClipInputs";

const mocks = vi.hoisted(() => {
  class AssetApiError extends Error {
    constructor(
      message: string,
      public readonly status: number,
    ) {
      super(message);
      this.name = "AssetApiError";
    }
  }
  return {
    AssetApiError,
    fetchAssetBlob: vi.fn(),
    fetchMusicBlob: vi.fn(),
    prepareAudioAsync: vi.fn(),
    requestAssetInfo: vi.fn(),
    getAssetInfo: vi.fn(),
  };
});
vi.mock("@/lib/assets/client/api", () => ({ AssetApiError: mocks.AssetApiError, fetchAssetBlob: mocks.fetchAssetBlob }));
vi.mock("@/hooks/useAudioMixing", () => ({ prepareAudioAsync: mocks.prepareAudioAsync }));
vi.mock("@/lib/stitch/assetInfo", () => ({ requestAssetInfo: mocks.requestAssetInfo, getAssetInfo: mocks.getAssetInfo }));
vi.mock("@/lib/stitch/musicBlob", () => ({ fetchMusicBlob: mocks.fetchMusicBlob }));

const clip = (id: string, source: StitchAudioClip["source"], extra: Partial<StitchAudioClip> = {}): StitchAudioClip => ({
  id,
  source,
  row: 0,
  startSec: 0,
  inSec: 0,
  outSec: null,
  muted: false,
  curve: [],
  ...extra,
});
const asset = (assetId: string) => ({ kind: "asset" as const, assetId });
const MUSIC = { kind: "music" as const };

/** Where each fetched Blob came from (jsdom's Blob cannot be read back), and which Blob each decode was given. */
const origins = new WeakMap<object, string>();
const sourced = (from: string) => {
  const blob = new Blob([from]);
  origins.set(blob, from);
  return blob;
};
const decodedFrom = new WeakMap<object, string | undefined>();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchAssetBlob.mockImplementation(async (id: string) => sourced(`asset:${id}`));
  mocks.fetchMusicBlob.mockImplementation(async (url: string) => sourced(`music:${url}`));
  mocks.prepareAudioAsync.mockImplementation(async (blob: Blob) => {
    const audio = { buffer: { sampleRate: 48000 }, duration: 3 };
    decodedFrom.set(audio, origins.get(blob));
    return audio;
  });
  mocks.getAssetInfo.mockReturnValue(undefined);
});

describe("gatherAudioClipInputs", () => {
  it("fetches and decodes a source once for both pieces of a split, and shares the decoded audio", async () => {
    const clips = [
      clip("left", asset("atone0000001"), { outSec: 1.3, startSec: 2 }),
      clip("right", asset("atone0000001"), { row: 1, inSec: 1.3, startSec: 3.3 }),
    ];
    const inputs = await gatherAudioClipInputs(clips, { musicUrl: null });
    expect(mocks.fetchAssetBlob).toHaveBeenCalledTimes(1);
    expect(mocks.prepareAudioAsync).toHaveBeenCalledTimes(1);
    expect(mocks.prepareAudioAsync.mock.calls[0][1]).toBe(0);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].audio).toBe(inputs[1].audio);
    expect(inputs.map(({ startSec, inSec, outSec }) => ({ startSec, inSec, outSec }))).toEqual([
      { startSec: 2, inSec: 0, outSec: 1.3 },
      { startSec: 3.3, inSec: 1.3, outSec: null },
    ]);
  });

  it("passes each clip's curve, in audio order (row, then start)", async () => {
    const curve = [{ t: 1, gain: 0 }, { t: 2, gain: 1 }];
    const clips = [
      clip("b", asset("abbbbbbbbbbb1"), { row: 1, startSec: 0 }),
      clip("a", MUSIC, { startSec: 4, curve }),
    ];
    const inputs = await gatherAudioClipInputs(clips, { musicUrl: "data:audio/mp4;base64,AA" });
    expect(inputs.map((input) => decodedFrom.get(input.audio))).toEqual(["music:data:audio/mp4;base64,AA", "asset:abbbbbbbbbbb1"]);
    expect(inputs[0].curve).toEqual(curve);
  });

  it("neither fetches nor returns a muted clip", async () => {
    const inputs = await gatherAudioClipInputs([clip("a", asset("aaaaaaaaaaaa1"), { muted: true })], { musicUrl: null });
    expect(inputs).toEqual([]);
    expect(mocks.fetchAssetBlob).not.toHaveBeenCalled();
  });

  it("skips music clips without a music URL", async () => {
    const inputs = await gatherAudioClipInputs([clip("m", MUSIC), clip("a", asset("aaaaaaaaaaaa1"), { row: 1 })], { musicUrl: null });
    expect(inputs).toHaveLength(1);
    expect(mocks.fetchMusicBlob).not.toHaveBeenCalled();
  });

  it("passes the run's signal to the library", async () => {
    const signal = new AbortController().signal;
    await gatherAudioClipInputs([clip("a", asset("aaaaaaaaaaaa1"))], { musicUrl: null, signal });
    expect(mocks.fetchAssetBlob).toHaveBeenCalledWith("aaaaaaaaaaaa1", signal);
  });

  it("names a library file that is gone by its filename when the record is known, and reads the record again", async () => {
    mocks.fetchAssetBlob.mockRejectedValue(new mocks.AssetApiError("gone", 404));
    mocks.getAssetInfo.mockReturnValue({ id: "agone00000001", filename: "tone1320.m4a" });
    await expect(gatherAudioClipInputs([clip("a", asset("agone00000001"), { startSec: 2 })], { musicUrl: null })).rejects.toThrow(
      "Audio clip “tone1320.m4a” is no longer in the library",
    );
    expect(mocks.requestAssetInfo).toHaveBeenCalledWith(["agone00000001"], { refresh: true });
  });

  it("names it by place when the record is not known in this page, with rows counted after compaction", async () => {
    mocks.fetchAssetBlob.mockImplementation(async (id: string) => {
      if (id === "agone00000001") throw new mocks.AssetApiError("gone", 404);
      return sourced(id);
    });
    const clips = [clip("x", asset("aaaaaaaaaaaa1"), { row: 0 }), clip("g", asset("agone00000001"), { row: 3, startSec: 3 })];
    await expect(gatherAudioClipInputs(clips, { musicUrl: null })).rejects.toThrow(
      "The audio clip on Audio 2 at 0:03.00 is no longer in the library",
    );
    expect(mocks.requestAssetInfo).toHaveBeenCalledWith(["agone00000001"], { refresh: true });
  });

  it("passes other library errors through", async () => {
    mocks.fetchAssetBlob.mockRejectedValue(new mocks.AssetApiError("server", 500));
    await expect(gatherAudioClipInputs([clip("a", asset("aaaaaaaaaaaa1"))], { musicUrl: null })).rejects.toThrow("server");
    expect(mocks.requestAssetInfo).not.toHaveBeenCalled();
  });

  it("names a file that cannot be decoded, without the decoder's prefix", async () => {
    mocks.getAssetInfo.mockReturnValue({ id: "abad000000001", filename: "noise.m4a" });
    mocks.prepareAudioAsync.mockRejectedValue(new Error("Failed to process audio: Unsupported codec"));
    await expect(gatherAudioClipInputs([clip("a", asset("abad000000001"))], { musicUrl: null })).rejects.toThrow(
      "Can't read audio clip “noise.m4a”: Unsupported codec",
    );
  });

  it("names undecodable music as the connected music", async () => {
    mocks.prepareAudioAsync.mockRejectedValue(new Error("Failed to process audio: Unsupported codec"));
    await expect(gatherAudioClipInputs([clip("m", MUSIC, { startSec: 2 })], { musicUrl: "blob:x" })).rejects.toThrow(
      "Can't read the connected music: Unsupported codec",
    );
  });

  it("stops when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      gatherAudioClipInputs([clip("a", asset("aaaaaaaaaaaa1"))], { musicUrl: null, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetchAssetBlob).not.toHaveBeenCalled();
  });
});
