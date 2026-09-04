import React from "react";
import { cn } from "./cn";

/** Red wash over existing media when the last run failed. */
export function ErrorOverlay({
  title = "Generation failed",
  detail = "See toast for details",
  className,
}: {
  title?: string;
  detail?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("absolute inset-0 bg-red-900/40 flex flex-col items-center justify-center gap-1 text-center px-3", className)}>
      <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span className="text-white text-xs font-medium">{title}</span>
      {detail && <span className="text-white/70 text-[10px]">{detail}</span>}
    </div>
  );
}

/** Inline error copy for an empty media slot. */
export function ErrorMessage({ message, className }: { message: string; className?: string }) {
  return (
    <div className={cn("absolute inset-0 flex items-center justify-center bg-neutral-900/40", className)}>
      <span className="text-node text-red-400 text-center px-3 break-words max-w-full">{message}</span>
    </div>
  );
}
