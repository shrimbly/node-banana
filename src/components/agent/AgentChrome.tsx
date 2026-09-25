"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { ChromeIconButton, type TooltipAlign, type TooltipPlacement } from "@/components/ChromeIconButton";
import { cn } from "@/components/agent/lib/utils";
import { Spinner } from "@/components/agent/ui/spinner";
import type { AgentStatusTone } from "@/lib/agent/client/readiness";

/**
 * Popovers, menus and tooltips opened from the agent window portal to <body>;
 * they must sit above the window (z-80, or z-91 when a narrow viewport puts it
 * over the Control Panel at z-90) and below modals (z-100).
 */
export const AGENT_POPOVER_LAYER = "z-[95]";

/** Lucide icons at the chrome's weight: 18px on the canvas, 16px inside the window. */
export const AGENT_ICON = { strokeWidth: 1.75, "aria-hidden": true } as const;

/** One of the window's icon buttons: the canvas chrome's own, with its hover label below. */
export function PanelIconButton({
  label,
  onClick,
  disabled,
  tooltipAlign = "center",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tooltipAlign?: TooltipAlign;
  children: ReactNode;
}) {
  return (
    <ChromeIconButton
      label={label}
      onClick={onClick}
      disabled={disabled}
      tooltipPlacement="bottom"
      tooltipAlign={tooltipAlign}
      className="[&_svg]:size-4"
    >
      {children}
    </ChromeIconButton>
  );
}

/** A decorative spinner next to text that already says what is happening. */
export function InlineSpinner({ className }: { className?: string }) {
  return <Spinner role="presentation" aria-hidden="true" aria-label={undefined} className={cn("size-3.5", className)} />;
}

/** Status colours: green only here, as a dot. */
const TONE_CLASSES: Record<AgentStatusTone, string> = {
  ready: "bg-handle-image",
  attention: "bg-amber-400",
  blocked: "bg-error",
  unknown: "bg-neutral-500",
};

export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: AgentStatusTone;
  /** Something is under way (a sign-in waiting on the browser). */
  pulse?: boolean;
  className?: string;
}) {
  if (!pulse) {
    return (
      <span
        aria-hidden="true"
        data-tone={tone}
        className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE_CLASSES[tone], className)}
      />
    );
  }
  return (
    <span aria-hidden="true" data-tone={tone} className={cn("relative inline-flex size-1.5 shrink-0", className)}>
      <span
        className={cn(
          "absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none",
          TONE_CLASSES[tone],
        )}
      />
      <span className={cn("relative inline-flex size-1.5 rounded-full", TONE_CLASSES[tone])} />
    </span>
  );
}

/** A copy button for one line of text; shows a check for a moment after copying. */
export function CopyButton({
  value,
  label,
  tooltipPlacement = "top",
}: {
  value: string;
  label: string;
  tooltipPlacement?: TooltipPlacement;
}) {
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
    <ChromeIconButton
      label={copied ? "Copied" : label}
      onClick={copy}
      tooltipPlacement={tooltipPlacement}
      tooltipAlign="end"
      className="[&_svg]:size-4"
    >
      {copied ? <CheckIcon {...AGENT_ICON} /> : <CopyIcon {...AGENT_ICON} />}
    </ChromeIconButton>
  );
}

/** A well holding one line of mono text, with a copy button at its end. */
export function MonoWell({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex min-h-9 items-center gap-1 rounded-lg bg-well py-0.5 pl-3 pr-0.5 shadow-well", className)}>
      {children}
    </div>
  );
}

/** A terminal command in a mono well with a copy button. */
export function CommandLine({ command }: { command: string }) {
  return (
    <MonoWell>
      <code className="min-w-0 flex-1 select-all truncate font-mono text-xs leading-4 text-neutral-200">
        <span aria-hidden="true" className="mr-2 select-none text-neutral-500">
          $
        </span>
        {command}
      </code>
      <CopyButton value={command} label="Copy command" />
    </MonoWell>
  );
}
