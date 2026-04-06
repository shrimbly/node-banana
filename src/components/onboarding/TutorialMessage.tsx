"use client";

import { useTypewriter } from "@/hooks/useTypewriter";

interface TutorialMessageProps {
  message: string;
  position?: "left" | "right" | "center" | "top-center";
  waitForClick?: boolean;
}

/**
 * Displays tutorial message with typewriter animation.
 * Positioned based on the position prop (left, right, center, or top-center).
 */
export function TutorialMessage({ message, position = "center", waitForClick = false }: TutorialMessageProps) {
  const { displayedText } = useTypewriter(message, 25);

  const positionClasses = {
    left: "left-8 top-1/2 -translate-y-1/2",
    right: "right-8 top-1/2 -translate-y-1/2",
    center: "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
    "top-center": "top-20 left-1/2 -translate-x-1/2",
  };

  return (
    <div className={`absolute ${positionClasses[position]} max-w-sm px-6 py-4 bg-neutral-800/95 backdrop-blur rounded-lg shadow-xl transition-opacity duration-300 opacity-100`}>
      <p className="text-neutral-100 text-base leading-relaxed text-center whitespace-pre-line">{displayedText}</p>
      {waitForClick && (
        <p className="mt-3 text-xs text-neutral-400 text-center italic">
          Click anywhere to continue
        </p>
      )}
    </div>
  );
}
