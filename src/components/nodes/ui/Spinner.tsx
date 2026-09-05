import React from "react";
import { cn } from "./cn";

/** The one spinner. `size` in px. */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={cn("animate-spin", className)}
      style={{ width: size, height: size }}
      fill="none"
      viewBox="0 0 24 24"
      role="status"
      aria-label="Loading"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

/** Translucent overlay with a spinner, for media that is being replaced. */
export function LoadingOverlay({ size = 24, dim = "strong" }: { size?: number; dim?: "strong" | "light" }) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center",
        dim === "strong" ? "bg-neutral-900/70" : "bg-neutral-900/50"
      )}
    >
      <Spinner size={size} className="text-white" />
    </div>
  );
}
