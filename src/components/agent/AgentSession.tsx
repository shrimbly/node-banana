"use client";

import type { ReactNode } from "react";

/** Placeholder: the shared agent session (one conversation for the window and the chat view) lands here. */
export function AgentSessionProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
