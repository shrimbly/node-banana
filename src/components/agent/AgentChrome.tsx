"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { cn } from "@/components/agent/lib/utils";
import { Spinner } from "@/components/agent/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/agent/ui/tooltip";
import type { AgentStatusTone } from "@/lib/agent/client/readiness";

/**
 * Popovers, menus and tooltips opened from the agent window portal to <body>;
 * they must sit above the window (z-80, or z-91 when a narrow viewport puts it
 * over the Control Panel at z-90) and below modals (z-100).
 */
export const AGENT_POPOVER_LAYER = "z-[95]";

export function PanelIconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className="flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent className={AGENT_POPOVER_LAYER} side="bottom">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/** A decorative spinner next to text that already says what is happening. */
export function InlineSpinner({ className }: { className?: string }) {
  return <Spinner role="presentation" aria-hidden="true" aria-label={undefined} className={cn("size-3.5", className)} />;
}

const TONE_CLASSES: Record<AgentStatusTone, string> = {
  ready: "bg-emerald-500",
  attention: "bg-amber-400",
  blocked: "bg-red-500",
  unknown: "bg-neutral-500",
};

export function StatusDot({ tone, className }: { tone: AgentStatusTone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-tone={tone}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE_CLASSES[tone], className)}
    />
  );
}

/** A copy button for one line of text; shows a check for a moment after copying. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context, denied permission): the text stays selectable.
    }
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
    >
      {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

/** A terminal command in a mono box with a copy button. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-neutral-700 bg-neutral-900/80 py-0.5 pl-3 pr-0.5">
      <code className="min-w-0 flex-1 select-all truncate font-mono text-xs text-neutral-200">
        <span aria-hidden="true" className="mr-1.5 text-neutral-500 select-none">
          $
        </span>
        {command}
      </code>
      <CopyButton value={command} label="Copy command" />
    </div>
  );
}
