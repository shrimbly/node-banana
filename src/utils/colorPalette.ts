/**
 * Color Palette Utilities
 *
 * Provides functions for extracting dominant colors from images
 * and applying color palettes to transform images.
 */

import { PaletteColor } from "@/types";

/**
 * RGB color representation
 */
interface RGB {
  r: number;
  g: number;
  b: number;
}

/**
 * Convert RGB to hex string
 */
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (c: number) => {
    const hex = Math.round(Math.max(0, Math.min(255, c))).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

/**
 * Convert hex string to RGB
 */
export function hexToRgb(hex: string): RGB {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16),
  };
}

/**
 * Calculate Euclidean distance between two RGB colors
 */
function colorDistance(c1: RGB, c2: RGB): number {
  return Math.sqrt(
    Math.pow(c1.r - c2.r, 2) +
    Math.pow(c1.g - c2.g, 2) +
    Math.pow(c1.b - c2.b, 2)
  );
}

/**
 * Calculate luminance of an RGB color (0-255)
 */
function getLuminance(color: RGB): number {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b;
}

/**
 * Get approximate color name based on RGB values
 */
function getColorName(color: RGB): string {
  const { r, g, b } = color;
  const lum = getLuminance(color);

  // Check for grayscale
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && Math.abs(r - b) < 20) {
    if (lum < 30) return "Black";
    if (lum < 100) return "Dark Gray";
    if (lum < 180) return "Gray";
    if (lum < 230) return "Light Gray";
    return "White";
  }

  // Determine dominant hue
  const max = Math.max(r, g, b);
  const isReddish = r === max && r > g && r > b;
  const isGreenish = g === max && g > r && g > b;
  const isBlueish = b === max && b > r && b > g;

  // Check for secondary colors
  const isYellow = r > 180 && g > 180 && b < 100;
  const isCyan = g > 150 && b > 150 && r < 100;
  const isMagenta = r > 150 && b > 150 && g < 100;
  const isOrange = r > 200 && g > 100 && g < 180 && b < 100;
  const isPink = r > 200 && b > 150 && g < 180;
  const isPurple = r > 100 && b > 150 && g < 100;
  const isBrown = r > 100 && r < 200 && g > 50 && g < 150 && b < 100;

  if (isYellow) return lum > 200 ? "Light Yellow" : "Yellow";
  if (isOrange) return "Orange";
  if (isCyan) return lum > 180 ? "Light Cyan" : "Cyan";
  if (isMagenta) return "Magenta";
  if (isPink) return "Pink";
  if (isPurple) return lum > 150 ? "Light Purple" : "Purple";
  if (isBrown) return "Brown";

  if (isReddish) {
    if (lum < 80) return "Dark Red";
    if (lum > 180) return "Light Red";
    return "Red";
  }

  if (isGreenish) {
    if (lum < 80) return "Dark Green";
    if (lum > 180) return "Light Green";
    return "Green";
  }

  if (isBlueish) {
    if (lum < 80) return "Dark Blue";
    if (lum > 180) return "Light Blue";
    return "Blue";
  }

  return "Mixed";
}

/**
 * K-means clustering for color quantization
 */
function kMeansCluster(
  pixels: RGB[],
  k: number,
  maxIterations: number = 20
): { centroid: RGB; count: number }[] {
  // Initialize centroids using k-means++ algorithm
  const centroids: RGB[] = [];
  centroids.push(pixels[Math.floor(Math.random() * pixels.length)]);

  for (let i = 1; i < k; i++) {
    const distances = pixels.map((pixel) => {
      const minDist = Math.min(
        ...centroids.map((c) => colorDistance(pixel, c))
      );
      return minDist * minDist;
    });
    const sum = distances.reduce((a, b) => a + b, 0);
    let target = Math.random() * sum;
    for (let j = 0; j < pixels.length; j++) {
      target -= distances[j];
      if (target <= 0) {
        centroids.push(pixels[j]);
        break;
      }
    }
  }

  // Iteratively update centroids
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Assign pixels to nearest centroid
    const clusters: RGB[][] = Array.from({ length: k }, () => []);

    for (const pixel of pixels) {
      let minDist = Infinity;
      let closestIdx = 0;
      for (let i = 0; i < centroids.length; i++) {
        const dist = colorDistance(pixel, centroids[i]);
        if (dist < minDist) {
          minDist = dist;
          closestIdx = i;
        }
      }
      clusters[closestIdx].push(pixel);
    }

    // Update centroids
    let converged = true;
    for (let i = 0; i < k; i++) {
      if (clusters[i].length === 0) continue;

      const newCentroid = {
        r: Math.round(
          clusters[i].reduce((sum, p) => sum + p.r, 0) / clusters[i].length
        ),
        g: Math.round(
          clusters[i].reduce((sum, p) => sum + p.g, 0) / clusters[i].length
        ),
        b: Math.round(
          clusters[i].reduce((sum, p) => sum + p.b, 0) / clusters[i].length
        ),
      };

      if (colorDistance(centroids[i], newCentroid) > 1) {
        converged = false;
      }
      centroids[i] = newCentroid;
    }

    if (converged) break;
  }

  // Count pixels per cluster
  const clusterCounts = Array(k).fill(0);
  for (const pixel of pixels) {
    let minDist = Infinity;
    let closestIdx = 0;
    for (let i = 0; i < centroids.length; i++) {
      const dist = colorDistance(pixel, centroids[i]);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    }
    clusterCounts[closestIdx]++;
  }

  return centroids.map((centroid, i) => ({
    centroid,
    count: clusterCounts[i],
  }));
}

/**
 * Extract dominant colors from an image
 * @param imageData - Base64 encoded image data URL
 * @param colorCount - Number of colors to extract (5-10)
 * @returns Promise resolving to array of palette colors
 */
export async function extractPalette(
  imageData: string,
  colorCount: number = 8
): Promise<PaletteColor[]> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        // Create canvas to sample pixels
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to create canvas context"));
          return;
        }

        // Scale down large images for performance (max 200x200 for sampling)
        const maxSize = 200;
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        canvas.width = Math.floor(img.width * scale);
        canvas.height = Math.floor(img.height * scale);

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const imageDataObj = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageDataObj.data;

        // Sample pixels (skip every few pixels for performance)
        const pixels: RGB[] = [];
        const step = 4; // Sample every 4th pixel
        for (let i = 0; i < data.length; i += 4 * step) {
          // Skip fully transparent pixels
          if (data[i + 3] < 128) continue;
          pixels.push({
            r: data[i],
            g: data[i + 1],
            b: data[i + 2],
          });
        }

        if (pixels.length < colorCount) {
          reject(new Error("Image has too few visible pixels"));
          return;
        }

        // Run k-means clustering
        const clusters = kMeansCluster(pixels, colorCount);
        const totalPixels = clusters.reduce((sum, c) => sum + c.count, 0);

        // Convert to palette colors, sorted by percentage (most dominant first)
        const palette: PaletteColor[] = clusters
          .map((cluster) => ({
            hex: rgbToHex(cluster.centroid.r, cluster.centroid.g, cluster.centroid.b),
            rgb: cluster.centroid,
            percentage: (cluster.count / totalPixels) * 100,
            name: getColorName(cluster.centroid),
          }))
          .filter((color) => color.percentage > 0.5) // Filter out negligible colors
          .sort((a, b) => b.percentage - a.percentage)
          .slice(0, colorCount);

        resolve(palette);
      } catch (error) {
        reject(error);
      }
    };

    img.onerror = () => {
      reject(new Error("Failed to load image"));
    };

    img.src = imageData;
  });
}

/**
 * Apply a color palette to an image using the specified mapping method
 * @param imageData - Base64 encoded source image
 * @param palette - Color palette to apply
 * @param method - Mapping method to use
 * @returns Promise resolving to base64 encoded result image
 */
export async function applyPalette(
  imageData: string,
  palette: PaletteColor[],
  method: "closest" | "histogram" | "luminance" = "closest"
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to create canvas context"));
          return;
        }

        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);

        const imageDataObj = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageDataObj.data;

        // Pre-compute palette info based on method
        const sortedByLuminance = [...palette].sort(
          (a, b) => getLuminance(a.rgb) - getLuminance(b.rgb)
        );

        for (let i = 0; i < data.length; i += 4) {
          // Skip transparent pixels
          if (data[i + 3] < 128) continue;

          const pixel: RGB = {
            r: data[i],
            g: data[i + 1],
            b: data[i + 2],
          };

          let mappedColor: RGB;

          switch (method) {
            case "closest": {
              // Find closest palette color by Euclidean distance
              let minDist = Infinity;
              mappedColor = palette[0].rgb;
              for (const color of palette) {
                const dist = colorDistance(pixel, color.rgb);
                if (dist < minDist) {
                  minDist = dist;
                  mappedColor = color.rgb;
                }
              }
              break;
            }

            case "luminance": {
              // Map based on relative luminance position
              const pixelLum = getLuminance(pixel);
              const lumMin = getLuminance(sortedByLuminance[0].rgb);
              const lumMax = getLuminance(sortedByLuminance[sortedByLuminance.length - 1].rgb);
              const lumRange = lumMax - lumMin || 1;
              const normalizedLum = (pixelLum - lumMin) / lumRange;
              const idx = Math.min(
                sortedByLuminance.length - 1,
                Math.floor(normalizedLum * sortedByLuminance.length)
              );
              mappedColor = sortedByLuminance[Math.max(0, idx)].rgb;
              break;
            }

            case "histogram": {
              // Quantize pixel luminance to palette index
              const pixelLum = getLuminance(pixel);
              const idx = Math.floor((pixelLum / 255) * (sortedByLuminance.length - 1));
              mappedColor = sortedByLuminance[idx].rgb;
              break;
            }

            default:
              mappedColor = pixel;
          }

          data[i] = mappedColor.r;
          data[i + 1] = mappedColor.g;
          data[i + 2] = mappedColor.b;
        }

        ctx.putImageData(imageDataObj, 0, 0);
        resolve(canvas.toDataURL("image/png"));
      } catch (error) {
        reject(error);
      }
    };

    img.onerror = () => {
      reject(new Error("Failed to load image"));
    };

    img.src = imageData;
  });
}

/**
 * Generate a visual swatch image from a palette
 * @param palette - Color palette
 * @param width - Width of output image
 * @param height - Height of output image
 * @returns Base64 encoded PNG image of color swatches
 */
export function generatePaletteSwatches(
  palette: PaletteColor[],
  width: number = 200,
  height: number = 40
): string {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return "";
  }

  canvas.width = width;
  canvas.height = height;

  const swatchWidth = width / palette.length;

  palette.forEach((color, i) => {
    ctx.fillStyle = color.hex;
    ctx.fillRect(i * swatchWidth, 0, swatchWidth, height);
  });

  return canvas.toDataURL("image/png");
}
