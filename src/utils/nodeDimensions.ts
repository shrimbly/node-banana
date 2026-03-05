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
    if (!base64DataUrl || !base64DataUrl.startsWith("data:image")) {
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
