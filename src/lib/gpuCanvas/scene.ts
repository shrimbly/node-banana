/**
 * The GPU scene: the whole graph on one WebGL2 canvas through three.js with
 * our own shaders. Node images are instanced quads reading the painted atlas
 * (a texture array), edges are instanced cubic beziers, and the dot grid,
 * groups and selection outline come from the same few draw calls. Pan and
 * zoom change one uniform; nothing per node runs on the CPU while the view
 * moves.
 *
 * Until a node has a painted image it is drawn as a card in its type's
 * colour (the low-detail card, on the GPU). The scene is read-only: it pans,
 * zooms, hovers, selects and opens nodes, and reports those through its
 * callbacks; it never writes to the workflow store.
 */
import * as THREE from "three";
import { GridIndex, type SceneGraph } from "./graph";
import { cubicLength, distanceToCubic, type Cubic, type EdgeRoute } from "./edgeRoutes";

/** Floats per node instance: rect (4), uv rect (4), colour (3), flags (1), layer (1), the node's own box within the rect (4), unused (3). */
const NODE_STRIDE = 20;
const FLAG_SELECTED = 1, FLAG_HOVERED = 2, FLAG_HIDDEN = 4, FLAG_GROUP = 8, FLAG_PAINTED = 16;
/**
 * Floats per edge instance, one cubic segment of a connection: the cubic (8),
 * colour (3), flags (1), width (1), length along the edge where it starts (1)
 * and its own length (1), the edge's x range for the gradient (2), unused (3).
 */
const EDGE_STRIDE = 20;
const EDGE_SEGMENTS = 24;
const EDGE_SELECTED = 1, EDGE_HOVERED = 2, EDGE_ACTIVE = 4, EDGE_HIDDEN = 8, EDGE_DASHED = 16, EDGE_STEM = 32;
/** How near (css px) a press must be to a connection to take it. */
const EDGE_HIT_PX = 7;

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 4;

export interface View {
  x: number;
  y: number;
  zoom: number;
}

/** A painted image of a node: where it sits relative to the node's top-left (header and margin included) and where it is in the atlas. */
export interface PaintedQuad {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const COMMON = /* glsl */ `
  uniform vec2 uViewport;   // css px
  uniform vec3 uView;       // translate x, y (css px), zoom (css px per flow unit)
  vec4 toClip(vec2 world) {
    vec2 css = world * uView.z + uView.xy;
    return vec4(css / uViewport * vec2(2.0, -2.0) + vec2(-1.0, 1.0), 0.0, 1.0);
  }
`;

const NODE_VERTEX = /* glsl */ `
  precision highp float;
  ${COMMON}
  in vec2 position;
  in vec4 iRect;
  in vec4 iUv;
  in vec3 iColor;
  in float iFlags;
  in float iLayer;
  in vec4 iBox;
  out vec2 vLocal;
  out vec2 vSize;
  out vec4 vUv;
  out vec3 vColor;
  flat out int vFlags;
  flat out float vLayer;
  flat out vec4 vBox;
  void main() {
    vFlags = int(iFlags);
    vBox = iBox;
    if ((vFlags & ${FLAG_HIDDEN}) != 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // Room for the outline and antialiasing.
    float pad = 3.0 / uView.z;
    vec2 local = position * (iRect.zw + 2.0 * pad) - pad;
    vLocal = local; vSize = iRect.zw; vUv = iUv; vColor = iColor; vLayer = iLayer;
    // The node starts on a whole pixel, as the page lays it out, so a painted
    // image at its own scale is copied texel for pixel rather than blurred.
    vec2 origin = iRect.xy * uView.z + uView.xy;
    vec2 snap = (floor(origin + 0.5) - origin) / uView.z;
    gl_Position = toClip(iRect.xy + snap + local);
  }
`;

const NODE_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler2DArray;
  uniform vec3 uView;
  uniform sampler2DArray uPainted;
  in vec2 vLocal;
  in vec2 vSize;
  in vec4 vUv;
  in vec3 vColor;
  flat in int vFlags;
  flat in float vLayer;
  flat in vec4 vBox;
  out vec4 outColor;
  float box(vec2 p, vec2 half_, float r) { vec2 q = abs(p) - half_ + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    float px = 1.0 / uView.z;   // flow units per css pixel
    if ((vFlags & ${FLAG_GROUP}) != 0) {
      vec2 half_ = vSize * 0.5;
      float d = box(vLocal - half_, half_, 12.0);
      float inside = clamp(0.5 - d / px, 0.0, 1.0);
      float border = clamp(1.0 - abs(d) / px, 0.0, 1.0);
      outColor = vec4(vColor, max(inside * 0.08, border * 0.5));
      return;
    }
    if ((vFlags & ${FLAG_PAINTED}) != 0) {
      // The image holds the node, its header and its margin; the outline is drawn by the live node's own frame when selected.
      if (any(lessThan(vLocal, vec2(0.0))) || any(greaterThan(vLocal, vSize))) discard;
      outColor = texture(uPainted, vec3(mix(vUv.xy, vUv.zw, vLocal / vSize), vLayer));
      return;
    }
    // The stand-in card: the node's body in its type's colour stripe.
    vec2 half_ = vSize * 0.5;
    float d = box(vLocal - half_, half_, 12.0);
    float inside = clamp(0.5 - d / px, 0.0, 1.0);
    vec3 color = vec3(0.13);
    if (vLocal.y < 5.0) color = vColor;
    else if (vLocal.y > 34.0 && vLocal.y < vSize.y - 16.0) {
      float line = mod(vLocal.y - 34.0, 22.0);
      if (line < 9.0 && vLocal.x > 14.0 && vLocal.x < vSize.x - 14.0 - mod(vLocal.y * 7.0, 60.0)) color = vec3(0.2);
    }
    float alpha = inside;
    if ((vFlags & (${FLAG_SELECTED} | ${FLAG_HOVERED})) != 0) {
      float ring = clamp(1.0 - abs(d - 1.5 * px) / (1.5 * px), 0.0, 1.0);
      vec3 ringColor = (vFlags & ${FLAG_SELECTED}) != 0 ? vec3(0.32, 0.6, 1.0) : vec3(0.5);
      color = mix(color, ringColor, ring);
      alpha = max(alpha, ring);
    }
    outColor = vec4(color, alpha);
  }
`;

/** Outlines over painted nodes (selection and hover), drawn after them. */
const OUTLINE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uView;
  in vec2 vLocal;
  in vec2 vSize;
  in vec4 vUv;
  in vec3 vColor;
  flat in int vFlags;
  flat in float vLayer;
  flat in vec4 vBox;
  out vec4 outColor;
  float box(vec2 p, vec2 half_, float r) { vec2 q = abs(p) - half_ + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    if ((vFlags & ${FLAG_PAINTED}) == 0 || (vFlags & (${FLAG_SELECTED} | ${FLAG_HOVERED})) == 0) discard;
    float px = 1.0 / uView.z;
    // The node's own rectangle within the painted quad.
    vec2 half_ = vBox.zw * 0.5;
    float d = box(vLocal - vBox.xy - half_, half_, 12.0);
    float ring = clamp(1.0 - abs(d - 1.5 * px) / (1.5 * px), 0.0, 1.0);
    vec3 ringColor = (vFlags & ${FLAG_SELECTED}) != 0 ? vec3(0.32, 0.6, 1.0) : vec3(0.5);
    outColor = vec4(ringColor, ring);
  }
`;

const EDGE_VERTEX = /* glsl */ `
  precision highp float;
  ${COMMON}
  in vec2 position;         // x: t along the segment, y: side (-1, 1)
  in vec4 iA;               // start, first control
  in vec4 iB;               // second control, end
  in vec3 iColor;
  in float iFlags;
  in float iWidth;
  in vec2 iLength;          // where the segment starts along its edge, its length
  in vec2 iRange;           // the edge's x range
  out float vSide;
  out vec3 vColor;
  out float vAlong;
  out float vX;
  out float vHalf;
  flat out int vFlags;
  flat out vec2 vRange;
  vec2 bezier(vec2 a, vec2 b, vec2 c, vec2 d, float t) { float u = 1.0 - t; return u*u*u*a + 3.0*u*u*t*b + 3.0*u*t*t*c + t*t*t*d; }
  vec2 tangent(vec2 a, vec2 b, vec2 c, vec2 d, float t) { float u = 1.0 - t; return 3.0*u*u*(b-a) + 6.0*u*t*(c-b) + 3.0*t*t*(d-c); }
  void main() {
    vFlags = int(iFlags);
    if ((vFlags & ${EDGE_HIDDEN}) != 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec2 a = iA.xy, b = iA.zw, c = iB.xy, d = iB.zw;
    float t = position.x;
    vec2 p = bezier(a, b, c, d, t);
    vec2 dir = tangent(a, b, c, d, t);
    // A degenerate tangent at an end (a control on its end point): look a little inside.
    if (dot(dir, dir) < 1e-8) dir = bezier(a, b, c, d, clamp(t + (t < 0.5 ? 0.01 : -0.01), 0.0, 1.0)) - p;
    if (t >= 0.5 && dot(dir, dir) < 1e-8) dir = p - bezier(a, b, c, d, t - 0.01);
    dir = normalize(dir + 1e-6);
    // As wide as the SVG stroke (flow units), never under a css pixel; a pixel more for the edge's antialiasing.
    float px = 1.0 / uView.z;
    float half_ = max(iWidth, px) * 0.5;
    vHalf = half_ / px;
    float reach = half_ + px;
    vSide = position.y * (half_ + px) / px;
    vColor = iColor;
    vAlong = iLength.x + iLength.y * t;
    vX = p.x;
    vRange = iRange;
    // Round caps: the ends reach past the segment by half the width.
    vec2 cap = (t == 0.0 ? -dir : t == 1.0 ? dir : vec2(0.0)) * half_;
    gl_Position = toClip(p + cap + vec2(-dir.y, dir.x) * position.y * reach);
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uGradient;
  uniform float uFaded;
  in float vSide;
  in vec3 vColor;
  in float vAlong;
  in float vX;
  in float vHalf;
  flat in int vFlags;
  flat in vec2 vRange;
  out vec4 outColor;
  void main() {
    // Dashes of 6 and gaps of 4 flow units (reference links).
    if ((vFlags & ${EDGE_DASHED}) != 0 && mod(vAlong, 10.0) > 6.0) discard;
    float coverage = clamp(vHalf + 0.5 - abs(vSide), 0.0, 1.0);
    bool isActive = (vFlags & ${EDGE_ACTIVE}) != 0;
    bool highlight = (vFlags & (${EDGE_SELECTED} | ${EDGE_HOVERED})) != 0;
    float alpha;
    if ((vFlags & ${EDGE_STEM}) == 0 && uGradient > 0.5) {
      // The shared gradient: bright ends, a softer middle, across the edge's bounding box.
      float span = max(vRange.y - vRange.x, 1e-3);
      float pos = clamp((vX - vRange.x) / span, 0.0, 1.0);
      vec3 stops = isActive || highlight ? vec3(1.0, 0.55, 1.0) : vec3(uFaded, uFaded * 0.4, uFaded);
      alpha = pos < 0.5 ? mix(stops.x, stops.y, pos * 2.0) : mix(stops.y, stops.z, (pos - 0.5) * 2.0);
    } else alpha = isActive ? 1.0 : uFaded;
    outColor = vec4(vColor, alpha * coverage);
  }
`;

const GRID_VERTEX = /* glsl */ `
  precision highp float;
  in vec2 position;
  void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const GRID_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec2 uViewport;
  uniform vec3 uView;
  uniform float uDpr;
  out vec4 outColor;
  void main() {
    vec2 css = vec2(gl_FragCoord.x, uViewport.y * uDpr - gl_FragCoord.y) / uDpr;
    vec2 world = (css - uView.xy) / uView.z;
    float spacing = 20.0;
    // Coarser dots when they would crowd under 8 css px apart.
    for (int i = 0; i < 6; i++) if (spacing * uView.z < 8.0) spacing *= 4.0;
    vec2 cell = mod(world + spacing * 0.5, spacing) - spacing * 0.5;
    float d = length(cell) * uView.z;
    float dot_ = 1.0 - smoothstep(0.5, 1.2, d);
    // bg-neutral-900 with #404040 dots, as the canvas draws them.
    outColor = vec4(mix(vec3(0.090, 0.090, 0.090), vec3(0.251), dot_), 1.0);
  }
`;

/** Every shader the scene compiles, for the tests. */
export const SCENE_SHADERS = { NODE_VERTEX, NODE_FRAGMENT, OUTLINE_FRAGMENT, EDGE_VERTEX, EDGE_FRAGMENT, GRID_VERTEX, GRID_FRAGMENT };

const EMPTY_ARRAY = (() => {
  const texture = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  texture.needsUpdate = true;
  return texture;
})();

function material(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>, transparent = true) {
  // Flow space has y down, so quads wind the other way on screen: no culling.
  return new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader, fragmentShader, uniforms, transparent, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
}

export interface SceneCallbacks {
  /** The scene cannot draw: a shader failed to compile or link. */
  onFailure?: (reason: string) => void;
  /** Computes a connection's route (the owner knows the store's edge style and bundles). */
  routeEdge?: (e: number) => EdgeRoute;
  /** Every animation frame, with the JavaScript the scene ran in it (ms). */
  onFrame?: (now: number, jsMs: number) => void;
  onHover?: (node: number) => void;
  /**
   * A press on the canvas (or handed over by the live layer): returns the
   * gesture it starts, or null to ignore it. Without it a drag pans.
   */
  onPress?: (event: PointerEvent) => Gesture | null;
  /** The pointer moved with no gesture under way (hover). */
  onIdleMove?: (event: PointerEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
  /** A double-click on a node. */
  onOpen?: (node: number) => void;
  /** A double-click on empty canvas, at a flow position. */
  onPaneDoubleClick?: (x: number, y: number, screen: { x: number; y: number }) => void;
  onViewChange?: (view: View) => void;
  /** A press, drag or wheel on the canvas: the user is navigating. */
  onInput?: () => void;
  /** ms from an input event to the frame that drew its effect (the page's own part of input latency). */
  onInputLatency?: (ms: number) => void;
  /** Whether a wheel event zooms rather than pans (the canvas's navigation settings). */
  wheelZooms?: (event: WheelEvent) => boolean;
}

/** A press being followed: its moves and its release, until it ends. */
export interface Gesture {
  move(event: PointerEvent): void;
  up(event: PointerEvent): void;
  cancel(): void;
}

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly view: View = { x: 0, y: 0, zoom: 1 };
  graph: SceneGraph;
  /** When the pointer or wheel last moved the view (performance.now()). */
  lastInputAt = 0;
  private viewListeners = new Set<() => void>();
  private layoutListeners = new Set<() => void>();
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private uniforms = { uViewport: { value: new THREE.Vector2() }, uView: { value: new THREE.Vector3() }, uDpr: { value: 1 } };
  private nodeData = new Float32Array(0);
  private nodeAttr: THREE.InstancedInterleavedBuffer | null = null;
  private nodeUniforms: Record<string, THREE.IUniform> = { ...this.uniforms, uPainted: { value: EMPTY_ARRAY } };
  private edgeData = new Float32Array(0);
  private edgeAttr: THREE.InstancedInterleavedBuffer | null = null;
  private edgeGeometry: THREE.InstancedBufferGeometry | null = null;
  private edgeUniforms: Record<string, THREE.IUniform> = { ...this.uniforms, uGradient: { value: 0 }, uFaded: { value: 1 } };
  /** Each edge's route, and where its segments start in the instance buffer. */
  private routes: (EdgeRoute | null)[] = [];
  private routeOffset: number[] = [];
  private routeCount: number[] = [];
  /** Each edge's bounds (flow units), for hit tests. */
  private edgeBounds = new Float32Array(0);
  private edgeSelected = new Set<number>();
  /** Edges the live layer draws (decorated ones on screen). */
  private edgeLive = new Set<number>();
  private hoveredEdge = -1;

  private graphMeshes: THREE.Mesh[] = [];
  private painted = new Map<number, PaintedQuad>();
  private hidden = new Set<number>();
  private selected = new Set<number>();
  private hovered = -1;
  private index: GridIndex;
  private dirty = true;
  private frameHandle = 0;
  private disposed = false;
  private gesture: Gesture | null = null;
  /** The earliest input event not yet drawn (its timeStamp). */
  private pendingInputAt = 0;
  private resizeObserver: ResizeObserver;

  constructor(readonly canvas: HTMLCanvasElement, graph: SceneGraph, readonly callbacks: SceneCallbacks = {}) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.autoClear = false;
    this.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].map((l) => l?.trim()).filter(Boolean).join("\n");
      this.callbacks.onFailure?.(`a shader failed to compile${log ? `: ${log}` : ""}`);
    };
    this.graph = graph;
    this.index = new GridIndex(graph.nodes);

    const grid = new THREE.BufferGeometry();
    grid.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
    this.add(new THREE.Mesh(grid, material(GRID_VERTEX, GRID_FRAGMENT, this.uniforms, false)), 0);
    this.buildGraphMeshes();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  /** A pan is under way (the painter waits). */
  get interacting() {
    return this.gesture !== null;
  }

  private add(mesh: THREE.Mesh, order: number) {
    mesh.frustumCulled = false;
    // Positions are 2D; three cannot compute bounds from them, and nothing is culled anyway.
    mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    mesh.renderOrder = order;
    this.scene.add(mesh);
  }

  /** (Re)creates the group, edge and node meshes for the current graph. */
  private buildGraphMeshes() {
    for (const mesh of this.graphMeshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.graphMeshes = [];
    const { graph } = this;

    if (graph.groups.length) {
      const data = new Float32Array(graph.groups.length * NODE_STRIDE);
      graph.groups.forEach((g, i) => data.set([g.x, g.y, g.w, g.h, 0, 0, 0, 0, ...g.color, FLAG_GROUP, 0, 0, 0, g.w, g.h], i * NODE_STRIDE));
      const { geometry } = this.nodeGeometry(data, graph.groups.length);
      this.addGraphMesh(new THREE.Mesh(geometry, material(NODE_VERTEX, NODE_FRAGMENT, this.nodeUniforms)), 1);
    }

    this.buildEdges();
    this.addGraphMesh(new THREE.Mesh(this.edgeGeometry!, material(EDGE_VERTEX, EDGE_FRAGMENT, this.edgeUniforms)), 2);

    this.nodeData = new Float32Array(Math.max(1, graph.nodes.length) * NODE_STRIDE);
    for (let i = 0; i < graph.nodes.length; i++) this.writeNode(i);
    const { geometry, attr } = this.nodeGeometry(this.nodeData, graph.nodes.length);
    this.nodeAttr = attr;
    this.addGraphMesh(new THREE.Mesh(geometry, material(NODE_VERTEX, NODE_FRAGMENT, this.nodeUniforms)), 3);
    // The same instances again, drawing only outlines over painted nodes.
    this.addGraphMesh(new THREE.Mesh(geometry, material(NODE_VERTEX, OUTLINE_FRAGMENT, this.nodeUniforms)), 4);
    this.dirty = true;
  }

  private addGraphMesh(mesh: THREE.Mesh, order: number) {
    this.add(mesh, order);
    this.graphMeshes.push(mesh);
  }

  private nodeGeometry(data: Float32Array, count: number) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
    geometry.setIndex([0, 1, 2, 1, 3, 2]);
    const attr = new THREE.InstancedInterleavedBuffer(data, NODE_STRIDE);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("iRect", new THREE.InterleavedBufferAttribute(attr, 4, 0));
    geometry.setAttribute("iUv", new THREE.InterleavedBufferAttribute(attr, 4, 4));
    geometry.setAttribute("iColor", new THREE.InterleavedBufferAttribute(attr, 3, 8));
    geometry.setAttribute("iFlags", new THREE.InterleavedBufferAttribute(attr, 1, 11));
    geometry.setAttribute("iLayer", new THREE.InterleavedBufferAttribute(attr, 1, 12));
    geometry.setAttribute("iBox", new THREE.InterleavedBufferAttribute(attr, 4, 13));
    geometry.instanceCount = count;
    return { geometry, attr };
  }

  private writeNode(i: number) {
    const node = this.graph.nodes[i];
    let flags = this.hidden.has(i) ? FLAG_HIDDEN : 0;
    if (this.selected.has(i)) flags |= FLAG_SELECTED;
    if (this.hovered === i) flags |= FLAG_HOVERED;
    const painted = this.painted.get(i);
    if (painted) {
      this.nodeData.set([node.x + painted.x, node.y + painted.y, painted.w, painted.h, painted.u0, painted.v0, painted.u1, painted.v1,
        ...node.color, flags | FLAG_PAINTED, painted.layer, -painted.x, -painted.y, node.w, node.h], i * NODE_STRIDE);
      return;
    }
    this.nodeData.set([node.x, node.y, node.w, node.h, 0, 0, 0, 0, ...node.color, flags, 0, 0, 0, node.w, node.h], i * NODE_STRIDE);
  }

  private touchNode(i: number) {
    if (i < 0 || i >= this.graph.nodes.length) return;
    this.writeNode(i);
    if (this.nodeAttr) {
      this.nodeAttr.addUpdateRange(i * NODE_STRIDE, NODE_STRIDE);
      this.nodeAttr.needsUpdate = true;
    }
    this.dirty = true;
  }

  /** The edge instance geometry, for the current routes (computed here when missing). */
  private buildEdges() {
    const { graph } = this;
    if (!this.edgeGeometry) {
      const strip: number[] = [], indices: number[] = [];
      for (let i = 0; i <= EDGE_SEGMENTS; i++) {
        strip.push(i / EDGE_SEGMENTS, -1, i / EDGE_SEGMENTS, 1);
        if (i < EDGE_SEGMENTS) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      }
      this.edgeGeometry = new THREE.InstancedBufferGeometry();
      this.edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(strip, 2));
      this.edgeGeometry.setIndex(indices);
    }
    const geometry = this.edgeGeometry;
    if (this.routes.length !== graph.edges.length) this.routes = graph.edges.map(() => null);
    let total = 0;
    this.routeOffset = new Array(graph.edges.length);
    this.routeCount = new Array(graph.edges.length);
    this.edgeBounds = new Float32Array(graph.edges.length * 4);
    for (let e = 0; e < graph.edges.length; e++) {
      const route = this.routes[e] ?? (this.routes[e] = this.route(e));
      this.routeOffset[e] = total;
      this.routeCount[e] = route.segments.length + route.stems.length;
      total += this.routeCount[e];
    }
    this.edgeData = new Float32Array(Math.max(1, total) * EDGE_STRIDE);
    this.edgeAttr = new THREE.InstancedInterleavedBuffer(this.edgeData, EDGE_STRIDE);
    this.edgeAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("iA", new THREE.InterleavedBufferAttribute(this.edgeAttr, 4, 0));
    geometry.setAttribute("iB", new THREE.InterleavedBufferAttribute(this.edgeAttr, 4, 4));
    geometry.setAttribute("iColor", new THREE.InterleavedBufferAttribute(this.edgeAttr, 3, 8));
    geometry.setAttribute("iFlags", new THREE.InterleavedBufferAttribute(this.edgeAttr, 1, 11));
    geometry.setAttribute("iWidth", new THREE.InterleavedBufferAttribute(this.edgeAttr, 1, 12));
    geometry.setAttribute("iLength", new THREE.InterleavedBufferAttribute(this.edgeAttr, 2, 13));
    geometry.setAttribute("iRange", new THREE.InterleavedBufferAttribute(this.edgeAttr, 2, 15));
    geometry.instanceCount = total;
    for (let e = 0; e < graph.edges.length; e++) this.writeEdge(e);
    this.dirty = true;
  }

  private route(e: number): EdgeRoute {
    if (this.callbacks.routeEdge) return this.callbacks.routeEdge(e);
    // No router (tests, or before the owner set one): a plain curve between the ends.
    const [sx, sy, tx, ty] = this.graph.edgeEnds(e);
    const d = tx - sx, off = d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d);
    const segment: Cubic = [sx, sy, sx + off, sy, tx - off, ty, tx, ty];
    return { segments: [segment], stems: [], ends: [sx, sy, tx, ty], labelX: (sx + tx) / 2, labelY: (sy + ty) / 2, width: 3, dashed: false, hidden: false, decorated: false };
  }

  private writeEdge(e: number) {
    const route = this.routes[e];
    if (!route) return;
    const edge = this.graph.edges[e];
    let flags = route.hidden || this.edgeLive.has(e) ? EDGE_HIDDEN : 0;
    if (this.edgeSelected.has(e)) flags |= EDGE_SELECTED;
    if (this.hoveredEdge === e) flags |= EDGE_HOVERED;
    if (this.selected.has(edge.source) || this.selected.has(edge.target)) flags |= EDGE_ACTIVE;
    if (route.dashed) flags |= EDGE_DASHED;
    const [sx, sy, tx, ty] = route.ends;
    let minX = Math.min(sx, tx), maxX = Math.max(sx, tx), minY = Math.min(sy, ty), maxY = Math.max(sy, ty);
    for (const c of route.segments) for (let k = 0; k < 8; k += 2) {
      minX = Math.min(minX, c[k]); maxX = Math.max(maxX, c[k]);
      minY = Math.min(minY, c[k + 1]); maxY = Math.max(maxY, c[k + 1]);
    }
    let at = this.routeOffset[e] * EDGE_STRIDE, along = 0;
    const [r, g, b] = edge.color;
    for (const c of route.segments) {
      const length = cubicLength(c);
      this.edgeData.set(c, at);
      this.edgeData.set([r, g, b, flags, route.width, along, length, minX, maxX], at + 8);
      along += length;
      at += EDGE_STRIDE;
    }
    for (const stem of route.stems) {
      this.edgeData.set(stem.segment, at);
      this.edgeData.set([r, g, b, (flags & ~EDGE_DASHED) | EDGE_STEM, stem.width, 0, cubicLength(stem.segment), 0, 1], at + 8);
      for (let k = 0; k < 8; k += 2) {
        minX = Math.min(minX, stem.segment[k]); maxX = Math.max(maxX, stem.segment[k]);
        minY = Math.min(minY, stem.segment[k + 1]); maxY = Math.max(maxY, stem.segment[k + 1]);
      }
      at += EDGE_STRIDE;
    }
    this.edgeBounds.set([minX, minY, maxX, maxY], e * 4);
  }

  /** Writes edges again (their flags or routes changed) and uploads them. */
  private touchEdgeList(edges: Iterable<number>) {
    if (!this.edgeAttr) return;
    for (const e of edges) {
      if (e < 0 || e >= this.graph.edges.length) continue;
      this.writeEdge(e);
      this.edgeAttr.addUpdateRange(this.routeOffset[e] * EDGE_STRIDE, this.routeCount[e] * EDGE_STRIDE);
    }
    this.edgeAttr.needsUpdate = true;
    this.dirty = true;
  }

  /** Computes the edges' routes again (their ends moved, or what they show changed). */
  reroute(edges: Iterable<number>) {
    let resized = false;
    const list = [...edges];
    for (const e of list) {
      if (e < 0 || e >= this.graph.edges.length) continue;
      const route = this.route(e);
      if (route.segments.length + route.stems.length !== this.routeCount[e]) resized = true;
      this.routes[e] = route;
    }
    // A route with more or fewer segments than before moves every edge after it in the buffer.
    if (resized) this.buildEdges();
    else this.touchEdgeList(list);
  }

  /** Every edge's route again (the edge style or appearance changed). */
  rerouteAll() {
    this.routes = this.graph.edges.map(() => null);
    this.buildEdges();
  }

  private touchEdges(i: number) {
    this.reroute(this.graph.edgesOf[i] ?? []);
  }

  /** The route the scene drew for an edge. */
  edgeRoute(e: number): EdgeRoute | null {
    return this.routes[e] ?? null;
  }

  /** The connection under a point (css px), or -1: the nearest within a few pixels. */
  edgeAt(cssX: number, cssY: number): number {
    const p = this.toWorld(cssX, cssY);
    const reach = EDGE_HIT_PX / this.view.zoom;
    let best = -1, bestDistance = Infinity;
    for (let e = 0; e < this.graph.edges.length; e++) {
      const b = e * 4, route = this.routes[e];
      if (!route || p.x < this.edgeBounds[b] - reach || p.x > this.edgeBounds[b + 2] + reach || p.y < this.edgeBounds[b + 1] - reach || p.y > this.edgeBounds[b + 3] + reach) continue;
      for (const c of route.segments) {
        const distance = distanceToCubic(c, p.x, p.y) - route.width / 2;
        if (distance < bestDistance) { bestDistance = distance; best = e; }
      }
    }
    return bestDistance <= reach ? best : -1;
  }

  /** Edges whose bounds overlap a rectangle (flow units). */
  edgesWithin(x0: number, y0: number, x1: number, y1: number): number[] {
    const found: number[] = [];
    for (let e = 0; e < this.graph.edges.length; e++) {
      const b = e * 4;
      if (this.routes[e] && this.edgeBounds[b] <= x1 && this.edgeBounds[b + 2] >= x0 && this.edgeBounds[b + 1] <= y1 && this.edgeBounds[b + 3] >= y0) found.push(e);
    }
    return found;
  }

  setSelectedEdges(edges: Iterable<number>) {
    const next = new Set(edges), changed: number[] = [];
    for (const e of this.edgeSelected) if (!next.has(e)) changed.push(e);
    for (const e of next) if (!this.edgeSelected.has(e)) changed.push(e);
    this.edgeSelected = next;
    if (changed.length) this.touchEdgeList(changed);
  }

  /** Edges the live layer draws; the scene leaves them out. */
  setLiveEdges(edges: Iterable<number>) {
    const next = new Set(edges), changed: number[] = [];
    for (const e of this.edgeLive) if (!next.has(e)) changed.push(e);
    for (const e of next) if (!this.edgeLive.has(e)) changed.push(e);
    this.edgeLive = next;
    if (changed.length) this.touchEdgeList(changed);
  }

  setHoveredEdge(e: number) {
    if (e === this.hoveredEdge) return;
    const previous = this.hoveredEdge;
    this.hoveredEdge = e;
    this.touchEdgeList([previous, e]);
  }

  /** The edge appearance settings: the gradient and the faded opacity. */
  setEdgeAppearance(gradient: boolean, fadedOpacity: number) {
    this.edgeUniforms.uGradient.value = gradient ? 1 : 0;
    this.edgeUniforms.uFaded.value = fadedOpacity;
    this.dirty = true;
  }

  /** The graph was rebuilt (nodes added, removed or reordered): indices are new. */
  setGraph(graph: SceneGraph) {
    this.graph = graph;
    this.painted.clear();
    this.hidden.clear();
    this.selected.clear();
    this.hovered = -1;
    this.routes = [];
    this.edgeSelected.clear();
    this.edgeLive.clear();
    this.hoveredEdge = -1;
    this.index = new GridIndex(graph.nodes);
    this.buildGraphMeshes();
    this.layoutChanged();
  }

  /** Nodes moved or resized in place. */
  nodesMoved(nodes: readonly number[]) {
    const edges = new Set<number>();
    for (const i of nodes) {
      this.index.update(i);
      this.touchNode(i);
      for (const e of this.graph.edgesOf[i] ?? []) edges.add(e);
    }
    if (edges.size) this.reroute(edges);
    this.layoutChanged();
  }

  /** The edges were replaced: their indices are new. */
  edgesChanged() {
    this.routes = [];
    this.edgeSelected.clear();
    this.edgeLive.clear();
    this.hoveredEdge = -1;
    this.buildGraphMeshes();
  }

  groupsChanged() {
    this.buildGraphMeshes();
  }

  /** The painted atlas (a texture array) painted images are read from. */
  setPaintedAtlas(texture: THREE.Texture) {
    this.nodeUniforms.uPainted.value = texture;
    this.dirty = true;
  }

  /** A painted image for a node, or null for its stand-in card. */
  setPainted(i: number, quad: PaintedQuad | null) {
    if (quad) this.painted.set(i, quad);
    else this.painted.delete(i);
    this.touchNode(i);
  }

  /** The node's height as painting measured it; moves its edges' ends. */
  setNodeHeight(i: number, height: number) {
    const node = this.graph.nodes[i];
    if (!node || node.h === height) return;
    node.h = height;
    this.index.update(i);
    this.touchNode(i);
    this.touchEdges(i);
    this.layoutChanged();
  }

  /** Where a node's handles are, once measured; moves its edges' ends. */
  setHandles(i: number, handles: Map<string, { x: number; y: number }>) {
    const node = this.graph.nodes[i];
    if (!node) return;
    node.handles = handles;
    this.touchEdges(i);
  }

  /** Nodes the live layer covers are not drawn by the scene. */
  setHidden(i: number, hidden: boolean) {
    if (hidden === this.hidden.has(i)) return;
    if (hidden) this.hidden.add(i);
    else this.hidden.delete(i);
    this.touchNode(i);
  }

  setSelected(nodes: Iterable<number>) {
    const next = new Set(nodes), edges = new Set<number>();
    const changed = (i: number) => {
      this.touchNode(i);
      for (const e of this.graph.edgesOf[i] ?? []) edges.add(e);
    };
    for (const i of this.selected) if (!next.has(i)) {
      this.selected.delete(i);
      changed(i);
    }
    for (const i of next) if (!this.selected.has(i)) {
      this.selected.add(i);
      changed(i);
    }
    // Connections to a selected node are drawn at full strength.
    if (edges.size) this.touchEdgeList(edges);
  }

  private setHovered(i: number) {
    if (i === this.hovered) return;
    const previous = this.hovered;
    this.hovered = i;
    this.touchNode(previous);
    this.touchNode(i);
    this.callbacks.onHover?.(i);
  }

  invalidate() {
    this.dirty = true;
  }

  /** Called whenever nodes move, resize or the graph is rebuilt. */
  onLayoutChanged(listener: () => void): () => void {
    this.layoutListeners.add(listener);
    return () => this.layoutListeners.delete(listener);
  }

  private layoutChanged() {
    for (const listener of this.layoutListeners) listener();
  }

  /** Called whenever the view changes. */
  onViewChanged(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  setView(view: Partial<View>) {
    const zoom = view.zoom == null ? this.view.zoom : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom));
    Object.assign(this.view, view, { zoom });
    this.dirty = true;
    this.callbacks.onViewChange?.(this.view);
    for (const listener of this.viewListeners) listener();
  }

  /** Fits a rectangle (flow units) on screen, at most at `maxZoom`. */
  fitRect(rect: { minX: number; minY: number; maxX: number; maxY: number }, padding = 40, maxZoom = 1) {
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    const width = Math.max(1, rect.maxX - rect.minX), height = Math.max(1, rect.maxY - rect.minY);
    const zoom = Math.min(maxZoom, MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - padding * 2) / width, (h - padding * 2) / height)));
    this.setView({ zoom, x: (w - width * zoom) / 2 - rect.minX * zoom, y: (h - height * zoom) / 2 - rect.minY * zoom });
  }

  /** Fits every node on screen. */
  fit() {
    const bounds = this.graph.bounds();
    if (bounds) this.fitRect(bounds);
  }

  toWorld(cssX: number, cssY: number) {
    return { x: (cssX - this.view.x) / this.view.zoom, y: (cssY - this.view.y) / this.view.zoom };
  }

  toScreen(x: number, y: number) {
    return { x: x * this.view.zoom + this.view.x, y: y * this.view.zoom + this.view.y };
  }

  nodeAt(cssX: number, cssY: number) {
    const p = this.toWorld(cssX, cssY);
    return this.index.at(p.x, p.y);
  }

  /** Nodes whose rectangle overlaps a rectangle (flow units). */
  nodesWithin(x0: number, y0: number, x1: number, y1: number): number[] {
    return this.index.within(x0, y0, x1, y1);
  }

  /** Nodes on screen, with a margin in screens (0.25 = a quarter screen each side). */
  visible(margin = 0): number[] {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const a = this.toWorld(-w * margin, -h * margin), b = this.toWorld(w * (1 + margin), h * (1 + margin));
    return this.index.within(a.x, a.y, b.x, b.y);
  }

  /** Pointer position in the canvas's css pixels, whatever element the event came from. */
  local(event: MouseEvent) {
    const box = this.canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  private noteInput(event: Event) {
    this.lastInputAt = performance.now();
    this.callbacks.onInput?.();
    // Injected input can carry a timestamp from another clock; then the time it reached the page stands in.
    const now = performance.now();
    if (!this.pendingInputAt) this.pendingInputAt = event.timeStamp <= now && now - event.timeStamp < 1000 ? event.timeStamp : now;
  }

  /** Public so the live layer can hand presses and wheels over live nodes to the scene. */
  pointerDown = (event: PointerEvent) => this.onPointerDown(event);
  wheel = (event: WheelEvent) => this.onWheel(event);

  private onPointerDown = (event: PointerEvent) => {
    if (this.gesture) return;
    this.lastInputAt = performance.now();
    this.callbacks.onInput?.();
    // The owner decides what a press does (select, drag, connect, marquee); by default a drag pans.
    const gesture = this.callbacks.onPress ? this.callbacks.onPress(event) : event.button === 0 || event.button === 1 ? this.panGesture(event) : null;
    if (!gesture) return;
    this.canvas.setPointerCapture?.(event.pointerId);
    this.gesture = gesture;
  };

  /** A gesture that pans the view with the pointer. */
  panGesture(event: PointerEvent): Gesture {
    let x = event.clientX, y = event.clientY;
    return {
      move: (move) => {
        const dx = move.clientX - x, dy = move.clientY - y;
        x = move.clientX;
        y = move.clientY;
        if (dx || dy) {
          this.noteInput(move);
          this.setView({ x: this.view.x + dx, y: this.view.y + dy });
        }
      },
      up: () => {},
      cancel: () => {},
    };
  }

  /** Records a pointer event as input for the latency figures (gestures call it as they move things). */
  input(event: Event) {
    this.noteInput(event);
  }

  /** Ends the gesture in progress, if any (a key cancels it, the canvas is replaced). */
  cancelGesture() {
    const gesture = this.gesture;
    this.gesture = null;
    gesture?.cancel();
  }

  private onPointerMove = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (!gesture) {
      const at = this.local(event);
      this.setHovered(this.nodeAt(at.x, at.y));
      this.callbacks.onIdleMove?.(event);
      return;
    }
    gesture.move(event);
  };

  private onPointerUp = (event: PointerEvent) => {
    const gesture = this.gesture;
    this.gesture = null;
    if (!gesture) return;
    if (event.type === "pointercancel") gesture.cancel();
    else gesture.up(event);
  };

  private onContextMenu = (event: MouseEvent) => {
    this.callbacks.onContextMenu?.(event);
  };

  private onPointerLeave = () => {
    if (!this.gesture) this.setHovered(-1);
  };

  private onDoubleClick = (event: MouseEvent) => {
    const at = this.local(event);
    const hit = this.nodeAt(at.x, at.y);
    if (hit >= 0) this.callbacks.onOpen?.(hit);
    else {
      const p = this.toWorld(at.x, at.y);
      this.callbacks.onPaneDoubleClick?.(p.x, p.y, { x: event.clientX, y: event.clientY });
    }
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.noteInput(event);
    const pinch = event.ctrlKey && !event.altKey;
    if (pinch || this.callbacks.wheelZooms?.(event)) {
      const lines = event.deltaMode === 1 ? 40 : 1;
      const zoom = this.view.zoom * Math.exp(-event.deltaY * lines * (pinch ? 0.01 : 0.002));
      const at = this.local(event);
      const p = this.toWorld(at.x, at.y);
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
      this.setView({ zoom: z, x: at.x - p.x * z, y: at.y - p.y * z });
    } else {
      const lines = event.deltaMode === 1 ? 40 : 1;
      const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
      const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
      this.setView({ x: this.view.x - dx * lines, y: this.view.y - dy * lines });
    }
  };

  private resize() {
    const { canvas } = this;
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.uniforms.uViewport.value.set(canvas.clientWidth, canvas.clientHeight);
    this.uniforms.uDpr.value = devicePixelRatio;
    this.dirty = true;
    for (const listener of this.viewListeners) listener();
  }

  /** Device pixels per css px of the canvas's backing store. */
  get scale() {
    return this.canvas.width / (this.canvas.clientWidth || 1) || devicePixelRatio;
  }

  private tick = (now: number) => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.tick);
    let jsMs = 0;
    if (this.dirty) {
      const start = performance.now();
      this.dirty = false;
      this.uniforms.uView.value.set(this.view.x, this.view.y, this.view.zoom);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      jsMs = performance.now() - start;
      if (this.pendingInputAt) {
        this.callbacks.onInputLatency?.(now - this.pendingInputAt);
        this.pendingInputAt = 0;
      }
    }
    this.callbacks.onFrame?.(now, jsMs);
  };

  /** Draw calls and triangles in the last frame. */
  info() {
    return { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameHandle);
    this.resizeObserver.disconnect();
    const { canvas } = this;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    canvas.removeEventListener("wheel", this.onWheel);
    for (const mesh of this.graphMeshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.renderer.dispose();
  }
}
