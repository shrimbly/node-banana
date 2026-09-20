"use client";

import { cn } from "@/components/nodes/ui/cn";

interface QuickstartBackButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * The "Back" link at the top of a split dialog's pane: a mono uppercase
 * eyebrow with a left arrow, the same face as the pane's other labels.
 */
export function QuickstartBackButton({
  onClick,
  disabled = false,
  className,
}: QuickstartBackButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-2 self-start rounded-sm font-mono text-[11px] leading-4 tracking-eyebrow uppercase text-neutral-400 transition-colors",
        "hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-pane",
        disabled ? "opacity-50 cursor-not-allowed hover:text-neutral-400" : "",
        className
      )}
    >
      <svg
        className="w-3.5 h-3.5 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M19 12H5M11 18l-6-6 6-6" />
      </svg>
      <span>Back</span>
    </button>
  );
}
