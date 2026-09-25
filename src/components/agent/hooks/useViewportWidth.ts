"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const readWidth = () => window.innerWidth;
/** The window only renders in the browser; this just keeps a server render from throwing. */
const readServerWidth = () => 1280;

/** window.innerWidth, kept current on resize. */
export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, readWidth, readServerWidth);
}
