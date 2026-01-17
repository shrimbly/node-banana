/**
 * Image Analysis Utilities
 *
 * Functions for analyzing image properties like dimensions, brightness,
 * dominant color, grayscale detection, and transparency.
 * Used by ConditionalBranchNode for routing decisions.
 */

import { ImagePropertyType } from "@/types";

/**
 * Result of analyzing all properties of an image
 */
export interface ImageAnalysisResult {
  width: number;
  height: number;
  aspect_ratio: number;
  brightness: number; // 0-100, percentage of max brightness
  dominant_color: string; // Hex color string
  is_grayscale: boolean;
  has_transparency: boolean;
}

/**
 * Loads an image from a base64 data URL and returns image dimensions
 */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

/**
 * Gets image data from a loaded image
 */
function getImageData(img: HTMLImageElement): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get 2D context");
  }
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/**
 * Calculates the average brightness of an image (0-100)
 * Uses perceived brightness formula: 0.299*R + 0.587*G + 0.114*B
 */
function calculateBrightness(imageData: ImageData): number {
  const data = imageData.data;
  let totalBrightness = 0;
  const pixelCount = data.length / 4;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Perceived brightness formula
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
    totalBrightness += brightness;
  }

  // Return as percentage (0-100)
  return Math.round((totalBrightness / pixelCount / 255) * 100);
}

/**
 * Finds the dominant color in an image using color quantization
 * Returns a hex color string
 */
function findDominantColor(imageData: ImageData): string {
  const data = imageData.data;
  const colorCounts: Record<string, number> = {};

  // Sample every 4th pixel for performance
  for (let i = 0; i < data.length; i += 16) {
    const r = Math.round(data[i] / 32) * 32;
    const g = Math.round(data[i + 1] / 32) * 32;
    const b = Math.round(data[i + 2] / 32) * 32;
    const key = `${r},${g},${b}`;
    colorCounts[key] = (colorCounts[key] || 0) + 1;
  }

  // Find the most common color
  let maxCount = 0;
  let dominantKey = "0,0,0";
  for (const [key, count] of Object.entries(colorCounts)) {
    if (count > maxCount) {
      maxCount = count;
      dominantKey = key;
    }
  }

  const [r, g, b] = dominantKey.split(",").map(Number);
  return rgbToHex(r, g, b);
}

/**
 * Converts RGB values to hex color string
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Checks if an image is grayscale
 * An image is considered grayscale if R, G, B values are similar for all pixels
 */
function checkGrayscale(imageData: ImageData): boolean {
  const data = imageData.data;
  const threshold = 10; // Allow small variations

  // Sample every 4th pixel for performance
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Check if R, G, B are similar
    if (
      Math.abs(r - g) > threshold ||
      Math.abs(r - b) > threshold ||
      Math.abs(g - b) > threshold
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Checks if an image has any transparent pixels
 */
function checkTransparency(imageData: ImageData): boolean {
  const data = imageData.data;

  // Check every 4th pixel (alpha channel)
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] < 255) {
      return true;
    }
  }

  return false;
}

/**
 * Analyzes all properties of an image from a base64 data URL
 */
export async function analyzeImage(
  dataUrl: string
): Promise<ImageAnalysisResult> {
  const img = await loadImage(dataUrl);
  const imageData = getImageData(img);

  const width = img.width;
  const height = img.height;
  const aspectRatio = Math.round((width / height) * 100) / 100;

  return {
    width,
    height,
    aspect_ratio: aspectRatio,
    brightness: calculateBrightness(imageData),
    dominant_color: findDominantColor(imageData),
    is_grayscale: checkGrayscale(imageData),
    has_transparency: checkTransparency(imageData),
  };
}

/**
 * Gets a single property value from an image
 */
export async function getImageProperty(
  dataUrl: string,
  property: ImagePropertyType
): Promise<string | number | boolean> {
  const analysis = await analyzeImage(dataUrl);
  return analysis[property];
}

/**
 * Named color mapping for common colors (used for "contains" operator)
 */
const COLOR_NAMES: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  white: [255, 255, 255],
  black: [0, 0, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
};

/**
 * Checks if a hex color is similar to a named color
 */
export function colorMatches(
  hexColor: string,
  colorName: string,
  tolerance = 80
): boolean {
  const lowerName = colorName.toLowerCase();
  const targetColor = COLOR_NAMES[lowerName];

  if (!targetColor) {
    // If not a named color, try to parse as hex
    if (colorName.startsWith("#")) {
      const targetHex = colorName.slice(1);
      const targetR = parseInt(targetHex.slice(0, 2), 16);
      const targetG = parseInt(targetHex.slice(2, 4), 16);
      const targetB = parseInt(targetHex.slice(4, 6), 16);
      return colorDistance(hexColor, [targetR, targetG, targetB]) < tolerance;
    }
    return false;
  }

  return colorDistance(hexColor, targetColor) < tolerance;
}

/**
 * Calculates the Euclidean distance between a hex color and an RGB tuple
 */
function colorDistance(
  hexColor: string,
  targetRgb: [number, number, number]
): number {
  const hex = hexColor.slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  return Math.sqrt(
    Math.pow(r - targetRgb[0], 2) +
      Math.pow(g - targetRgb[1], 2) +
      Math.pow(b - targetRgb[2], 2)
  );
}
