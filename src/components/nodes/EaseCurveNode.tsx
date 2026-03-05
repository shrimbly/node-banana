"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, NodeProps, Node, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { EaseCurveNodeData } from "@/types";
import { checkEncoderSupport } from "@/hooks/useStitchVideos";
import { useVideoBlobUrl } from "@/hooks/useVideoBlobUrl";
import { CubicBezierEditor } from "@/components/CubicBezierEditor";
import {
  EASING_PRESETS,
  getPresetBezier,
  getEasingBezier,
} from "@/lib/easing-presets";
import { getAllEasingNames, getEasingFunction } from "@/lib/easing-functions";

type EaseCurveNodeType = Node<EaseCurveNodeData, "easeCurve">;

// Generate SVG polyline points by sampling an easing function
function generateEasingPolyline(
  easingName: string,
  width: number,
  height: number,
  samples: number = 20
): string {
  const fn = getEasingFunction(easingName);
  return Array.from({ length: samples + 1 }, (_, i) => {
    const t = i / samples;
    const y = fn(t);
    return `${(t * width).toFixed(1)},${((1 - y) * height).toFixed(1)}`;
  }).join(" ");
}

// Categorize easing names into presets (with Bezier handles) and others (polyline only)
const ALL_EASING_NAMES = getAllEasingNames();
const PRESET_NAMES = new Set(EASING_PRESETS);

export function EaseCurveNode({ id, data, selected }: NodeProps<EaseCurveNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const edges = useWorkflowStore((state) => state.edges);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const { setNodes } = useReactFlow();
  const videoBlobUrl = useVideoBlobUrl(nodeData.outputVideo ?? null);

  const [activeTab, setActiveTab] = useState<"editor" | "video">("editor");
  const [showPresets, setShowPresets] = useState(false);
  const presetsButtonRef = useRef<HTMLButtonElement>(null);
  const presetsPopoverRef = useRef<HTMLDivElement>(null);
  const [presetsPosition, setPresetsPosition] = useState<{ top: number; left: number } | null>(null);

  // Auto-resize node height when switching tabs
  const EDITOR_HEIGHT = 480;
  const VIDEO_HEIGHT = 320;
  const switchTab = useCallback((tab: "editor" | "video") => {
    setActiveTab(tab);
    const height = tab === "editor" ? EDITOR_HEIGHT : VIDEO_HEIGHT;
    setNodes((nodes) =>
      nodes.map((n) =>
        n.id === id ? { ...n, style: { ...n.style, height } } : n
      )
    );
  }, [id, setNodes]);

  // Auto-switch to Video tab when processing completes
  const prevOutputRef = useRef(nodeData.outputVideo);
  useEffect(() => {
    if (!prevOutputRef.current && nodeData.outputVideo) {
      switchTab("video");
    }
    prevOutputRef.current = nodeData.outputVideo;
  }, [nodeData.outputVideo, switchTab]);

  // Check encoder support on mount
  useEffect(() => {
    if (nodeData.encoderSupported === null) {
      checkEncoderSupport().then((supported) => {
        updateNodeData(id, { encoderSupported: supported });
      });
    }
  }, [id, nodeData.encoderSupported, updateNodeData]);

  // Position the presets popover above the button and track it
  useEffect(() => {
    if (!showPresets || !presetsButtonRef.current) {
      setPresetsPosition(null);
      return;
    }

    const updatePosition = () => {
      if (presetsButtonRef.current) {
        const rect = presetsButtonRef.current.getBoundingClientRect();
        setPresetsPosition({
          top: rect.top,
          left: rect.right,
        });
      }
    };

    updatePosition();

    let animationId: number;
    const trackPosition = () => {
      updatePosition();
      animationId = requestAnimationFrame(trackPosition);
    };
    animationId = requestAnimationFrame(trackPosition);

    return () => cancelAnimationFrame(animationId);
  }, [showPresets]);

  // Close presets popover on click outside or Escape
  useEffect(() => {
    if (!showPresets) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        presetsButtonRef.current && !presetsButtonRef.current.contains(target) &&
        presetsPopoverRef.current && !presetsPopoverRef.current.contains(target)
      ) {
        setShowPresets(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowPresets(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showPresets]);

  const handleBezierChange = useCallback(
    (value: [number, number, number, number]) => {
      updateNodeData(id, { bezierHandles: value, easingPreset: null });
    },
    [id, updateNodeData]
  );

  const handleBezierCommit = useCallback(
    (value: [number, number, number, number]) => {
      updateNodeData(id, { bezierHandles: value, easingPreset: null });
    },
    [id, updateNodeData]
  );

  const handleSelectPreset = useCallback(
    (name: string) => {
      updateNodeData(id, {
        easingPreset: name,
        bezierHandles: getPresetBezier(name),
      });
      setShowPresets(false);
    },
    [id, updateNodeData]
  );

  const handleSelectEasing = useCallback(
    (name: string) => {
      updateNodeData(id, {
        easingPreset: name,
        bezierHandles: getEasingBezier(name),
      });
      setShowPresets(false);
    },
    [id, updateNodeData]
  );

  const handleDurationChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseFloat(e.target.value);
      updateNodeData(id, { outputDuration: isNaN(val) ? 1.5 : Math.max(0.1, Math.min(30, val)) });
    },
    [id, updateNodeData]
  );

  const handleRun = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  // Check if this node has an incoming easeCurve connection (inheritance)
  const inheritedEdge = useMemo(() => {
    return edges.find((e) => e.target === id && e.targetHandle === "easeCurve") || null;
  }, [edges, id]);
  const isInherited = inheritedEdge !== null;

  // Default to video tab when inherited
  useEffect(() => {
    if (isInherited) {
      switchTab("video");
    }
  }, [isInherited, switchTab]);

  const handleBreakInheritance = useCallback(() => {
    if (inheritedEdge) {
      removeEdge(inheritedEdge.id);
      updateNodeData(id, { inheritedFrom: null });
    }
  }, [inheritedEdge, removeEdge, id, updateNodeData]);

  // Compute easing curve polyline for the editor overlay (higher sample count than thumbnails)
  const editorEasingCurve = useMemo(() => {
    if (!nodeData.easingPreset) return undefined;
    return generateEasingPolyline(nodeData.easingPreset, 100, 100, 50);
  }, [nodeData.easingPreset]);

  // Memoize the preset thumbnail SVGs
  const presetThumbnails = useMemo(() => {
    return ALL_EASING_NAMES.map((name) => ({
      name,
      polyline: generateEasingPolyline(name, 36, 36),
      isPreset: PRESET_NAMES.has(name as any),
    }));
  }, []);

  // Shared handles rendered in ALL states (4 handles with labels)
  const renderHandles = () => (
    <>
      {/* Video In (target, left, 35%) */}
      <Handle
        type="target"
        position={Position.Left}
        id="video"
        data-handletype="video"
        isConnectable={true}
        style={{ top: "35%" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{ right: "calc(100% + 8px)", top: "calc(35% - 7px)", color: "rgb(168, 85, 247)" }}
      >
        Video In
      </div>

      {/* Video Out (source, right, 35%) */}
      <Handle
        type="source"
        position={Position.Right}
        id="video"
        data-handletype="video"
        isConnectable={true}
        style={{ top: "35%" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{ left: "calc(100% + 8px)", top: "calc(35% - 7px)", color: "rgb(168, 85, 247)" }}
      >
        Video Out
      </div>

      {/* Settings In (target, left, 75%) */}
      <Handle
        type="target"
        position={Position.Left}
        id="easeCurve"
        data-handletype="easeCurve"
        isConnectable={true}
        style={{ top: "75%", background: "rgb(190, 242, 100)" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none text-right"
        style={{ right: "calc(100% + 8px)", top: "calc(75% - 7px)", color: "rgb(190, 242, 100)" }}
      >
        Settings
      </div>

      {/* Settings Out (source, right, 75%) */}
      <Handle
        type="source"
        position={Position.Right}
        id="easeCurve"
        data-handletype="easeCurve"
        isConnectable={true}
        style={{ top: "75%", background: "rgb(190, 242, 100)" }}
      />
      <div
        className="absolute text-[10px] font-medium whitespace-nowrap pointer-events-none"
        style={{ left: "calc(100% + 8px)", top: "calc(75% - 7px)", color: "rgb(190, 242, 100)" }}
      >
        Settings
      </div>
    </>
  );

  // Encoder not supported
  if (nodeData.encoderSupported === false) {
    return (
      <BaseNode
        id={id}
        selected={selected}
        minWidth={340}
        minHeight={480}
      >
        {renderHandles()}
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center px-4">
          <svg className="w-8 h-8 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span className="text-xs text-neutral-400">
            Your browser doesn&apos;t support video encoding.
          </span>
          <a
            href="https://discord.com/invite/89Nr6EKkTf"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-blue-400 hover:text-blue-300 underline"
          >
            Doesn&apos;t seem right? Message Willie on Discord.
          </a>
        </div>
      </BaseNode>
    );
  }

  // Checking encoder state
  if (nodeData.encoderSupported === null) {
    return (
      <BaseNode
        id={id}
        selected={selected}
        minWidth={340}
        minHeight={480}
      >
        {renderHandles()}
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-neutral-400">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-xs">Checking encoder...</span>
          </div>
        </div>
      </BaseNode>
    );
  }

  return (
    <BaseNode
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      minWidth={340}
      minHeight={VIDEO_HEIGHT}
    >
      {renderHandles()}

      <div className="flex-1 flex flex-col min-h-0 gap-2">
        {/* Tab bar */}
        <div className="flex border-b border-neutral-700">
          <button
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === "editor"
                ? "text-lime-300 border-b-2 border-lime-300"
                : "text-neutral-400 hover:text-neutral-300"
            }`}
            onClick={() => switchTab("editor")}
          >
            Editor
          </button>
          <button
            className={`px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === "video"
                ? "text-lime-300 border-b-2 border-lime-300"
                : "text-neutral-400 hover:text-neutral-300"
            }`}
            onClick={() => switchTab("video")}
          >
            Video
          </button>
        </div>

        {/* Tab content */}
        {activeTab === "editor" && (
          <div className="flex-1 flex flex-col min-h-0 gap-2 relative">
            {/* Editor controls - dimmed when inherited */}
            <div className={`flex flex-col gap-2 ${isInherited ? "pointer-events-none opacity-40" : ""}`}>
              {/* Bezier curve editor - fixed size, centered */}
              <div className="flex justify-center">
                <div className="w-60">
                  <CubicBezierEditor
                    value={nodeData.bezierHandles}
                    onChange={handleBezierChange}
                    onCommit={handleBezierCommit}
                    disabled={nodeData.status === "loading" || isInherited}
                    easingCurve={editorEasingCurve}
                  />
                </div>
              </div>

              {/* Preset label */}
              {nodeData.easingPreset && (
                <div className="text-center">
                  <span className="text-[10px] text-lime-300/70 font-medium">
                    {nodeData.easingPreset}
                  </span>
                </div>
              )}

              {/* Controls row: Duration + Presets button */}
              <div className="flex items-center gap-2 px-2">
                <label className="text-[10px] text-neutral-400 whitespace-nowrap">Duration</label>
                <input
                  type="number"
                  min="0.1"
                  max="30"
                  step="0.1"
                  value={nodeData.outputDuration}
                  onChange={handleDurationChange}
                  className="nodrag w-16 px-1.5 py-1 bg-neutral-800 border border-neutral-600 rounded text-xs text-neutral-200 text-center"
                />
                <span className="text-[10px] text-neutral-500">sec</span>

                {/* Presets button */}
                <div className="ml-auto">
                  <button
                    ref={presetsButtonRef}
                    className="nodrag nopan px-2 py-1 bg-neutral-800 hover:bg-neutral-700 border border-neutral-600 rounded text-xs text-neutral-300 transition-colors flex items-center gap-1 disabled:opacity-40 disabled:pointer-events-none"
                    onClick={() => setShowPresets(!showPresets)}
                    disabled={isInherited}
                  >
                    {/* Curve icon */}
                    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M2 14 C 6 14, 4 2, 14 2" strokeLinecap="round" />
                    </svg>
                    <span>Presets</span>
                  </button>
                </div>

              </div>

              {/* Apply button */}
              <div className="flex justify-end px-2">
                <button
                  className="nodrag nopan px-3 py-1.5 bg-lime-300/15 hover:bg-lime-300/25 border border-lime-300/30 rounded text-xs text-lime-300 font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none"
                  onClick={handleRun}
                  disabled={isRunning || nodeData.status === "loading" || isInherited}
                >
                  Apply
                </button>
              </div>
            </div>

            {/* Inheritance overlay */}
            {isInherited && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-neutral-900/80 backdrop-blur-sm rounded z-10">
                <p className="text-sm text-neutral-200 font-medium">Settings inherited from parent node</p>
                <p className="text-[11px] text-neutral-400 mt-1">Break connection to edit manually</p>
                <button
                  className="mt-3 px-3 py-1.5 bg-white/10 hover:bg-white/20 border border-white/20 rounded text-xs text-neutral-200 transition-colors"
                  onClick={handleBreakInheritance}
                >
                  Control manually
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === "video" && (
          <div className="flex-1 flex flex-col min-h-0">
            {nodeData.outputVideo ? (
              <div className="relative flex-1 min-h-0">
                <video
                  src={videoBlobUrl ?? undefined}
                  controls
                  autoPlay
                  loop
                  muted
                  className="absolute inset-0 w-full h-full object-contain rounded"
                  playsInline
                />
                <button
                  onClick={() => updateNodeData(id, { outputVideo: null, status: "idle" })}
                  className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                  title="Clear video"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center border border-dashed border-neutral-600 rounded">
                <span className="text-[10px] text-neutral-500">Run workflow to apply ease curve</span>
              </div>
            )}
          </div>
        )}

        {/* Processing overlay */}
        {nodeData.status === "loading" && (
          <div className="absolute inset-0 bg-neutral-900/70 rounded flex flex-col items-center justify-center gap-2">
            <svg className="w-6 h-6 animate-spin text-white" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-white text-xs">Processing... {Math.round(nodeData.progress)}%</span>
          </div>
        )}

        {/* Error display */}
        {nodeData.status === "error" && nodeData.error && (
          <div className="px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
            <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
          </div>
        )}
      </div>

      {/* Presets popover - rendered via portal to avoid clipping */}
      {showPresets && presetsPosition && createPortal(
        <div
          ref={presetsPopoverRef}
          className="fixed z-[9999] w-[280px] bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-2 nowheel"
          style={{
            top: presetsPosition.top,
            left: presetsPosition.left,
            transform: "translateY(-100%) translateX(-100%)",
          }}
        >
          {/* Preset Bezier thumbnails (top section) */}
          <div className="mb-2">
            <div className="text-[9px] text-neutral-500 uppercase tracking-wider mb-1 px-1">
              Bezier Presets
            </div>
            <div className="grid grid-cols-5 gap-1">
              {EASING_PRESETS.map((name) => {
                const thumb = presetThumbnails.find((t) => t.name === name);
                const isActive = nodeData.easingPreset === name;
                return (
                  <button
                    key={name}
                    className={`flex flex-col items-center gap-0.5 p-1 rounded transition-colors ${
                      isActive
                        ? "bg-lime-300/20 border border-lime-300/40"
                        : "hover:bg-neutral-700 border border-transparent"
                    }`}
                    onClick={() => handleSelectPreset(name)}
                    title={name}
                  >
                    <svg width="40" height="40" viewBox="-2 -2 40 40" className="flex-shrink-0">
                      <rect x="-2" y="-2" width="40" height="40" fill="transparent" />
                      <line x1="0" y1="36" x2="36" y2="0" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" strokeDasharray="2 2" />
                      {thumb && (
                        <polyline
                          points={thumb.polyline}
                          fill="none"
                          stroke={isActive ? "#bef264" : "rgba(255,255,255,0.5)"}
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      )}
                    </svg>
                    <span className="text-[7px] text-neutral-400 truncate w-full text-center leading-none">
                      {name.replace(/^ease/, "")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* All easing functions (scrollable grid) */}
          <div className="border-t border-neutral-700 pt-2">
            <div className="text-[9px] text-neutral-500 uppercase tracking-wider mb-1 px-1">
              All Easing Functions
            </div>
            <div className="grid grid-cols-5 gap-1 max-h-[200px] overflow-y-auto nowheel">
              {presetThumbnails.map(({ name, polyline }) => {
                const isActive = nodeData.easingPreset === name;
                return (
                  <button
                    key={name}
                    className={`flex flex-col items-center gap-0.5 p-1 rounded transition-colors ${
                      isActive
                        ? "bg-lime-300/20 border border-lime-300/40"
                        : "hover:bg-neutral-700 border border-transparent"
                    }`}
                    onClick={() => handleSelectEasing(name)}
                    title={name}
                  >
                    <svg width="40" height="40" viewBox="-2 -2 40 40" className="flex-shrink-0">
                      <rect x="-2" y="-2" width="40" height="40" fill="transparent" />
                      <line x1="0" y1="36" x2="36" y2="0" stroke="rgba(255,255,255,0.1)" strokeWidth="0.5" strokeDasharray="2 2" />
                      <polyline
                        points={polyline}
                        fill="none"
                        stroke={isActive ? "#bef264" : "rgba(255,255,255,0.5)"}
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span className="text-[7px] text-neutral-400 truncate w-full text-center leading-none">
                      {name.replace(/^ease/, "")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>,
        document.body
      )}
    </BaseNode>
  );
}
