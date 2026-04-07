"use client";

import { useEffect, useState, useRef } from "react";

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

/**
 * Highlights one or more UI elements with pulsing blue rings.
 * Supports single selector string or array of selectors.
 */
export function ElementHighlight({ selector, onComplete }: ElementHighlightProps) {
  const [rects, setRects] = useState<ElementRect[]>([]);
  const observersRef = useRef<ResizeObserver[]>([]);

  const updateRects = () => {
    const selectors = Array.isArray(selector) ? selector : [selector];
    const newRects: ElementRect[] = [];

    selectors.forEach((sel) => {
      const element = document.querySelector(sel);
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

    setRects(newRects);
  };

  useEffect(() => {
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
        const element = document.querySelector(sel);
        if (element) {
          const observer = new ResizeObserver(() => updateRects());
          observer.observe(element);
          observersRef.current.push(observer);
        }
      });
    }

    // Periodic check for element appearing/disappearing
    const intervalId = setInterval(updateRects, 500);

    return () => {
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
