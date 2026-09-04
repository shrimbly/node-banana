import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's default scale, so a theme token it
 * has not heard of is guessed from its prefix: `text-node` reads as a text
 * colour and gets dropped the moment a real colour follows it. Declare the
 * tokens from globals.css so they merge by what they are.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["node"] }],
      rounded: [{ rounded: ["card", "media", "controls", "well"] }],
      shadow: [{ shadow: ["well"] }],
    },
  },
});

/** Merge class names, letting later Tailwind utilities win over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
