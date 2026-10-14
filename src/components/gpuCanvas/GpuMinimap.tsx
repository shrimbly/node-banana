"use client";

/**
 * The navigator's minimap on the GPU canvas: React Flow's MiniMap draws the
 * nodes in its store, which here are only the live ones, so this one draws
 * every node from the scene graph on a 2D canvas, with the same colours,
 * mask and gestures (drag pans, wheel zooms, a click centres the view).
 */
import { useEffect, useRef } from "react";
import { MIN_ZOOM, MAX_ZOOM } from "@/lib/gpuCanvas/scene";
import { useGpuCanvasBridge } from "./bridge";

interface GpuMinimapProps {
  width: number;
  height: number;
  className?: string;
  bgColor: string;
  maskColor: string;
  maskStrokeColor: string;
  /** Takes no gestures (the locked tutorial), as classic's inert navigator. */
  disabled?: boolean;
}

/** Flow units on either side of the nodes and view, as React Flow's MiniMap pads them. */
const OFFSET_SCALE = 5;
/** React Flow's isMacOs, which its minimap's pinch factor reads. */
const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

export function GpuMinimap({ width, height, className, bgColor, maskColor, maskStrokeColor, disabled = false }: GpuMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  const bridge = useGpuCanvasBridge();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bridge) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    // Flow → minimap: the transform the last draw used, for the gestures.
    let fit = { scale: 1, x: 0, y: 0 };
    const draw = () => {
      frame = 0;
      const dpr = devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
      if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
      const graph = bridge.graph(), view = bridge.view(), size = bridge.size();
      const viewRect = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: size.width / view.zoom, h: size.height / view.zoom };
      const bounds = graph.bounds();
      let minX = viewRect.x, minY = viewRect.y, maxX = viewRect.x + viewRect.w, maxY = viewRect.y + viewRect.h;
      if (bounds) {
        minX = Math.min(minX, bounds.minX); minY = Math.min(minY, bounds.minY);
        maxX = Math.max(maxX, bounds.maxX); maxY = Math.max(maxY, bounds.maxY);
      }
      const pad = OFFSET_SCALE * (Math.max((maxX - minX) / width, (maxY - minY) / height) || 1);
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const scale = Math.max((maxX - minX) / width, (maxY - minY) / height) || 1;
      const x0 = minX - (width * scale - (maxX - minX)) / 2, y0 = minY - (height * scale - (maxY - minY)) / 2;
      const s = 1 / scale;
      fit = { scale: s, x: x0, y: y0 };
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Transparent, as classic's svg: the well's background and inset shadow show through from the wrapper.
      context.clearRect(0, 0, width, height);
      for (const n of graph.nodes) {
        context.fillStyle = `rgb(${n.color[0] * 255},${n.color[1] * 255},${n.color[2] * 255})`;
        const w = Math.max(1, n.w * s), h = Math.max(1, n.h * s);
        context.beginPath();
        context.roundRect((n.x - x0) * s, (n.y - y0) * s, w, h, Math.min(5 * s, w / 2, h / 2));
        context.fill();
      }
      // The mask: everything but the view darkened, and the view outlined.
      const vx = (viewRect.x - x0) * s, vy = (viewRect.y - y0) * s, vw = viewRect.w * s, vh = viewRect.h * s;
      context.fillStyle = maskColor;
      context.beginPath();
      context.rect(0, 0, width, height);
      context.rect(vx, vy, vw, vh);
      context.fill("evenodd");
      context.strokeStyle = maskStrokeColor;
      context.lineWidth = 1;
      context.strokeRect(vx + 0.5, vy + 0.5, vw - 1, vh - 1);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(draw); };
    const unsubscribe = bridge.subscribe(schedule);
    schedule();

    // A drag moves the view with the pointer (in minimap units); a click glides it to centre there.
    const toFlow = (event: MouseEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: (event.clientX - box.left) / fit.scale + fit.x, y: (event.clientY - box.top) / fit.scale + fit.y };
    };
    // The view follows from the first move, as React Flow's minimap pans; past 3px the release is no click.
    let drag: { x: number; y: number; startX: number; startY: number; moved: boolean } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || disabledRef.current) return;
      canvas.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false };
    };
    const move = (event: PointerEvent) => {
      if (disabledRef.current) drag = null;
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!dx && !dy) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 3) drag.moved = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      const view = bridge.view();
      bridge.setView({ x: view.x - (dx / fit.scale) * view.zoom, y: view.y - (dy / fit.scale) * view.zoom });
    };
    const up = (event: PointerEvent) => {
      const wasClick = drag && !drag.moved && !disabledRef.current;
      drag = null;
      if (!wasClick) return;
      const p = toFlow(event), view = bridge.view(), size = bridge.size();
      // Glides there as the navigator's setCenter does on today's canvas.
      bridge.animateView({ zoom: view.zoom, x: size.width / 2 - p.x * view.zoom, y: size.height / 2 - p.y * view.zoom }, 250);
    };
    // A press the browser cancels (or whose capture is lost) ends the drag, so hovering after it pans nothing.
    const cancel = () => { drag = null; };
    const wheel = (event: WheelEvent) => {
      if (disabledRef.current) return;
      // The minimap's zoom is the wheel's only move, as d3-zoom's noevent on classic's: the scene and the
      // canvas's own wheel listeners (ancestors) must not pan or step-zoom the view on top of it.
      event.preventDefault();
      event.stopImmediatePropagation();
      const view = bridge.view(), size = bridge.size();
      // React Flow's minimap step: by line, page or pixel deltas, ten times a Mac pinch's (Ctrl) deltas.
      const step = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
      const factor = event.ctrlKey && isMac ? 10 : 1;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * Math.pow(2, -event.deltaY * step * factor)));
      // Zoom about the middle of the view, as React Flow's minimap does.
      const cx = (size.width / 2 - view.x) / view.zoom, cy = (size.height / 2 - view.y) / view.zoom;
      bridge.setView({ zoom, x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom });
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("lostpointercapture", cancel);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", cancel);
      canvas.removeEventListener("wheel", wheel);
    };
  }, [bridge, width, height, maskColor, maskStrokeColor]);

  // The wrapper is React Flow's minimap panel: the classes, the background and the label go on it.
  return (
    <div className={className} style={{ width, height, background: bgColor }} role="img" aria-label="Mini Map">
      <canvas ref={canvasRef} style={{ width, height, display: "block" }} data-testid="gpu-minimap" />
    </div>
  );
}
