"use client";

import { useTypewriter } from "@/hooks/useTypewriter";

interface TutorialMessageProps {
  message: string;
}

/**
 * Displays tutorial message with typewriter animation.
 * Positioned absolutely for contextual placement near highlighted elements.
 */
export function TutorialMessage({ message }: TutorialMessageProps) {
  const { displayedText } = useTypewriter(message, 50);

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-md px-6 py-4 bg-neutral-800/95 backdrop-blur rounded-lg shadow-xl transition-opacity duration-300 opacity-100">
      <p className="text-neutral-100 text-base leading-relaxed">{displayedText}</p>
    </div>
  );
}
