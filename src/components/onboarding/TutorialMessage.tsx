"use client";

import { useTypewriter } from "@/hooks/useTypewriter";

interface TutorialLink {
  text: string;
  url: string;
}

interface TutorialMessageProps {
  message: string;
  position?: "left" | "right" | "center" | "top-center";
  waitForClick?: boolean;
  links?: TutorialLink[];
}

/**
 * Displays tutorial message with typewriter animation.
 * Positioned based on the position prop (left, right, center, or top-center).
 */
export function TutorialMessage({ message, position = "center", waitForClick = false, links }: TutorialMessageProps) {
  const { displayedText } = useTypewriter(message, 25);

  const positionClasses = {
    left: "left-8 top-1/2 -translate-y-1/2",
    right: "right-8 top-1/2 -translate-y-1/2",
    center: "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
    "top-center": "top-20 left-1/2 -translate-x-1/2",
  };

  return (
    <div className={`absolute ${positionClasses[position]} max-w-sm px-6 py-4 bg-neutral-800/95 backdrop-blur rounded-lg shadow-xl transition-opacity duration-300 opacity-100 pointer-events-auto`}>
      <p className="text-neutral-100 text-base leading-relaxed text-center whitespace-pre-line">{displayedText}</p>
      {links && links.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {links.map((link, index) => (
            <a
              key={index}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:text-blue-300 underline text-center transition-colors"
            >
              {link.text}
            </a>
          ))}
        </div>
      )}
      {waitForClick && (
        <p className="mt-3 text-xs text-neutral-400 text-center italic">
          Click anywhere to continue
        </p>
      )}
    </div>
  );
}
