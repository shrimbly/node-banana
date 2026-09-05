"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { EaseCurveNodeData } from "@/types";
import { checkEncoderSupport } from "@/hooks/useStitchVideos";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { useVideoAutoplay } from "@/hooks/useVideoAutoplay";
import { CubicBezierEditor } from "@/components/CubicBezierEditor";
import { EASING_PRESETS, getEasingBezier } from "@/lib/easing-presets";
import { getAllEasingNames, getEasingFunction } from "@/lib/easing-functions";
import {
  ControlsCard,
  EmptyState,
  FieldRow,
  NumberField,
  PanelButton,
  ScrubRow,
  Spinner,
  SummaryValues,
  type SocketSpec,
} from "./ui";

type EaseCurveNodeType = Node<EaseCurveNodeData, "easeCurve">;

const INPUT_SOCKETS: SocketSpec[] = [
  { id: "video", type: "video", label: "Video In" },
  { id: "easeCurve", type: "easeCurve", label: "Settings" },
];
const OUTPUT_SOCKETS: SocketSpec[] = [
  { id: "video", type: "video", label: "Video Out" },
  { id: "easeCurve", type: "easeCurve", label: "Settings" },
];
const EMPTY_HEIGHT = 120;

const ALL_EASING_NAMES = getAllEasingNames();
const PRESET_NAMES = new Set<string>(EASING_PRESETS);

/** Preset thumbnail: the curve's drawn size, and the margin that keeps its
 * stroke and any overshoot (the back/elastic families) inside the box. */
const THUMB = 64;
const THUMB_PAD = 10;

/** SVG polyline points for an easing function's preview. */
function generateEasingPolyline(easingName: string, width: number, height: number, samples = 20): string {
  const fn = getEasingFunction(easingName);
  return Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    const y = fn(t);
    return `${(t * width).toFixed(1)},${((1 - y) * height).toFixed(1)}`;
  }).join(" ");
}

export function EaseCurveNode({ id, data, selected }: NodeProps<EaseCurveNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const edges = useWorkflowStore((state) => state.edges);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);
  const videoAutoplayRef = useVideoAutoplay(id, selected);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [showPresets, setShowPresets] = useState(false);
  const presetsButtonRef = useRef<HTMLButtonElement>(null);
  const presetsPopupRef = useRef<HTMLDivElement>(null);

  // Check encoder support on mount
  useEffect(() => {
    if (nodeData.encoderSupported === null) {
      checkEncoderSupport().then((supported) => {
        updateNodeData(id, { encoderSupported: supported });
      });
    }
  }, [id, nodeData.encoderSupported, updateNodeData]);

  useEffect(() => {
    if (!showPresets) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowPresets(false);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (presetsButtonRef.current?.contains(e.target as HTMLElement)) return;
      if (presetsPopupRef.current?.contains(e.target as HTMLElement)) return;
      setShowPresets(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showPresets]);

  // Settings arriving over the easeCurve socket take over from the editor.
  const inheritedEdge = useMemo(
    () => (edges ?? []).find((e) => e.target === id && e.targetHandle === "easeCurve") || null,
    [edges, id]
  );
  const isInherited = !!inheritedEdge;

  const handleBreakInheritance = useCallback(() => {
    if (inheritedEdge) {
      removeEdge(inheritedEdge.id);
      updateNodeData(id, { inheritedFrom: null });
    }
  }, [inheritedEdge, removeEdge, id, updateNodeData]);

  const handleBezierChange = useCallback(
    (value: [number, number, number, number]) => {
      updateNodeData(id, { bezierHandles: value, easingPreset: null });
    },
    [id, updateNodeData]
  );

  const handleSelectEasing = useCallback(
    (name: string) => {
      updateNodeData(id, { easingPreset: name, bezierHandles: getEasingBezier(name) });
      setShowPresets(false);
    },
    [id, updateNodeData]
  );

  const editorEasingCurve = useMemo(() => {
    if (!nodeData.easingPreset) return undefined;
    return generateEasingPolyline(nodeData.easingPreset, 100, 100, 50);
  }, [nodeData.easingPreset]);

  const presetThumbnails = useMemo(
    () =>
      ALL_EASING_NAMES.map((name) => ({
        name,
        polyline: generateEasingPolyline(name, THUMB, THUMB),
        isPreset: PRESET_NAMES.has(name),
      })),
    []
  );

  const encoderChecking = nodeData.encoderSupported === null;
  const encoderUnsupported = nodeData.encoderSupported === false;
  const duration = nodeData.outputDuration || 1.5;

  const media =
    nodeData.outputVideo && !encoderChecking && !encoderUnsupported
      ? { kind: "aspect" as const, aspect: loadedAspect?.src === nodeData.outputVideo ? loadedAspect.aspect : 16 / 9 }
      : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  const settings = (
    <div className="relative flex flex-col gap-1">
      {isInherited && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-panel/95 rounded-well text-center">
          <p className="text-[11px] text-neutral-200 font-medium">Settings inherited</p>
          <p className="text-node text-neutral-400 mt-0.5">Break connection to edit manually</p>
          <PanelButton className="mt-2" onClick={handleBreakInheritance}>
            Control manually
          </PanelButton>
        </div>
      )}
      <FieldRow className="justify-between">
        <span className="text-node text-neutral-400">Easing function</span>
        <button
          ref={presetsButtonRef}
          type="button"
          onClick={() => setShowPresets(!showPresets)}
          className="nodrag nopan h-[22px] px-2 rounded-well squircle text-node bg-neutral-700 hover:bg-neutral-600 text-neutral-200 transition-colors"
        >
          Presets
        </button>
      </FieldRow>
      <CubicBezierEditor
        value={nodeData.bezierHandles || [0.42, 0, 0.58, 1]}
        onChange={handleBezierChange}
        onCommit={handleBezierChange}
        easingCurve={editorEasingCurve}
      />
      {nodeData.easingPreset && (
        <span className="text-node text-neutral-500">Current: {nodeData.easingPreset}</span>
      )}
      <NumberField
        label="Duration"
        unit="s"
        value={duration}
        min={0.1}
        max={30}
        step={0.1}
        allowEmpty={false}
        onChange={(v) => updateNodeData(id, { outputDuration: v === undefined || Number.isNaN(v) ? 1.5 : v })}
      />
      <FieldRow className="justify-end">
        <PanelButton onClick={() => regenerateNode(id)} disabled={isRunning}>
          {isRunning ? "Applying..." : "Apply"}
        </PanelButton>
      </FieldRow>
    </div>
  );

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        isExecuting={isRunning}
        hasError={nodeData.status === "error"}
        media={media}
        inputs={INPUT_SOCKETS}
        outputs={OUTPUT_SOCKETS}
        minWidth={300}
        mediaClassName="group"
        gap={
          nodeData.outputVideo && !encoderChecking && !encoderUnsupported ? (
            <ScrubRow videoRef={videoAutoplayRef} src={videoBlobUrl} className="w-full" />
          ) : undefined
        }
        controls={
          <ControlsCard
            id={id}
            summary={{
              title: "Ease curve",
              values: <SummaryValues items={[nodeData.easingPreset ?? "custom", `${duration.toFixed(1)}s`]} />,
            }}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          >
            {settings}
          </ControlsCard>
        }
      >
        {encoderUnsupported ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4 bg-neutral-900/40">
            <svg className="w-8 h-8 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            <span className="text-xs text-neutral-400">Your browser doesn&apos;t support video encoding.</span>
            <a
              href="https://discord.com/invite/89Nr6EKkTf"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-blue-400 hover:text-blue-300 underline"
            >
              Doesn&apos;t seem right? Message Willie on Discord.
            </a>
          </div>
        ) : encoderChecking ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-neutral-400 bg-neutral-900/40">
            <Spinner />
            <span className="text-xs">Checking encoder...</span>
          </div>
        ) : nodeData.outputVideo ? (
          <>
            <video
              ref={videoAutoplayRef}
              src={videoBlobUrl ?? undefined}
              loop
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-cover"
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0 && nodeData.outputVideo) {
                  setLoadedAspect({ src: nodeData.outputVideo, aspect: v.videoWidth / v.videoHeight });
                }
              }}
            />
            <button
              onClick={() => updateNodeData(id, { outputVideo: null, status: "idle" })}
              className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
              title="Clear video"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </>
        ) : (
          <EmptyState message="Run workflow to apply ease curve" />
        )}

        {!encoderChecking && !encoderUnsupported && nodeData.status === "loading" && (
          <div className="absolute inset-0 bg-neutral-900/70 flex flex-col items-center justify-center gap-2">
            <Spinner size={24} className="text-white" />
            <span className="text-white text-xs">Processing... {Math.round(nodeData.progress)}%</span>
          </div>
        )}

        {!encoderChecking && !encoderUnsupported && nodeData.status === "error" && nodeData.error && (
          <div className="absolute bottom-2 left-2 right-2 px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
            <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
          </div>
        )}
      </NodeShell>

      {showPresets &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={presetsPopupRef}
            className="fixed z-[100] bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-2 max-h-[60vh] overflow-y-auto nowheel"
            style={{
              top: presetsButtonRef.current?.getBoundingClientRect().bottom || 0,
              right: window.innerWidth - (presetsButtonRef.current?.getBoundingClientRect().right || 0),
              width: 480,
            }}
          >
            <div className="grid grid-cols-4 gap-1.5">
              {presetThumbnails.map(({ name, polyline }) => (
                <button
                  key={name}
                  onClick={() => handleSelectEasing(name)}
                  className="nodrag nopan aspect-square p-2 bg-neutral-900 hover:bg-neutral-700 rounded flex flex-col items-center justify-between transition-colors"
                  title={name}
                >
                  <svg
                    className="flex-1 min-h-0 w-full"
                    viewBox={`${-THUMB_PAD} ${-THUMB_PAD} ${THUMB + THUMB_PAD * 2} ${THUMB + THUMB_PAD * 2}`}
                    preserveAspectRatio="xMidYMid meet"
                    overflow="visible"
                  >
                    <polyline points={polyline} fill="none" stroke="#a3a3a3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="text-[11px] text-neutral-300 text-center whitespace-nowrap overflow-hidden text-ellipsis w-full shrink-0">{name}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
