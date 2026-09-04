/**
 * Utility functions for calculating node dimensions based on output aspect ratio.
 */

/**
 * Extract dimensions from a base64 data URL image.
 * @param base64DataUrl - The image as a base64 data URL (e.g., "data:image/png;base64,...")
 * @returns Promise resolving to {width, height} or null if extraction fails
 */
export function getImageDimensions(
  base64DataUrl: string
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!base64DataUrl || (!base64DataUrl.startsWith("data:image") && !base64DataUrl.startsWith("http"))) {
      resolve(null);
      return;
    }

    let resolved = false;
    const img = new Image();
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      img.src = "";
    };
    const safeResolve = (value: { width: number; height: number } | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    const timeout = setTimeout(() => safeResolve(null), 10_000);

    img.onload = () => {
      clearTimeout(timeout);
      safeResolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      clearTimeout(timeout);
      safeResolve(null);
    };
    img.src = base64DataUrl;
  });
}

/**
 * Extract dimensions from a video data URL or blob URL.
 * @param videoUrl - The video as a data URL or blob URL
 * @returns Promise resolving to {width, height} or null if extraction fails
 */
export function getVideoDimensions(
  videoUrl: string
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!videoUrl) {
      resolve(null);
      return;
    }

    let resolved = false;
    const video = document.createElement("video");
    video.preload = "metadata";

    const cleanup = () => {
      video.onloadedmetadata = null;
      video.onerror = null;
      video.src = "";
      video.load();
    };

    const safeResolve = (value: { width: number; height: number } | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    const timeout = setTimeout(() => safeResolve(null), 10_000);

    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      safeResolve({ width: video.videoWidth, height: video.videoHeight });
    };
    video.onerror = () => {
      clearTimeout(timeout);
      safeResolve(null);
    };
    video.src = videoUrl;
  });
}

/**
 * Detect media type from URL and return dimensions using the appropriate loader.
 * Handles data:image/*, data:video/*, blob:*, and http(s) URLs.
 */
export function getMediaDimensions(
  url: string | null | undefined
): Promise<{ width: number; height: number } | null> {
  if (!url) return Promise.resolve(null);

  if (url.startsWith("data:image")) {
    return getImageDimensions(url);
  }

  // data:video/* → always video
  if (url.startsWith("data:video")) {
    return getVideoDimensions(url);
  }

  // blob:* → treat as video (most common use case)
  if (url.startsWith("blob:")) {
    return getVideoDimensions(url);
  }

  // http(s) URLs → check pathname for image extensions before defaulting to video
  if (url.startsWith("http")) {
    try {
      const pathname = new URL(url).pathname.toLowerCase();
      if (/\.(jpe?g|png|gif|webp|bmp|svg|avif|ico)(\?|$)/.test(pathname)) {
        return getImageDimensions(url);
      }
    } catch {
      // Invalid URL, fall through to video
    }
    return getVideoDimensions(url);
  }

  return Promise.resolve(null);
}

/**
 * Calculate a node size that matches the given aspect ratio, preferring to grow.
 * No min/max clamping — the node sizes freely to fit the content.
 *
 * @param aspectRatio - content width / content height
 * @param currentWidth - the node's current width
 * @param currentHeight - the node's current height
 * @param fullBleed - if true, skip chrome height offset
 * @returns {width, height} that preserves the aspect ratio at the larger-area candidate
 */
export function calculateAspectFitSize(
  aspectRatio: number,
  currentWidth: number,
  currentHeight: number,
  fullBleed: boolean = false
): { width: number; height: number } {
  if (!aspectRatio || aspectRatio <= 0 || !isFinite(aspectRatio)) {
    return { width: currentWidth, height: currentHeight };
  }

  const chromeHeight = fullBleed ? 0 : NODE_CHROME_HEIGHT;

  // Candidate A: keep current width, adjust height
  const heightA = currentWidth / aspectRatio + chromeHeight;
  const areaA = currentWidth * heightA;

  // Candidate B: keep current height, adjust width
  const widthB = (currentHeight - chromeHeight) * aspectRatio;
  const areaB = widthB * currentHeight;

  if (areaA >= areaB) {
    return { width: Math.round(currentWidth), height: Math.round(heightA) };
  }
  return { width: Math.round(widthB), height: Math.round(currentHeight) };
}

// Node sizing constraints
const MIN_WIDTH = 200;
const MAX_WIDTH = 500;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 600;

// Node chrome: header (~40px), controls/padding (~60px)
const NODE_CHROME_HEIGHT = 100;

/**
 * Calculate node dimensions that maintain aspect ratio within constraints.
 * @param aspectRatio - Width divided by height (e.g., 16/9 for landscape, 9/16 for portrait)
 * @param baseWidth - Starting width to calculate from (default 300px)
 * @returns {width, height} dimensions that fit within constraints
 */
export function calculateNodeSize(
  aspectRatio: number,
  baseWidth: number = 300
): { width: number; height: number } {
  // Handle invalid aspect ratios
  if (!aspectRatio || aspectRatio <= 0 || !isFinite(aspectRatio)) {
    return { width: 300, height: 300 }; // Return default square
  }

  // Start with base width and calculate content height
  let width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, baseWidth));

  // Calculate content area height based on aspect ratio
  // Content height = width / aspectRatio
  let contentHeight = width / aspectRatio;
  let totalHeight = contentHeight + NODE_CHROME_HEIGHT;

  // Check if height exceeds max - if so, scale down width to fit
  if (totalHeight > MAX_HEIGHT) {
    contentHeight = MAX_HEIGHT - NODE_CHROME_HEIGHT;
    width = contentHeight * aspectRatio;
    totalHeight = MAX_HEIGHT;
  }

  // Check if height is below min - if so, scale up width to fit
  if (totalHeight < MIN_HEIGHT) {
    contentHeight = MIN_HEIGHT - NODE_CHROME_HEIGHT;
    width = contentHeight * aspectRatio;
    totalHeight = MIN_HEIGHT;
  }

  // Clamp width to constraints
  if (width > MAX_WIDTH) {
    width = MAX_WIDTH;
    contentHeight = width / aspectRatio;
    totalHeight = contentHeight + NODE_CHROME_HEIGHT;
    // Re-clamp height
    totalHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, totalHeight));
  }

  if (width < MIN_WIDTH) {
    width = MIN_WIDTH;
    contentHeight = width / aspectRatio;
    totalHeight = contentHeight + NODE_CHROME_HEIGHT;
    // Re-clamp height
    totalHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, totalHeight));
  }

  return {
    width: Math.round(width),
    height: Math.round(totalHeight),
  };
}

/**
 * Calculate node dimensions while preserving the user's manually set height.
 * When a user manually resizes a node, we should maintain their height preference
 * and only adjust the width to match the new content's aspect ratio.
 *
 * @param aspectRatio - Width divided by height of the content
 * @param currentHeight - The node's current height (if manually set)
 * @param skipChromeOffset - If true, skip subtracting NODE_CHROME_HEIGHT (for full-bleed nodes with floating headers)
 * @returns {width, height} dimensions that preserve height when possible
 */
export function calculateNodeSizePreservingHeight(
  aspectRatio: number,
  currentHeight?: number,
  skipChromeOffset: boolean = false
): { width: number; height: number } {
  // Handle invalid aspect ratios
  if (!aspectRatio || aspectRatio <= 0 || !isFinite(aspectRatio)) {
    return { width: 300, height: 300 };
  }

  // No current height or below minimum = use default behavior
  if (!currentHeight || currentHeight < MIN_HEIGHT) {
    return skipChromeOffset ? calculateNodeSizeForFullBleed(aspectRatio) : calculateNodeSize(aspectRatio);
  }

  // Preserve height, calculate width to maintain aspect ratio
  const chromeHeight = skipChromeOffset ? 0 : NODE_CHROME_HEIGHT;
  const contentHeight = currentHeight - chromeHeight;
  let newWidth = contentHeight * aspectRatio;

  // Clamp width to constraints
  newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));

  return {
    width: Math.round(newWidth),
    height: Math.round(currentHeight),
  };
}

/**
 * Calculate node dimensions for full-bleed content (no header chrome).
 * Used by nodes with floating headers where content fills the entire node area.
 *
 * @param aspectRatio - Width divided by height (e.g., 16/9 for landscape, 9/16 for portrait)
 * @param currentHeight - Optional current height to preserve (if manually resized)
 * @returns {width, height} dimensions that fit within constraints
 */
export function calculateNodeSizeForFullBleed(
  aspectRatio: number,
  currentHeight?: number
): { width: number; height: number } {
  // Handle invalid aspect ratios
  if (!aspectRatio || aspectRatio <= 0 || !isFinite(aspectRatio)) {
    return { width: 300, height: 300 }; // Return default square
  }

  // If preserving height, calculate width
  if (currentHeight && currentHeight >= MIN_HEIGHT) {
    let width = currentHeight * aspectRatio;
    width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
    return {
      width: Math.round(width),
      height: Math.round(currentHeight),
    };
  }

  // Start with base width and calculate height
  let width = 300; // Default starting width
  let height = width / aspectRatio;

  // Check if height exceeds max - if so, scale down width to fit
  if (height > MAX_HEIGHT) {
    height = MAX_HEIGHT;
    width = height * aspectRatio;
  }

  // Check if height is below min - if so, scale up width to fit
  if (height < MIN_HEIGHT) {
    height = MIN_HEIGHT;
    width = height * aspectRatio;
  }

  // Clamp width to constraints
  if (width > MAX_WIDTH) {
    width = MAX_WIDTH;
    height = width / aspectRatio;
    // Re-clamp height
    height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));
  }

  if (width < MIN_WIDTH) {
    width = MIN_WIDTH;
    height = width / aspectRatio;
    // Re-clamp height
    height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height));
  }

  return {
    width: Math.round(width),
    height: Math.round(height),
  };
}

/* ------------------------------------------------------------------------ */
/* Redesigned node geometry                                                 */
/*                                                                          */
/* Nodes are width-driven: the media card takes the node's width, its       */
/* height follows the media's aspect ratio, and the gap row and controls    */
/* card stack beneath. Everything here is pure so the store, the canvas     */
/* and the shell agree on one set of numbers.                               */
/* ------------------------------------------------------------------------ */

import type { Node } from "@xyflow/react";
import { defaultNodeDimensions } from "@/store/utils/nodeDefaults";
import type { NodeType } from "@/types";
import {
  CARD_PAD,
  GAP_ROW_H,
  NODE_MAX_W,
  NODE_MIN_W,
  socketMinHeight,
} from "@/components/nodes/ui/tokens";

/** Border + padding on one side of the media card. */
export const CARD_EDGE = CARD_PAD + 1;

/**
 * "16:9" → 16/9. Accepts "16:9", "16/9", "16x9", a bare number, or a
 * numeric string; returns `fallback` (1) for anything unparsable.
 */
export function parseAspectRatio(value: string | number | null | undefined, fallback = 1): number {
  if (typeof value === "number") return value > 0 && Number.isFinite(value) ? value : fallback;
  if (!value) return fallback;
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)$/i);
  if (match) {
    const w = parseFloat(match[1]);
    const h = parseFloat(match[2]);
    return w > 0 && h > 0 ? w / h : fallback;
  }
  const n = parseFloat(trimmed);
  return n > 0 && Number.isFinite(n) ? n : fallback;
}

export function clampNodeWidth(width: number, min = NODE_MIN_W, max = NODE_MAX_W): number {
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.max(min, Math.min(max, width)));
}

/**
 * The size a node occupies on the canvas.
 *
 * Width prefers what the node was told to be (`width`, then `style.width`)
 * because that is newer than the last measurement right after a resize.
 * Height prefers the measurement, because under the redesign height is
 * derived from content and the stored value only mirrors it.
 */
export function getNodeSize(node: Node): { width: number; height: number } {
  const defaults = defaultNodeDimensions[node.type as NodeType] ?? { width: 300, height: 280 };
  const styleW = typeof node.style?.width === "number" ? node.style.width : undefined;
  const styleH = typeof node.style?.height === "number" ? node.style.height : undefined;
  const width = node.width ?? styleW ?? node.measured?.width ?? defaults.width;
  const height = node.measured?.height ?? node.height ?? styleH ?? defaults.height;
  return { width, height };
}

export type ShellMedia =
  | { kind: "aspect"; aspect: number }
  | { kind: "fixed"; height: number }
  /** Content-sized (logic nodes laid out in rows at the socket pitch). */
  | { kind: "auto" };

export interface ShellLayoutInput {
  /** Node width. */
  width: number;
  media: ShellMedia;
  inputs?: number;
  outputs?: number;
  /** Whether a gap row (history nav / scrubber) is shown. */
  gap?: boolean;
  /** Measured height of the controls card, 0 when there is none. */
  controlsH?: number;
}

export interface ShellLayout {
  /** Height of the media clip inside the card. */
  mediaH: number;
  /** Height of the media card including border and padding. */
  cardH: number;
  gapH: number;
  controlsH: number;
  /** Total node height. */
  height: number;
}

/**
 * Derive every vertical measurement of a node from its width and content.
 * The card never gets shorter than its sockets need.
 */
export function computeShellLayout({
  width,
  media,
  inputs = 0,
  outputs = 0,
  gap = false,
  controlsH = 0,
}: ShellLayoutInput): ShellLayout {
  const clipW = Math.max(0, width - 2 * CARD_EDGE);
  const mediaH =
    media.kind === "aspect"
      ? Math.round(clipW / (media.aspect > 0 && Number.isFinite(media.aspect) ? media.aspect : 1))
      : media.kind === "fixed"
        ? Math.round(media.height)
        : 0;
  const cardH = Math.max(mediaH + 2 * CARD_EDGE, socketMinHeight(Math.max(inputs, outputs)));
  const gapH = gap || controlsH > 0 ? GAP_ROW_H : 0;
  return { mediaH, cardH, gapH, controlsH, height: cardH + gapH + controlsH };
}

export function computeShellHeight(input: ShellLayoutInput): number {
  return computeShellLayout(input).height;
}
