/**
 * Equirectangular Projection Utilities
 *
 * Math for converting between equirectangular panorama images and
 * perspective (rectilinear) camera views. Used by:
 *   - Panorama Viewer: extract a perspective crop from an equirect image
 *   - Panorama Editor: composite an edited perspective image back onto an equirect
 */

// ─── Types ──────────────────────────────────────────────────────

/**
 * Metadata describing the perspective camera that captured a crop
 * from an equirectangular panorama.
 */
export interface PanoCropMetadata {
  /** Horizontal rotation in radians (longitude direction). 0 = center, positive = right */
  yaw: number;
  /** Vertical rotation in radians (latitude direction). 0 = horizon, positive = up */
  pitch: number;
  /** Roll in radians. 0 = no roll (reserved for future use) */
  roll: number;
  /** Horizontal field of view in radians */
  hFov: number;
  /** Vertical field of view in radians */
  vFov: number;
  /** Aspect ratio (width / height) */
  aspectRatio: number;
}

// ─── Rotation Matrix ────────────────────────────────────────────

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

/**
 * Build a 3×3 rotation matrix from Euler angles (YXZ order).
 * This matches the convention: first rotate around Y (yaw), then X (pitch), then Z (roll).
 *
 * The resulting matrix transforms a direction in camera space to world space.
 */
export function buildRotationMatrix(yaw: number, pitch: number, roll: number): Mat3 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);

  // R = Ry * Rx * Rz
  return [
    [
      cy * cr + sy * sp * sr,
      -cy * sr + sy * sp * cr,
      sy * cp,
    ],
    [
      cp * sr,
      cp * cr,
      -sp,
    ],
    [
      -sy * cr + cy * sp * sr,
      sy * sr + cy * sp * cr,
      cy * cp,
    ],
  ];
}

/**
 * Multiply a 3×3 matrix by a 3D vector.
 */
export function rotateDirection(mat: Mat3, dir: Vec3): Vec3 {
  return [
    mat[0][0] * dir[0] + mat[0][1] * dir[1] + mat[0][2] * dir[2],
    mat[1][0] * dir[0] + mat[1][1] * dir[1] + mat[1][2] * dir[2],
    mat[2][0] * dir[0] + mat[2][1] * dir[1] + mat[2][2] * dir[2],
  ];
}

/**
 * Multiply the transpose (inverse for orthonormal) of a 3×3 matrix by a 3D vector.
 */
export function inverseRotateDirection(mat: Mat3, dir: Vec3): Vec3 {
  return [
    mat[0][0] * dir[0] + mat[1][0] * dir[1] + mat[2][0] * dir[2],
    mat[0][1] * dir[0] + mat[1][1] * dir[1] + mat[2][1] * dir[2],
    mat[0][2] * dir[0] + mat[1][2] * dir[1] + mat[2][2] * dir[2],
  ];
}

// ─── Coordinate Conversions ─────────────────────────────────────

/**
 * Convert equirectangular UV coordinates [0,1]×[0,1] to spherical angles.
 * UV origin is top-left. u=0 → lon=-π (left), u=1 → lon=π (right).
 * v=0 → lat=π/2 (top/north pole), v=1 → lat=-π/2 (bottom/south pole).
 */
export function uvToLonLat(u: number, v: number): { lon: number; lat: number } {
  const lon = u * 2 * Math.PI - Math.PI; // [-π, π]
  const lat = (0.5 - v) * Math.PI;       // [π/2, -π/2] → top is +, bottom is -
  return { lon, lat };
}

/**
 * Convert spherical angles to equirectangular UV coordinates [0,1]×[0,1].
 */
export function lonLatToUv(lon: number, lat: number): { u: number; v: number } {
  const u = (lon + Math.PI) / (2 * Math.PI);
  const v = 0.5 - lat / Math.PI;
  return { u, v };
}

/**
 * Convert spherical angles (lon, lat) to a unit 3D direction vector.
 * Convention: +X = right, +Y = up, -Z = forward (OpenGL-style).
 */
export function lonLatToDirection(lon: number, lat: number): Vec3 {
  const cosLat = Math.cos(lat);
  return [
    cosLat * Math.sin(lon),  // x
    Math.sin(lat),            // y
    cosLat * Math.cos(lon),  // z (forward at lon=0)
  ];
}

/**
 * Convert a 3D direction to spherical angles.
 */
export function directionToLonLat(dir: Vec3): { lon: number; lat: number } {
  const lon = Math.atan2(dir[0], dir[2]);
  const lat = Math.asin(Math.max(-1, Math.min(1, dir[1])));
  return { lon, lat };
}

// ─── Perspective Extraction ─────────────────────────────────────

/**
 * Extract a perspective (rectilinear) view from an equirectangular image.
 *
 * For each pixel in the output perspective image:
 * 1. Map to normalized camera space using FOV
 * 2. Rotate from camera space to world space using the rotation matrix
 * 3. Convert world direction to equirectangular UV
 * 4. Sample the equirectangular source
 *
 * @param equirectCanvas - Source equirectangular image as a canvas element
 * @param outWidth - Output perspective image width in pixels
 * @param outHeight - Output perspective image height in pixels
 * @param metadata - Camera orientation and FOV parameters
 * @returns Canvas element with the extracted perspective view
 */
export function extractPerspectiveView(
  equirectCanvas: HTMLCanvasElement | OffscreenCanvas,
  outWidth: number,
  outHeight: number,
  metadata: PanoCropMetadata
): HTMLCanvasElement {
  const { yaw, pitch, roll, hFov, vFov } = metadata;

  // Build rotation matrix (camera → world)
  const rotMat = buildRotationMatrix(yaw, pitch, roll);

  // Get source image data
  const srcCtx = equirectCanvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  if (!srcCtx) throw new Error("Failed to get 2D context from equirect canvas");
  const srcWidth = equirectCanvas.width;
  const srcHeight = equirectCanvas.height;
  const srcData = srcCtx.getImageData(0, 0, srcWidth, srcHeight);

  // Create output canvas
  const outCanvas = document.createElement("canvas");
  outCanvas.width = outWidth;
  outCanvas.height = outHeight;
  const outCtx = outCanvas.getContext("2d")!;
  const outData = outCtx.createImageData(outWidth, outHeight);

  const halfTanH = Math.tan(hFov / 2);
  const halfTanV = Math.tan(vFov / 2);

  for (let py = 0; py < outHeight; py++) {
    for (let px = 0; px < outWidth; px++) {
      // Normalized device coordinates [-1, 1]
      const nx = (2 * (px + 0.5) / outWidth - 1) * halfTanH;
      const ny = (1 - 2 * (py + 0.5) / outHeight) * halfTanV; // flip Y: top = positive

      // Camera-space direction (looking along +Z)
      const camDir: Vec3 = [nx, ny, 1];
      const len = Math.sqrt(camDir[0] ** 2 + camDir[1] ** 2 + camDir[2] ** 2);
      camDir[0] /= len;
      camDir[1] /= len;
      camDir[2] /= len;

      // Rotate to world space
      const worldDir = rotateDirection(rotMat, camDir);

      // Convert to equirect UV
      const { lon, lat } = directionToLonLat(worldDir);
      const { u, v } = lonLatToUv(lon, lat);

      // Bilinear sample from source
      const sx = u * srcWidth - 0.5;
      const sy = v * srcHeight - 0.5;

      // Wrap horizontally for seamless panorama
      const sx0 = ((Math.floor(sx) % srcWidth) + srcWidth) % srcWidth;
      const sx1 = (sx0 + 1) % srcWidth;
      const sy0 = Math.max(0, Math.min(srcHeight - 1, Math.floor(sy)));
      const sy1 = Math.min(srcHeight - 1, sy0 + 1);
      const fx = sx - Math.floor(sx);
      const fy = sy - Math.floor(sy);

      const i00 = (sy0 * srcWidth + sx0) * 4;
      const i10 = (sy0 * srcWidth + sx1) * 4;
      const i01 = (sy1 * srcWidth + sx0) * 4;
      const i11 = (sy1 * srcWidth + sx1) * 4;

      const outIdx = (py * outWidth + px) * 4;
      for (let c = 0; c < 4; c++) {
        outData.data[outIdx + c] = Math.round(
          srcData.data[i00 + c] * (1 - fx) * (1 - fy) +
          srcData.data[i10 + c] * fx * (1 - fy) +
          srcData.data[i01 + c] * (1 - fx) * fy +
          srcData.data[i11 + c] * fx * fy
        );
      }
    }
  }

  outCtx.putImageData(outData, 0, 0);
  return outCanvas;
}

// ─── Perspective Compositing (Canvas 2D fallback) ───────────────

/**
 * Composite an edited perspective image back onto an equirectangular panorama.
 * Canvas 2D fallback — used when WebGL is unavailable.
 *
 * For each pixel in the equirectangular output:
 * 1. Convert to (lon, lat) → 3D direction
 * 2. Inverse-rotate to camera space
 * 3. Perspective project to check if in frustum
 * 4. If in bounds, sample from edited image; else keep original
 */
export function compositeOntoEquirect(
  panoCanvas: HTMLCanvasElement | OffscreenCanvas,
  editedCanvas: HTMLCanvasElement | OffscreenCanvas,
  metadata: PanoCropMetadata
): HTMLCanvasElement {
  const { yaw, pitch, roll, hFov, vFov } = metadata;
  const rotMat = buildRotationMatrix(yaw, pitch, roll);

  const panoCtx = panoCanvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const editCtx = editedCanvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  if (!panoCtx || !editCtx) throw new Error("Failed to get 2D contexts");

  const pW = panoCanvas.width;
  const pH = panoCanvas.height;
  const eW = editedCanvas.width;
  const eH = editedCanvas.height;

  const panoData = panoCtx.getImageData(0, 0, pW, pH);
  const editData = editCtx.getImageData(0, 0, eW, eH);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = pW;
  outCanvas.height = pH;
  const outCtx = outCanvas.getContext("2d")!;
  const outImgData = outCtx.createImageData(pW, pH);

  // Copy panorama data as base
  outImgData.data.set(panoData.data);

  const halfTanH = Math.tan(hFov / 2);
  const halfTanV = Math.tan(vFov / 2);

  for (let y = 0; y < pH; y++) {
    for (let x = 0; x < pW; x++) {
      // Equirect UV → lon/lat → direction
      const u = (x + 0.5) / pW;
      const v = (y + 0.5) / pH;
      const { lon, lat } = uvToLonLat(u, v);
      const worldDir = lonLatToDirection(lon, lat);

      // Inverse-rotate to camera space
      const camDir = inverseRotateDirection(rotMat, worldDir);

      // Must be in front of camera (positive Z in camera space)
      if (camDir[2] <= 0) continue;

      // Perspective projection
      const px = camDir[0] / camDir[2];
      const py = camDir[1] / camDir[2];

      // Normalize to [0, 1] using FOV
      const su = px / halfTanH * 0.5 + 0.5;
      const sv = 0.5 - py / halfTanV * 0.5; // flip Y

      if (su < 0 || su > 1 || sv < 0 || sv > 1) continue;

      // Bilinear sample from edited image
      const ex = su * eW - 0.5;
      const ey = sv * eH - 0.5;

      const ex0 = Math.max(0, Math.min(eW - 1, Math.floor(ex)));
      const ex1 = Math.min(eW - 1, ex0 + 1);
      const ey0 = Math.max(0, Math.min(eH - 1, Math.floor(ey)));
      const ey1 = Math.min(eH - 1, ey0 + 1);
      const fx = ex - Math.floor(ex);
      const fy = ey - Math.floor(ey);

      const i00 = (ey0 * eW + ex0) * 4;
      const i10 = (ey0 * eW + ex1) * 4;
      const i01 = (ey1 * eW + ex0) * 4;
      const i11 = (ey1 * eW + ex1) * 4;

      const outIdx = (y * pW + x) * 4;
      for (let c = 0; c < 4; c++) {
        outImgData.data[outIdx + c] = Math.round(
          editData.data[i00 + c] * (1 - fx) * (1 - fy) +
          editData.data[i10 + c] * fx * (1 - fy) +
          editData.data[i01 + c] * (1 - fx) * fy +
          editData.data[i11 + c] * fx * fy
        );
      }
    }
  }

  outCtx.putImageData(outImgData, 0, 0);
  return outCanvas;
}
