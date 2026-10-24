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
  const nodesRef = useRef<HTMLCanvasElement>(null);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    disabledRef.current = disabled;
  }, [disabled]);
  const bridge = useGpuCanvasBridge();

  useEffect(() => {
    const canvas = canvasRef.current, nodesCanvas = nodesRef.current;
    if (!canvas || !nodesCanvas || !bridge) return;
    const context = canvas.getContext("2d"), nodesContext = nodesCanvas.getContext("2d");
    if (!context || !nodesContext) return;
    let frame = 0;
    // Flow → minimap: the transform the last draw used, for the gestures.
    let fit = { scale: 1, x: 0, y: 0 };
    // The nodes sit on a canvas of their own, drawn again only when they or the fit move: a pan within the
    // graph moves only the mask, and redrawing thousands of nodes a frame kept the GPU from the scene.
    // A view reaching past the graph (zoomed out, or the fit view's spare width) moves the fit every frame:
    // the nodes are drawn once at the graph's own fit (`graphCanvas`) and that picture is scaled down into place.
    const graphCanvas = document.createElement("canvas"), graphContext = graphCanvas.getContext("2d");
    let graphKey = "", graphStale = true, layoutChanged = true, nodesKey = "";
    const fitTo = (minX: number, minY: number, maxX: number, maxY: number) => {
      const pad = OFFSET_SCALE * (Math.max((maxX - minX) / width, (maxY - minY) / height) || 1);
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const scale = Math.max((maxX - minX) / width, (maxY - minY) / height) || 1;
      return { scale: 1 / scale, x: minX - (width * scale - (maxX - minX)) / 2, y: minY - (height * scale - (maxY - minY)) / 2 };
    };
    const drawNodes = (target: CanvasRenderingContext2D, at: { scale: number; x: number; y: number }, dpr: number) => {
      const graph = bridge.graph(), s = at.scale;
      target.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Transparent, as classic's svg: the well's background and inset shadow show through from the wrapper.
      target.clearRect(0, 0, width, height);
      // One fill per colour.
      const paths = new Map<string, Path2D>();
      for (const n of graph.nodes) {
        const color = `rgb(${n.color[0] * 255},${n.color[1] * 255},${n.color[2] * 255})`;
        let path = paths.get(color);
        if (!path) paths.set(color, path = new Path2D());
        const w = Math.max(1, n.w * s), h = Math.max(1, n.h * s), x = (n.x - at.x) * s, y = (n.y - at.y) * s;
        path.roundRect(x, y, w, h, Math.min(5 * s, w / 2, h / 2));
      }
      for (const [color, path] of paths) {
        target.fillStyle = color;
        target.fill(path);
      }
    };
    const draw = () => {
      frame = 0;
      const dpr = devicePixelRatio || 1;
      for (const c of [canvas, nodesCanvas, graphCanvas]) {
        if (c.width !== Math.round(width * dpr)) c.width = Math.round(width * dpr);
        if (c.height !== Math.round(height * dpr)) c.height = Math.round(height * dpr);
      }
      const graph = bridge.graph(), view = bridge.view(), size = bridge.size();
      const viewRect = { x: -view.x / view.zoom, y: -view.y / view.zoom, w: size.width / view.zoom, h: size.height / view.zoom };
      const bounds = graph.bounds();
      fit = bounds
        ? fitTo(Math.min(viewRect.x, bounds.minX), Math.min(viewRect.y, bounds.minY), Math.max(viewRect.x + viewRect.w, bounds.maxX), Math.max(viewRect.y + viewRect.h, bounds.maxY))
        : fitTo(viewRect.x, viewRect.y, viewRect.x + viewRect.w, viewRect.y + viewRect.h);
      const s = fit.scale, x0 = fit.x, y0 = fit.y;
      const key = `${s} ${x0} ${y0} ${nodesCanvas.width} ${nodesCanvas.height}`;
      if (layoutChanged || key !== nodesKey) {
        nodesKey = key;
        const own = bounds ? fitTo(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY) : fit;
        const ownKey = `${own.scale} ${own.x} ${own.y} ${graphCanvas.width} ${graphCanvas.height}`;
        if (!graphContext || own.scale === s && own.x === x0 && own.y === y0) drawNodes(nodesContext, fit, dpr);
        else {
          if (graphStale || ownKey !== graphKey) drawNodes(graphContext, own, dpr);
          graphKey = ownKey;
          graphStale = false;
          // The graph's picture at the wider fit: never larger than drawn, since this fit holds the graph's.
          const k = s / own.scale;
          nodesContext.setTransform(1, 0, 0, 1, 0, 0);
          nodesContext.clearRect(0, 0, nodesCanvas.width, nodesCanvas.height);
          nodesContext.imageSmoothingQuality = "medium";
          nodesContext.drawImage(graphCanvas, (own.x - x0) * s * dpr, (own.y - y0) * s * dpr, graphCanvas.width * k, graphCanvas.height * k);
        }
        layoutChanged = false;
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);
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
    const schedule = (layout = false) => {
      if (layout) layoutChanged = graphStale = true;
      if (!frame) frame = requestAnimationFrame(draw);
    };
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
    <div className={className} style={{ width, height, background: bgColor, position: "relative" }} role="img" aria-label="Mini Map">
      <canvas ref={nodesRef} style={{ width, height, display: "block", position: "absolute", inset: 0 }} />
      <canvas ref={canvasRef} style={{ width, height, display: "block", position: "relative" }} data-testid="gpu-minimap" />
    </div>
  );
}
