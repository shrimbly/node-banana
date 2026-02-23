/**
 * Cinema Camera Presets
 *
 * Standalone utility for cinematic camera calculations.
 * Maps real-world sensor sizes and lens focal lengths to FOV values
 * for use with Three.js PerspectiveCamera in the Spark.js viewer.
 */

// ─── Sensor Presets ─────────────────────────────────────────────

export interface SensorPreset {
  name: string;
  /** Sensor width in millimeters */
  widthMm: number;
  /** Sensor height in millimeters */
  heightMm: number;
}

/**
 * Common cinema and photography sensor sizes.
 * Super 35mm is the default (most common in cinema).
 */
export const SENSOR_PRESETS: SensorPreset[] = [
  { name: "Super 35mm", widthMm: 24.89, heightMm: 18.66 },
  { name: "Full Frame", widthMm: 36.0, heightMm: 24.0 },
  { name: "ARRI Alexa LF", widthMm: 36.70, heightMm: 25.54 },
  { name: "RED Monstro VV", widthMm: 40.96, heightMm: 21.60 },
  { name: "IMAX 65mm", widthMm: 70.41, heightMm: 52.63 },
  { name: "Micro Four Thirds", widthMm: 17.30, heightMm: 13.0 },
  { name: "APS-C", widthMm: 23.60, heightMm: 15.60 },
];

/** Default sensor index (Super 35mm) */
export const DEFAULT_SENSOR_INDEX = 0;

// ─── Lens Focal Lengths ─────────────────────────────────────────

/**
 * Standard cinema prime lens focal lengths in millimeters.
 * Covers ultra-wide (14mm) through telephoto (200mm).
 */
export const LENS_FOCAL_LENGTHS: number[] = [
  14, 18, 21, 24, 28, 35, 40, 50, 75, 85, 100, 135, 200,
];

/** Default focal length index (35mm — standard "normal" lens for Super 35) */
export const DEFAULT_LENS_INDEX = 5;

// ─── Aspect Ratio Presets ───────────────────────────────────────

export interface AspectRatioPreset {
  name: string;
  /** Width-to-height ratio (e.g., 2.39 for anamorphic scope) */
  ratio: number;
}

/**
 * Standard cinema and broadcast aspect ratios.
 */
export const ASPECT_RATIO_PRESETS: AspectRatioPreset[] = [
  { name: "2.39:1 Scope", ratio: 2.39 },
  { name: "1.85:1 Flat", ratio: 1.85 },
  { name: "16:9", ratio: 16 / 9 },
  { name: "4:3", ratio: 4 / 3 },
  { name: "1.43:1 IMAX", ratio: 1.43 },
  { name: "1:1 Square", ratio: 1.0 },
];

/** Default aspect ratio index (2.39:1 Scope) */
export const DEFAULT_ASPECT_RATIO_INDEX = 0;

// ─── FOV Calculations ───────────────────────────────────────────

/**
 * Calculate horizontal field of view from sensor width and focal length.
 *
 * Formula: hFOV = 2 × atan(sensorWidth / (2 × focalLength)) × (180/π)
 *
 * @param sensorWidthMm - Sensor width in millimeters
 * @param focalLengthMm - Lens focal length in millimeters
 * @returns Horizontal FOV in degrees
 */
export function calculateHorizontalFOV(
  sensorWidthMm: number,
  focalLengthMm: number
): number {
  return 2 * Math.atan(sensorWidthMm / (2 * focalLengthMm)) * (180 / Math.PI);
}

/**
 * Calculate vertical field of view from horizontal FOV and aspect ratio.
 *
 * This is the value Three.js PerspectiveCamera expects for its `fov` property.
 *
 * Formula: vFOV = 2 × atan(tan(hFOV/2 × π/180) / aspectRatio) × (180/π)
 *
 * @param horizontalFOV - Horizontal FOV in degrees
 * @param aspectRatio - Width-to-height ratio (e.g., 2.39)
 * @returns Vertical FOV in degrees
 */
export function calculateVerticalFOV(
  horizontalFOV: number,
  aspectRatio: number
): number {
  const hFovRad = (horizontalFOV / 2) * (Math.PI / 180);
  return 2 * Math.atan(Math.tan(hFovRad) / aspectRatio) * (180 / Math.PI);
}

/**
 * Calculate the Three.js camera FOV (vertical) from sensor, lens, and aspect ratio.
 *
 * Convenience function combining both calculations.
 *
 * @param sensorWidthMm - Sensor width in millimeters
 * @param focalLengthMm - Lens focal length in millimeters
 * @param aspectRatio - Width-to-height ratio
 * @returns Vertical FOV in degrees (for Three.js camera.fov)
 */
export function calculateCameraFOV(
  sensorWidthMm: number,
  focalLengthMm: number,
  aspectRatio: number
): number {
  const hFov = calculateHorizontalFOV(sensorWidthMm, focalLengthMm);
  return calculateVerticalFOV(hFov, aspectRatio);
}

/**
 * Get a human-readable summary of the current camera setup.
 *
 * @param sensor - Selected sensor preset
 * @param focalLength - Selected focal length in mm
 * @param aspectRatio - Selected aspect ratio preset
 * @returns Formatted string like "ARRI Alexa LF · 85mm · 2.39:1 Scope · 15.2° vFOV"
 */
export function getCameraSummary(
  sensor: SensorPreset,
  focalLength: number,
  aspectRatio: AspectRatioPreset
): string {
  const vFov = calculateCameraFOV(sensor.widthMm, focalLength, aspectRatio.ratio);
  return `${sensor.name} · ${focalLength}mm · ${aspectRatio.name} · ${vFov.toFixed(1)}° vFOV`;
}

/**
 * Generate a filename-safe camera descriptor for captured frame naming.
 *
 * @param sensor - Selected sensor preset
 * @param focalLength - Selected focal length in mm
 * @returns String like "Super35mm_35mm" or "ARRIAlexaLF_85mm"
 */
export function getCameraFilenameSegment(
  sensor: SensorPreset,
  focalLength: number
): string {
  const sensorSlug = sensor.name.replace(/[\s-]/g, "");
  return `${sensorSlug}_${focalLength}mm`;
}
