import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { checkEncoderSupport, stitchVideosAsync } from "../useStitchVideos";

// ---- AudioBuffer polyfill for jsdom ----
class MockAudioBuffer {
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
  copyFromChannel() {}
  copyToChannel() {}
}

beforeAll(() => {
  if (typeof globalThis.AudioBuffer === "undefined") {
    (globalThis as any).AudioBuffer = MockAudioBuffer;
  }
});

// Mock mediabunny with proper class constructors
const mockCanEncodeVideo = vi.fn();
const mockGetVideoTracks = vi.fn();
const mockDispose = vi.fn();
const mockOutputStart = vi.fn().mockResolvedValue(undefined);
const mockOutputFinalize = vi.fn().mockResolvedValue(undefined);
const mockVideoSourceAdd = vi.fn().mockResolvedValue(undefined);
const mockVideoSourceClose = vi.fn().mockResolvedValue(undefined);
const mockAddVideoTrack = vi.fn();
const mockAddAudioTrack = vi.fn();
const mockAudioSourceAdd = vi.fn().mockResolvedValue(undefined);
const mockAudioSourceClose = vi.fn().mockResolvedValue(undefined);
const mockGetFirstEncodableAudioCodec = vi.fn();
const mockBufferTargetBuffer = new ArrayBuffer(100);

vi.mock("mediabunny", () => {
  class BlobSourceMock { constructor() {} }
  class InputMock {
    getVideoTracks: any;
    computeDuration: any;
    dispose: any;
    constructor() {
      this.getVideoTracks = (...args: any[]) => mockGetVideoTracks(...args);
      this.computeDuration = vi.fn().mockResolvedValue(1.0);
      this.dispose = (...args: any[]) => mockDispose(...args);
    }
  }
  class OutputMock {
    addVideoTrack: any;
    addAudioTrack: any;
    start: any;
    finalize: any;
    constructor() {
      this.addVideoTrack = (...args: any[]) => mockAddVideoTrack(...args);
      this.addAudioTrack = (...args: any[]) => mockAddAudioTrack(...args);
      this.start = (...args: any[]) => mockOutputStart(...args);
      this.finalize = (...args: any[]) => mockOutputFinalize(...args);
    }
  }
  class VideoSampleSinkMock {
    samples: any;
    constructor() {
      this.samples = vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: async function* () {
          yield { timestamp: 0, setTimestamp: vi.fn(), setDuration: vi.fn(), close: vi.fn() };
        },
      });
    }
  }
  class VideoSampleSourceMock {
    add: any;
    close: any;
    constructor() {
      this.add = (...args: any[]) => mockVideoSourceAdd(...args);
      this.close = (...args: any[]) => mockVideoSourceClose(...args);
    }
  }
  class AudioBufferSourceMock {
    add: any;
    close: any;
    constructor() {
      this.add = (...args: any[]) => mockAudioSourceAdd(...args);
      this.close = (...args: any[]) => mockAudioSourceClose(...args);
    }
  }
  class BufferTargetMock {
    get buffer() { return mockBufferTargetBuffer; }
  }
  class Mp4OutputFormatMock { constructor() {} }

  return {
    BlobSource: BlobSourceMock,
    Input: InputMock,
    Output: OutputMock,
    VideoSampleSink: VideoSampleSinkMock,
    VideoSampleSource: VideoSampleSourceMock,
    AudioBufferSource: AudioBufferSourceMock,
    BufferTarget: BufferTargetMock,
    Mp4OutputFormat: Mp4OutputFormatMock,
    ALL_FORMATS: [],
    canEncodeVideo: (...args: unknown[]) => mockCanEncodeVideo(...args),
    getFirstEncodableAudioCodec: (...args: unknown[]) => mockGetFirstEncodableAudioCodec(...args),
  };
});

vi.mock("@/lib/video-encoding", () => ({
  createAvcEncodingConfig: vi.fn(() => ({})),
  AVC_LEVEL_4_0: "avc1.640028",
  AVC_LEVEL_5_1: "avc1.640033",
}));

describe("useStitchVideos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe("checkEncoderSupport", () => {
    it("returns true when canEncodeVideo resolves true", async () => {
      mockCanEncodeVideo.mockResolvedValue(true);
      expect(await checkEncoderSupport()).toBe(true);
    });

    it("returns false when canEncodeVideo resolves false", async () => {
      mockCanEncodeVideo.mockResolvedValue(false);
      expect(await checkEncoderSupport()).toBe(false);
    });

    it("returns false when canEncodeVideo throws", async () => {
      mockCanEncodeVideo.mockRejectedValue(new Error("Not supported"));
      expect(await checkEncoderSupport()).toBe(false);
    });

    it("checks with correct parameters", async () => {
      mockCanEncodeVideo.mockResolvedValue(true);
      await checkEncoderSupport();
      expect(mockCanEncodeVideo).toHaveBeenCalledWith("avc", {
        width: 1920,
        height: 1080,
        bitrate: 8_000_000,
      });
    });
  });

  describe("stitchVideosAsync", () => {
    const createMockVideoTrack = (width = 1920, height = 1080, rotation = 0) => ({
      displayWidth: width,
      displayHeight: height,
      codedWidth: width,
      codedHeight: height,
      rotation,
      computePacketStats: vi.fn().mockResolvedValue({ averageBitrate: 8_000_000 }),
    });

    beforeEach(() => {
      mockCanEncodeVideo.mockResolvedValue(true);
      mockGetVideoTracks.mockResolvedValue([createMockVideoTrack()]);
    });

    it("throws when given empty array", async () => {
      await expect(stitchVideosAsync([])).rejects.toThrow("No videos to stitch");
    });

    it("reports progress updates", async () => {
      const onProgress = vi.fn();
      const blob = new Blob(["video1"], { type: "video/mp4" });
      await stitchVideosAsync([blob], null, onProgress);

      expect(onProgress).toHaveBeenCalled();
      const statuses = onProgress.mock.calls.map((c: any[]) => c[0].status);
      expect(statuses).toContain("processing");
      expect(statuses).toContain("complete");
    });

    it("returns a video/mp4 Blob", async () => {
      const blob = new Blob(["video1"], { type: "video/mp4" });
      const result = await stitchVideosAsync([blob]);
      expect(result.blob).toBeInstanceOf(Blob);
      expect(result.blob.type).toBe("video/mp4");
      expect(result.warning).toBeNull();
    });

    it("processes multiple video blobs", async () => {
      const blob1 = new Blob(["video1"], { type: "video/mp4" });
      const blob2 = new Blob(["video2"], { type: "video/mp4" });
      const result = await stitchVideosAsync([blob1, blob2]);
      expect(result.blob).toBeInstanceOf(Blob);
    });

    it("reports error status on failure", async () => {
      mockCanEncodeVideo.mockResolvedValue(false);
      const onProgress = vi.fn();
      const blob = new Blob(["video"], { type: "video/mp4" });

      await expect(stitchVideosAsync([blob], null, onProgress)).rejects.toThrow();

      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      if (lastCall) {
        expect(lastCall[0].status).toBe("error");
      }
    });

    it("handles audio data when provided", async () => {
      mockGetFirstEncodableAudioCodec.mockResolvedValue("aac");

      const videoBlob = new Blob(["video"], { type: "video/mp4" });
      const audioBuffer = new MockAudioBuffer({ length: 44100, numberOfChannels: 1, sampleRate: 44100 });
      const audioData = { buffer: audioBuffer as unknown as AudioBuffer, duration: 1.0 };

      await stitchVideosAsync([videoBlob], audioData);

      expect(mockGetFirstEncodableAudioCodec).toHaveBeenCalled();
      expect(mockAddAudioTrack).toHaveBeenCalled();
    });

    it("continues without audio when no codec is supported", async () => {
      mockGetFirstEncodableAudioCodec.mockResolvedValue(null);

      const videoBlob = new Blob(["video"], { type: "video/mp4" });
      const audioBuffer = new MockAudioBuffer({ length: 44100, numberOfChannels: 1, sampleRate: 44100 });

      const result = await stitchVideosAsync([videoBlob], {
        buffer: audioBuffer as unknown as AudioBuffer,
        duration: 1.0,
      });

      expect(result.blob).toBeInstanceOf(Blob);
      expect(result.warning).toMatch(/no supported audio codec/i);
      expect(mockAddAudioTrack).not.toHaveBeenCalled();
    });

    it("probes video metadata before encoding", async () => {
      const blob = new Blob(["video"], { type: "video/mp4" });
      await stitchVideosAsync([blob]);
      expect(mockGetVideoTracks).toHaveBeenCalled();
    });

    it("checks encoder support for target resolution", async () => {
      const blob = new Blob(["video"], { type: "video/mp4" });
      await stitchVideosAsync([blob]);
      expect(mockCanEncodeVideo).toHaveBeenCalled();
    });
  });
});
