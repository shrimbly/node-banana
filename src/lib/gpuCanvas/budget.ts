/**
 * How much GPU memory the painted atlas may take.
 *
 * The spike held 256 MB (16 layers of 2048²) on a 2560×1440 screen at every
 * zoom, on an RTX 4090 and an M5 Pro. Integrated GPUs share memory with the
 * system and have less to give, so they get half; so does a machine that
 * reports little memory. The array is allocated whole, so the budget is
 * paid up front.
 */

export interface AtlasBudget {
  layerSize: number;
  layers: number;
  bytes: number;
  /** Why this budget was chosen, for the overlay and diagnostics. */
  reason: string;
}

export interface GpuInfo {
  renderer: string;
  maxTextureSize: number;
  maxArrayLayers: number;
  /** navigator.deviceMemory, in GB, when the browser reports it. */
  deviceMemoryGb?: number;
}

const LAYER_SIZE = 2048;
const FULL_LAYERS = 16;

/** Integrated GPUs, by the names their drivers report (Apple silicon shares memory but has plenty). */
const INTEGRATED = /intel|uhd graphics|iris|mali|adreno|powervr|vivante|radeon\(tm\) graphics|radeon graphics|swiftshader|llvmpipe|software/i;

export function atlasBudget(gpu: GpuInfo): AtlasBudget {
  const layerSize = Math.min(LAYER_SIZE, gpu.maxTextureSize || LAYER_SIZE);
  let layers = FULL_LAYERS;
  let reason = "default";
  if (INTEGRATED.test(gpu.renderer)) {
    layers = FULL_LAYERS / 2;
    reason = "integrated GPU";
  } else if (gpu.deviceMemoryGb != null && gpu.deviceMemoryGb < 8) {
    layers = FULL_LAYERS / 2;
    reason = `${gpu.deviceMemoryGb} GB of memory`;
  }
  layers = Math.max(4, Math.min(layers, gpu.maxArrayLayers || layers));
  return { layerSize, layers, bytes: layerSize * layerSize * 4 * layers, reason };
}

/** What the WebGL2 context says about the GPU. */
export function readGpuInfo(gl: WebGL2RenderingContext): GpuInfo {
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = String(debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  const deviceMemoryGb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return {
    renderer,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number,
    deviceMemoryGb,
  };
}
