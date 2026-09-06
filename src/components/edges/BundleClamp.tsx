import type { CSSProperties } from "react";

/**
 * The handle at a bundle's split point, shared by handle bundles and free hook
 * bundles: a flat outline pill, canvas-dark inside, so it punches a hole in the
 * noodle rather than sitting on it. Neutral on purpose; the noodle colour
 * belongs to the noodles.
 */
export const bundleClampStyle: CSSProperties = {
  width: 10,
  height: 26,
  borderRadius: 9999,
  boxSizing: "border-box",
  background: "var(--color-canvas-bg)",
  border: "1.5px solid #e5e5e5",
};
