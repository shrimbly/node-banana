import { describe, it, expect } from "vitest";
import {
  isMusicInput,
  normalizeAudioClips,
  normalizeLoopCount,
  normalizePlacement,
  normalizeStack,
  normalizeStitchArgs,
  type StitchAudioClipInput,
  type StitchAudioData,
  type StitchClipInput,
} from "../engineTypes";

const audio = { buffer: { sampleRate: 48000 } as unknown as AudioBuffer, duration: 2 } satisfies StitchAudioData;
const a = new Blob(["a"], { type: "video/mp4" });
const b = new Blob(["b"], { type: "video/mp4" });

describe("normalizeStitchArgs", () => {
  it("mutes bare Blobs under bare music: the old engine let the music replace their sound", () => {
    const { clips, music } = normalizeStitchArgs([a, b], audio);
    expect(clips).toEqual([
      { blob: a, inSec: 0, outSec: null, muted: true, volume: 1 },
      { blob: b, inSec: 0, outSec: null, muted: true, volume: 1 },
    ]);
    expect(music).toEqual({ audio, curve: [], muted: false });
  });

  it("keeps bare Blobs' sound without music", () => {
    for (const none of [null, undefined]) {
      const { clips, music } = normalizeStitchArgs([a], none);
      expect(clips[0].muted).toBe(false);
      expect(music).toBeNull();
    }
  });

  it("passes explicit inputs and music through", () => {
    const clip = { blob: a, inSec: 0.8, outSec: 5, muted: false, volume: 0.5 };
    const input = { audio, curve: [{ t: 1, gain: 0 }], muted: true };
    const { clips, music } = normalizeStitchArgs([clip], input);
    expect(clips).toEqual([clip]);
    expect(music).toBe(input);
  });

  it("does not mute explicit clips under bare music", () => {
    const { clips } = normalizeStitchArgs([{ blob: a, inSec: 0, outSec: null, muted: false, volume: 1 }], audio);
    expect(clips[0].muted).toBe(false);
  });

  it("makes In, Out and volume usable", () => {
    const { clips } = normalizeStitchArgs([{ blob: a, inSec: Number.NaN, outSec: Infinity, muted: false, volume: 3 }], null);
    expect(clips[0]).toMatchObject({ inSec: 0, outSec: null, volume: 1 });
    expect(normalizeStitchArgs([{ blob: a, inSec: -2, outSec: null, muted: false, volume: -1 }], null).clips[0]).toMatchObject({
      inSec: 0,
      volume: 0,
    });
  });

  it("keeps a clip's source key when it is a non-empty string, and drops anything else", () => {
    const base = { blob: a, inSec: 0, outSec: null, muted: false, volume: 1 };
    const read = (source: unknown) =>
      normalizeStitchArgs([{ ...base, source } as unknown as StitchClipInput], null).clips[0];
    expect(read("edge:e1").source).toBe("edge:e1");
    for (const junk of ["", 7, null, {}]) expect(read(junk)).not.toHaveProperty("source");
    expect(normalizeStitchArgs([a], null).clips[0]).not.toHaveProperty("source");
  });

  it("tells music from a bare buffer", () => {
    expect(isMusicInput(audio)).toBe(false);
    expect(isMusicInput({ audio, curve: [], muted: false })).toBe(true);
  });
});

describe("normalizeLoopCount", () => {
  it("is a whole number, at least 1", () => {
    expect(normalizeLoopCount(undefined)).toBe(1);
    expect(normalizeLoopCount({})).toBe(1);
    expect(normalizeLoopCount({ loopCount: 3 })).toBe(3);
    expect(normalizeLoopCount({ loopCount: 2.7 })).toBe(2);
    expect(normalizeLoopCount({ loopCount: 0 })).toBe(1);
    expect(normalizeLoopCount({ loopCount: Number.NaN })).toBe(1);
  });
});

describe("normalizeStack", () => {
  it("is null without a positive, finite overlap: the clips butt", () => {
    expect(normalizeStack(undefined)).toBeNull();
    expect(normalizeStack({ loopCount: 2 })).toBeNull();
    expect(normalizeStack({ overlapSec: 0 })).toBeNull();
    expect(normalizeStack({ overlapSec: -1 })).toBeNull();
    expect(normalizeStack({ overlapSec: Number.NaN })).toBeNull();
    expect(normalizeStack({ overlapSec: Infinity })).toBeNull();
  });

  it("caps the overlap at 10 s and crossfades unless told not to", () => {
    expect(normalizeStack({ overlapSec: 12 })).toEqual({ overlapSec: 10, crossfade: true });
    expect(normalizeStack({ overlapSec: 1 })).toEqual({ overlapSec: 1, crossfade: true });
    expect(normalizeStack({ overlapSec: 1, crossfade: false })).toEqual({ overlapSec: 1, crossfade: false });
  });
});

describe("placed stacks", () => {
  it("keeps a finite startSec on a clip, clamped to [0, 600], and drops anything else", () => {
    const base = { blob: a, inSec: 0, outSec: null, muted: false, volume: 1 };
    const read = (startSec: unknown) =>
      normalizeStitchArgs([{ ...base, startSec } as unknown as StitchClipInput], null).clips[0].startSec;
    expect(read(4.25)).toBe(4.25);
    expect(read(0)).toBe(0);
    expect(read(-3)).toBe(0);
    expect(read(700)).toBe(600);
    for (const bad of [Number.NaN, Infinity, "4", null, undefined]) expect(read(bad)).toBeUndefined();
    expect("startSec" in normalizeStitchArgs([base], null).clips[0]).toBe(false);
  });

  it("routes by the placed flag alone: null without it, even when clips carry starts", () => {
    expect(normalizePlacement(undefined)).toBeNull();
    expect(normalizePlacement({ loopCount: 1, overlapSec: 1, crossfade: true })).toBeNull();
    expect(normalizePlacement({ placed: false, overlapSec: 1 })).toBeNull();
  });

  it("defaults Crossfade on and reads Overlap as the stack does, 0 when absent", () => {
    expect(normalizePlacement({ placed: true })).toEqual({ crossfade: true, overlapSec: 0 });
    expect(normalizePlacement({ placed: true, crossfade: false, overlapSec: 1.5 })).toEqual({ crossfade: false, overlapSec: 1.5 });
    expect(normalizePlacement({ placed: true, overlapSec: 0 })).toEqual({ crossfade: true, overlapSec: 0 });
    expect(normalizePlacement({ placed: true, overlapSec: Number.NaN })).toEqual({ crossfade: true, overlapSec: 0 });
    expect(normalizePlacement({ placed: true, overlapSec: 12 })).toEqual({ crossfade: true, overlapSec: 10 });
  });
});

describe("normalizeAudioClips", () => {
  const clip = (init: Record<string, unknown>) => ({ audio, startSec: 0, inSec: 0, outSec: null, curve: [], ...init }) as unknown as StitchAudioClipInput;

  it("is null when the options carry no audioClips: the old music rule", () => {
    expect(normalizeAudioClips(undefined)).toBeNull();
    expect(normalizeAudioClips({ loopCount: 2 })).toBeNull();
  });

  it("keeps an empty list: the new rule with nothing to play", () => {
    expect(normalizeAudioClips({ audioClips: [] })).toEqual([]);
  });

  it("clamps the start to 0..600, In to >= 0, and keeps Out only after In", () => {
    const read = (init: Record<string, unknown>) => normalizeAudioClips({ audioClips: [clip(init)] })![0];
    expect(read({ startSec: -1, inSec: -2, outSec: 3 })).toMatchObject({ startSec: 0, inSec: 0, outSec: 3 });
    expect(read({ startSec: 700, inSec: 2, outSec: 2 })).toMatchObject({ startSec: 600, inSec: 2, outSec: null });
    expect(read({ startSec: Number.NaN, inSec: "1", outSec: Infinity })).toMatchObject({ startSec: 0, inSec: 0, outSec: null });
    expect(read({ startSec: 2.5, inSec: 0.5, outSec: 1 })).toMatchObject({ startSec: 2.5, inSec: 0.5, outSec: 1 });
  });

  it("sorts the curve and drops a clip without decoded audio", () => {
    const [first, ...rest] = normalizeAudioClips({
      audioClips: [clip({ curve: [{ t: 2, gain: 1 }, { t: 1, gain: 3 }] }), clip({ audio: null }), clip({ audio: {} })],
    })!;
    expect(first.curve).toEqual([{ t: 1, gain: 1 }, { t: 2, gain: 1 }]);
    expect(first.audio).toBe(audio);
    expect(rest).toEqual([]);
  });
});
