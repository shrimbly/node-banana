/**
 * The path React Flow's animated viewport changes take: d3-zoom's transition
 * of a transform, which follows d3-interpolate's `interpolateZoom` (van Wijk
 * and Nuij's smooth zoom, rho √2) about the centre of the pane, eased cubic
 * in-out (React Flow's default ease).
 */
import type { View } from "./scene";

export const easeCubicInOut = (t: number) => ((t *= 2) <= 1 ? t * t * t : (t -= 2) * t * t + 2) / 2;

const RHO = Math.SQRT2, RHO2 = 2, RHO4 = 4, EPSILON2 = 1e-12;

/** d3-interpolate's interpolateZoom: [centre x, centre y, width in view] from a to b. */
function interpolateZoom(a: [number, number, number], b: [number, number, number]) {
  const [ux0, uy0, w0] = a, [ux1, uy1, w1] = b;
  const dx = ux1 - ux0, dy = uy1 - uy0, d2 = dx * dx + dy * dy;
  if (d2 < EPSILON2) {
    const S = Math.log(w1 / w0) / RHO;
    return (t: number): [number, number, number] => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(RHO * t * S)];
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + RHO4 * d2) / (2 * w0 * RHO2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - RHO4 * d2) / (2 * w1 * RHO2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0), r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / RHO;
  return (t: number): [number, number, number] => {
    const s = t * S, coshr0 = Math.cosh(r0);
    const u = (w0 / (RHO2 * d1)) * (coshr0 * Math.tanh(RHO * s + r0) - Math.sinh(r0));
    return [ux0 + u * dx, uy0 + u * dy, (w0 * coshr0) / Math.cosh(RHO * s + r0)];
  };
}

/** The view at t (0 to 1) on the way from `from` to `to`, on a pane `width` x `height` css px. */
export function zoomPath(from: View, to: View, width: number, height: number): (t: number) => View {
  const px = width / 2, py = height / 2, w = Math.max(width, height);
  const i = interpolateZoom(
    [(px - from.x) / from.zoom, (py - from.y) / from.zoom, w / from.zoom],
    [(px - to.x) / to.zoom, (py - to.y) / to.zoom, w / to.zoom],
  );
  return (t) => {
    if (t >= 1) return { ...to };
    const [cx, cy, l] = i(t), zoom = w / l;
    return { zoom, x: px - cx * zoom, y: py - cy * zoom };
  };
}
