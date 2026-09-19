"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface CubicBezierEditorProps {
  value: [number, number, number, number];
  onChange: (value: [number, number, number, number]) => void;
  onCommit?: (value: [number, number, number, number]) => void;
  disabled?: boolean;
  /** SVG polyline points string (in 0–100 coordinate space) for the actual easing curve overlay */
  easingCurve?: string;
  /** Extra classes on the framed box, e.g. to cap its size. */
  className?: string;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

// Hardcoded dark-theme palette matching easy-peasy-ease color scheme
const palette = {
  background: "#0f1720",      // dark navy (easy-peasy-ease bg tint)
  border: "rgba(255,255,255,0.12)",
  muted: "rgba(255,255,255,0.35)",
  primary: "#bef264",         // lime-300 (easy-peasy-ease primary)
};

const now = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export function CubicBezierEditor({
  value,
  onChange,
  onCommit,
  disabled = false,
  easingCurve,
  className,
}: CubicBezierEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef(value);
  const draggingHandleRef = useRef<"p1" | "p2" | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<"p1" | "p2" | null>(null);
  const commitFrameRef = useRef<number | null>(null);
  const pendingValueRef = useRef<{
    value: [number, number, number, number];
    capturedAt: number;
  } | null>(null);

  const [v0, v1, v2, v3] = value;

  // Sync valueRef with prop values (used by drag handlers)
  useEffect(() => {
    valueRef.current = value;
  }, [v0, v1, v2, v3]); // eslint-disable-line react-hooks/exhaustive-deps

  const flushPendingChange = useCallback(() => {
    commitFrameRef.current = null;
    if (!pendingValueRef.current) return;
    const { value: nextValue } = pendingValueRef.current;
    onChange(nextValue);
    pendingValueRef.current = null;
  }, [onChange]);

  const scheduleCommit = useCallback(() => {
    if (commitFrameRef.current !== null) return;
    commitFrameRef.current = window.requestAnimationFrame(flushPendingChange);
  }, [flushPendingChange]);

  useEffect(() => {
    return () => {
      if (commitFrameRef.current !== null) {
        cancelAnimationFrame(commitFrameRef.current);
      }
    };
  }, []);

  const updateHandleFromClient = useCallback(
    (handle: "p1" | "p2", clientX: number, clientY: number) => {
      const container = editorRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const width = rect.width || 260;
      const height = rect.height || 260;
      const normalizedX = clamp((clientX - rect.left) / width);
      const normalizedY = clamp(1 - (clientY - rect.top) / height);
      const current = valueRef.current;
      const nextValue: [number, number, number, number] =
        handle === "p1"
          ? [normalizedX, normalizedY, current[2], current[3]]
          : [current[0], current[1], normalizedX, normalizedY];
      pendingValueRef.current = {
        value: nextValue,
        capturedAt: now(),
      };
      valueRef.current = nextValue;
      scheduleCommit();
    },
    [scheduleCommit]
  );

  const startDragging = useCallback(
    (handle: "p1" | "p2", event: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      event.preventDefault();
      draggingHandleRef.current = handle;
      setDraggingHandle(handle);
      updateHandleFromClient(handle, event.clientX, event.clientY);
    },
    [disabled, updateHandleFromClient]
  );

  // Window-level pointer listeners for smooth drag across entire viewport
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const handle = draggingHandleRef.current;
      if (!handle || disabled) return;
      event.preventDefault();
      updateHandleFromClient(handle, event.clientX, event.clientY);
    };

    const stopDragging = () => {
      if (!draggingHandleRef.current) return;
      draggingHandleRef.current = null;
      setDraggingHandle(null);
      if (onCommit) {
        onCommit(valueRef.current);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [disabled, onCommit, updateHandleFromClient]);

  const controlStyles = useMemo(
    () => ({
      p1: {
        left: `${(v0 * 100).toFixed(2)}%`,
        top: `${((1 - v1) * 100).toFixed(2)}%`,
      },
      p2: {
        left: `${(v2 * 100).toFixed(2)}%`,
        top: `${((1 - v3) * 100).toFixed(2)}%`,
      },
    }),
    [v0, v1, v2, v3]
  );

  const svgPoints = useMemo(
    () => ({
      start: { x: 0, y: 100 },
      end: { x: 100, y: 0 },
      c1: { x: v0 * 100, y: (1 - v1) * 100 },
      c2: { x: v2 * 100, y: (1 - v3) * 100 },
    }),
    [v0, v1, v2, v3]
  );

  const curvePath = useMemo(
    () =>
      `M${svgPoints.start.x} ${svgPoints.start.y} C ${svgPoints.c1.x} ${svgPoints.c1.y}, ${svgPoints.c2.x} ${svgPoints.c2.y}, ${svgPoints.end.x} ${svgPoints.end.y}`,
    [svgPoints]
  );

  return (
    <div className={`bg-neutral-900/50 rounded-lg border border-neutral-700 p-2${className ? ` ${className}` : ""}`}>
      <div ref={editorRef} className="relative w-full aspect-square">
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full select-none"
          aria-hidden="true"
        >
          <rect
            x="0"
            y="0"
            width="100"
            height="100"
            fill={palette.background}
            stroke={palette.border}
            strokeWidth="0.8"
            rx="2"
          />
          {/* Grid lines */}
          <g stroke={palette.border} strokeWidth="0.4" strokeOpacity="0.6">
            <line x1="0" y1="50" x2="100" y2="50" />
            <line x1="50" y1="0" x2="50" y2="100" />
          </g>
          {/* Diagonal reference line */}
          <line
            x1="0"
            y1="100"
            x2="100"
            y2="0"
            stroke={palette.border}
            strokeWidth="0.6"
            strokeDasharray="4 4"
            strokeOpacity="0.7"
          />
          {/* Control point lines */}
          <g stroke={palette.muted} strokeWidth="0.8">
            <line x1="0" y1="100" x2={svgPoints.c1.x} y2={svgPoints.c1.y} />
            <line x1="100" y1="0" x2={svgPoints.c2.x} y2={svgPoints.c2.y} />
          </g>
          {/* Bezier curve — dimmed when easing overlay is active */}
          <path
            d={curvePath}
            fill="none"
            stroke={easingCurve ? palette.muted : palette.primary}
            strokeWidth={easingCurve ? "0.8" : "1.5"}
            strokeLinecap="round"
            strokeDasharray={easingCurve ? "3 2" : undefined}
          />
          {/* Actual easing function curve overlay */}
          {easingCurve && (
            <polyline
              points={easingCurve}
              fill="none"
              stroke={palette.primary}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
        {/* Control point 1 - nodrag nopan touch-none prevents React Flow node dragging */}
        <button
          type="button"
          aria-label="Adjust control point 1"
          className={`nodrag nopan absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border border-neutral-900/80 bg-lime-300/80 shadow transition active:cursor-grabbing active:scale-95 disabled:cursor-not-allowed disabled:pointer-events-none touch-none ${
            draggingHandle === "p1" ? "ring-2 ring-lime-300/80" : ""
          }`}
          style={controlStyles.p1}
          onPointerDown={(event) => startDragging("p1", event)}
          disabled={disabled}
        />
        {/* Control point 2 - nodrag nopan touch-none prevents React Flow node dragging */}
        <button
          type="button"
          aria-label="Adjust control point 2"
          className={`nodrag nopan absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border border-neutral-900/80 bg-lime-300/80 shadow transition active:cursor-grabbing active:scale-95 disabled:cursor-not-allowed disabled:pointer-events-none touch-none ${
            draggingHandle === "p2" ? "ring-2 ring-lime-300/80" : ""
          }`}
          style={controlStyles.p2}
          onPointerDown={(event) => startDragging("p2", event)}
          disabled={disabled}
        />
      </div>
    </div>
  );
}
