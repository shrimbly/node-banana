import React, { ReactNode } from "react";
import { cn } from "./cn";

interface EmptyStateProps {
  /** Primary line ("Run to generate", "Drop image"). */
  message: ReactNode;
  /** Secondary line, dimmer ("Connect inputs and run"). */
  hint?: ReactNode;
  /** Third line, dimmer still (cost estimate). */
  meta?: ReactNode;
  icon?: ReactNode;
  /** Draw the dashed placeholder frame (default true). */
  frame?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Fills the media clip when there is nothing to show. The clip itself sets
 * the aspect ratio, so this only paints the frame and the copy.
 */
export function EmptyState({ message, hint, meta, icon, frame = true, className, children }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-1 text-center px-3",
        "bg-neutral-900/40 text-neutral-500",
        className
      )}
    >
      {frame && (
        <div className="absolute inset-2 rounded-[6px] squircle border border-dashed border-neutral-700/70 pointer-events-none" />
      )}
      {icon && <div className="text-neutral-600 mb-0.5">{icon}</div>}
      <span className="text-node text-neutral-500">{message}</span>
      {hint && <span className="text-node text-neutral-600">{hint}</span>}
      {meta && <span className="text-node text-neutral-600 tabular-nums">{meta}</span>}
      {children}
    </div>
  );
}
