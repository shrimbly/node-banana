/**
 * Panorama Editor Executor
 *
 * Composites an edited perspective image back onto an equirectangular panorama
 * using WebGL for high-performance rendering. Falls back to Canvas 2D if WebGL
 * is unavailable.
 *
 * Inputs:
 *   - images[0]: original equirectangular panorama (base64 data URL)
 *   - images[1]: edited perspective crop (base64 data URL)
 *   - text: JSON-serialized PanoCropMetadata (yaw, pitch, roll, hFov, vFov, aspectRatio)
 *
 * Output:
 *   - outputImage: composited equirectangular panorama (base64 data URL)
 */

import type { NodeExecutionContext } from "./types";
import type { PanoCropMetadata } from "@/utils/equirectProjection";
import { compositeOntoEquirect } from "@/utils/equirectProjection";

/**
 * Load an image from a URL or data-URL into an HTMLImageElement.
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = src;
  });
}

/**
 * Create a WebGL2-based compositing pipeline.
 * Returns the composited equirect as a base64 data URL.
 */
async function compositeWithWebGL(
  panoImg: HTMLImageElement,
  editedImg: HTMLImageElement,
  metadata: PanoCropMetadata,
): Promise<string> {
  const width = panoImg.naturalWidth;
  const height = panoImg.naturalHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true });
  if (!gl) {
    throw new Error("WebGL2 not available");
  }

  // Vertex shader — full-screen quad
  const vsSource = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // Fragment shader — equirect compositing
  const fsSource = `#version 300 es
    precision highp float;

    in vec2 v_uv;
    out vec4 fragColor;

    uniform sampler2D u_panoTex;
    uniform sampler2D u_editedTex;
    uniform mat3 u_invRotMat;
    uniform float u_hFov;
    uniform float u_vFov;

    const float PI = 3.14159265359;

    void main() {
      // UV to equirectangular lon/lat
      float lon = v_uv.x * 2.0 * PI - PI;
      float lat = v_uv.y * PI - PI * 0.5;

      // Direction on unit sphere
      vec3 dir = vec3(
        cos(lat) * sin(lon),
        sin(lat),
        cos(lat) * cos(lon)
      );

      // Transform to camera space via inverse rotation
      vec3 camDir = u_invRotMat * dir;

      // Perspective projection — check if in front of camera
      if (camDir.z > 0.0) {
        float px = camDir.x / camDir.z;
        float py = camDir.y / camDir.z;

        float halfTanH = tan(u_hFov * 0.5);
        float halfTanV = tan(u_vFov * 0.5);

        float su = px / halfTanH * 0.5 + 0.5;
        float sv = py / halfTanV * 0.5 + 0.5;

        // Flip V for texture sampling (top-left origin)
        sv = 1.0 - sv;

        if (su >= 0.0 && su <= 1.0 && sv >= 0.0 && sv <= 1.0) {
          fragColor = texture(u_editedTex, vec2(su, sv));
          return;
        }
      }

      fragColor = texture(u_panoTex, vec2(v_uv.x, 1.0 - v_uv.y));
    }
  `;

  // Compile shaders
  function compileShader(type: number, source: string): WebGLShader {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      const info = gl!.getShaderInfoLog(shader);
      gl!.deleteShader(shader);
      throw new Error(`Shader compile error: ${info}`);
    }
    return shader;
  }

  const vs = compileShader(gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);

  const program = gl.createProgram()!;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  // Full-screen quad
  const quadVerts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  // Upload textures
  function uploadTexture(img: HTMLImageElement, unit: number): WebGLTexture {
    const tex = gl!.createTexture()!;
    gl!.activeTexture(gl!.TEXTURE0 + unit);
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, img);
    return tex;
  }

  const panoTex = uploadTexture(panoImg, 0);
  const editedTex = uploadTexture(editedImg, 1);

  // Set uniforms
  gl.uniform1i(gl.getUniformLocation(program, "u_panoTex"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_editedTex"), 1);
  gl.uniform1f(gl.getUniformLocation(program, "u_hFov"), metadata.hFov);
  gl.uniform1f(gl.getUniformLocation(program, "u_vFov"), metadata.vFov);

  // Build inverse rotation matrix
  // Rotation order: Y (yaw) then X (pitch) then Z (roll)
  const cy = Math.cos(metadata.yaw), sy = Math.sin(metadata.yaw);
  const cp = Math.cos(metadata.pitch), sp = Math.sin(metadata.pitch);
  const cr = Math.cos(metadata.roll), sr = Math.sin(metadata.roll);

  // Forward rotation matrix (YXZ)
  const m00 = cy * cr + sy * sp * sr;
  const m01 = -cy * sr + sy * sp * cr;
  const m02 = sy * cp;
  const m10 = cp * sr;
  const m11 = cp * cr;
  const m12 = -sp;
  const m20 = -sy * cr + cy * sp * sr;
  const m21 = sy * sr + cy * sp * cr;
  const m22 = cy * cp;

  // Inverse (transpose since it's orthogonal)
  // WebGL column-major: each group of 3 is one column of the GLSL mat3.
  // For M^T, column j of M^T = row j of M.
  const invMat = new Float32Array([
    m00, m01, m02,  // column 0 of M^T (= row 0 of M)
    m10, m11, m12,  // column 1 of M^T (= row 1 of M)
    m20, m21, m22,  // column 2 of M^T (= row 2 of M)
  ]);
  gl.uniformMatrix3fv(gl.getUniformLocation(program, "u_invRotMat"), false, invMat);

  // Render
  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  // Read result
  const result = canvas.toDataURL("image/png");

  // Cleanup
  gl.deleteTexture(panoTex);
  gl.deleteTexture(editedTex);
  gl.deleteBuffer(vbo);
  gl.deleteVertexArray(vao);
  gl.deleteProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  return result;
}

/**
 * Canvas 2D fallback for compositing.
 */
async function compositeWithCanvas2D(
  panoImg: HTMLImageElement,
  editedImg: HTMLImageElement,
  metadata: PanoCropMetadata,
): Promise<string> {
  // Draw panorama onto a canvas
  const panoCanvas = document.createElement("canvas");
  panoCanvas.width = panoImg.naturalWidth;
  panoCanvas.height = panoImg.naturalHeight;
  const pCtx = panoCanvas.getContext("2d")!;
  pCtx.drawImage(panoImg, 0, 0);

  // Draw edited image onto a canvas
  const editCanvas = document.createElement("canvas");
  editCanvas.width = editedImg.naturalWidth;
  editCanvas.height = editedImg.naturalHeight;
  const eCtx = editCanvas.getContext("2d")!;
  eCtx.drawImage(editedImg, 0, 0);

  // Use the CPU-based compositing function
  const result = compositeOntoEquirect(panoCanvas, editCanvas, metadata);
  return result.toDataURL("image/png");
}

/**
 * Execute panorama editor node.
 *
 * Takes an original panorama, an edited perspective crop, and metadata,
 * then composites the edited image back onto the panorama.
 */
export async function executePanoEditor(ctx: NodeExecutionContext): Promise<void> {
  const { node, getConnectedInputs, updateNodeData } = ctx;

  try {
    updateNodeData(node.id, { status: "loading", error: null });

    const { images, text } = getConnectedInputs(node.id);

    if (images.length < 2) {
      throw new Error("Panorama Editor requires two image inputs: panorama (image-0) and edited crop (image-1)");
    }
    if (!text) {
      throw new Error("Panorama Editor requires metadata text input (PanoCropMetadata JSON)");
    }

    // Parse metadata
    let metadata: PanoCropMetadata;
    try {
      metadata = JSON.parse(text) as PanoCropMetadata;
    } catch {
      throw new Error("Invalid metadata JSON — expected PanoCropMetadata format");
    }

    // Load both images
    const [panoImg, editedImg] = await Promise.all([
      loadImage(images[0]),
      loadImage(images[1]),
    ]);

    // Try WebGL first, fallback to Canvas 2D
    let result: string;
    try {
      result = await compositeWithWebGL(panoImg, editedImg, metadata);
    } catch (webglError) {
      console.warn("[PanoEditor] WebGL failed, falling back to Canvas 2D:", webglError);
      result = await compositeWithCanvas2D(panoImg, editedImg, metadata);
    }

    updateNodeData(node.id, {
      outputImage: result,
      status: "complete",
      error: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Workflow] PanoEditor node ${node.id} failed:`, message);
    updateNodeData(node.id, { status: "error", error: message });
  }
}
