/**
 * Video Processing Executors
 *
 * Unified executors for videoStitch and easeCurve nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { VideoStitchNodeData, EaseCurveNodeData, VideoTrimNodeData, VideoFrameGrabNodeData } from "@/types";
import { dataUrlToBlob, isDataUrl, readBlobBytes } from "@/lib/assets/client/mediaBlob";
import { isMediaReference } from "@/lib/media/references";
import type { NodeExecutionContext } from "./types";
import { assetParameters, assetProducer, holdRecordingRun, recordingResult, recordOutput } from "./assetRecording";
import { gatherStitchInputs, stitchEngineOptions, stitchRecordParameters } from "./stitchInputs";

const FINGERPRINT_SAMPLES = 8;
const FINGERPRINT_SAMPLE_BYTES = 4096;
const MAX_REMEMBERED_VIDEOS = 256;

/**
 * A cheap stand-in for an encoded video's identity: its size, its type and a
 * few slices spread through its body, tail included. The head is left out:
 * the muxer stamps the time of each encode into the moov box at the front,
 * so two encodes of the same edit differ there and nowhere else.
 */
export async function videoFingerprint(blob: Blob): Promise<string> {
  const { size } = blob;
  const starts = new Set<number>([Math.max(0, size - FINGERPRINT_SAMPLE_BYTES)]);
  for (let i = 1; i <= FINGERPRINT_SAMPLES; i++) starts.add(Math.floor((size * i) / (FINGERPRINT_SAMPLES + 1)));
  // 32-bit FNV-1a over the sampled bytes, in file order
  let hash = 0x811c9dc5;
  for (const start of [...starts].sort((a, b) => a - b)) {
    const bytes = await readBlobBytes(blob.slice(start, Math.min(size, start + FINGERPRINT_SAMPLE_BYTES)));
    for (let i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return `${size}:${blob.type}:${(hash >>> 0).toString(16)}`;
}

interface RecordedVideo {
  fingerprint: string;
  /** True once the library holds it; false if that recording failed. */
  landed: Promise<boolean>;
}

/**
 * The video each edit node last recorded, by workflow and node. A re-run that
 * produced it again is not a new asset, and over 20 MB the node's string can
 * never tell: every run gets a fresh object URL.
 */
const lastRecordedVideo = new Map<string, RecordedVideo>();

function rememberRecordedVideo(key: string, video: RecordedVideo): void {
  lastRecordedVideo.delete(key);
  lastRecordedVideo.set(key, video);
  if (lastRecordedVideo.size > MAX_REMEMBERED_VIDEOS) {
    const oldest = lastRecordedVideo.keys().next().value;
    if (oldest !== undefined) lastRecordedVideo.delete(oldest);
  }
}

/** What the node showed before this run, when that was a video still readable here. */
async function previousVideoFingerprint(previousOutput: unknown): Promise<string | null> {
  // An object URL is revoked by now; a data: URL (under 20 MB) still holds its
  // bytes, and a reference (a saved workflow's file) still points at them
  if (typeof previousOutput !== "string") return null;
  if (isDataUrl(previousOutput)) return videoFingerprint(dataUrlToBlob(previousOutput));
  if (!isMediaReference(previousOutput)) return null;
  try {
    const response = await fetch(previousOutput);
    return response.ok ? videoFingerprint(await response.blob()) : null;
  } catch {
    return null;
  }
}

/**
 * Keep an edited video in the asset library. The Blob goes rather than the
 * node's string: over 20 MB that string is an object URL, which does not
 * outlive the session. A re-run that produced the same video is not a new one.
 */
async function recordEditedVideo(
  ctx: NodeExecutionContext,
  outputVideo: string,
  previousOutput: unknown,
  outputBlob: Blob,
  operation: string,
  parameters: Record<string, unknown>,
  durationSec?: number
): Promise<void> {
  if (outputVideo === previousOutput || !ctx.recordAsset) return;
  const key = `${ctx.assetRun?.workflowId ?? ""}\u0000${ctx.node.id}`;

  const record = (fingerprint: string | null): void => {
    const handle = recordOutput(ctx, {
      kind: "video",
      origin: "edited",
      media: outputBlob,
      mime: outputBlob.type || "video/mp4",
      parameters: assetParameters(parameters),
      producer: assetProducer(ctx, { operation }),
      ...(typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec > 0 ? { durationSec } : {}),
    });
    if (!handle || !fingerprint) return;
    const video: RecordedVideo = { fingerprint, landed: recordingResult(handle).then((result) => result !== null) };
    rememberRecordedVideo(key, video);
    // A recording that failed kept nothing, so the next run records it again
    void video.landed.then((landed) => {
      if (!landed && lastRecordedVideo.get(key) === video) lastRecordedVideo.delete(key);
    });
  };

  let fingerprint: string | null = null;
  try {
    fingerprint = await videoFingerprint(outputBlob);
    const remembered = lastRecordedVideo.get(key);
    if (remembered && fingerprint === remembered.fingerprint) {
      rememberRecordedVideo(key, remembered);
      // That recording may still be uploading. If it then fails, this run's
      // copy is the one to keep, unless a later run has recorded since. This
      // run stays open until then, so that copy gets its workflow snapshot.
      const release = holdRecordingRun(ctx);
      void remembered.landed
        .then((landed) => {
          if (!landed && !lastRecordedVideo.has(key)) record(fingerprint);
        })
        .finally(release);
      return;
    }
    if (!remembered && fingerprint === (await previousVideoFingerprint(previousOutput))) {
      rememberRecordedVideo(key, { fingerprint, landed: Promise.resolve(true) });
      return;
    }
  } catch (error) {
    // Not knowing is no reason to lose the edit
    console.warn("Could not compare the edited video with the previous one:", error);
  }
  record(fingerprint);
}

/**
 * VideoStitch: combines multiple video clips into a single output.
 */
export async function executeVideoStitch(ctx: NodeExecutionContext): Promise<void> {
  const { node, updateNodeData, getNodes, signal } = ctx;
  // Fresh, so the encoder check and the timeline are the node's current ones
  const nodeData = (ctx.getFreshNode(node.id) ?? node).data as VideoStitchNodeData;

  if (nodeData.encoderSupported === false) {
    updateNodeData(node.id, {
      status: "error",
      error: "Browser does not support video encoding",
      progress: 0,
    });
    throw new Error("Browser does not support video encoding");
  }

  updateNodeData(node.id, { status: "loading", progress: 0, error: null });

  try {
    // The timeline, resolved to Blobs: trims, clip sound, library clips, and the music's curve or the audio clips
    const gathered = await gatherStitchInputs(ctx, nodeData);

    const { stitchVideosAsync } = await import("@/hooks/useStitchVideos");
    const outputBlob = await stitchVideosAsync(
      gathered.clips,
      gathered.music,
      (progress) => {
        if (signal?.aborted) return;
        updateNodeData(node.id, { progress: progress.progress });
      },
      signal,
      stitchEngineOptions(gathered)
    );

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // The previous output is released once the new one is in place, and only
    // if nothing else (a copy, another tab, undo) still holds it
    const oldData = getNodes().find((n) => n.id === node.id)?.data as
      | Record<string, unknown>
      | undefined;
    const previousOutput = oldData?.outputVideo;

    let outputVideo: string;
    if (outputBlob.size > 20 * 1024 * 1024) {
      outputVideo = URL.createObjectURL(outputBlob);
    } else {
      const reader = new FileReader();
      outputVideo = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("FileReader error while reading the rendered video"));
        reader.onabort = () => reject(new Error("FileReader aborted while reading the rendered video"));
        reader.readAsDataURL(outputBlob);
      });
    }

    updateNodeData(node.id, {
      outputVideo,
      status: "complete",
      progress: 100,
      error: null,
    });

    ctx.releaseMediaUrl?.(previousOutput as string | undefined);

    await recordEditedVideo(ctx, outputVideo, previousOutput, outputBlob, "stitch", stitchRecordParameters(gathered));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      updateNodeData(node.id, { status: "idle", error: null, progress: 0 });
      throw err;
    }
    const errorMessage = err instanceof Error ? err.message : "Render failed";
    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
      progress: 0,
    });
    throw err instanceof Error ? err : new Error(errorMessage);
  }
}

/**
 * VideoTrim: trims a video clip to a user-defined start/end time range with audio preservation.
 */
export async function executeVideoTrim(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, getNodes, signal } = ctx;
  const nodeData = node.data as VideoTrimNodeData;

  if (nodeData.encoderSupported === false) {
    updateNodeData(node.id, {
      status: "error",
      error: "Browser does not support video encoding",
      progress: 0,
    });
    throw new Error("Browser does not support video encoding");
  }

  updateNodeData(node.id, { status: "loading", progress: 0, error: null });

  try {
    const inputs = getConnectedInputs(node.id);

    if (inputs.videos.length === 0) {
      updateNodeData(node.id, {
        status: "error",
        error: "Connect a video input to trim",
        progress: 0,
      });
      throw new Error("Connect a video input to trim");
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const videoUrl = inputs.videos[0];
    const videoBlob = await fetch(videoUrl).then((r) => r.blob());

    // Get fresh node data for current slider values
    const freshNodeData = getNodes().find((n) => n.id === node.id)?.data as VideoTrimNodeData | undefined;
    const startTime = freshNodeData?.startTime ?? nodeData.startTime;
    const endTime = freshNodeData?.endTime ?? nodeData.endTime;

    if (endTime <= 0 || startTime >= endTime) {
      updateNodeData(node.id, {
        status: "error",
        error: "Set valid start/end trim times",
        progress: 0,
      });
      throw new Error("Set valid start/end trim times");
    }

    const { trimVideoAsync } = await import("@/hooks/useTrimVideo");
    const outputBlob = await trimVideoAsync(
      videoBlob,
      startTime,
      endTime,
      (progress) => {
        if (signal?.aborted) return;
        updateNodeData(node.id, { progress: progress.progress });
      },
      signal
    );

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // Released once the new output is in place (see the stitch above)
    const oldData = getNodes().find((n) => n.id === node.id)?.data as
      | Record<string, unknown>
      | undefined;
    const oldOutputVideo = oldData?.outputVideo as string | undefined;

    let outputVideo: string;
    if (outputBlob.size > 20 * 1024 * 1024) {
      outputVideo = URL.createObjectURL(outputBlob);
    } else {
      const reader = new FileReader();
      outputVideo = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("FileReader error while reading trimmed video"));
        reader.onabort = () => reject(new Error("FileReader aborted while reading trimmed video"));
        reader.readAsDataURL(outputBlob);
      });
    }

    updateNodeData(node.id, {
      outputVideo,
      status: "complete",
      progress: 100,
      error: null,
    });

    ctx.releaseMediaUrl?.(oldOutputVideo);

    await recordEditedVideo(ctx, outputVideo, oldOutputVideo, outputBlob, "trim", { startTime, endTime }, endTime - startTime);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      updateNodeData(node.id, { status: "idle", error: null, progress: 0 });
      throw err;
    }
    const errorMessage = err instanceof Error ? err.message : "Video trim failed";
    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
      progress: 0,
    });
    throw err instanceof Error ? err : new Error(errorMessage);
  }
}

/**
 * EaseCurve: applies speed curve to a video input.
 */
export async function executeEaseCurve(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, getEdges, getNodes, signal } = ctx;
  const nodeData = node.data as EaseCurveNodeData;

  if (nodeData.encoderSupported === false) {
    updateNodeData(node.id, {
      status: "error",
      error: "Browser does not support video encoding",
      progress: 0,
    });
    throw new Error("Browser does not support video encoding");
  }

  updateNodeData(node.id, { status: "loading", progress: 0, error: null });

  try {
    const inputs = getConnectedInputs(node.id);

    // Propagate parent easeCurve settings if inherited
    let activeBezierHandles = nodeData.bezierHandles;
    let activeEasingPreset = nodeData.easingPreset;
    let activeOutputDuration = nodeData.outputDuration;
    if (inputs.easeCurve) {
      activeBezierHandles = inputs.easeCurve.bezierHandles;
      activeEasingPreset = inputs.easeCurve.easingPreset;
      activeOutputDuration = inputs.easeCurve.outputDuration;
      const edges = getEdges();
      const easeCurveSourceId =
        edges.filter(
          (e) => e.target === node.id && e.targetHandle === "easeCurve"
        )[0]?.source ?? null;
      updateNodeData(node.id, {
        bezierHandles: activeBezierHandles,
        easingPreset: activeEasingPreset,
        outputDuration: activeOutputDuration,
        inheritedFrom: easeCurveSourceId,
      });
    }

    if (inputs.videos.length === 0) {
      updateNodeData(node.id, {
        status: "error",
        error: "Connect a video input to apply ease curve",
        progress: 0,
      });
      throw new Error("Connect a video input to apply ease curve");
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const videoUrl = inputs.videos[0];
    const videoBlob = await fetch(videoUrl).then((r) => r.blob());

    // Get video duration for warpTime input
    const videoDuration = await new Promise<number>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        resolve(video.duration);
        URL.revokeObjectURL(video.src);
      };
      video.onerror = () => {
        resolve(5); // Fallback to 5 seconds
        URL.revokeObjectURL(video.src);
      };
      video.src = URL.createObjectURL(videoBlob);
    });

    // Determine easing function: use named preset if set, otherwise create from Bezier handles
    let easingFunction: string | ((t: number) => number);
    if (activeEasingPreset) {
      easingFunction = activeEasingPreset;
    } else {
      const { createBezierEasing } = await import("@/lib/easing-functions");
      easingFunction = createBezierEasing(
        activeBezierHandles[0],
        activeBezierHandles[1],
        activeBezierHandles[2],
        activeBezierHandles[3]
      );
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const { applySpeedCurveAsync } = await import("@/hooks/useApplySpeedCurve");
    const outputBlob = await applySpeedCurveAsync(
      videoBlob,
      videoDuration,
      activeOutputDuration,
      (progress) => {
        if (signal?.aborted) return;
        updateNodeData(node.id, { progress: progress.progress });
      },
      easingFunction,
      undefined, // bitrate — keep default
      signal
    );

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    if (!outputBlob) {
      throw new Error("Speed curve processing returned no output");
    }

    // Released once the new output is in place (see the stitch above)
    const oldData = getNodes().find((n) => n.id === node.id)?.data as
      | Record<string, unknown>
      | undefined;
    const previousOutput = oldData?.outputVideo;

    let outputVideo: string;
    if (outputBlob.size > 20 * 1024 * 1024) {
      outputVideo = URL.createObjectURL(outputBlob);
    } else {
      const reader = new FileReader();
      outputVideo = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("FileReader error while reading ease curve video"));
        reader.onabort = () => reject(new Error("FileReader aborted while reading ease curve video"));
        reader.readAsDataURL(outputBlob);
      });
    }

    updateNodeData(node.id, {
      outputVideo,
      status: "complete",
      progress: 100,
      error: null,
    });

    ctx.releaseMediaUrl?.(previousOutput as string | undefined);

    await recordEditedVideo(
      ctx,
      outputVideo,
      previousOutput,
      outputBlob,
      "easeCurve",
      { easingPreset: activeEasingPreset, bezierHandles: activeBezierHandles, outputDuration: activeOutputDuration },
      activeOutputDuration
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      updateNodeData(node.id, { status: "idle", error: null, progress: 0 });
      throw err;
    }
    const errorMessage =
      err instanceof Error ? err.message : "Ease curve processing failed";
    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
      progress: 0,
    });
    throw err instanceof Error ? err : new Error(errorMessage);
  }
}

/**
 * VideoFrameGrab: extracts the first or last frame from a video as a full-resolution PNG image.
 */
export async function executeVideoFrameGrab(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;
  const nodeData = node.data as VideoFrameGrabNodeData;

  updateNodeData(node.id, { status: "loading", error: null });

  try {
    const inputs = getConnectedInputs(node.id);

    if (inputs.videos.length === 0) {
      updateNodeData(node.id, {
        status: "error",
        error: "Connect a video input to extract a frame",
      });
      throw new Error("Connect a video input to extract a frame");
    }

    const videoUrl = inputs.videos[0];

    // Create video element and seek to target frame
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    let blobUrl: string | null = null;

    try {
    const FRAME_EXTRACTION_TIMEOUT = 30_000; // 30 seconds
    const outputImage = await new Promise<string>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
      };

      video.onloadedmetadata = () => {
        // For "first" frame, seek to 0.001 (not exactly 0 to ensure a decoded frame)
        // For "last" frame, seek to duration - small epsilon
        const seekTime = nodeData.framePosition === "first"
          ? 0.001
          : Math.max(0, video.duration - 0.1);
        video.currentTime = seekTime;

        timeoutId = setTimeout(() => {
          if (blobUrl) URL.revokeObjectURL(blobUrl);
          reject(new Error("Frame extraction timed out"));
        }, FRAME_EXTRACTION_TIMEOUT);
      };

      video.onseeked = () => {
        cleanup();
        try {
          const canvas = document.createElement("canvas");
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx2d = canvas.getContext("2d");
          if (!ctx2d) {
            reject(new Error("Could not get canvas 2d context"));
            return;
          }
          ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
          const frameDataUrl = canvas.toDataURL("image/png");
          resolve(frameDataUrl);
        } catch (err) {
          reject(err instanceof Error ? err : new Error("Frame extraction failed"));
        }
      };

      video.onerror = () => {
        cleanup();
        reject(new Error("Failed to load video for frame extraction"));
      };

      // If data URL, convert to blob URL for better performance
      if (videoUrl.startsWith("data:")) {
        fetch(videoUrl)
          .then((r) => r.blob())
          .then((blob) => {
            blobUrl = URL.createObjectURL(blob);
            video.src = blobUrl;
          })
          .catch(() => {
            video.src = videoUrl;
          });
      } else {
        video.src = videoUrl;
      }
    });

    const previousOutput = (ctx.getFreshNode(node.id)?.data as VideoFrameGrabNodeData | undefined)?.outputImage;
    updateNodeData(node.id, {
      outputImage,
      status: "complete",
      error: null,
    });

    if (outputImage !== previousOutput) {
      recordOutput(ctx, {
        kind: "image",
        origin: "edited",
        media: outputImage,
        mime: "image/png",
        parameters: { framePosition: nodeData.framePosition },
        producer: assetProducer(ctx, { operation: "frameGrab" }),
        ...(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : {}),
      });
    }
    } finally {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Frame extraction failed";
    updateNodeData(node.id, {
      status: "error",
      error: errorMessage,
    });
    throw err instanceof Error ? err : new Error(errorMessage);
  }
}
