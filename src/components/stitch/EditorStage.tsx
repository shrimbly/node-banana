"use client";

import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Film } from "lucide-react";
import { useStitchEditorStore } from "@/store/stitchEditorStore";

/** Room kept at the frame's sides, and above the frame and below its control row. */
const STAGE_PAD_X = 32;
const STAGE_PAD_Y = 24;
/** The control row under the frame: 8px of air and its 48px. */
const CONTROLS_PX = 56;
/**
 * The row is the frame's width, but never narrower than this under a tall frame (a portrait clip): what Stacked's row
 * holds with Fit, − and + dropped, Play still centred.
 */
export const CONTROLS_MIN_PX = 576;

/**
 * The frame, contain-fitted to the output's aspect in the stage less its padding and the control row, and the row's
 * width. null until the stage has a size.
 */
export function stageLayout(
  box: { width: number; height: number } | null,
  aspect: number,
): { frame: { width: number; height: number }; row: number } | null {
  if (!box || box.width <= 0 || box.height <= 0) return null;
  const width = Math.max(0, box.width - STAGE_PAD_X * 2);
  const height = Math.max(0, box.height - STAGE_PAD_Y * 2 - CONTROLS_PX);
  const frame =
    height === 0 || width / height > aspect ? { width: height * aspect, height } : { width, height: width / aspect };
  return { frame, row: Math.min(width, Math.max(frame.width, CONTROLS_MIN_PX)) };
}

/** A preview element: one per clip. */
export interface PreviewLayerSource {
  /** What the playback registers it by: the clip's id. */
  key: string;
  src: string;
}

/** A hidden <audio> per audio clip, registered by the clip's id. */
function PreviewAudio({
  clipId,
  src,
  registerAudio,
}: {
  clipId: string;
  src: string;
  registerAudio: (clipId: string, el: HTMLAudioElement | null) => void;
}) {
  const ref = useCallback((el: HTMLAudioElement | null) => registerAudio(clipId, el), [registerAudio, clipId]);
  return <audio ref={ref} src={src} preload="auto" className="hidden" />;
}

/**
 * One <video>, with a ref callback that keeps its identity while its key does. Hidden by class until the playback
 * writes its inline opacity (and its sound): a cut is never a render. Only its metadata loads until the playback
 * needs it (it sets preload to auto for the clips shown, playing and coming up).
 */
function PreviewVideo({
  layerKey,
  src,
  registerVideo,
}: {
  layerKey: string;
  src: string;
  registerVideo: (key: string, el: HTMLVideoElement | null) => void;
}) {
  const ref = useCallback((el: HTMLVideoElement | null) => registerVideo(layerKey, el), [registerVideo, layerKey]);
  return (
    <video
      ref={ref}
      src={src}
      preload="metadata"
      playsInline
      className="absolute inset-0 h-full w-full object-contain opacity-0"
    />
  );
}

/**
 * The stage: the sequence on black in an 8px-rounded frame, contain-fitted to
 * the output's aspect and centred on the pane with its control row (the
 * children) under it at its width. One <video> per clip is mounted, in row
 * order, and the playback works their opacities out in that order (each
 * clip's share of the picture does not depend on which one paints last).
 * Over them a canvas, where the playback draws clips that blend while
 * playing. useSequencePlayback drives them, and each audio clip's hidden
 * <audio>. An editor with no clips shows an empty frame that says why.
 */
export function EditorStage({
  empty,
  aspect,
  layers,
  registerVideo,
  registerCanvas,
  audioLayers,
  registerAudio,
  children,
}: {
  empty: boolean;
  /** width / height of the output; 16:9 when no clip has a size yet. */
  aspect: number;
  /** One per clip with a playable URL, in timeline order. */
  layers: ReadonlyArray<PreviewLayerSource>;
  registerVideo: (key: string, el: HTMLVideoElement | null) => void;
  registerCanvas: (el: HTMLCanvasElement | null) => void;
  /** One per audio clip with a playable URL, keyed by the clip's id. */
  audioLayers: ReadonlyArray<PreviewLayerSource>;
  registerAudio: (clipId: string, el: HTMLAudioElement | null) => void;
  /** The control row, under the frame. */
  children: ReactNode;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  // An edit project has no node: its clips come from its media, added through the media pane or Add media
  const inEdit = useStitchEditorStore((s) => s.editId !== null);

  // Measured by observation, not getBoundingClientRect: the dialog opens with a scale transform. Before the first
  // paint, so the frame never shows at the stage's full width
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setBox({ width: stage.clientWidth, height: stage.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const layout = stageLayout(box, aspect);
  const frameStyle: CSSProperties = layout
    ? { width: layout.frame.width, height: layout.frame.height }
    : { width: "100%", aspectRatio: aspect };

  return (
    <div ref={stageRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center">
      <div
        data-testid="stitch-stage-column"
        className="flex flex-col items-center"
        style={layout ? { width: layout.row } : { width: "100%" }}
      >
        {empty ? (
          <div
            className="flex shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-edit-line bg-editor-well px-10 text-center"
            style={frameStyle}
          >
            <Film size={22} strokeWidth={1.5} className="text-neutral-600" aria-hidden="true" />
            <p className="mt-1 text-[13px] font-medium text-neutral-300">No clips yet</p>
            <p className="max-w-[320px] text-xs leading-4 text-ink-3">
              {inEdit
                ? "Click a video in the library to add it at the playhead, or drag it onto the timeline."
                : "Connect videos to the node's inputs on the canvas. They line up here in socket order."}
            </p>
          </div>
        ) : (
          <div data-testid="stitch-preview" className="relative shrink-0 overflow-hidden rounded-lg bg-black" style={frameStyle}>
            {layers.map((layer) => (
              <PreviewVideo key={layer.key} layerKey={layer.key} src={layer.src} registerVideo={registerVideo} />
            ))}
            <canvas
              ref={registerCanvas}
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
            />
          </div>
        )}
        <div className="mt-2 w-full">{children}</div>
      </div>
      {/* Keyed by its clip and URL: a new source is a new element, which the playback starts afresh */}
      {audioLayers.map((layer) => (
        <PreviewAudio key={`${layer.key}\n${layer.src}`} clipId={layer.key} src={layer.src} registerAudio={registerAudio} />
      ))}
    </div>
  );
}
