import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { applyFades, decodeAudioPieces, fullLengthSamples, prepareAudioAsync } from "../useAudioMixing";

// ---- AudioBuffer polyfill for jsdom ----
class MockAudioBuffer implements AudioBuffer {
  readonly sampleRate: number;
  readonly length: number;
  readonly duration: number;
  readonly numberOfChannels: number;
  private channels: Float32Array[];

  constructor(options: { length: number; numberOfChannels: number; sampleRate: number }) {
    this.length = options.length;
    this.numberOfChannels = options.numberOfChannels;
    this.sampleRate = options.sampleRate;
    this.duration = options.length / options.sampleRate;
    this.channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
  }
  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
  copyFromChannel(dest: Float32Array, channel: number, offset = 0) {
    dest.set(this.channels[channel].subarray(offset, offset + dest.length));
  }
  copyToChannel(source: Float32Array, channel: number, offset = 0) {
    this.channels[channel].set(source, offset);
  }
}

beforeAll(() => {
  if (typeof globalThis.AudioBuffer === "undefined") {
    (globalThis as any).AudioBuffer = MockAudioBuffer;
  }
  if (typeof globalThis.AudioContext === "undefined") {
    (globalThis as any).AudioContext = vi.fn().mockImplementation(() => ({
      decodeAudioData: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      state: "running",
    }));
  }
});

function createTestAudioBuffer(length: number, channels = 1, sampleRate = 44100): AudioBuffer {
  return new AudioBuffer({ length, numberOfChannels: channels, sampleRate });
}

function fillChannel(buffer: AudioBuffer, channel: number, value: number) {
  buffer.getChannelData(channel).fill(value);
}

// ---- Mocks ----
const mockGetPrimaryAudioTrack = vi.fn();
const mockComputeDuration = vi.fn();
const mockCanDecode = vi.fn();
const mockBuffers = vi.fn();

vi.mock("mediabunny", () => {
  class BlobSourceMock { constructor() {} }
  class InputMock {
    getPrimaryAudioTrack: any;
    computeDuration: any;
    constructor() {
      this.getPrimaryAudioTrack = (...args: any[]) => mockGetPrimaryAudioTrack(...args);
      this.computeDuration = (...args: any[]) => mockComputeDuration(...args);
    }
  }
  class AudioBufferSinkMock {
    buffers: any;
    constructor() {
      this.buffers = (...args: any[]) => mockBuffers(...args);
    }
  }
  return {
    BlobSource: BlobSourceMock,
    Input: InputMock,
    AudioBufferSink: AudioBufferSinkMock,
    ALL_FORMATS: [],
  };
});

describe("useAudioMixing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("applyFades", () => {
    it("does nothing when options is undefined", () => {
      const buffer = createTestAudioBuffer(100);
      fillChannel(buffer, 0, 1.0);
      applyFades(buffer, undefined);
      const data = buffer.getChannelData(0);
      expect(data[0]).toBe(1.0);
      expect(data[99]).toBe(1.0);
    });

    it("does nothing when fadeIn and fadeOut are both 0", () => {
      const buffer = createTestAudioBuffer(100);
      fillChannel(buffer, 0, 1.0);
      applyFades(buffer, { fadeIn: 0, fadeOut: 0 });
      expect(buffer.getChannelData(0)[0]).toBe(1.0);
      expect(buffer.getChannelData(0)[99]).toBe(1.0);
    });

    it("applies linear fade-in", () => {
      const buffer = createTestAudioBuffer(1000, 1, 1000);
      fillChannel(buffer, 0, 1.0);
      applyFades(buffer, { fadeIn: 0.5 });
      const data = buffer.getChannelData(0);
      expect(data[0]).toBeCloseTo(0, 5);
      expect(data[250]).toBeCloseTo(0.5, 1);
      expect(data[500]).toBeCloseTo(1.0, 1);
      expect(data[999]).toBeCloseTo(1.0, 1);
    });

    it("applies linear fade-out", () => {
      const buffer = createTestAudioBuffer(1000, 1, 1000);
      fillChannel(buffer, 0, 1.0);
      applyFades(buffer, { fadeOut: 0.5 });
      const data = buffer.getChannelData(0);
      expect(data[0]).toBeCloseTo(1.0, 1);
      expect(data[499]).toBeCloseTo(1.0, 1);
      expect(data[999]).toBeCloseTo(0, 1);
    });

    it("applies both fade-in and fade-out", () => {
      const buffer = createTestAudioBuffer(1000, 1, 1000);
      fillChannel(buffer, 0, 1.0);
      applyFades(buffer, { fadeIn: 0.2, fadeOut: 0.2 });
      const data = buffer.getChannelData(0);
      expect(data[0]).toBeCloseTo(0, 5);
      expect(data[500]).toBeCloseTo(1.0, 1);
      expect(data[999]).toBeCloseTo(0, 1);
    });

    it("scales fades when fadeIn+fadeOut > buffer length", () => {
      const buffer = createTestAudioBuffer(100, 1, 100);
      fillChannel(buffer, 0, 1.0);
      applyFades(buffer, { fadeIn: 1, fadeOut: 1 });
      const data = buffer.getChannelData(0);
      expect(data[0]).toBeCloseTo(0, 2);
      expect(data[99]).toBeCloseTo(0, 1);
    });

    it("handles multi-channel audio", () => {
      const buffer = createTestAudioBuffer(1000, 2, 1000);
      fillChannel(buffer, 0, 1.0);
      fillChannel(buffer, 1, 1.0);
      applyFades(buffer, { fadeIn: 0.1 });
      expect(buffer.getChannelData(0)[0]).toBeCloseTo(0, 5);
      expect(buffer.getChannelData(1)[0]).toBeCloseTo(0, 5);
      expect(buffer.getChannelData(0)[999]).toBeCloseTo(1.0, 1);
      expect(buffer.getChannelData(1)[999]).toBeCloseTo(1.0, 1);
    });

    it("handles empty buffer gracefully", () => {
      const buffer = createTestAudioBuffer(0, 1, 44100);
      expect(() => applyFades(buffer, { fadeIn: 1, fadeOut: 1 })).not.toThrow();
    });
  });

  describe("prepareAudioAsync", () => {
    it("reports progress callbacks", async () => {
      const decodedBuffer = createTestAudioBuffer(44100, 1, 44100);
      fillChannel(decodedBuffer, 0, 0.5);

      mockGetPrimaryAudioTrack.mockResolvedValue({
        canDecode: mockCanDecode.mockResolvedValue(true),
      });
      mockComputeDuration.mockResolvedValue(1.0);
      mockBuffers.mockReturnValue({
        [Symbol.asyncIterator]: async function* () { yield { buffer: decodedBuffer }; },
      });

      const onProgress = vi.fn();
      await prepareAudioAsync(new Blob(["audio"]), 2.0, onProgress);

      expect(onProgress).toHaveBeenCalled();
      const messages = onProgress.mock.calls.map((c: any[]) => c[0].message);
      expect(messages.some((m: string) => m.includes("Loading"))).toBe(true);
    });

    it("falls back to WebAudio when MediaBunny fails", async () => {
      mockGetPrimaryAudioTrack.mockRejectedValue(new Error("MediaBunny fail"));

      const decodedBuffer = createTestAudioBuffer(44100, 1, 44100);
      const mockCtx = {
        decodeAudioData: vi.fn().mockResolvedValue(decodedBuffer),
        close: vi.fn().mockResolvedValue(undefined),
      };
      // Must be a constructable function (not vi.fn arrow) for `new AudioContext()`
      vi.stubGlobal("AudioContext", function MockAudioContext() { return mockCtx; });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      // jsdom Blob doesn't have arrayBuffer() — polyfill it for this test
      const blob = new Blob(["audio"], { type: "audio/mp3" });
      if (!blob.arrayBuffer) {
        (blob as any).arrayBuffer = () =>
          new Promise<ArrayBuffer>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as ArrayBuffer);
            reader.readAsArrayBuffer(blob);
          });
      }

      const result = await prepareAudioAsync(blob, 1.0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("MediaBunny audio decode failed"), expect.anything());
      expect(result).not.toBeNull();
      expect(result!.buffer).toBeTruthy();
      warnSpy.mockRestore();
    });

    it("loops audio to fill remaining duration", async () => {
      const decodedBuffer = createTestAudioBuffer(22050, 1, 44100);
      fillChannel(decodedBuffer, 0, 0.8);

      mockGetPrimaryAudioTrack.mockResolvedValue({
        canDecode: mockCanDecode.mockResolvedValue(true),
      });
      mockComputeDuration.mockResolvedValue(0.5);
      mockBuffers.mockReturnValue({
        [Symbol.asyncIterator]: async function* () { yield { buffer: decodedBuffer }; },
      });

      const result = await prepareAudioAsync(new Blob(["audio"]), 2.0);
      expect(result).not.toBeNull();
      expect(result!.duration).toBeCloseTo(2.0, 1);
    });

    it("handles positive offset", async () => {
      const decodedBuffer = createTestAudioBuffer(44100, 1, 44100);
      fillChannel(decodedBuffer, 0, 1.0);

      mockGetPrimaryAudioTrack.mockResolvedValue({ canDecode: mockCanDecode.mockResolvedValue(true) });
      mockComputeDuration.mockResolvedValue(1.0);
      mockBuffers.mockReturnValue({ [Symbol.asyncIterator]: async function* () { yield { buffer: decodedBuffer }; } });

      const result = await prepareAudioAsync(new Blob(["audio"]), 2.0, undefined, { offset: 0.5 });
      expect(result).not.toBeNull();
      expect(result!.buffer.getChannelData(0)[0]).toBeCloseTo(0, 5);
    });

    it("handles negative offset (skip source samples)", async () => {
      const decodedBuffer = createTestAudioBuffer(44100, 1, 44100);
      fillChannel(decodedBuffer, 0, 1.0);

      mockGetPrimaryAudioTrack.mockResolvedValue({ canDecode: mockCanDecode.mockResolvedValue(true) });
      mockComputeDuration.mockResolvedValue(1.0);
      mockBuffers.mockReturnValue({ [Symbol.asyncIterator]: async function* () { yield { buffer: decodedBuffer }; } });

      const result = await prepareAudioAsync(new Blob(["audio"]), 2.0, undefined, { offset: -0.5 });
      expect(result).not.toBeNull();
    });

    it("applies fades when options provided", async () => {
      const decodedBuffer = createTestAudioBuffer(44100, 1, 44100);
      fillChannel(decodedBuffer, 0, 1.0);

      mockGetPrimaryAudioTrack.mockResolvedValue({ canDecode: mockCanDecode.mockResolvedValue(true) });
      mockComputeDuration.mockResolvedValue(1.0);
      mockBuffers.mockReturnValue({ [Symbol.asyncIterator]: async function* () { yield { buffer: decodedBuffer }; } });

      const result = await prepareAudioAsync(new Blob(["audio"]), 1.0, undefined, { fadeIn: 0.1, fadeOut: 0.1 });
      expect(result).not.toBeNull();
      expect(result!.buffer.getChannelData(0)[0]).toBeCloseTo(0, 2);
    });

    it("throws on complete decode failure", async () => {
      mockGetPrimaryAudioTrack.mockRejectedValue(new Error("fail"));

      const mockCtx = {
        decodeAudioData: vi.fn().mockRejectedValue(new Error("WebAudio fail")),
        close: vi.fn().mockResolvedValue(undefined),
      };
      vi.stubGlobal("AudioContext", vi.fn(() => mockCtx));

      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(prepareAudioAsync(new Blob(["audio"]), 1.0)).rejects.toThrow("Failed to process audio");
    });
  });

  describe("decodeAudioPieces", () => {
    it("hands each MediaBunny piece over in order, keeping none", async () => {
      const first = createTestAudioBuffer(10, 1, 10);
      const second = createTestAudioBuffer(5, 1, 10);
      mockGetPrimaryAudioTrack.mockResolvedValue({ canDecode: mockCanDecode.mockResolvedValue(true) });
      mockComputeDuration.mockResolvedValue(1.5);
      mockBuffers.mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { buffer: first };
          yield { buffer: second };
        },
      });
      const got: AudioBuffer[] = [];
      const restart = vi.fn();
      await decodeAudioPieces(new Blob(["audio"]), { piece: (b) => got.push(b), restart });
      expect(got).toEqual([first, second]);
      expect(restart).not.toHaveBeenCalled();
    });

    it("restarts before the Web Audio fallback's one buffer when MediaBunny fails part-way", async () => {
      const first = createTestAudioBuffer(10, 1, 10);
      const whole = createTestAudioBuffer(20, 1, 10);
      mockGetPrimaryAudioTrack.mockResolvedValue({ canDecode: mockCanDecode.mockResolvedValue(true) });
      mockComputeDuration.mockResolvedValue(2);
      mockBuffers.mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { buffer: first };
          throw new Error("corrupt packet");
        },
      });
      const ctx = { decodeAudioData: vi.fn().mockResolvedValue(whole), close: vi.fn().mockResolvedValue(undefined) };
      vi.stubGlobal("AudioContext", function MockAudioContext() {
        return ctx;
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const blob = Object.assign(new Blob(["audio"]), { arrayBuffer: async () => new ArrayBuffer(4) });
      const order: string[] = [];
      await decodeAudioPieces(blob, {
        piece: (b) => order.push(b === first ? "first" : "whole"),
        restart: () => order.push("restart"),
      });
      expect(order).toEqual(["first", "restart", "whole"]);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });
  });

  it("fullLengthSamples matches prepareAudioAsync's length for a file, never under its minimum", () => {
    expect(fullLengthSamples(44101, 44100)).toBe(Math.max(1, Math.floor(Math.max(0.1, 44101 / 44100) * 44100)));
    expect(fullLengthSamples(5, 100)).toBe(10);
  });
});
