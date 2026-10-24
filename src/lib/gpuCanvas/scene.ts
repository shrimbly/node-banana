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
import { getViewportForBounds } from "@xyflow/react";
import { GridIndex, NODE_HEADER, type SceneGraph, type SceneNode } from "./graph";
import { cubicArcLength, cubicLength, cubicPieces, distanceToCubic, routeGradientRange, type Cubic, type EdgeRoute } from "./edgeRoutes";
import { easeCubicInOut, zoomPath } from "./viewPath";
import type { SceneWheel } from "./wheel";
import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM } from "@/lib/canvasZoom";
import { GROUP_FILL_ALPHA } from "@/utils/groupColors";
import { clampTrail, stepTrail, type TrailPoint } from "./trail";

/**
 * Floats per node instance: rect (4), uv rect (4), colour (3), flags (1), layer (1), the node's own box within the
 * rect (4), opacity (1), its controls card's trail offset (2, flow units: classic's useTrailingOffset), its media
 * card's box within the rect (4).
 */
const NODE_STRIDE = 24;
const FLAG_SELECTED = 1, FLAG_HOVERED = 2, FLAG_HIDDEN = 4, FLAG_GROUP = 8, FLAG_PAINTED = 16, FLAG_RUNNING = 32;
/** A painted node whose floating header the live layer shows (a live node covers it): the header pass skips it. */
const FLAG_HEADER_LIVE = 64;
/**
 * Floats per edge instance, one cubic segment of a connection: the cubic (8),
 * colour (3), flags (1), width (1), length along the edge where it starts (1)
 * and its own length (1), the edge's x range for the gradient (2), unused (3).
 */
const EDGE_STRIDE = 20;
/**
 * Spare instances laid out after each edge's pieces: a route that gains a piece or a stem (a node turning live or
 * selected, an end moved) is written in place, instead of laying out every edge's buffer again.
 */
const EDGE_SPARE_PIECES = 2;
const EDGE_SEGMENTS = 24;
const EDGE_SELECTED = 1, EDGE_HOVERED = 2, EDGE_ACTIVE = 4, EDGE_HIDDEN = 8, EDGE_DASHED = 16, EDGE_STEM = 32;
/**
 * The longest stretch (flow units) one instance of the strip draws: a longer cubic is cut into pieces, so
 * its chords stay a few css px at the largest zoom (a 24-piece strip over 96 units, 16 px at 4x).
 */
const EDGE_PIECE = 96;
/** At most this many pieces to a cubic. */
const EDGE_MAX_PIECES = 16;
const piecesOf = new WeakMap<EdgeRoute, Cubic[]>();
/** A route's noodle as the scene draws it: each cubic cut by length (a dashed route comes cut already). */
function drawnPieces(route: EdgeRoute): Cubic[] {
  let pieces = piecesOf.get(route);
  if (!pieces) {
    pieces = route.dashed ? route.segments : route.segments.flatMap((c) => (cubicLength(c) <= EDGE_PIECE ? [c] : cubicPieces(c, EDGE_PIECE, EDGE_MAX_PIECES)));
    piecesOf.set(route, pieces);
  }
  return pieces;
}
/** The segment starts or ends its connection, and so takes a round cap there (joints inside a route take none, or they would overlap and darken). */
export const EDGE_CAP_START = 64, EDGE_CAP_END = 128;
/** How long a node's opacity takes to change (classic's .switch-dimmed / .node-skipped transition). */
const FADE_MS = 250;
/** How near (css px) past its stroke a press must be to a connection to take it, at least. */
const EDGE_HIT_PX = 7;
/** How near (flow units) a press must be to a connection's centre line: half React Flow's default interactionWidth (20). */
const EDGE_HIT_FLOW = 10;
/** The same for a bundle's stem, past its stroke: its hit path is 12 wider than it (EditableEdge's BundleStem). */
const STEM_HIT_FLOW = 6;

export const MIN_ZOOM = CANVAS_MIN_ZOOM;
export const MAX_ZOOM = CANVAS_MAX_ZOOM;

/**
 * The offset (flow units) that moves flow coordinate `at`, drawn at `zoom` css px per unit after a translation of
 * `translate` css px, onto the nearest whole css pixel: NODE_VERTEX's snap, for the live nodes to match it.
 */
export function pixelSnap(at: number, zoom: number, translate: number): number {
  const origin = at * zoom + translate;
  return (Math.floor(origin + 0.5) - origin) / zoom;
}

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

/** --color-selection (#3b82f6). */
const SELECTION_GLSL = "const vec3 SELECTION = vec3(0.231, 0.510, 0.965);";

const NODE_VERTEX = /* glsl */ `
  precision highp float;
  ${COMMON}
  uniform float uPad;
  in vec2 position;
  in vec4 iRect;
  in vec4 iUv;
  in vec3 iColor;
  in float iFlags;
  in float iLayer;
  in vec4 iBox;
  in float iAlpha;
  in vec4 iCard;
  in vec2 iTrail;
  out vec2 vLocal;
  out vec2 vSize;
  out vec4 vUv;
  out vec3 vColor;
  flat out int vFlags;
  flat out float vLayer;
  flat out vec4 vBox;
  flat out float vAlpha;
  flat out vec4 vCard;
  flat out vec2 vTrail;
  void main() {
    vFlags = int(iFlags);
    vBox = iBox;
    vAlpha = iAlpha;
    vCard = iCard;
    vTrail = iTrail;
    if ((vFlags & ${FLAG_HIDDEN}) != 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // Room for the outline and antialiasing (and the running halo, for its pass).
    float pad = uPad / uView.z;
    // A trailing controls card is drawn up to its offset outside the image.
    vec2 lo = min(iTrail, 0.0) - pad, hi = iRect.zw + max(iTrail, 0.0) + pad;
    vec2 local = mix(lo, hi, position);
    vLocal = local; vSize = iRect.zw; vUv = iUv; vColor = iColor; vLayer = iLayer;
    // The node starts on a whole pixel, as the page lays it out, so a painted
    // image at its own scale is copied texel for pixel rather than blurred.
    // The live layer moves a live node by the same offset (pixelSnap).
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
  uniform float uHeaderPass;
  in vec2 vLocal;
  in vec2 vSize;
  in vec4 vUv;
  in vec3 vColor;
  flat in int vFlags;
  flat in float vLayer;
  flat in vec4 vBox;
  flat in float vAlpha;
  flat in vec4 vCard;
  flat in vec2 vTrail;
  out vec4 outColor;
  float box(vec2 p, vec2 half_, float r) { vec2 q = abs(p) - half_ + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  ${SELECTION_GLSL}
  // A painted image is drawn at the smallest tier at least as sharp as the view, so up to two
  // texels fall on a pixel. One bilinear tap there skips thin borders and text stems by phase,
  // and they shimmer while zooming; four taps spread over the pixel's footprint (a box of up to
  // 4×4 texels) keep them as the browser's own rasterisation does. At the tier's own scale a
  // pixel is one texel and the single, pixel-snapped tap stays. Taps are kept inside the slot.
  vec4 paintedColor(vec2 uv, vec2 uvPerPx) {
    vec2 texSize = vec2(textureSize(uPainted, 0).xy);
    vec2 fp = uvPerPx * texSize;   // texels per device pixel
    if (max(fp.x, fp.y) <= 1.001) return texture(uPainted, vec3(uv, vLayer));
    vec2 halfTexel = 0.5 / texSize;
    vec2 lo = min(vUv.xy, vUv.zw) + halfTexel, hi = max(lo, max(vUv.xy, vUv.zw) - halfTexel);
    vec2 o = 0.25 * max(fp, 1.0) / texSize;
    return 0.25 * (
      texture(uPainted, vec3(clamp(uv + vec2(-o.x, -o.y), lo, hi), vLayer)) +
      texture(uPainted, vec3(clamp(uv + vec2(o.x, -o.y), lo, hi), vLayer)) +
      texture(uPainted, vec3(clamp(uv + vec2(-o.x, o.y), lo, hi), vLayer)) +
      texture(uPainted, vec3(clamp(uv + vec2(o.x, o.y), lo, hi), vLayer)));
  }
  void main() {
    float px = 1.0 / uView.z;   // flow units per css pixel
    // The image's texture coordinates per device pixel, taken here, before any branch or discard, so the derivatives are defined.
    vec2 uvLocal = mix(vUv.xy, vUv.zw, vLocal / vSize);
    vec2 uvPerPx = max(abs(dFdx(uvLocal)), abs(dFdy(uvLocal)));
    if ((vFlags & ${FLAG_GROUP}) != 0) {
      vec2 half_ = vSize * 0.5;
      float d = box(vLocal - half_, half_, 12.0);
      // Classic's faint wash with no outline (groupFill).
      float inside = clamp(0.5 - d / px, 0.0, 1.0);
      outColor = vec4(vColor, inside * ${GROUP_FILL_ALPHA.toFixed(3)});
      return;
    }
    // The header pass draws painted nodes' floating headers over every node, as classic's sit above the nodes (z-index 1500).
    bool header = vLocal.y < vBox.y;
    if (uHeaderPass > 0.5 && (!header || (vFlags & ${FLAG_PAINTED}) == 0 || (vFlags & ${FLAG_HEADER_LIVE}) != 0)) discard;
    if ((vFlags & ${FLAG_PAINTED}) != 0) {
      // The image holds the node, its header and its margin; the outline is drawn by the live node's own frame when selected.
      // The body pass leaves the header (above the node's box) to the header pass.
      if (header && uHeaderPass < 0.5) discard;
      vec2 at = vLocal, uv = uvLocal;
      if (vTrail != vec2(0.0)) {
        // Classic's controls card trails the moving node (useTrailingOffset): what lies below the media card (the
        // gap row and the controls) is drawn offset, over the media card where they meet, as it comes later in the DOM.
        float below = vCard.y + vCard.w;
        vec2 from = vLocal - vTrail;
        if (from.y >= below && all(greaterThanEqual(from, vec2(0.0))) && all(lessThanEqual(from, vSize))) {
          at = from;
          uv = uvLocal - (vUv.zw - vUv.xy) * vTrail / vSize;
        } else if (vLocal.y >= below) discard;
      }
      if (any(lessThan(at, vec2(0.0))) || any(greaterThan(at, vSize))) discard;
      outColor = paintedColor(uv, uvPerPx);
      // A dimmed node fades as classic's node element does; its floating header, above it, does not.
      if (!header) outColor.a *= vAlpha;
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
    if ((vFlags & ${FLAG_SELECTED}) != 0) {
      float ring = clamp(1.0 - abs(d - 1.5 * px) / (1.5 * px), 0.0, 1.0);
      color = mix(color, SELECTION, ring);
      alpha = max(alpha, ring);
    }
    outColor = vec4(color, alpha * vAlpha);
  }
`;

/**
 * A selected painted node's outline, drawn after the nodes (it shows only while the node is swapping in, as a
 * selected node is live): classic's on the media card (NodeShell), a 1px border in the selection colour, a 2px
 * ring at 40% and shadow-lg at 25% (0 10px 15px -3px and 0 4px 6px -4px), outside the card.
 */
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
  flat in float vAlpha;
  flat in vec4 vCard;
  out vec4 outColor;
  float box(vec2 p, vec2 half_, float r) { vec2 q = abs(p) - half_ + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  ${SELECTION_GLSL}
  void main() {
    if ((vFlags & ${FLAG_PAINTED}) == 0 || (vFlags & ${FLAG_SELECTED}) == 0) discard;
    float px = 1.0 / uView.z;
    // The media card's rectangle within the painted quad (flow units are the node's css px).
    vec2 half_ = vCard.zw * 0.5;
    vec2 p = vLocal - vCard.xy - half_;
    float d = box(p, half_, 12.0);
    float inside = clamp(0.5 - d / px, 0.0, 1.0);
    float border = inside * clamp(0.5 + (d + 1.0) / px, 0.0, 1.0);
    float ring = (1.0 - inside) * clamp(0.5 - (d - 2.0) / px, 0.0, 1.0) * 0.4;
    // Each shadow is its shape (offset, shrunk by its spread) blurred over its blur radius.
    float lg = 1.0 - smoothstep(-15.0, 15.0, box(p - vec2(0.0, 10.0), max(half_ - 3.0, 0.0), 9.0));
    float sm = 1.0 - smoothstep(-6.0, 6.0, box(p - vec2(0.0, 4.0), max(half_ - 4.0, 0.0), 8.0));
    float shadow = (1.0 - inside) * (1.0 - (1.0 - lg * 0.25) * (1.0 - sm * 0.25));
    float alpha = max(border, 1.0 - (1.0 - shadow) * (1.0 - ring)) * vAlpha;
    if (alpha <= 0.0) discard;
    outColor = vec4(SELECTION, alpha);
  }
`;

/**
 * A running node seen zoomed out, past the low-detail zoom: a tint over the node and a 12 px halo around it, pulsing
 * between 35% and full strength every 0.9 s; held at 80% under reduced motion.
 */
const HALO_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform vec3 uView;
  uniform float uTime;
  uniform float uMotion;
  in vec2 vLocal;
  in vec2 vSize;
  in vec4 vUv;
  in vec3 vColor;
  flat in int vFlags;
  flat in float vLayer;
  flat in vec4 vBox;
  flat in float vAlpha;
  flat in vec4 vCard;
  out vec4 outColor;
  float box(vec2 p, vec2 half_, float r) { vec2 q = abs(p) - half_ + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  void main() {
    if ((vFlags & ${FLAG_RUNNING}) == 0) discard;
    float px = 1.0 / uView.z;
    vec2 half_ = vBox.zw * 0.5;
    float d = box(vLocal - vBox.xy - half_, half_, 12.0);
    float inside = clamp(0.5 - d / px, 0.0, 1.0);
    float halo = clamp(0.5 - (d - 12.0 * px) / px, 0.0, 1.0) * (1.0 - inside);
    float alpha = inside * 0.4 + halo * 0.6;
    if (alpha <= 0.0) discard;
    // 0.9 s each way; smoothstep stands in for the CSS ease.
    float phase = mod(uTime / 0.9, 2.0);
    float pulse = mix(0.35, 1.0, smoothstep(0.0, 1.0, phase < 1.0 ? phase : 2.0 - phase));
    outColor = vec4(0.231, 0.510, 0.965, alpha * (uMotion > 0.5 ? pulse : 0.8));
  }
`;

const EDGE_VERTEX = /* glsl */ `
  precision highp float;
  ${COMMON}
  in vec3 position;         // x: t along the segment, y: side (-1, 1), z: -1/1 on the rows past its start/end
  in vec4 iA;               // start, first control
  in vec4 iB;               // second control, end
  in vec3 iColor;
  in float iFlags;
  in float iWidth;
  in vec2 iLength;          // where the segment starts along its edge, its length
  in vec2 iRange;           // the edge's x range
  uniform float uDpr;
  out float vSide;
  out float vCap;
  out vec3 vColor;
  out float vAlong;
  out float vX;
  out float vHalf;
  out float vThin;
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
    // As wide as the SVG stroke (flow units), never under a css pixel; a device pixel more for the edge's
    // antialiasing, which is measured in device pixels as the browser rasterises an SVG stroke.
    float css = 1.0 / uView.z;
    float dev = css / uDpr;
    float half_ = max(iWidth, css) * 0.5;
    vHalf = half_ / dev;
    // A stroke under a css pixel is drawn a pixel wide but as faint as its share of it (an SVG hairline).
    vThin = clamp(iWidth * uView.z, 0.0, 1.0);
    float reach = half_ + dev;
    vSide = position.y * reach / dev;
    vColor = iColor;
    vAlong = iLength.x + iLength.y * t;
    vX = p.x;
    vRange = iRange;
    // Round caps: the connection's ends reach past it by half the width and the antialiasing pixel, on rows of
    // their own so the distance past the end interpolates exactly (its inner joints meet edge to edge).
    float capped = position.z < 0.0 ? ((vFlags & ${EDGE_CAP_START}) != 0 ? -1.0 : 0.0)
      : position.z > 0.0 ? ((vFlags & ${EDGE_CAP_END}) != 0 ? 1.0 : 0.0) : 0.0;
    vCap = abs(capped) * reach / dev;
    vAlong += capped * reach;
    gl_Position = toClip(p + dir * capped * reach + vec2(-dir.y, dir.x) * position.y * reach);
  }
`;

const EDGE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform float uGradient;
  uniform float uFaded;
  uniform vec3 uView;
  uniform float uDpr;
  in float vSide;
  in float vCap;
  in vec3 vColor;
  in float vAlong;
  in float vX;
  in float vHalf;
  in float vThin;
  flat in int vFlags;
  flat in vec2 vRange;
  out vec4 outColor;
  void main() {
    // Device pixels past the stroke's end along it (a round cap: coverage falls with the distance from the end).
    float outside = vCap;
    if ((vFlags & ${EDGE_DASHED}) != 0) {
      // Dashes of 6 and gaps of 4 flow units with round caps (reference links' "6 4" and round linecap):
      // each dash a capsule, its ends reaching half the width into the gaps.
      float d = mod(vAlong, 10.0);
      outside = max(outside, (d > 6.0 ? min(d - 6.0, 10.0 - d) : 0.0) * uView.z * uDpr);
    }
    float coverage = clamp(vHalf + 0.5 - length(vec2(outside, vSide)), 0.0, 1.0);
    if (coverage <= 0.0) discard;
    bool isActive = (vFlags & ${EDGE_ACTIVE}) != 0;
    bool highlight = (vFlags & (${EDGE_SELECTED} | ${EDGE_HOVERED})) != 0;
    float alpha;
    if ((vFlags & ${EDGE_STEM}) == 0 && uGradient > 0.5) {
      // The shared gradient: bright ends, a softer middle, across the edge's bounding box.
      float span = max(vRange.y - vRange.x, 1e-3);
      float pos = clamp((vX - vRange.x) / span, 0.0, 1.0);
      vec3 stops = isActive || highlight ? vec3(1.0, 0.55, 1.0) : vec3(uFaded, uFaded * 0.4, uFaded);
      alpha = pos < 0.5 ? mix(stops.x, stops.y, pos * 2.0) : mix(stops.y, stops.z, (pos - 0.5) * 2.0);
    } else alpha = isActive || highlight ? 1.0 : uFaded;
    outColor = vec4(vColor, alpha * coverage * vThin);
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
  uniform float uGridAlpha;
  out vec4 outColor;
  void main() {
    vec2 css = vec2(gl_FragCoord.x, uViewport.y * uDpr - gl_FragCoord.y) / uDpr;
    float z = uView.z;
    vec2 world = (css - uView.xy) / z;
    // React Flow's <Background gap={20} size={1}>: a pattern shifted back by 1 + gap/2 css px, each dot a
    // circle of radius size/2 flow units at its tile's corner, so the dots sit a little over half a cell off
    // the multiples of 20 and grow and shrink with the zoom.
    float origin = -10.0 - (1.0 - 0.5 * z) / z;
    // One dot every 20 flow units at every zoom, as React Flow's gap: zoomed out they crowd into a faint texture.
    float spacing = 20.0;
    vec2 cell = mod(world - origin + spacing * 0.5, spacing) - spacing * 0.5;
    // In device pixels, antialiased over one; a dot under a pixel fades by its area, as the SVG's does.
    float r = 0.5 * z * uDpr;
    float d = length(cell) * z * uDpr;
    float dot_ = (1.0 - smoothstep(r - 0.5, r + 0.5, d)) * min(1.0, 4.0 * r * r);
    // bg-neutral-900 with #404040 dots, as the canvas draws them (at uGridAlpha: the tutorial dims them).
    outColor = vec4(mix(vec3(0.090, 0.090, 0.090), vec3(0.251), dot_ * uGridAlpha), 1.0);
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
  /** The node a point (css px) hovers, when more than its box does (its sockets, a little outside it): nodeAt otherwise. */
  hoverAt?: (cssX: number, cssY: number) => number;
  /**
   * A press on the canvas (or handed over by the live layer): returns the
   * gesture it starts, or null to ignore it. Without it a drag pans.
   */
  onPress?: (event: PointerEvent) => Gesture | null;
  /** The pointer moved with no gesture under way (hover). */
  onIdleMove?: (event: PointerEvent) => void;
  /**
   * Hover over handles and connections ends until the next idle move: the pointer left the canvas
   * ("leave"), a gesture is moving ("gesture") or a wheel moved the view ("wheel"), as classic's edges
   * and nodes take no pointer events while the canvas is interacting or wheel-navigating.
   */
  onHoverEnd?: (reason: "leave" | "gesture" | "wheel") => void;
  onContextMenu?: (event: MouseEvent) => void;
  /**
   * Whether a point (css px) is the pane's for a double-click: without it, no node (or its header band) is
   * under it. A locked canvas's node bodies let the pointer through to the pane, as classic's.
   */
  paneAt?: (cssX: number, cssY: number) => boolean;
  /** A double-click on empty canvas, at a flow position (one on a node is the node's own, as on classic). */
  onPaneDoubleClick?: (x: number, y: number, screen: { x: number; y: number }) => void;
  onViewChange?: (view: View) => void;
  /** The zoom below which running nodes show a halo (0: never). */
  runningHaloBelow?: () => number;
  /** A drag or wheel on the canvas (not a bare press): the user is navigating. */
  onInput?: () => void;
  /** ms from an input event to the frame that drew its effect (the page's own part of input latency). */
  onInputLatency?: (ms: number) => void;
  /**
   * What a wheel does (the canvas's navigation settings); without it every wheel pans. `pane` is false
   * for one over chrome beside the canvas, which classic's wrapper handler alone sees.
   */
  wheel?: (event: WheelEvent, pane: boolean) => SceneWheel;
  /** Whether two fingers pinch to zoom (React Flow's zoomOnPinch); on when not given. */
  pinchZooms?: () => boolean;
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
  private viewAnimation = 0;
  private viewListeners = new Set<() => void>();
  private layoutListeners = new Set<() => void>();
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private uniforms = { uViewport: { value: new THREE.Vector2() }, uView: { value: new THREE.Vector3() }, uDpr: { value: 1 } };
  private nodeData = new Float32Array(0);
  private nodeAttr: THREE.InstancedInterleavedBuffer | null = null;
  private nodeUniforms: Record<string, THREE.IUniform> = { ...this.uniforms, uPainted: { value: EMPTY_ARRAY }, uPad: { value: 3 }, uHeaderPass: { value: 0 } };
  /** The node pass's own uniforms (the painted texture is the same one), drawing only headers. */
  private headerUniforms: Record<string, THREE.IUniform> = { ...this.nodeUniforms, uHeaderPass: { value: 1 } };
  /** Room past a painted node's quad for its selection shadow below the card. */
  private outlineUniforms: Record<string, THREE.IUniform> = { ...this.uniforms, uPad: { value: 24 } };
  private haloUniforms: Record<string, THREE.IUniform> = { ...this.uniforms, uPad: { value: 16 }, uTime: { value: 0 }, uMotion: { value: 1 } };
  private haloMesh: THREE.Mesh | null = null;
  /** Nodes a run is on, by id (they keep it across graph rebuilds). */
  private running = new Set<string>();
  /** Nodes not at full opacity, or fading to or from it, by id: they keep it across graph rebuilds. */
  private fades = new Map<string, { from: number; to: number; start: number }>();
  private reducedMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  private edgeData = new Float32Array(0);
  private edgeAttr: THREE.InstancedInterleavedBuffer | null = null;
  private edgeGeometry: THREE.InstancedBufferGeometry | null = null;
  private edgeUniforms: Record<string, THREE.IUniform> = { ...this.uniforms, uGradient: { value: 0 }, uFaded: { value: 1 } };
  private gridUniforms: Record<string, THREE.IUniform> = { ...this.uniforms, uGridAlpha: { value: 1 } };
  /** Each edge's route, and where its segments start in the instance buffer. */
  private routes: (EdgeRoute | null)[] = [];
  private routeOffset: number[] = [];
  private routeCount: number[] = [];
  /** Each edge's bounds (flow units), for hit tests. */
  private edgeBounds = new Float32Array(0);
  private edgeSelected = new Set<number>();
  /** Edges the live layer draws (decorated ones on screen). */
  private edgeLive = new Set<number>();
  /** The edge whose end is being dragged to reconnect it: not drawn meanwhile, as React Flow hides it. */
  private edgeHeld = -1;
  private hoveredEdge = -1;

  private graphMeshes: THREE.Mesh[] = [];
  private painted = new Map<number, PaintedQuad>();
  /**
   * Painted nodes whose controls card is trailing after a move from the store (a group's header drag, arrange,
   * undo): the smoothed position it eases from (trail.ts). Live nodes trail themselves (NodeShell).
   */
  private trails = new Map<number, TrailPoint>();
  private trailTime = 0;
  /** Each node's position as last drawn (x, y per node): where a trail starts from. */
  private drawnAt = new Float64Array(0);
  private hidden = new Set<number>();
  /** Nodes (by id) drawn as nothing rather than as the stand-in card until their painted image lands (holdStandIn). */
  private standInHeld = new Set<string>();
  /** Painted nodes whose header the live layer shows (setHeadersLive). */
  private headersLive = new Set<number>();
  private selected = new Set<number>();
  private hovered = -1;
  private index: GridIndex;
  private dirty = true;
  private backingScale = 1;
  /** For runners isolating page costs from the GPU's: the view and its listeners run, nothing is drawn. */
  drawing = true;
  private haloWasShown = false;
  private frameHandle = 0;
  private disposed = false;
  private gesture: Gesture | null = null;
  /** The pointer the gesture follows: another one (a second finger) neither moves nor ends it. */
  private gesturePointer = -1;
  /** Fingers down (client px), followed through the window wherever they press. */
  private touches = new Map<number, { x: number; y: number }>();
  /**
   * A pinch under way, as d3-zoom's touch zoom on classic: two fingers zoom about their midpoint and
   * pan with it, one left pans, until the last lifts. Anchored again whenever a finger comes or goes.
   */
  private pinch: { mid: { x: number; y: number }; distance: number; view: View } | null = null;
  private stopFollowingTouches: (() => void) | null = null;
  /** The mouse over the canvas (client px), for hover under a still pointer as the view moves; null once it leaves. */
  private pointerAt: { clientX: number; clientY: number } | null = null;
  private hoverStale = false;
  /** A press handed over by the live layer and not captured yet: its moves and release come through the window. */
  private uncaptured: { pointerId: number; off: () => void } | null = null;
  /** Lifts the block on text selection and native drags a gesture holds (blockNativeDrag). */
  private nativeDragBlock: (() => void) | null = null;
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
    this.index = new GridIndex(graph.nodes, 512, NODE_HEADER);
    this.placeAll();

    const grid = new THREE.BufferGeometry();
    grid.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 3, -1, -1, 3], 2));
    this.add(new THREE.Mesh(grid, material(GRID_VERTEX, GRID_FRAGMENT, this.gridUniforms, false)), 0);
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
    return this.gesture !== null || this.pinch !== null;
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
      graph.groups.forEach((g, i) => data.set([g.x, g.y, g.w, g.h, 0, 0, 0, 0, ...g.color, FLAG_GROUP, 0, 0, 0, g.w, g.h, 1], i * NODE_STRIDE));
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
    this.addGraphMesh(new THREE.Mesh(geometry, material(NODE_VERTEX, OUTLINE_FRAGMENT, this.outlineUniforms)), 4);
    // And again for painted nodes' floating headers, over every node and its outline.
    this.addGraphMesh(new THREE.Mesh(geometry, material(NODE_VERTEX, NODE_FRAGMENT, this.headerUniforms)), 4.5);
    // And again for running nodes' halos, shown only zoomed out.
    this.haloMesh = new THREE.Mesh(geometry, material(NODE_VERTEX, HALO_FRAGMENT, this.haloUniforms));
    this.addGraphMesh(this.haloMesh, 5);
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
    geometry.setAttribute("iAlpha", new THREE.InterleavedBufferAttribute(attr, 1, 17));
    geometry.setAttribute("iTrail", new THREE.InterleavedBufferAttribute(attr, 2, 18));
    geometry.setAttribute("iCard", new THREE.InterleavedBufferAttribute(attr, 4, 20));
    geometry.instanceCount = count;
    return { geometry, attr };
  }

  private writeNode(i: number) {
    const node = this.graph.nodes[i];
    const painted = this.painted.get(i), alpha = this.opacityOf(node.id, performance.now());
    let flags = this.hidden.has(i) || (!painted && this.standInHeld.has(node.id)) ? FLAG_HIDDEN : 0;
    if (this.selected.has(i)) flags |= FLAG_SELECTED;
    if (this.hovered === i) flags |= FLAG_HOVERED;
    if (this.running.has(node.id)) flags |= FLAG_RUNNING;
    if (this.headersLive.has(i)) flags |= FLAG_HEADER_LIVE;
    // The media card's box, once measured (the node's own box until then).
    const card = node.card ?? { x: 0, y: 0, w: node.w, h: node.h };
    if (painted) {
      const trail = this.hidden.has(i) ? undefined : this.trails.get(i);
      this.nodeData.set([node.x + painted.x, node.y + painted.y, painted.w, painted.h, painted.u0, painted.v0, painted.u1, painted.v1,
        ...node.color, flags | FLAG_PAINTED, painted.layer, -painted.x, -painted.y, node.w, node.h, alpha,
        trail ? trail.x - node.x : 0, trail ? trail.y - node.y : 0,
        card.x - painted.x, card.y - painted.y, card.w, card.h], i * NODE_STRIDE);
      return;
    }
    this.nodeData.set([node.x, node.y, node.w, node.h, 0, 0, 0, 0, ...node.color, flags, 0, 0, 0, node.w, node.h, alpha, 0, 0,
      card.x, card.y, card.w, card.h], i * NODE_STRIDE);
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
    this.edgesResized = false;
    const { graph } = this;
    if (!this.edgeGeometry) {
      // Rows of (t, side, cap): a cap row before t = 0 and after t = 1, which the vertex shader pushes out
      // past a capped end and folds onto the end otherwise.
      const strip: number[] = [], indices: number[] = [];
      const rows = [[0, -1], ...Array.from({ length: EDGE_SEGMENTS + 1 }, (_, i) => [i / EDGE_SEGMENTS, 0]), [1, 1]];
      rows.forEach(([t, cap], i) => {
        strip.push(t, -1, cap, t, 1, cap);
        if (i < rows.length - 1) indices.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
      });
      this.edgeGeometry = new THREE.InstancedBufferGeometry();
      this.edgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(strip, 3));
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
      this.routeCount[e] = drawnPieces(route).length + route.stems.length + EDGE_SPARE_PIECES;
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
    const ends = this.graph.edgeEnds(e);
    if (!ends) return { segments: [], stems: [], ends: [0, 0, 0, 0], labelX: 0, labelY: 0, width: 3, dashed: false, hidden: false, decorated: false, running: false, unresolved: true };
    const [sx, sy, tx, ty] = ends;
    const d = tx - sx, off = d >= 0 ? 0.5 * d : 0.25 * 25 * Math.sqrt(-d);
    const segment: Cubic = [sx, sy, sx + off, sy, tx - off, ty, tx, ty];
    return { segments: [segment], stems: [], ends: [sx, sy, tx, ty], labelX: (sx + tx) / 2, labelY: (sy + ty) / 2, width: 3, dashed: false, hidden: false, decorated: false, running: false };
  }

  private writeEdge(e: number) {
    const route = this.routes[e];
    if (!route) return;
    const edge = this.graph.edges[e];
    let flags = route.hidden || this.edgeLive.has(e) || this.edgeHeld === e ? EDGE_HIDDEN : 0;
    if (this.edgeSelected.has(e)) flags |= EDGE_SELECTED;
    if (this.hoveredEdge === e) flags |= EDGE_HOVERED;
    if (this.selected.has(edge.source) || this.selected.has(edge.target)) flags |= EDGE_ACTIVE;
    if (route.dashed) flags |= EDGE_DASHED;
    const [sx, sy, tx, ty] = route.ends;
    let minX = Math.min(sx, tx), maxX = Math.max(sx, tx), minY = Math.min(sy, ty), maxY = Math.max(sy, ty);
    // The gradient spans the noodle's own tight extent (routeGradientRange).
    const [gradientMin, gradientMax] = routeGradientRange(route);
    for (const c of route.segments) for (let k = 0; k < 8; k += 2) {
      minX = Math.min(minX, c[k]); maxX = Math.max(maxX, c[k]);
      minY = Math.min(minY, c[k + 1]); maxY = Math.max(maxY, c[k + 1]);
    }
    let at = this.routeOffset[e] * EDGE_STRIDE, along = 0;
    const [r, g, b] = edge.color;
    const pieces = drawnPieces(route), last = pieces.length - 1;
    pieces.forEach((c, k) => {
      // Dashes are laid out by true arc length (a dashed route comes in short pieces, near even in speed).
      const length = route.dashed ? cubicArcLength(c) : cubicLength(c);
      const caps = (k === 0 ? EDGE_CAP_START : 0) | (k === last ? EDGE_CAP_END : 0);
      this.edgeData.set(c, at);
      this.edgeData.set([r, g, b, flags | caps, route.width, along, length, gradientMin, gradientMax], at + 8);
      along += length;
      at += EDGE_STRIDE;
    });
    for (const stem of route.stems) {
      this.edgeData.set(stem.segment, at);
      this.edgeData.set([r, g, b, (flags & ~EDGE_DASHED) | EDGE_STEM | EDGE_CAP_START | EDGE_CAP_END, stem.width, 0, cubicLength(stem.segment), 0, 1], at + 8);
      for (let k = 0; k < 8; k += 2) {
        minX = Math.min(minX, stem.segment[k]); maxX = Math.max(maxX, stem.segment[k]);
        minY = Math.min(minY, stem.segment[k + 1]); maxY = Math.max(maxY, stem.segment[k + 1]);
      }
      at += EDGE_STRIDE;
    }
    // The slots it does not use draw nothing.
    for (const end = (this.routeOffset[e] + this.routeCount[e]) * EDGE_STRIDE; at < end; at += EDGE_STRIDE) {
      this.edgeData.fill(0, at, at + EDGE_STRIDE);
      this.edgeData[at + 11] = EDGE_HIDDEN;
    }
    // A connection with a missing handle has no extent: nothing finds it.
    if (route.unresolved) this.edgeBounds.set([Infinity, Infinity, -Infinity, -Infinity], e * 4);
    else this.edgeBounds.set([minX, minY, maxX, maxY], e * 4);
  }

  /** Writes edges again (their flags or routes changed) and uploads them. */
  private touchEdgeList(edges: Iterable<number>) {
    if (!this.edgeAttr || this.edgesResized) return;
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
      if (drawnPieces(route).length + route.stems.length > this.routeCount[e]) resized = true;
      this.routes[e] = route;
    }
    // A route with more or fewer segments than before moves every edge after it in the buffer: rebuilt once, before the next draw or read.
    if (resized || this.edgesResized) {
      this.edgesResized = true;
      this.dirty = true;
    } else this.touchEdgeList(list);
  }

  /** Edges whose piece counts changed since the buffer was laid out: it is laid out again once. */
  private edgesResized = false;

  private flushEdges() {
    if (!this.edgesResized) return;
    this.edgesResized = false;
    this.buildEdges();
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

  /**
   * The connection under a point (css px), or -1: the topmost whose hit band takes it, as the browser gives
   * classic's overlapping interaction paths to the later edge (drawn last, here as there). The band is
   * classic's interaction path (10 flow units either side of the centre line), and never under a few pixels
   * past the stroke, so connections stay easy to take zoomed out.
   */
  edgeAt(cssX: number, cssY: number): number {
    this.flushEdges?.();
    const p = this.toWorld(cssX, cssY);
    const floor = EDGE_HIT_PX / this.view.zoom;
    for (let e = this.graph.edges.length - 1; e >= 0; e--) {
      const b = e * 4, route = this.routes[e];
      if (!route) continue;
      const reach = Math.max(EDGE_HIT_FLOW, route.width / 2 + floor);
      let outer = reach;
      for (const stem of route.stems) outer = Math.max(outer, stem.width / 2 + Math.max(STEM_HIT_FLOW, floor));
      if (p.x < this.edgeBounds[b] - outer || p.x > this.edgeBounds[b + 2] + outer || p.y < this.edgeBounds[b + 1] - outer || p.y > this.edgeBounds[b + 3] + outer) continue;
      for (const c of route.segments) if (distanceToCubic(c, p.x, p.y) <= reach) return e;
      // A bundle's shared stem is part of the connection that draws it (BundleStem's hit path).
      for (const stem of route.stems) if (distanceToCubic(stem.segment, p.x, p.y) <= stem.width / 2 + Math.max(STEM_HIT_FLOW, floor)) return e;
    }
    return -1;
  }

  /** Edges whose bounds overlap a rectangle (flow units). */
  edgesWithin(x0: number, y0: number, x1: number, y1: number): number[] {
    this.flushEdges?.();
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

  /** Hides an edge while its end is dragged to reconnect it (-1: none). */
  setHeldEdge(e: number) {
    if (e === this.edgeHeld) return;
    const previous = this.edgeHeld;
    this.edgeHeld = e;
    this.touchEdgeList([previous, e]);
  }

  setHoveredEdge(e: number) {
    if (e === this.hoveredEdge) return;
    const previous = this.hoveredEdge;
    this.hoveredEdge = e;
    this.touchEdgeList([previous, e]);
  }

  /** The dot grid's strength: 0.3 while the tutorial locks the canvas (classic's Background at opacity-30). */
  setGridDim(alpha: number) {
    if (this.gridUniforms.uGridAlpha.value === alpha) return;
    this.gridUniforms.uGridAlpha.value = alpha;
    this.dirty = true;
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
    // A new graph (an opened workflow, a canvas swap, nodes added or removed) is placed, not moved.
    this.trails.clear();
    this.placeAll();
    this.hidden.clear();
    this.headersLive.clear();
    this.selected.clear();
    this.hovered = -1;
    this.routes = [];
    this.edgeSelected.clear();
    this.edgeLive.clear();
    this.edgeHeld = -1;
    this.hoveredEdge = -1;
    this.index = new GridIndex(graph.nodes, 512, NODE_HEADER);
    this.buildGraphMeshes();
    this.layoutChanged();
  }

  /** Every node's position is where it is drawn from now on, with no trail. */
  private placeAll() {
    const nodes = this.graph.nodes;
    this.drawnAt = new Float64Array(nodes.length * 2);
    nodes.forEach((n, i) => this.drawnAt.set([n.x, n.y], i * 2));
  }

  /**
   * Nodes moved or resized in place. With `trail`, a painted node that moved has its controls card ease after it, as
   * classic's do for any move of the node (a store move: a group's header drag, arrange, undo). The editor's own
   * drags leave it out: the nodes they move are live, and trail on the live layer.
   */
  nodesMoved(nodes: readonly number[], trail = false) {
    const edges = new Set<number>();
    for (const i of nodes) {
      const node = this.graph.nodes[i];
      if (node && i * 2 + 1 < this.drawnAt.length) {
        const from = { x: this.drawnAt[i * 2], y: this.drawnAt[i * 2 + 1] };
        if (from.x !== node.x || from.y !== node.y) {
          if (trail && this.painted.has(i) && !this.hidden.has(i)) {
            const smoothed = this.trails.get(i) ?? from;
            clampTrail(smoothed, node);
            if (!this.trails.size) this.trailTime = performance.now();
            this.trails.set(i, smoothed);
          } else this.trails.delete(i);
        }
        this.drawnAt[i * 2] = node.x;
        this.drawnAt[i * 2 + 1] = node.y;
      }
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
    this.edgeHeld = -1;
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
    else {
      this.painted.delete(i);
      this.trails.delete(i);
    }
    this.touchNode(i);
  }

  /** The node's controls card where it reaches past the node's sides (SceneNode.overhang): presses and hover find it there. */
  setOverhang(i: number, overhang: SceneNode["overhang"]) {
    const node = this.graph.nodes[i];
    const a = node?.overhang, b = overhang;
    if (!node || a === b || (a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)) return;
    node.overhang = overhang;
    this.index.update(i);
  }

  /**
   * How far (flow units) the scene moves node `i` to start its painted image on a whole css pixel (NODE_VERTEX's
   * snap), so its live copy can sit at the same place and a swap does not shift it.
   */
  pixelSnap(i: number): [number, number] {
    const node = this.graph.nodes[i], painted = this.painted.get(i);
    if (!node) return [0, 0];
    const { x, y, zoom } = this.view;
    return [pixelSnap(node.x + (painted?.x ?? 0), zoom, x), pixelSnap(node.y + (painted?.y ?? 0), zoom, y)];
  }

  /** Whether the scene draws a painted image for the node (not its stand-in card). */
  hasPainted(i: number): boolean {
    return this.painted.has(i);
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

  /** Where a node's handles are, once measured (at `width`, the node's own by default); moves its edges' ends. */
  setHandles(i: number, handles: Map<string, { x: number; y: number }>, width?: number) {
    const node = this.graph.nodes[i];
    if (!node) return;
    node.handles = handles;
    node.measuredW = width ?? node.w;
    this.touchEdges(i);
  }

  /** Whether the live layer covers the node (setHidden). */
  isHidden(i: number) {
    return this.hidden.has(i);
  }

  /** Nodes the live layer covers are not drawn by the scene. */
  setHidden(i: number, hidden: boolean) {
    if (hidden === this.hidden.has(i)) return;
    // A node turning live trails on the layer from where it is; one turning painted starts still.
    this.trails.delete(i);
    if (hidden) this.hidden.add(i);
    else this.hidden.delete(i);
    this.touchNode(i);
  }

  /**
   * Holds a node's stand-in card back: until its painted image lands the scene draws nothing for it (classic shows
   * a node whole at once, never a placeholder). Held by id, so a rebuilt graph keeps it; released by the owner.
   */
  holdStandIn(id: string, held: boolean) {
    if (held === this.standInHeld.has(id)) return;
    if (held) this.standInHeld.add(id);
    else this.standInHeld.delete(id);
    const i = this.graph.indexOf.get(id);
    if (i != null) this.touchNode(i);
  }

  /** Painted nodes whose floating header the live layer shows instead, above the live node covering it. */
  setHeadersLive(nodes: Iterable<number>) {
    const next = new Set(nodes);
    for (const i of this.headersLive) if (!next.has(i)) {
      this.headersLive.delete(i);
      this.touchNode(i);
    }
    for (const i of next) if (!this.headersLive.has(i)) {
      this.headersLive.add(i);
      this.touchNode(i);
    }
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

  /** Hovers the node under the mouse where it last was over the canvas (the view may have moved under it). */
  private updateHover() {
    this.hoverStale = false;
    if (!this.pointerAt || this.gesture || this.pinch) return;
    const at = this.local(this.pointerAt);
    this.setHovered(this.hoverAt(at.x, at.y));
  }

  private hoverAt(cssX: number, cssY: number) {
    return this.callbacks.hoverAt?.(cssX, cssY) ?? this.nodeAt(cssX, cssY);
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

  /** The nodes a run is on (in the run, or loading on their own): halos when zoomed out. */
  setRunning(ids: Iterable<string>) {
    const next = new Set(ids);
    const changed = [...this.running].filter((id) => !next.has(id)).concat([...next].filter((id) => !this.running.has(id)));
    this.running = next;
    for (const id of changed) {
      const i = this.graph.indexOf.get(id);
      if (i != null) this.touchNode(i);
    }
  }

  /**
   * Each node's opacity (absent: 1), as classic dims nodes downstream of a disabled Switch output and
   * skipped ones. A change fades over 250 ms, as their CSS transition does; `instant` sets it at once
   * (a workflow opened dimmed shows so from its first frame, as a node mounted with the class does).
   */
  setNodeOpacity(targets: ReadonlyMap<string, number>, instant = false) {
    const now = performance.now();
    for (const id of new Set([...this.fades.keys(), ...targets.keys()])) {
      const to = targets.get(id) ?? 1, fade = this.fades.get(id);
      if ((fade?.to ?? 1) === to && !instant) continue;
      if (instant && to === 1) this.fades.delete(id);
      else this.fades.set(id, { from: instant ? to : this.opacityOf(id, now), to, start: now });
      const i = this.graph.indexOf.get(id);
      if (i != null) this.touchNode(i);
    }
  }

  /** A node's opacity at a time, along its fade. */
  private opacityOf(id: string, now: number): number {
    const fade = this.fades.get(id);
    if (!fade) return 1;
    const t = Math.min(1, Math.max(0, (now - fade.start) / FADE_MS));
    return fade.from + (fade.to - fade.from) * easeCubicInOut(t);
  }

  /** Redraws the nodes still fading; forgets those back at full opacity. */
  private stepFades(now: number) {
    for (const [id, fade] of this.fades) {
      if (fade.from === fade.to) continue;
      const i = this.graph.indexOf.get(id);
      if (i != null) this.touchNode(i);
      if (now - fade.start >= FADE_MS) {
        if (fade.to === 1) this.fades.delete(id);
        else fade.from = fade.to;
      }
    }
  }

  /** Eases trailing controls cards after their nodes; forgets those that settled. */
  private stepTrails(now: number) {
    const dt = now - this.trailTime;
    this.trailTime = now;
    for (const [i, smoothed] of this.trails) {
      const node = this.graph.nodes[i];
      if (!node || !stepTrail(smoothed, node, dt)) this.trails.delete(i);
      this.touchNode(i);
    }
  }

  /** Halos show while zoomed out below the canvas's low-detail zoom (low detail on). */
  private haloShown() {
    return this.running.size > 0 && this.view.zoom < (this.callbacks.runningHaloBelow?.() ?? 0);
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
    // What lies under a still pointer changed: hover follows on the next frame.
    if (this.pointerAt) this.hoverStale = true;
    this.callbacks.onViewChange?.(this.view);
    for (const listener of this.viewListeners) listener();
  }

  /** Fits every node on screen as React Flow's fitView does: 10% padding, within the zoom limits. */
  fit() {
    const bounds = this.graph.bounds();
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!bounds || !w || !h) return;
    const rect = { x: bounds.minX, y: bounds.minY, width: Math.max(1, bounds.maxX - bounds.minX), height: Math.max(1, bounds.maxY - bounds.minY) };
    this.setView(getViewportForBounds(rect, w, h, MIN_ZOOM, MAX_ZOOM, 0.1));
  }

  toWorld(cssX: number, cssY: number) {
    return { x: (cssX - this.view.x) / this.view.zoom, y: (cssY - this.view.y) / this.view.zoom };
  }

  toScreen(x: number, y: number) {
    return { x: x * this.view.zoom + this.view.x, y: y * this.view.zoom + this.view.y };
  }

  /**
   * The node under a point (css px): its floating header's band counts, unless `header` is false.
   * Where nodes overlap, the one on top answers: a live node (drawn above the scene), then a selected
   * one (React Flow's elevateNodesOnSelect), then the last drawn.
   */
  nodeAt(cssX: number, cssY: number, header = true) {
    const p = this.toWorld(cssX, cssY);
    return this.index.at(p.x, p.y, header, this.raised);
  }

  private raised = (i: number) => (this.hidden.has(i) ? 2 : 0) + (this.selected.has(i) ? 1 : 0);

  /** Whether node `i` is drawn at or above node `top`, in nodeAt's order: `top` does not cover it. */
  drawnAtOrAbove(i: number, top: number) {
    const a = this.raised(i), b = this.raised(top);
    return a > b || (a === b && i >= top);
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
  local(event: { clientX: number; clientY: number }) {
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
  wheel = (event: WheelEvent, pane = true) => this.onWheel(event, pane);

  private onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "touch" && this.touchDown(event)) return;
    if (this.gesture) return;
    // Input for the painter's quiet wait, not a move of the canvas: a press alone (a click) leaves onInput
    // (the canvas-interacting class) alone, as classic's tracker hears only view moves and drags.
    this.lastInputAt = performance.now();
    // The owner decides what a press does (select, drag, connect, marquee); by default a drag pans.
    const gesture = this.callbacks.onPress ? this.callbacks.onPress(event) : event.button === 0 || event.button === 1 ? this.panGesture(event) : null;
    if (!gesture) return;
    this.gesture = gesture;
    this.gesturePointer = event.pointerId;
    this.blockNativeDrag();
    if (event.target === this.canvas) this.canvas.setPointerCapture?.(event.pointerId);
    else this.followUncaptured(event.pointerId);
  };

  /**
   * As d3-drag's nodrag under React Flow's pans and drags: while a gesture runs, no text selection
   * and no native drag (an image, a link in a live node) starts. Lifted when the gesture ends.
   */
  private blockNativeDrag() {
    this.nativeDragBlock?.();
    const prevent = (event: Event) => event.preventDefault();
    const options = { capture: true, passive: false };
    window.addEventListener("selectstart", prevent, options);
    window.addEventListener("dragstart", prevent, options);
    this.nativeDragBlock = () => {
      window.removeEventListener("selectstart", prevent, options);
      window.removeEventListener("dragstart", prevent, options);
      this.nativeDragBlock = null;
    };
  }

  /**
   * Captures the pointer for the gesture in progress. A press on a live node
   * is captured only once it turns into a drag (the gestures call this), so
   * a click still lands on the element under it and runs its onClick (an
   * Output node's image opens its lightbox), as React Flow's drag allows.
   */
  capture() {
    const pending = this.uncaptured;
    if (!pending) return;
    this.stopFollowing();
    this.canvas.setPointerCapture?.(pending.pointerId);
  }

  private followUncaptured(pointerId: number) {
    // Events on the canvas itself reach its own listeners.
    const move = (event: PointerEvent) => {
      if (event.pointerId === pointerId && event.target !== this.canvas) this.onPointerMove(event);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === pointerId && event.target !== this.canvas) this.onPointerUp(event);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    this.uncaptured = {
      pointerId,
      off: () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
        window.removeEventListener("pointercancel", up, true);
      },
    };
  }

  private stopFollowing() {
    this.uncaptured?.off();
    this.uncaptured = null;
  }

  /**
   * A finger came down: followed until it lifts. A second one starts a pinch, which drops what the first
   * began (a drag, a marquee); while one runs, it takes every finger. Returns whether the pinch took this one.
   */
  private touchDown(event: PointerEvent): boolean {
    this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.followTouches();
    if (!this.pinch && this.touches.size === 2 && (this.callbacks.pinchZooms?.() ?? true)) {
      this.cancelGesture();
      this.anchorPinch();
      this.noteInput(event);
    } else if (this.pinch) this.anchorPinch();
    return this.pinch !== null;
  }

  private anchorPinch() {
    const [a, b] = [...this.touches.values()];
    const box = this.canvas.getBoundingClientRect();
    const mid = b ? { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top } : { x: a.x - box.left, y: a.y - box.top };
    this.pinch = { mid, distance: b ? Math.hypot(b.x - a.x, b.y - a.y) : 0, view: { ...this.view } };
  }

  /** Fingers are followed through the window: one may press on a live node, whose moves the canvas never sees. */
  private followTouches() {
    if (this.stopFollowingTouches) return;
    const options = { capture: true };
    const move = (event: PointerEvent) => {
      if (!this.touches.has(event.pointerId)) return;
      this.touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pinch = this.pinch;
      if (!pinch) return;
      const [a, b] = [...this.touches.values()];
      const box = this.canvas.getBoundingClientRect();
      const mid = b ? { x: (a.x + b.x) / 2 - box.left, y: (a.y + b.y) / 2 - box.top } : { x: a.x - box.left, y: a.y - box.top };
      const zoom = b && pinch.distance ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.view.zoom * Math.hypot(b.x - a.x, b.y - a.y) / pinch.distance)) : pinch.view.zoom;
      // The flow point under the first midpoint stays under the fingers.
      const scale = zoom / pinch.view.zoom;
      this.noteInput(event);
      this.setView({ zoom, x: mid.x - (pinch.mid.x - pinch.view.x) * scale, y: mid.y - (pinch.mid.y - pinch.view.y) * scale });
    };
    const up = (event: PointerEvent) => {
      if (!this.touches.delete(event.pointerId)) return;
      if (this.touches.size) {
        if (this.pinch) this.anchorPinch();
        return;
      }
      this.pinch = null;
      this.stopFollowingTouches?.();
    };
    window.addEventListener("pointermove", move, options);
    window.addEventListener("pointerup", up, options);
    window.addEventListener("pointercancel", up, options);
    this.stopFollowingTouches = () => {
      window.removeEventListener("pointermove", move, options);
      window.removeEventListener("pointerup", up, options);
      window.removeEventListener("pointercancel", up, options);
      this.stopFollowingTouches = null;
    };
  }

  /** A gesture that pans the view with the pointer. */
  panGesture(event: PointerEvent): Gesture {
    let x = event.clientX, y = event.clientY;
    return {
      move: (move) => {
        const dx = move.clientX - x, dy = move.clientY - y;
        x = move.clientX;
        y = move.clientY;
        if (dx || dy) {
          this.capture();
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

  /** Whether dispose has run: per-frame loops a gesture started stop on it. */
  get isDisposed() {
    return this.disposed;
  }

  /** Ends the gesture in progress, if any (a key cancels it, the canvas is replaced). */
  cancelGesture() {
    const gesture = this.gesture;
    this.gesture = null;
    this.stopFollowing();
    this.nativeDragBlock?.();
    gesture?.cancel();
  }

  private onPointerMove = (event: PointerEvent) => {
    // A pinch's fingers are its own (followTouches).
    if (this.pinch && event.pointerType === "touch") return;
    const gesture = this.gesture;
    if (gesture && event.pointerId !== this.gesturePointer) return;
    if (event.pointerType === "mouse") this.pointerAt = { clientX: event.clientX, clientY: event.clientY };
    if (!gesture) {
      const at = this.local(event);
      this.setHovered(this.hoverAt(at.x, at.y));
      this.callbacks.onIdleMove?.(event);
      return;
    }
    this.callbacks.onHoverEnd?.("gesture");
    gesture.move(event);
  };

  private onPointerUp = (event: PointerEvent) => {
    const gesture = this.gesture;
    if (gesture && event.pointerId !== this.gesturePointer) return;
    this.gesture = null;
    this.stopFollowing();
    this.nativeDragBlock?.();
    if (!gesture) return;
    if (event.type === "pointercancel") gesture.cancel();
    else gesture.up(event);
  };

  private onContextMenu = (event: MouseEvent) => {
    this.callbacks.onContextMenu?.(event);
  };

  private onPointerLeave = () => {
    this.pointerAt = null;
    if (this.gesture) return;
    this.setHovered(-1);
    this.callbacks.onHoverEnd?.("leave");
  };

  private onDoubleClick = (event: MouseEvent) => {
    const at = this.local(event);
    // A node (or its header band) is not empty canvas: on classic a double-click there is the node's
    // own (rename, title edit) and the view stays put; a painted node has none of its own.
    if (this.callbacks.paneAt ? this.callbacks.paneAt(at.x, at.y) : this.nodeAt(at.x, at.y) < 0) {
      const p = this.toWorld(at.x, at.y);
      this.callbacks.onPaneDoubleClick?.(p.x, p.y, { x: event.clientX, y: event.clientY });
    }
  };

  private onWheel = (event: WheelEvent, pane = true) => {
    // A wheel on the canvas hovers what it is over at once: a node coming under a still pointer turns
    // live, and its inner areas take the wheels that follow (on classic, nodes are always there to).
    if (event.target === this.canvas) this.pointerAt = { clientX: event.clientX, clientY: event.clientY };
    const action: SceneWheel = this.callbacks.wheel ? this.callbacks.wheel(event, pane) : { type: "pan", dx: event.deltaX, dy: event.deltaY };
    if (event.target === this.canvas) this.updateHover();
    if (!action) return;
    event.preventDefault();
    if (action.type === "block") return;
    this.callbacks.onHoverEnd?.("wheel");
    this.noteInput(event);
    if (action.type === "pan") this.setView({ x: this.view.x - action.dx, y: this.view.y - action.dy });
    else {
      this.zoomBy(action.factor, action.about === "pointer" ? this.local(event) : undefined);
    }
  };

  /** Zooms by a factor, keeping a point (css px; the centre by default) in place. */
  zoomBy(factor: number, at = { x: this.canvas.clientWidth / 2, y: this.canvas.clientHeight / 2 }) {
    const p = this.toWorld(at.x, at.y);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.view.zoom * factor));
    this.setView({ zoom: z, x: at.x - p.x * z, y: at.y - p.y * z });
  }

  /**
   * Moves the view to `to` over `duration` ms as React Flow's animated setViewport does (d3's
   * smooth zoom path, cubic in-out). Input on the canvas, or any other change to the view, stops it.
   */
  animateView(to: View, duration: number) {
    cancelAnimationFrame(this.viewAnimation);
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (duration <= 0 || !w || !h) {
      this.setView(to);
      return;
    }
    const path = zoomPath({ ...this.view }, to, w, h);
    const start = performance.now(), inputAt = this.lastInputAt;
    let last: View = { ...this.view };
    const step = (now: number) => {
      const moved = this.view.x !== last.x || this.view.y !== last.y || this.view.zoom !== last.zoom;
      if (moved || this.lastInputAt !== inputAt) return;
      const t = Math.min(1, (now - start) / duration);
      this.setView(path(easeCubicInOut(t)));
      last = { ...this.view };
      if (t < 1) this.viewAnimation = requestAnimationFrame(step);
    };
    this.viewAnimation = requestAnimationFrame(step);
  }

  private resize() {
    const { canvas } = this;
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.uniforms.uViewport.value.set(canvas.clientWidth, canvas.clientHeight);
    this.uniforms.uDpr.value = devicePixelRatio;
    this.backingScale = canvas.width / (canvas.clientWidth || 1) || devicePixelRatio;
    this.dirty = true;
    for (const listener of this.viewListeners) listener();
  }

  /** Device pixels per css px of the canvas's backing store (kept at each resize: the painter asks per node). */
  get scale() {
    return this.backingScale;
  }

  private tick = (now: number) => {
    if (this.disposed) return;
    this.frameHandle = requestAnimationFrame(this.tick);
    this.flushEdges();
    if (this.hoverStale) this.updateHover();
    if (this.fades.size) this.stepFades(performance.now());
    if (this.trails.size) this.stepTrails(performance.now());
    let jsMs = 0;
    const halo = this.haloShown();
    if (this.haloMesh) this.haloMesh.visible = halo;
    if (halo) {
      const motion = this.reducedMotion?.matches ? 0 : 1;
      // A pulsing halo draws every frame; a still one only when it starts.
      if (motion || this.haloUniforms.uMotion.value !== motion || !this.haloWasShown) this.dirty = true;
      this.haloUniforms.uMotion.value = motion;
      this.haloUniforms.uTime.value = now / 1000;
    } else if (this.haloWasShown) this.dirty = true;
    this.haloWasShown = halo;
    if (this.dirty && this.drawing) {
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
    this.stopFollowing();
    this.nativeDragBlock?.();
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
    this.stopFollowingTouches?.();
    cancelAnimationFrame(this.viewAnimation);
    for (const mesh of this.graphMeshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.renderer.dispose();
  }
}
