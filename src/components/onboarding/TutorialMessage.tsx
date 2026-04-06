"use client";

import { useTypewriter } from "@/hooks/useTypewriter";

interface TutorialMessageProps {
  message: string;
}

/**
 * Displays tutorial message with typewriter animation.
 * Positioned at center of screen for maximum visibility.
 */
export function TutorialMessage({ message }: TutorialMessageProps) {
  const { displayedText } = useTypewriter(message, 50);

  return (
    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md px-6 py-4 bg-neutral-800/95 backdrop-blur rounded-lg shadow-xl transition-opacity duration-300 opacity-100">
      <p className="text-neutral-100 text-base leading-relaxed">{displayedText}</p>
    </div>
  );
}
