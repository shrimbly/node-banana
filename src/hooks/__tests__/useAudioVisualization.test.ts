import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// The hook's module caches a shared AudioContext singleton via getSharedAudioContext().
// That function reads window.AudioContext on first call. We must install the mock
// on globalThis BEFORE the module is imported. vi.hoisted runs before any imports.
const { mockDecodeAudioData, MockAudioBuffer } = vi.hoisted(() => {
  const _mockDecodeAudioData = vi.fn();

  // AudioBuffer polyfill for jsdom
  class _MockAudioBuffer {
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
      this.channels = Array.from({ length: options.numberOfChannels }, () => {
        const arr = new Float32Array(options.length);
        for (let i = 0; i < options.length; i++) {
          arr[i] = Math.sin((2 * Math.PI * i) / Math.max(1, options.length));
        }
        return arr;
      });
    }
    getChannelData(channel: number): Float32Array { return this.channels[channel]; }
    copyFromChannel() {}
    copyToChannel() {}
  }

  // Install polyfills on globalThis (which is window in jsdom)
  if (typeof globalThis.AudioBuffer === "undefined") {
    (globalThis as any).AudioBuffer = _MockAudioBuffer;
  }
  // The hook's decodeAudioBuffer checks context.decodeAudioData.length === 1
  // to decide between promise-based and callback-based calling. Set length to 1
  // so it uses the simpler `return context.decodeAudioData(arrayBuffer)` path.
  Object.defineProperty(_mockDecodeAudioData, "length", { value: 1 });

  // AudioContext must be a constructable function (not vi.fn arrow)
  function MockAudioContext() {
    return {
      decodeAudioData: _mockDecodeAudioData,
      close: vi.fn(),
      state: "running",
    };
  }
  (globalThis as any).AudioContext = MockAudioContext;

  return { mockDecodeAudioData: _mockDecodeAudioData, MockAudioBuffer: _MockAudioBuffer };
});

// Now the import will pick up our AudioContext when getSharedAudioContext() runs
import { audioSourceKey, useAudioVisualization } from "../useAudioVisualization";

/**
 * Create a Blob with arrayBuffer() polyfilled (jsdom Blob lacks this method).
 */
function createAudioBlob(content: string, type = "audio/mp3"): Blob {
  const blob = new Blob([content], { type });
  if (!blob.arrayBuffer) {
    (blob as any).arrayBuffer = () =>
      new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(blob);
      });
  }
  return blob;
}

/**
 * Create a File with arrayBuffer() polyfilled.
 */
function createAudioFile(content: string, name: string, type = "audio/mp3"): File {
  const file = new File([content], name, { type });
  if (!file.arrayBuffer) {
    (file as any).arrayBuffer = () =>
      new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });
  }
  return file;
}

describe("useAudioVisualization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds a waveform decoded before by its source in the first render, without the file", async () => {
    const audioBuffer = new MockAudioBuffer({ length: 4410, numberOfChannels: 1, sampleRate: 44100 });
    mockDecodeAudioData.mockResolvedValue(audioBuffer);
    const key = audioSourceKey("data:audio/mp3;base64," + "A".repeat(5000) + "first");
    const first = renderHook(() => useAudioVisualization(createAudioBlob("audio"), key));
    await waitFor(() => expect(first.result.current.waveformData).not.toBeNull());
    // Mounted again (a painted copy, then the live node): there at once.
    const again = renderHook(() => useAudioVisualization(null, key));
    expect(again.result.current.waveformData?.peaks).toEqual(first.result.current.waveformData!.peaks);
    // Another source of the same length is not it.
    expect(audioSourceKey("data:audio/mp3;base64," + "A".repeat(5000) + "other")).not.toBe(key);
    expect(audioSourceKey(null)).toBeNull();
  });

  it("returns null waveformData and isLoading=false for null input", () => {
    const { result } = renderHook(() => useAudioVisualization(null));
    expect(result.current.waveformData).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sets isLoading then resolves to data on success", async () => {
    const audioBuffer = new MockAudioBuffer({ length: 4410, numberOfChannels: 1, sampleRate: 44100 });
    mockDecodeAudioData.mockResolvedValue(audioBuffer);

    const blob = createAudioBlob("audio");
    const { result } = renderHook(() => useAudioVisualization(blob));

    await waitFor(() => {
      expect(result.current.waveformData).not.toBeNull();
    });
    expect(result.current.isLoading).toBe(false);
  });

  it("returns peaks, channelData, sampleRate, duration on success", async () => {
    const audioBuffer = new MockAudioBuffer({ length: 44100, numberOfChannels: 2, sampleRate: 44100 });
    mockDecodeAudioData.mockResolvedValue(audioBuffer);

    const blob = createAudioBlob("audio", "audio/wav");
    const { result } = renderHook(() => useAudioVisualization(blob));

    await waitFor(() => {
      expect(result.current.waveformData).not.toBeNull();
    });

    const data = result.current.waveformData!;
    expect(data.peaks).toBeInstanceOf(Array);
    expect(data.peaks.length).toBeGreaterThan(0);
    expect(data.channelData).toHaveLength(2);
    expect(data.sampleRate).toBe(44100);
    expect(data.duration).toBeCloseTo(1.0, 1);
  });

  it("caches by File identity (name+size+lastModified)", async () => {
    const audioBuffer = new MockAudioBuffer({ length: 4410, numberOfChannels: 1, sampleRate: 44100 });
    mockDecodeAudioData.mockResolvedValue(audioBuffer);

    const file = createAudioFile("audio", "test.mp3");
    const { result } = renderHook(() => useAudioVisualization(file));

    await waitFor(() => {
      expect(result.current.waveformData).not.toBeNull();
    });

    const callCountAfterFirst = mockDecodeAudioData.mock.calls.length;

    // Re-render with same file should use cache
    const { result: result2 } = renderHook(() => useAudioVisualization(file));

    await waitFor(() => {
      expect(result2.current.waveformData).not.toBeNull();
    });

    expect(mockDecodeAudioData.mock.calls.length).toBe(callCountAfterFirst);
  });

  it("caches by Blob identity", async () => {
    const audioBuffer = new MockAudioBuffer({ length: 4410, numberOfChannels: 1, sampleRate: 44100 });
    mockDecodeAudioData.mockResolvedValue(audioBuffer);

    const blob = createAudioBlob("audio", "audio/wav");
    const { result } = renderHook(() => useAudioVisualization(blob));

    await waitFor(() => {
      expect(result.current.waveformData).not.toBeNull();
    });

    const callCountAfterFirst = mockDecodeAudioData.mock.calls.length;

    const { result: result2 } = renderHook(() => useAudioVisualization(blob));

    await waitFor(() => {
      expect(result2.current.waveformData).not.toBeNull();
    });

    expect(mockDecodeAudioData.mock.calls.length).toBe(callCountAfterFirst);
  });

  it("sets error state on decode failure", async () => {
    mockDecodeAudioData.mockRejectedValue(new Error("Decode failed"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const blob = createAudioBlob("bad-audio");
    const { result } = renderHook(() => useAudioVisualization(blob));

    await waitFor(() => {
      expect(result.current.error).toBe("Decode failed");
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.waveformData).toBeNull();
  });

  it("sets generic error for non-Error exceptions", async () => {
    mockDecodeAudioData.mockRejectedValue("string error");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const blob = createAudioBlob("bad");
    const { result } = renderHook(() => useAudioVisualization(blob));

    await waitFor(() => {
      expect(result.current.error).toBe("Failed to process audio");
    });
  });

  it("cleans up on unmount (cancellation)", async () => {
    mockDecodeAudioData.mockReturnValue(new Promise(() => {})); // Never resolves

    const blob = createAudioBlob("audio", "audio/ogg");
    const { unmount } = renderHook(() => useAudioVisualization(blob));

    // Unmount before resolving - should not throw
    unmount();
  });

  it("resets state when input changes to null", async () => {
    const audioBuffer = new MockAudioBuffer({ length: 4410, numberOfChannels: 1, sampleRate: 44100 });
    mockDecodeAudioData.mockResolvedValue(audioBuffer);

    const blob = createAudioBlob("audio-for-reset");
    const { result, rerender } = renderHook(
      ({ file }: { file: Blob | null }) => useAudioVisualization(file),
      { initialProps: { file: blob } }
    );

    await waitFor(() => {
      expect(result.current.waveformData).not.toBeNull();
    });

    rerender({ file: null });

    await waitFor(() => {
      expect(result.current.waveformData).toBeNull();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
