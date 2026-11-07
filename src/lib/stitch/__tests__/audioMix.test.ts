import { describe, it, expect } from "vitest";
import {
  applyCrossfades,
  applyCurveGain,
  applyCurveGainAt,
  applyGainPieces,
  audioClipLayers,
  audioLayersOverlap,
  chooseLayerMasterFormat,
  chooseMasterFormat,
  clampSamples,
  masterLength,
  masterRange,
  mixInto,
  mixLoop,
  pcmFromAudioBuffer,
  pcmHead,
  remix,
  resampleLinear,
  sliceChunksToRange,
  toMasterFormat,
  type AudioBufferLike,
  type LoopMix,
  type MasterFormat,
  type Pcm,
  type PcmChunk,
} from "../audioMix";
import { buildEnvelope, gainPieceAt, gainPieces, type GainPiece } from "../placement";
import { crossfadeGain } from "../stack";

const SR = 1000;

function filled(length: number, value: number | ((i: number) => number)): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = typeof value === "number" ? value : value(i);
  return out;
}

function chunk(timestamp: number, samples: Float32Array, sampleRate = SR): PcmChunk {
  return { sampleRate, channels: [samples], timestamp };
}

describe("pcmFromAudioBuffer", () => {
  it("copies the channels", () => {
    const left = filled(4, 0.5);
    const right = filled(4, -0.5);
    const buffer = { sampleRate: SR, numberOfChannels: 2, length: 4, getChannelData: (c: number) => [left, right][c] };
    const pcm = pcmFromAudioBuffer(buffer, 1.5);
    expect(pcm.timestamp).toBe(1.5);
    expect(pcm.channels[0]).toEqual(left);
    expect(pcm.channels[0]).not.toBe(left);
    expect(pcmFromAudioBuffer(buffer).timestamp).toBe(0);
  });
});

describe("pcmHead", () => {
  it("gives the first frames of each channel as views on the buffer, never more than it holds", () => {
    const left = filled(10, (i) => i);
    const right = filled(10, (i) => -i);
    const buffer = { sampleRate: SR, numberOfChannels: 2, length: 10, getChannelData: (c: number) => [left, right][c] };
    const head = pcmHead(buffer, 3.2);
    expect(head.sampleRate).toBe(SR);
    expect(head.channels.map((c) => Array.from(c))).toEqual([
      [0, 1, 2, 3],
      [-0, -1, -2, -3],
    ]);
    // A view, not a copy
    expect(head.channels[0].buffer).toBe(left.buffer);
    expect(pcmHead(buffer, 50).channels[0]).toHaveLength(10);
    expect(pcmHead(buffer, -1).channels[0]).toHaveLength(0);
  });
});

describe("sliceChunksToRange", () => {
  it("is null for no chunks", () => {
    expect(sliceChunksToRange([], 0, 1)).toBeNull();
  });

  it("gives exactly round((to − from) · sr) samples", () => {
    const pcm = sliceChunksToRange([chunk(0, filled(5000, 1))], 0.2, 1.4565);
    expect(pcm?.channels[0].length).toBe(Math.round(1.2565 * SR));
  });

  it("skips the head before `from` by the chunk's timestamp and cuts the tail", () => {
    // The first chunk is the one in effect at 0.5: it starts at 0.4
    const pcm = sliceChunksToRange(
      [chunk(0.4, filled(200, (i) => i)), chunk(0.6, filled(200, (i) => 200 + i))],
      0.5,
      0.7,
    )!;
    expect(pcm.channels[0].length).toBe(200);
    expect(pcm.channels[0][0]).toBe(100);
    expect(pcm.channels[0][199]).toBe(299);
  });

  it("zero-fills a gap between chunks", () => {
    const pcm = sliceChunksToRange([chunk(0, filled(100, 1)), chunk(0.2, filled(100, 1))], 0, 0.3)!;
    expect(pcm.channels[0][50]).toBe(1);
    expect(pcm.channels[0][150]).toBe(0);
    expect(pcm.channels[0][250]).toBe(1);
  });

  it("puts sound that starts with the video's origin at index 0", () => {
    const pcm = sliceChunksToRange([chunk(0.04, filled(100, (i) => i + 1))], 0.04, 0.1)!;
    expect(pcm.channels[0][0]).toBe(1);
  });

  it("skips round(0.04 · sr) samples of sound that starts before the video's origin", () => {
    const pcm = sliceChunksToRange([chunk(0, filled(100, (i) => i))], 0.04, 0.1)!;
    expect(pcm.channels[0][0]).toBe(40);
  });

  it("leaves no seams between chunks when `from` falls on a half sample", () => {
    // 44.1 kHz from 25/24 s is 45937.5 samples in; AAC-like 1024-sample chunks on whole samples
    const rate = 44100;
    const chunks: PcmChunk[] = [];
    for (let k = 0; k < 300; k++) chunks.push(chunk((k * 1024) / rate, filled(1024, 1), rate));
    const pcm = sliceChunksToRange(chunks, 25 / 24, 25 / 24 + 5)!;
    expect(pcm.channels[0].length).toBe(Math.round(5 * rate));
    expect(pcm.channels[0].every((v) => v === 1)).toBe(true);
  });

  it("converts a chunk in another format to the first one's", () => {
    const pcm = sliceChunksToRange(
      [chunk(0, filled(100, 1)), { sampleRate: 2 * SR, channels: [filled(200, 0.5), filled(200, 0.5)], timestamp: 0.1 }],
      0,
      0.2,
    )!;
    expect(pcm.channels).toHaveLength(1);
    expect(pcm.channels[0][150]).toBeCloseTo(0.5, 6);
  });
});

describe("resampleLinear", () => {
  it("returns the same pcm at the same rate", () => {
    const pcm: Pcm = { sampleRate: SR, channels: [filled(10, 1)] };
    expect(resampleLinear(pcm, SR)).toBe(pcm);
  });

  it("scales the length", () => {
    const pcm: Pcm = { sampleRate: 44100, channels: [filled(44100, 0.25)] };
    const out = resampleLinear(pcm, 48000);
    expect(out.sampleRate).toBe(48000);
    expect(out.channels[0].length).toBe(48000);
    expect(resampleLinear({ sampleRate: 48000, channels: [filled(480, 0)] }, 44100).channels[0].length).toBe(441);
  });

  it("keeps a constant signal constant", () => {
    const out = resampleLinear({ sampleRate: 44100, channels: [filled(1000, 0.25)] }, 48000);
    expect(out.channels[0].every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
  });
});

describe("remix", () => {
  it("duplicates mono into stereo", () => {
    const out = remix({ sampleRate: SR, channels: [filled(3, 0.5)] }, 2);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[1]).toEqual(filled(3, 0.5));
  });

  it("averages stereo into mono", () => {
    const out = remix({ sampleRate: SR, channels: [filled(3, 1), filled(3, 0)] }, 1);
    expect(out.channels).toEqual([filled(3, 0.5)]);
  });

  it("keeps the first two of three channels", () => {
    const out = remix({ sampleRate: SR, channels: [filled(2, 1), filled(2, 2), filled(2, 3)] }, 2);
    expect(out.channels).toEqual([filled(2, 1), filled(2, 2)]);
  });

  it("downmixes 5.1 to stereo, keeping the centre and dropping the LFE", () => {
    // L, R, C, LFE, SL, SR
    const out = remix(
      { sampleRate: SR, channels: [filled(2, 0.1), filled(2, 0.2), filled(2, 0.4), filled(2, 1), filled(2, 0.3), filled(2, 0.05)] },
      2,
    );
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0][0]).toBeCloseTo(0.1 + Math.SQRT1_2 * (0.4 + 0.3), 6);
    expect(out.channels[1][0]).toBeCloseTo(0.2 + Math.SQRT1_2 * (0.4 + 0.05), 6);
  });

  it("downmixes quad to stereo", () => {
    const out = remix({ sampleRate: SR, channels: [filled(2, 0.2), filled(2, 0.4), filled(2, 0.6), filled(2, 0.8)] }, 2);
    expect(out.channels[0][0]).toBeCloseTo(0.4, 6);
    expect(out.channels[1][0]).toBeCloseTo(0.6, 6);
  });

  it("toMasterFormat remixes and resamples", () => {
    const out = toMasterFormat({ sampleRate: 500, channels: [filled(50, 0.5)] }, { sampleRate: SR, channels: 2 });
    expect(out.sampleRate).toBe(SR);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0].length).toBe(100);
  });
});

describe("chooseMasterFormat", () => {
  it("takes the music's rate when the music is the only source", () => {
    expect(chooseMasterFormat({ sampleRate: 24000, channels: 1 }, [])).toEqual({ sampleRate: 24000, channels: 1 });
  });

  it("takes the highest rate when clip sound plays under the music", () => {
    expect(chooseMasterFormat({ sampleRate: 44100, channels: 1 }, [{ sampleRate: 48000, channels: 2 }])).toEqual({
      sampleRate: 48000,
      channels: 2,
    });
    // A 24 kHz voice-over does not drag a 48 kHz clip down
    expect(chooseMasterFormat({ sampleRate: 24000, channels: 1 }, [{ sampleRate: 48000, channels: 1 }])?.sampleRate).toBe(48000);
    expect(chooseMasterFormat({ sampleRate: 48000, channels: 2 }, [{ sampleRate: 22050, channels: 1 }])?.sampleRate).toBe(48000);
  });

  it("takes the highest clip rate without music", () => {
    expect(chooseMasterFormat(null, [{ sampleRate: 48000, channels: 1 }, { sampleRate: 44100, channels: 1 }])).toEqual({
      sampleRate: 48000,
      channels: 1,
    });
  });

  it("caps the channels at 2", () => {
    expect(chooseMasterFormat(null, [{ sampleRate: 48000, channels: 6 }])?.channels).toBe(2);
  });

  it("is null with nothing to hear", () => {
    expect(chooseMasterFormat(null, [])).toBeNull();
  });
});

describe("mixInto", () => {
  it("adds at an offset with a gain, ignoring what falls outside", () => {
    const target = [filled(5, 1)];
    mixInto(target, [filled(4, 1)], 3, 0.5);
    expect([...target[0]]).toEqual([1, 1, 1, 1.5, 1.5]);
    mixInto(target, [filled(4, 1)], -3, 1);
    expect(target[0][0]).toBe(2);
    expect(target[0][1]).toBe(1);
  });
});

describe("applyCurveGain", () => {
  it("changes nothing for an empty curve", () => {
    const channels = [filled(SR, 1)];
    applyCurveGain(channels, SR, []);
    expect(channels[0].every((v) => v === 1)).toBe(true);
  });

  it("zeroes the samples around a dip to 0", () => {
    const channels = [filled(2 * SR, 1)];
    applyCurveGain(channels, SR, [
      { t: 0.5, gain: 1 },
      { t: 1, gain: 0 },
      { t: 1.5, gain: 1 },
    ]);
    expect(channels[0][0]).toBe(1);
    expect(Math.abs(channels[0][SR])).toBeLessThan(0.01);
    expect(channels[0][Math.round(0.75 * SR)]).toBeGreaterThan(0);
    expect(channels[0][Math.round(0.75 * SR)]).toBeLessThan(1);
    expect(channels[0][2 * SR - 1]).toBe(1);
  });

  it("ramps straight inside a block", () => {
    const channels = [filled(8, 1)];
    applyCurveGain(channels, SR, [{ t: 0, gain: 1 }, { t: 0.008, gain: 0 }], 0, 8);
    // gain at 0 is 1, at 8 samples 0: each sample steps down by 1/8
    expect(channels[0][4]).toBeCloseTo(0.5, 6);
  });

  it("reads the curve from startSec", () => {
    const channels = [filled(10, 1)];
    applyCurveGain(channels, SR, [{ t: 5, gain: 1 }, { t: 5.001, gain: 0 }], 6);
    expect(channels[0].every((v) => v === 0)).toBe(true);
  });
});

describe("clampSamples", () => {
  it("clips to ±1 and silences NaN", () => {
    const channels = [Float32Array.from([2, -3, 0.5, Number.NaN])];
    clampSamples(channels);
    expect([...channels[0]]).toEqual([1, -1, 0.5, 0]);
  });
});

describe("mixLoop", () => {
  const format = { sampleRate: SR, channels: 1 as const };

  it("lays clips out at their sequence starts with their gains", () => {
    const mix: LoopMix = {
      format,
      loopLength: 1,
      clips: [
        { pcm: { sampleRate: SR, channels: [filled(500, 0.4)] }, seqStart: 0, gain: 1 },
        { pcm: { sampleRate: SR, channels: [filled(500, 0.4)] }, seqStart: 0.5, gain: 0.5 },
      ],
      music: null,
    };
    const [out] = mixLoop(mix, 0);
    expect(out.length).toBe(SR);
    expect(out[100]).toBeCloseTo(0.4, 6);
    expect(out[700]).toBeCloseTo(0.2, 6);
  });

  it("leaves silence where a muted clip would be (it is not listed)", () => {
    const [out] = mixLoop({ format, loopLength: 1, clips: [], music: null }, 0);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("reads loop 1's music from loopSamples on", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(2 * SR, (i) => (i < SR ? 0.1 : 0.2))] }, curve: [] };
    expect(mixLoop({ format, loopLength: 1, clips: [], music }, 0)[0][10]).toBeCloseTo(0.1, 6);
    expect(mixLoop({ format, loopLength: 1, clips: [], music }, 1)[0][10]).toBeCloseTo(0.2, 6);
  });

  it("gives silence after music shorter than the loop", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(SR / 2, 0.3)] }, curve: [] };
    const [out] = mixLoop({ format, loopLength: 1, clips: [], music }, 0);
    expect(out[100]).toBeCloseTo(0.3, 6);
    expect(out[800]).toBe(0);
    expect(mixLoop({ format, loopLength: 1, clips: [], music }, 1)[0].every((v) => v === 0)).toBe(true);
  });

  it("applies the curve to the music only, again each loop", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(2 * SR, 0.5)] }, curve: [{ t: 0, gain: 0 }] };
    const clip = { pcm: { sampleRate: SR, channels: [filled(SR, 0.25)] }, seqStart: 0, gain: 1 };
    for (const loop of [0, 1]) {
      const [out] = mixLoop({ format, loopLength: 1, clips: [clip], music }, loop);
      expect(out[500]).toBeCloseTo(0.25, 6);
    }
  });

  it("restarts the curve each loop while the music runs on", () => {
    // A fade from full to nothing over the one-second loop
    const music = { pcm: { sampleRate: SR, channels: [filled(2 * SR, 0.5)] }, curve: [{ t: 0, gain: 1 }, { t: 1, gain: 0 }] };
    for (const loop of [0, 1]) {
      const [out] = mixLoop({ format, loopLength: 1, clips: [], music }, loop);
      // Near full at the loop's start (the gain ramps inside each block), near nothing at its end
      expect(out[10]).toBeCloseTo(0.5, 1);
      expect(out[990]).toBeLessThan(0.01);
    }
  });

  it("passes one source's overs through unclipped, and silences NaN", () => {
    const loud = filled(SR, 1.2);
    loud[3] = Number.NaN;
    const [clipsOnly] = mixLoop({ format, loopLength: 1, clips: [{ pcm: { sampleRate: SR, channels: [loud] }, seqStart: 0, gain: 1 }], music: null }, 0);
    expect(clipsOnly[10]).toBeCloseTo(1.2, 6);
    expect(clipsOnly[3]).toBe(0);
    const [musicOnly] = mixLoop({ format, loopLength: 1, clips: [], music: { pcm: { sampleRate: SR, channels: [filled(SR, 1.2)] }, curve: [] } }, 0);
    expect(musicOnly[10]).toBeCloseTo(1.2, 6);
  });

  it("clamps the sum", () => {
    const music = { pcm: { sampleRate: SR, channels: [filled(SR, 0.9)] }, curve: [] };
    const clip = { pcm: { sampleRate: SR, channels: [filled(SR, 0.9)] }, seqStart: 0, gain: 1 };
    const [out] = mixLoop({ format, loopLength: 1, clips: [clip], music }, 0);
    expect(out[10]).toBe(1);
  });
});

describe("applyCrossfades", () => {
  it("fades in, fades out, and silences what follows the fade out", () => {
    const channel = filled(100, 1);
    applyCrossfades([channel], { inLength: 10, outStart: 60, outLength: 20 });
    expect(channel[0]).toBeCloseTo(crossfadeGain(0.5 / 10, "in"), 6);
    expect(channel[9]).toBeCloseTo(crossfadeGain(9.5 / 10, "in"), 6);
    expect(channel[10]).toBe(1);
    expect(channel[59]).toBe(1);
    expect(channel[60]).toBeCloseTo(crossfadeGain(0.5 / 20, "out"), 6);
    expect(channel[79]).toBeCloseTo(crossfadeGain(19.5 / 20, "out"), 6);
    expect(channel.slice(80).every((v) => v === 0)).toBe(true);
  });

  it("changes nothing at zero lengths", () => {
    const channel = filled(50, 0.5);
    applyCrossfades([channel], { inLength: 0, outStart: 0, outLength: 0 });
    expect(channel.every((v) => v === 0.5)).toBe(true);
  });

  it("fades every channel", () => {
    const channels = [filled(20, 1), filled(20, -1)];
    applyCrossfades(channels, { inLength: 4, outStart: 10, outLength: 4 });
    expect(channels[1][0]).toBeCloseTo(-channels[0][0], 6);
    expect(channels[1][19]).toBe(0);
  });

  it("keeps a constant A fading out and a constant B fading in at constant power", () => {
    // A at 0 for 100 samples, B from 70: a 30-sample overlap
    const a = filled(100, 1);
    const b = filled(100, 1);
    applyCrossfades([a], { inLength: 0, outStart: 70, outLength: 30 });
    applyCrossfades([b], { inLength: 30, outStart: 0, outLength: 0 });
    for (let i = 0; i < 30; i++) expect(a[70 + i] ** 2 + b[i] ** 2).toBeCloseTo(1, 6);
  });
});

describe("mixLoop with overlapping clips", () => {
  const format = { sampleRate: SR, channels: 1 } as const;

  it("clamps when the engine says the clips overlap", () => {
    const a = { pcm: { sampleRate: SR, channels: [filled(600, 0.8)] }, seqStart: 0, gain: 1 };
    const b = { pcm: { sampleRate: SR, channels: [filled(600, 0.8)] }, seqStart: 0.4, gain: 1 };
    const [out] = mixLoop({ format, loopLength: 1, clips: [a, b], music: null, clipsOverlap: true }, 0);
    expect(out[100]).toBeCloseTo(0.8, 6);
    expect(out[500]).toBe(1);
  });

  it("lets one source's overs pass without the flag", () => {
    const loud = { pcm: { sampleRate: SR, channels: [filled(SR, 1.2)] }, seqStart: 0, gain: 1 };
    const [out] = mixLoop({ format, loopLength: 1, clips: [loud], music: null }, 0);
    expect(out[10]).toBeCloseTo(1.2, 6);
    const [flagged] = mixLoop({ format, loopLength: 1, clips: [loud], music: null, clipsOverlap: false }, 0);
    expect(flagged[10]).toBeCloseTo(1.2, 6);
  });
});

describe("applyGainPieces", () => {
  it("multiplies constant pieces, fills 0 and leaves gain 1 alone, by the pieces' whole samples", () => {
    const channels = [filled(10, 1), filled(10, 2)];
    // The clip starts at loop sample 3 (0.003 s at 1 kHz)
    const pieces: GainPiece[] = [
      { fromSec: 0.003, toSec: 0.006, gain: 1 },
      { fromSec: 0.006, toSec: 0.009, gain: 0.5 },
      { fromSec: 0.009, toSec: 0.013, gain: 0 },
    ];
    applyGainPieces(channels, SR, 3, pieces);
    expect([...channels[0]]).toEqual([1, 1, 1, 0.5, 0.5, 0.5, 0, 0, 0, 0]);
    expect([...channels[1]]).toEqual([2, 2, 2, 1, 1, 1, 0, 0, 0, 0]);
  });

  it("reads a varying piece at each sample's middle in loop time, within 1e-9 of the formula", () => {
    const n = 400;
    const channels = [filled(n, 1)];
    const startSample = 1500;
    const piece: GainPiece = { fromSec: 1.5, toSec: 1.9, own: { at: 0.1, slope: 2 }, above: [{ at: 0.8, slope: -1.5 }] };
    applyGainPieces(channels, SR, startSample, [piece]);
    for (let i = 0; i < n; i++) {
      const t = (startSample + i + 0.5) / SR;
      const own = Math.min(1, Math.max(0, 0.1 + 2 * (t - 1.5)));
      const above = Math.min(1, Math.max(0, 0.8 - 1.5 * (t - 1.5)));
      expect(Math.abs(channels[0][i] - Math.sin((own * Math.PI) / 2) * Math.cos((above * Math.PI) / 2))).toBeLessThan(1e-6);
      expect(Math.abs(channels[0][i] - gainPieceAt(piece, t))).toBeLessThan(1e-6);
    }
  });

  it("follows an envelope's pieces: a front clip fading out over the clip below crossfades at equal power", () => {
    // A [0,5) in front fades out over B [4,9) across [4,5)
    const env = buildEnvelope(
      [
        { start: 0, length: 5, row: 0, source: "a", inSec: 0 },
        { start: 4, length: 5, row: 1, source: "b", inSec: 0 },
      ],
      true,
    );
    const a = [filled(5 * SR, 1)];
    const b = [filled(5 * SR, 1)];
    applyGainPieces(a, SR, 0, gainPieces(env, 0));
    applyGainPieces(b, SR, 4 * SR, gainPieces(env, 1));
    for (const i of [0, 250, 500, 999]) {
      const x = (i + 0.5) / SR;
      expect(a[0][4 * SR + i]).toBeCloseTo(crossfadeGain(x, "out"), 6);
      expect(b[0][i]).toBeCloseTo(crossfadeGain(x, "in"), 6);
    }
    expect(a[0][3999]).toBe(1);
    expect(b[0][1000]).toBe(1);
  });

  it("makes a clip hidden under a higher row exactly silent", () => {
    const env = buildEnvelope(
      [
        { start: 0, length: 10, row: 0, source: "a", inSec: 0 },
        { start: 3, length: 2, row: 1, source: "b", inSec: 0 },
      ],
      true,
    );
    const b = [filled(2 * SR, 0.7)];
    applyGainPieces(b, SR, 3 * SR, gainPieces(env, 1));
    expect(b[0].every((v) => v === 0)).toBe(true);
  });

  it("stops on an abort, checked per piece and every 65,536 samples inside one", () => {
    const controller = new AbortController();
    controller.abort();
    const channels = [filled(10, 1)];
    expect(() => applyGainPieces(channels, SR, 0, [{ fromSec: 0, toSec: 0.01, gain: 0.5 }], controller.signal)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
    expect(channels[0][0]).toBe(1);
    // Mid-piece: the signal goes off while the piece runs
    const long = [filled(200000, 1)];
    const late = new AbortController();
    const piece = { fromSec: 0, toSec: 200, own: { at: 0, slope: 0.01 }, above: [] };
    let reads = 0;
    Object.defineProperty(piece.own, "slope", {
      get() {
        if (++reads === 70000) late.abort();
        return 0.01;
      },
    });
    expect(() => applyGainPieces(long, SR, 0, [piece], late.signal)).toThrow(expect.objectContaining({ name: "AbortError" }));
    // It stopped at the next check, before the piece's end
    expect(long[0][199999]).toBe(1);
    expect(long[0][65535]).not.toBe(1);
  });
});

/** A decoded buffer of `length` frames per channel, sample i of channel c = fill(i, c). */
function buffer(sampleRate: number, length: number, channels: number, fill: (i: number, c: number) => number): AudioBufferLike {
  const data = Array.from({ length: channels }, (_, c) => filled(length, (i) => fill(i, c)));
  return { sampleRate, numberOfChannels: channels, length, getChannelData: (c: number) => data[c] };
}
/** A sound that changes every sample, so an off-by-one shows. */
const wobble = (i: number, c: number) => Math.sin(i * 0.37 + c) * 0.5;
const asPcm = (b: AudioBufferLike): Pcm => ({
  sampleRate: b.sampleRate,
  channels: Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c)),
});
const fmt = (sampleRate: number, channels: 1 | 2): MasterFormat => ({ sampleRate, channels });

describe("masterLength", () => {
  it("is resampleLinear's length rule", () => {
    expect(masterLength(buffer(48000, 1000, 1, () => 0), fmt(48000, 1))).toBe(1000);
    expect(masterLength(buffer(44100, 441, 1, () => 0), fmt(48000, 2))).toBe(480);
    expect(masterLength(buffer(44100, 1000, 1, () => 0), fmt(48000, 1))).toBe(resampleLinear({ sampleRate: 44100, channels: [filled(1000, 0)] }, 48000).channels[0].length);
  });
});

describe("masterRange", () => {
  const cases: Array<[string, AudioBufferLike, MasterFormat]> = [
    ["48 → 48", buffer(48000, 3000, 2, wobble), fmt(48000, 2)],
    ["44.1 → 48", buffer(44100, 3000, 2, wobble), fmt(48000, 2)],
    ["mono → stereo, resampled", buffer(44100, 3000, 1, wobble), fmt(48000, 2)],
    ["stereo → mono", buffer(48000, 3000, 2, wobble), fmt(48000, 1)],
    ["stereo → mono, resampled", buffer(32000, 3000, 2, wobble), fmt(48000, 1)],
  ];
  for (const [name, source, format] of cases) {
    it(`is sample for sample the same slice of toMasterFormat of the whole buffer (${name})`, () => {
      const whole = toMasterFormat(asPcm(source), format);
      const length = masterLength(source, format);
      for (const [a, b] of [[0, length], [37, 300], [301, 302], [length - 129, length]]) {
        const range = masterRange(source, format, a, b);
        expect(range.sampleRate).toBe(format.sampleRate);
        expect(range.channels).toHaveLength(format.channels);
        range.channels.forEach((channel, c) => expect([...channel]).toEqual([...whole.channels[c].subarray(a, b)]));
      }
    });
  }

  it("copies: scaling the range leaves the buffer alone", () => {
    const source = buffer(48000, 100, 2, () => 0.5);
    const range = masterRange(source, fmt(48000, 2), 10, 20);
    range.channels[0].fill(0);
    expect(source.getChannelData(0)[15]).toBe(0.5);
  });

  it("is empty for an empty range", () => {
    expect(masterRange(buffer(48000, 100, 2, () => 0.5), fmt(48000, 2), 50, 50).channels.map((c) => c.length)).toEqual([0, 0]);
  });
});

describe("applyCurveGainAt", () => {
  const curve = [{ t: 0.1, gain: 1 }, { t: 0.2, gain: 0.2 }, { t: 0.35, gain: 0.9 }, { t: 0.6, gain: 0 }];

  it("with first 0 and cutAt the length, equals applyCurveGain", () => {
    const n = 700;
    const a = [filled(n, (i) => wobble(i, 0)), filled(n, (i) => wobble(i, 1))];
    const b = a.map((channel) => channel.slice());
    applyCurveGain(a, SR, curve);
    applyCurveGainAt(b, SR, curve, 0, n);
    expect(b.map((c) => [...c])).toEqual(a.map((c) => [...c]));
  });

  it("gives two ranges of one grid the samples the whole range gets, the cut off the block grid", () => {
    const n = 700;
    const cut = 301;
    const whole = [filled(n, (i) => wobble(i, 0))];
    applyCurveGainAt(whole, SR, curve, 0, 650);
    const left = [filled(cut, (i) => wobble(i, 0))];
    const right = [filled(n - cut, (i) => wobble(i + cut, 0))];
    applyCurveGainAt(left, SR, curve, 0, 650);
    applyCurveGainAt(right, SR, curve, cut, 650);
    expect([...left[0], ...right[0]]).toEqual([...whole[0]]);
  });

  it("reads the gain at the source's own grid: a range from sample 500 reads the curve from 0.5 s", () => {
    const channel = [filled(100, 1)];
    applyCurveGainAt(channel, SR, [{ t: 0.5, gain: 0.25 }, { t: 1, gain: 0.25 }], 500);
    expect(channel[0].every((v) => Math.abs(v - 0.25) < 1e-7)).toBe(true);
  });

  it("changes nothing for an empty curve", () => {
    const channel = [filled(10, 0.5)];
    applyCurveGainAt(channel, SR, [], 3);
    expect([...channel[0]]).toEqual([...filled(10, 0.5)]);
  });
});

describe("chooseLayerMasterFormat", () => {
  it("takes the one source's rate when there is no clip sound", () => {
    expect(chooseLayerMasterFormat([{ sampleRate: 44100, channels: 1 }], [])).toEqual({ sampleRate: 44100, channels: 1 });
  });

  it("takes the highest rate of several sources, or of sources and clip sound", () => {
    expect(chooseLayerMasterFormat([{ sampleRate: 44100, channels: 1 }, { sampleRate: 48000, channels: 2 }], [])).toEqual({ sampleRate: 48000, channels: 2 });
    expect(chooseLayerMasterFormat([{ sampleRate: 44100, channels: 1 }], [{ sampleRate: 48000, channels: 1 }])).toEqual({ sampleRate: 48000, channels: 1 });
    expect(chooseLayerMasterFormat([], [{ sampleRate: 32000, channels: 6 }])).toEqual({ sampleRate: 32000, channels: 2 });
  });

  it("is null with nothing usable", () => {
    expect(chooseLayerMasterFormat([], [])).toBeNull();
    expect(chooseLayerMasterFormat([{ sampleRate: 0, channels: 2 }], [])).toBeNull();
  });
});

describe("audioClipLayers", () => {
  const format = fmt(SR, 1);
  const source = buffer(SR, 3 * SR, 1, () => 0.5);
  const layer = (init: Partial<{ startSec: number; inSec: number; outSec: number | null; curve: { t: number; gain: number }[] }>) => ({
    buffer: source,
    startSec: 0,
    inSec: 0,
    outSec: null,
    curve: [],
    ...init,
  });

  it("puts each clip's In at its start, on the source's grid", () => {
    const [placed] = audioClipLayers([layer({ startSec: 2, inSec: 1, outSec: 1.5 })], format, 10);
    expect(placed.at).toBe(2 * SR);
    expect(placed.pcm.channels[0].length).toBe(SR / 2);
  });

  it("cuts a clip at the loop's end and drops one that starts after it", () => {
    const layers = audioClipLayers([layer({ startSec: 0.5 }), layer({ startSec: 1 }), layer({ startSec: 1.2 })], format, 1);
    expect(layers).toHaveLength(1);
    expect(layers[0].pcm.channels[0].length).toBe(SR / 2);
  });

  it("stops at the source's end however far Out is", () => {
    const [placed] = audioClipLayers([layer({ outSec: 9 })], format, 10);
    expect(placed.pcm.channels[0].length).toBe(3 * SR);
  });

  it("applies the curve in the clip's source seconds", () => {
    const [placed] = audioClipLayers([layer({ startSec: 4, inSec: 1, curve: [{ t: 1, gain: 0 }, { t: 2, gain: 0 }, { t: 2.2, gain: 1 }] })], format, 10);
    expect(placed.pcm.channels[0][500]).toBe(0);
    expect(placed.pcm.channels[0][1600]).toBeCloseTo(0.5, 6);
  });

  it("never scales the shared buffer", () => {
    audioClipLayers([layer({ curve: [{ t: 0, gain: 0 }] })], format, 10);
    expect(source.getChannelData(0).every((v) => v === 0.5)).toBe(true);
  });
});

describe("audioLayersOverlap", () => {
  const pcm = (n: number): Pcm => ({ sampleRate: SR, channels: [filled(n, 0.1)] });
  it("is false for the touching pieces of a split, true for clips that overlap each other or clip sound", () => {
    expect(audioLayersOverlap([{ pcm: pcm(300), at: 0 }, { pcm: pcm(200), at: 300 }], [], SR)).toBe(false);
    expect(audioLayersOverlap([{ pcm: pcm(300), at: 0 }, { pcm: pcm(200), at: 299 }], [], SR)).toBe(true);
    expect(audioLayersOverlap([{ pcm: pcm(300), at: 500 }], [{ pcm: pcm(500), seqStart: 0, gain: 1 }], SR)).toBe(false);
    expect(audioLayersOverlap([{ pcm: pcm(300), at: 499 }], [{ pcm: pcm(500), seqStart: 0, gain: 1 }], SR)).toBe(true);
  });
});

describe("mixLoop with audio clips", () => {
  const format = fmt(SR, 1);

  it("plays the same audio every loop and nothing past the loop's end", () => {
    const audio = [{ pcm: { sampleRate: SR, channels: [filled(300, 0.4)] }, at: 800 }];
    for (const loop of [0, 1, 2]) {
      const [out] = mixLoop({ format, loopLength: 1, clips: [], music: null, audio }, loop);
      expect(out.length).toBe(SR);
      expect(out[799]).toBe(0);
      expect(out[800]).toBeCloseTo(0.4, 6);
      expect(out[999]).toBeCloseTo(0.4, 6);
    }
  });

  it("clamps only when the engine says audio sums", () => {
    const audio = [{ pcm: { sampleRate: SR, channels: [filled(SR, 1.2)] }, at: 0 }];
    expect(mixLoop({ format, loopLength: 1, clips: [], music: null, audio }, 0)[0][5]).toBeCloseTo(1.2, 6);
    expect(mixLoop({ format, loopLength: 1, clips: [], music: null, audio, audioSums: true }, 0)[0][5]).toBe(1);
  });

  // P3: an untouched music clip under the new rule plays at Loop 1x as the old music path plays the music
  describe("an untouched music clip plays as the music did (P3)", () => {
    const curve = [{ t: 0, gain: 0.2 }, { t: 0.31, gain: 1 }, { t: 0.5, gain: 0.4 }, { t: 0.9, gain: 1 }];
    const loopLength = 1.0123;
    for (const [name, musicRate, clipRate] of [
      ["48 kHz music alone", 48000, null],
      ["44.1 kHz music under 48 kHz clip sound", 44100, 48000],
    ] as const) {
      it(name, () => {
        const music = buffer(musicRate, 2 * musicRate, 2, wobble);
        const clipSound = clipRate ? [{ sampleRate: clipRate, channels: 2 }] : [];
        const format = chooseMasterFormat({ sampleRate: musicRate, channels: 2 }, clipSound)!;
        expect(chooseLayerMasterFormat([{ sampleRate: musicRate, channels: 2 }], clipSound)).toEqual(format);
        const clips = clipRate
          ? [{ pcm: { sampleRate: clipRate, channels: [filled(clipRate / 2, 0.1), filled(clipRate / 2, 0.1)] }, seqStart: 0.2, gain: 1 }]
          : [];
        // The engine's old music path: the head the loops play, in the master format
        const played = Math.round(loopLength * format.sampleRate);
        const old: LoopMix = {
          format,
          loopLength,
          clips,
          music: { pcm: toMasterFormat(pcmHead(music, (played * music.sampleRate) / format.sampleRate + 1), format), curve },
        };
        const audio = audioClipLayers([{ buffer: music, startSec: 0, inSec: 0, outSec: null, curve }], format, loopLength);
        const fresh: LoopMix = {
          format,
          loopLength,
          clips,
          music: null,
          audio,
          audioSums: audioLayersOverlap(audio, clips, format.sampleRate),
        };
        const a = mixLoop(old, 0);
        const b = mixLoop(fresh, 0);
        expect(played % 128).not.toBe(0);
        b.forEach((channel, c) => expect([...channel]).toEqual([...a[c]]));
      });
    }
  });
});
