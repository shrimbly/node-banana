import type { CSSProperties } from "react";

/** Shared cable-tie appearance for handle bundles and free hook bundles. */
export const bundleClampStyle: CSSProperties = {
  width: 10,
  height: 26,
  borderRadius: 9999,
  background: "linear-gradient(180deg, rgba(255,255,255,0.28), rgba(255,255,255,0.08))",
  border: "1px solid rgba(255,255,255,0.45)",
  backdropFilter: "blur(4px)",
  WebkitBackdropFilter: "blur(4px)",
};
