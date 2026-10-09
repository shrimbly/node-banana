"use client";

import { createContext, useContext } from "react";

/**
 * Which surface a transcript is drawn in: the floating window over the canvas
 * (narrow, 13px) or the full-page chat view (a centred column, 15px). Parts of
 * the transcript size themselves by it; the window is the default.
 */
export type AgentSurface = "window" | "page";

const AgentSurfaceContext = createContext<AgentSurface>("window");

export const AgentSurfaceProvider = AgentSurfaceContext.Provider;

export function useAgentSurface(): AgentSurface {
  return useContext(AgentSurfaceContext);
}
