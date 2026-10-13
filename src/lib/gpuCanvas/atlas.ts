/**
 * The painted atlas on the GPU: a texture array of square layers, laid out by
 * AtlasLayout. Images arrive two ways: copied from the painter's staging
 * texture (one sheet, many nodes) by drawing quads, or uploaded from the
 * disk cache as raw pixels.
 */
import * as THREE from "three";
import { AtlasLayout, type Slot } from "./atlasLayout";

export interface BlitItem {
  /** Source rectangle in the staging texture, in its texels. */
  src: { x: number; y: number; w: number; h: number };
  dst: Slot;
}

const BLIT_VERTEX = /* glsl */ `
  precision highp float;
  in vec2 position;   // destination, in clip space of the atlas layer
  in vec2 aSrc;
  out vec2 vSrc;
  void main() { vSrc = aSrc; gl_Position = vec4(position, 0.0, 1.0); }
`;
const BLIT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D uStaging;
  in vec2 vSrc;
  out vec4 outColor;
  void main() { outColor = texture(uStaging, vSrc); }
`;

export class PaintedAtlas {
  readonly target: THREE.WebGLArrayRenderTarget;
  readonly layout: AtlasLayout;
  private blitScene = new THREE.Scene();
  private blitCamera = new THREE.Camera();
  private blitGeometry = new THREE.BufferGeometry();
  private blitMaterial: THREE.RawShaderMaterial;

  constructor(readonly renderer: THREE.WebGLRenderer, readonly size: number, readonly layers: number) {
    this.layout = new AtlasLayout(size, layers);
    this.target = new THREE.WebGLArrayRenderTarget(size, size, layers, { depthBuffer: false, stencilBuffer: false });
    const texture = this.target.texture;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.blitMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: BLIT_VERTEX, fragmentShader: BLIT_FRAGMENT,
      uniforms: { uStaging: { value: null } }, depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(this.blitGeometry, this.blitMaterial);
    mesh.frustumCulled = false;
    this.blitGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.blitScene.add(mesh);
    // Allocate the array now, so its memory is paid up front and uploads have a texture to write into.
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target, 0);
    renderer.setRenderTarget(previous);
  }

  get bytes() {
    return this.size * this.size * 4 * this.layers;
  }

  /** Copies each item's source rectangle of `staging` into its slot. */
  blit(staging: THREE.Texture, stagingSize: { width: number; height: number }, items: readonly BlitItem[]) {
    if (!items.length) return;
    const { renderer } = this;
    this.blitMaterial.uniforms.uStaging.value = staging;
    const byLayer = new Map<number, BlitItem[]>();
    for (const item of items) {
      const list = byLayer.get(item.dst.layer);
      if (list) list.push(item);
      else byLayer.set(item.dst.layer, [item]);
    }
    const previous = renderer.getRenderTarget();
    for (const [layer, list] of byLayer) {
      const dst: number[] = [], src: number[] = [];
      for (const { src: s, dst: d } of list) {
        const x0 = (d.x / this.size) * 2 - 1, y0 = (d.y / this.size) * 2 - 1, x1 = ((d.x + d.w) / this.size) * 2 - 1, y1 = ((d.y + d.h) / this.size) * 2 - 1;
        const u0 = s.x / stagingSize.width, v0 = s.y / stagingSize.height, u1 = (s.x + s.w) / stagingSize.width, v1 = (s.y + s.h) / stagingSize.height;
        dst.push(x0, y0, x1, y0, x0, y1, x1, y0, x1, y1, x0, y1);
        src.push(u0, v0, u1, v0, u0, v1, u1, v0, u1, v1, u0, v1);
      }
      this.blitGeometry.setAttribute("position", new THREE.Float32BufferAttribute(dst, 2));
      this.blitGeometry.setAttribute("aSrc", new THREE.Float32BufferAttribute(src, 2));
      renderer.setRenderTarget(this.target, layer);
      renderer.render(this.blitScene, this.blitCamera);
    }
    renderer.setRenderTarget(previous);
  }

  /** Writes raw RGBA pixels (row 0 at the top, as painted) into a slot. */
  upload(slot: Slot, pixels: Uint8Array, width: number, height: number) {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    const texture = (this.renderer.properties.get(this.target.texture) as { __webglTexture?: WebGLTexture }).__webglTexture;
    if (!texture) return;
    const w = Math.min(width, slot.w), h = Math.min(height, slot.h);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, slot.x, slot.y, slot.layer, w, h, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    this.renderer.resetState();
  }

  dispose() {
    this.target.dispose();
    this.blitGeometry.dispose();
    this.blitMaterial.dispose();
  }
}
