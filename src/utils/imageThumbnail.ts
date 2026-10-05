/**
 * Generates a lower-resolution JPEG thumbnail from a base64 image data URL.
 * Used for adaptive image resolution — rendering smaller images when nodes
 * are small in the viewport.
 *
 * Drawing an image that has only loaded decodes it on the main thread, and a
 * workflow full of multi-megapixel images asked for every thumbnail at once
 * as it opened. The image is decoded off the main thread first, and only a
 * few decode at a time, which also bounds the decoded pixels held in memory.
 */
const MAX_CONCURRENT = 3;
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try { return await work(); } finally { active--; waiting.shift()?.(); }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image failed to load"));
    img.src = src;
  });
}

export async function generateThumbnail(
  base64DataUrl: string,
  maxDim: number = 256,
  quality: number = 0.6
): Promise<string> {
  if (!base64DataUrl) return base64DataUrl;

  return withSlot(async () => {
    try {
      const img = await loadImage(base64DataUrl);
      const { naturalWidth: w, naturalHeight: h } = img;

      // Skip if already small enough
      if (w <= maxDim && h <= maxDim) return base64DataUrl;

      // Decode away from the main thread; when the browser declines (an
      // image past its decode limits), drawing below decodes it instead.
      if (typeof img.decode === "function") await img.decode().catch(() => {});

      // Calculate scaled dimensions preserving aspect ratio
      const scale = Math.min(maxDim / w, maxDim / h);
      const newW = Math.round(w * scale);
      const newH = Math.round(h * scale);

      const canvas = document.createElement("canvas");
      canvas.width = newW;
      canvas.height = newH;

      const ctx = canvas.getContext("2d");
      if (!ctx) return base64DataUrl;

      ctx.drawImage(img, 0, 0, newW, newH);
      return canvas.toDataURL("image/jpeg", quality);
    } catch {
      // The full image falls back gracefully
      return base64DataUrl;
    }
  });
}
