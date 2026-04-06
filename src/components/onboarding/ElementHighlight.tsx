"use client";

import { useEffect, useState, useRef } from "react";

interface ElementHighlightProps {
  selector: string;
  onComplete?: () => void;
}

interface ElementRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Highlights a UI element with a pulsing blue ring and dims everything else.
 * Creates three layers: dimmed overlay, pulsing blue ring, and clickable window.
 */
export function ElementHighlight({ selector, onComplete }: ElementHighlightProps) {
  const [rect, setRect] = useState<ElementRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementRef = useRef<Element | null>(null);

  const updateRect = () => {
    const element = document.querySelector(selector);
    if (element) {
      const bounds = element.getBoundingClientRect();
      setRect({
        top: bounds.top,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      });
      elementRef.current = element;
    } else {
      setRect(null);
      elementRef.current = null;
    }
  };

  useEffect(() => {
    // Initial measurement
    updateRect();

    // Update on resize
    const handleResize = () => updateRect();
    window.addEventListener("resize", handleResize);

    // Update on scroll
    const handleScroll = () => updateRect();
    window.addEventListener("scroll", handleScroll, true);

    // ResizeObserver for element size changes
    if (typeof ResizeObserver !== "undefined") {
      observerRef.current = new ResizeObserver(() => updateRect());
      const element = document.querySelector(selector);
      if (element) {
        observerRef.current.observe(element);
      }
    }

    // Periodic check for element appearing/disappearing
    const intervalId = setInterval(updateRect, 500);

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      clearInterval(intervalId);
    };
  }, [selector]);

  if (!rect) {
    return null;
  }

  return (
    <>
      {/* Pulsing blue ring highlight (no darkening overlay) */}
      <div
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
    </>
  );
}
