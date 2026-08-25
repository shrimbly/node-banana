/**
 * Video Processing Executors
 *
 * Unified executors for videoStitch and easeCurve nodes.
 * Used by both executeWorkflow and regenerateNode.
 */

import type { VideoStitchNodeData, EaseCurveNodeData, VideoTrimNodeData, VideoFrameGrabNodeData } from "@/types";
import { revokeBlobUrl } from "@/store/utils/executionUtils";
import type { NodeExecutionContext } from "./types";

/**
 * VideoStitch: combines multiple video clips into a single output.
 */
export async function executeVideoStitch(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData, getNodes, signal } = ctx;
  const nodeData = node.data as VideoStitchNodeData;

  if (nodeData.encoderSupported === false) {
    updateNodeData(node.id, {
      status: "error",
      error: "Browser does not support video encoding",
      progress: 0,
    });
    throw new Error("Browser does not support video encoding");
  }

  updateNodeData(node.id, { status: "loading", progress: 0, error: null, warning: null });

  try {
    const inputs = getConnectedInputs(node.id);

    if (inputs.videos.length < 2) {
      updateNodeData(node.id, {
        status: "error",
        error: "Need at least 2 video clips to stitch",
        progress: 0,
      });
      throw new Error("Need at least 2 video clips to stitch");
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const videoBlobs = await Promise.all(
      inputs.videos.map((v) => fetch(v).then((r) => r.blob()))
    );

    // Duplicate blobs based on loopCount (2x or 3x repeats the sequence)
    const loopCount = nodeData.loopCount || 1;
    const loopedBlobs =
      loopCount > 1
        ? Array.from({ length: loopCount }, () =>
            videoBlobs.map((b) => new Blob([b], { type: b.type }))
          ).flat()
        : videoBlobs;

    // Prepare audio if connected
    let audioData = null;
    if (inputs.audio.length > 0 && inputs.audio[0]) {
      const { prepareAudioAsync } = await import("@/hooks/useAudioMixing");
      const audioUrl = inputs.audio[0];
      const audioResponse = await fetch(audioUrl);
      const rawBlob = await audioResponse.blob();
      const audioMime =
        rawBlob.type ||
        (audioUrl.startsWith("data:")
          ? audioUrl.split(";")[0].split(":")[1]
          : "audio/mpeg");
      const audioBlob = rawBlob.type
        ? rawBlob
        : new Blob([rawBlob], { type: audioMime });
      audioData = await prepareAudioAsync(audioBlob, 0);
    }

    const { stitchVideosAsync } = await import("@/hooks/useStitchVideos");
    const { blob: outputBlob, warning: stitchWarning } = await stitchVideosAsync(
      loopedBlobs,
      audioData,
      (progress) => {
        if (signal?.aborted) return;
        updateNodeData(node.id, { progress: progress.progress });
      },
      signal
    );

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // Revoke old blob URL before replacing
    const oldData = getNodes().find((n) => n.id === node.id)?.data as
      | Record<string, unknown>
      | undefined;
    revokeBlobUrl(oldData?.outputVideo as string | undefined);

    let outputVideo: string;
    if (outputBlob.size > 20 * 1024 * 1024) {
      outputVideo = URL.createObjectURL(outputBlob);
    } else {
      const reader = new FileReader();
      outputVideo = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("FileReader error while reading stitched video"));
        reader.onabort = () => reject(new Error("FileReader aborted while reading stitched video"));
        reader.readAsDataURL(outputBlob);
      });
    }

    updateNodeData(node.id, {
      outputVideo,
      status: "complete",
      progress: 100,
      error: null,
      warning: stitchWarning,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      updateNodeData(node.id, { status: "idle", error: null, progress: 0 });
      throw err;
    }
    const errorMessage = err instanceof Error ? err.message : "Stitch failed";
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

  updateNodeData(node.id, { status: "loading", progress: 0, error: null, warning: null });

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
    const { blob: outputBlob, warning: trimWarning } = await trimVideoAsync(
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

    // Revoke old blob URL before replacing
    const oldData = getNodes().find((n) => n.id === node.id)?.data as
      | Record<string, unknown>
      | undefined;
    const oldOutputVideo = oldData?.outputVideo as string | undefined;
    if (oldOutputVideo && oldOutputVideo.startsWith("blob:")) {
      URL.revokeObjectURL(oldOutputVideo);
    }

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
      warning: trimWarning,
    });
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

    // Revoke old blob URL before replacing
    const oldData = getNodes().find((n) => n.id === node.id)?.data as
      | Record<string, unknown>
      | undefined;
    revokeBlobUrl(oldData?.outputVideo as string | undefined);

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

    updateNodeData(node.id, {
      outputImage,
      status: "complete",
      error: null,
    });
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
