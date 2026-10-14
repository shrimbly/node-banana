"use client";

import { useEffect, useState, useRef } from "react";
import { gpuCanvasBridge, shownNodeElement } from "@/components/gpuCanvas/bridge";
import { createLiveProbe, type LiveProbe } from "./liveProbe";

interface ElementHighlightProps {
  selector: string | string[]; // Support single or multiple selectors
  onComplete?: () => void;
}

interface ElementRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The GPU canvas painter's sheet: hidden copies of nodes, laid out to be painted, never shown. */
const SHEET = "[data-gpu-canvas-sheet]";

/** The first element matching the selector that the page shows (not a painted copy's). */
function shownElement(selector: string): Element | null {
  for (const element of document.querySelectorAll(selector)) if (!element.closest(SHEET)) return element;
  return null;
}

/** On the GPU canvas, the node whose painted copy alone holds a match: it is held live, so a real element shows. */
function paintedNodeId(selector: string): string | null {
  for (const element of document.querySelectorAll(selector)) {
    const id = element.closest(SHEET) && element.closest(".react-flow__node")?.getAttribute("data-id");
    if (id) return id;
  }
  return null;
}

/**
 * Highlights one or more UI elements with pulsing blue rings.
 * Supports single selector string or array of selectors.
 */
export function ElementHighlight({ selector, onComplete }: ElementHighlightProps) {
  const [rects, setRects] = useState<ElementRect[]>([]);
  const observersRef = useRef<ResizeObserver[]>([]);
  const heldRef = useRef(new Map<string, () => void>());
  const probeRef = useRef<LiveProbe | null>(null);

  const updateRects = () => {
    const selectors = Array.isArray(selector) ? selector : [selector];
    const newRects: ElementRect[] = [];
    const missing: string[] = [];

    selectors.forEach((sel) => {
      const element = shownElement(sel);
      const painted = element ? null : paintedNodeId(sel);
      const bridge = painted && !heldRef.current.has(painted) ? gpuCanvasBridge() : null;
      if (painted && bridge) heldRef.current.set(painted, bridge.holdLive([painted]).release);
      if (!element && !painted) missing.push(sel);
      if (element) {
        const bounds = element.getBoundingClientRect();
        newRects.push({
          top: bounds.top,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
        });
      }
    });

    // On the GPU canvas, a node painted earlier (or from the disk cache) has no copy on the sheet either:
    // look inside the graph's nodes by holding them live (liveProbe).
    const bridge = gpuCanvasBridge(), probe = probeRef.current;
    if (bridge && probe) probe.update(bridge, selectors, missing, () => { if (probeRef.current === probe) updateRects(); });
    setRects(newRects);
  };

  useEffect(() => {
    const probe = createLiveProbe(shownNodeElement);
    probeRef.current = probe;
    // Initial measurement
    updateRects();

    // Update on resize
    const handleResize = () => updateRects();
    window.addEventListener("resize", handleResize);

    // Update on scroll
    const handleScroll = () => updateRects();
    window.addEventListener("scroll", handleScroll, true);

    // ResizeObserver for element size changes
    if (typeof ResizeObserver !== "undefined") {
      const selectors = Array.isArray(selector) ? selector : [selector];

      // Clean up previous observers
      observersRef.current.forEach(observer => observer.disconnect());
      observersRef.current = [];

      selectors.forEach((sel) => {
        const element = shownElement(sel);
        if (element) {
          const observer = new ResizeObserver(() => updateRects());
          observer.observe(element);
          observersRef.current.push(observer);
        }
      });
    }

    // Periodic check for element appearing/disappearing
    const intervalId = setInterval(updateRects, 500);
    const held = heldRef.current;

    return () => {
      for (const release of held.values()) release();
      held.clear();
      probe.dispose();
      if (probeRef.current === probe) probeRef.current = null;
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
      observersRef.current.forEach(observer => observer.disconnect());
      observersRef.current = [];
      clearInterval(intervalId);
    };
  }, [selector]);

  if (rects.length === 0) {
    return null;
  }

  return (
    <>
      {rects.map((rect, index) => (
        <div
          key={index}
          className="fixed pointer-events-none"
          style={{
            top: rect.top - 4,
            left: rect.left - 4,
            width: rect.width + 8,
            height: rect.height + 8,
            zIndex: 101,
            border: "2px solid rgb(59, 130, 246)",
            borderRadius: "8px",
            boxShadow: "0 0 8px rgba(59, 130, 246, 0.3)",
            animation: "pulse-ring 2s infinite",
          }}
        />
      ))}
    </>
  );
}
