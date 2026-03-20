/**
 * Resolve image variable references (@varName) in prompt text.
 *
 * Splits prompt text around @varName references that correspond to named images,
 * producing an interleaved array of text and image parts for multimodal API requests.
 *
 * Text @variables are left as-is (they should already be resolved by the caller).
 */

import type { PromptPart } from "@/types";

/**
 * Check if a prompt text contains any @varName references that match named images.
 */
export function hasImageVarReferences(
  text: string,
  namedImages: Record<string, string>
): boolean {
  const pattern = /@(\w+)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (namedImages[match[1]]) return true;
  }
  return false;
}

/**
 * Split prompt text into multimodal parts, replacing @varName with image parts
 * where varName matches a key in namedImages.
 *
 * Non-image @variables are kept as literal text (they should already be resolved).
 *
 * @returns Array of PromptPart with interleaved text and image entries
 */
export function resolveImageVars(
  text: string,
  namedImages: Record<string, string>
): PromptPart[] {
  const pattern = /@(\w+)/g;
  const parts: PromptPart[] = [];
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const varName = match[1];
    const imageValue = namedImages[varName];

    if (!imageValue) continue; // Not an image variable, skip

    // Add text before this image reference
    if (match.index > lastIndex) {
      const textBefore = text.slice(lastIndex, match.index).trim();
      if (textBefore) {
        parts.push({ type: "text", value: textBefore });
      }
    }

    // Add the image part
    parts.push({ type: "image", name: varName, value: imageValue });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last image reference
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex).trim();
    if (remaining) {
      parts.push({ type: "text", value: remaining });
    }
  }

  // If no image vars were found, return single text part
  if (parts.length === 0) {
    return [{ type: "text", value: text }];
  }

  return parts;
}
