/**
 * Download Image Utility
 *
 * Reusable function for downloading images from base64 data URLs.
 */

export interface DownloadOptions {
  filename?: string;
  format?: "png" | "jpg" | "webp";
}

/**
 * Downloads an image from a base64 data URL
 */
export function downloadImage(
  dataUrl: string,
  options: DownloadOptions = {}
): void {
  const { filename, format = "png" } = options;

  const defaultFilename = `image-${Date.now()}.${format}`;
  const finalFilename = filename || defaultFilename;

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = finalFilename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Downloads multiple images as individual files
 * Note: Browser may prompt for permission for multiple downloads
 */
export function downloadImages(
  dataUrls: string[],
  baseFilename: string = "image"
): void {
  dataUrls.forEach((dataUrl, index) => {
    // Stagger downloads slightly to avoid browser blocking
    setTimeout(() => {
      downloadImage(dataUrl, {
        filename: `${baseFilename}-${index + 1}.png`,
      });
    }, index * 100);
  });
}

/**
 * Creates a ZIP file containing multiple images and downloads it
 * Requires JSZip library - falls back to individual downloads if not available
 */
export async function downloadImagesAsZip(
  dataUrls: string[],
  zipFilename: string = "images.zip"
): Promise<void> {
  // Try to dynamically import JSZip
  try {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();

    // Add each image to the zip
    dataUrls.forEach((dataUrl, index) => {
      // Extract base64 data from data URL
      const base64Data = dataUrl.split(",")[1];
      zip.file(`image-${index + 1}.png`, base64Data, { base64: true });
    });

    // Generate the zip file
    const content = await zip.generateAsync({ type: "blob" });

    // Download the zip
    const url = URL.createObjectURL(content);
    const link = document.createElement("a");
    link.href = url;
    link.download = zipFilename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch {
    // JSZip not available, fall back to individual downloads
    console.warn("JSZip not available, downloading images individually");
    downloadImages(dataUrls, "image");
  }
}
