import { useState, useEffect } from "react";

interface UseTypewriterResult {
  displayedText: string;
  isComplete: boolean;
}

/**
 * Typewriter animation hook that displays text character by character.
 *
 * @param text - The full text to display
 * @param speed - Milliseconds per character (default: 50ms)
 * @returns Object with displayedText (current partial text) and isComplete (true when done)
 */
export function useTypewriter(text: string, speed: number = 50): UseTypewriterResult {
  const [displayedText, setDisplayedText] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    // Reset when text changes
    setDisplayedText("");
    setCurrentIndex(0);
  }, [text]);

  useEffect(() => {
    if (currentIndex >= text.length) {
      return; // Animation complete
    }

    const timer = setInterval(() => {
      setCurrentIndex((prevIndex) => {
        const nextIndex = prevIndex + 1;
        if (nextIndex <= text.length) {
          setDisplayedText(text.slice(0, nextIndex));
        }
        if (nextIndex >= text.length) {
          clearInterval(timer);
        }
        return nextIndex;
      });
    }, speed);

    return () => clearInterval(timer);
  }, [text, speed, currentIndex]);

  return {
    displayedText,
    isComplete: currentIndex >= text.length,
  };
}
