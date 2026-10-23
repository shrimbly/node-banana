import React, { useCallback, useEffect, useState } from "react";
import { Check, Copy, Hourglass } from "lucide-react";
import type { PendingGenerationTask } from "@/types";
import { pollProviderName } from "@/store/execution/pollTaskCompletion";
import { useIsPaintedNode } from "../paintMode";
import { cn } from "./cn";
import { PanelButton } from "./Field";

const MINUTE = 60_000;

/** How long ago a request was sent: "just now", "12 min ago", "3 h ago", "2 days ago". */
export function sentAgo(submittedAt: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - submittedAt) / MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * When a request was sent, as a date and clock time ("23 Oct, 14:02"). A
 * painted card is a picture kept on disk, so it says this rather than a
 * relative time that would go stale in it.
 */
export function sentAt(submittedAt: number): string {
  const sent = new Date(submittedAt);
  const date = sent.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${date}, ${sent.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** The time now, again every `ms`, so a relative time keeps up. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * The provider request a generate node kept when the app stopped waiting on
 * it (the poll safety net, a reload, a crash): where it runs, when it was
 * sent, its id to copy, and Pick up. Fills the media clip, over any earlier
 * output. See docs/generation-polling.md.
 */
export function PendingTaskNotice({
  task,
  onPickUp,
  disabled = false,
  compact = false,
  className,
}: {
  task: PendingGenerationTask;
  onPickUp: () => void;
  /** Another run holds the canvas. */
  disabled?: boolean;
  /** Without the icon, for a short media clip (audio, 3D). */
  compact?: boolean;
  className?: string;
}) {
  const now = useNow(30_000);
  const painted = useIsPaintedNode();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(task.taskId);
      setCopied(true);
    } catch {
      // The id stays selectable
    }
  }, [task.taskId]);

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col items-center justify-center gap-1 text-center px-3",
        "bg-neutral-900/90",
        className
      )}
    >
      {!compact && <Hourglass size={20} strokeWidth={1.5} className="text-amber-300/90 mb-0.5" aria-hidden />}
      <span className="text-node text-neutral-200">May still be running on {pollProviderName(task.provider)}</span>
      <span className="text-node text-neutral-500 tabular-nums">Sent {painted ? sentAt(task.submittedAt) : sentAgo(task.submittedAt, now)}</span>
      <div className="nodrag nopan flex items-center gap-1 max-w-full min-w-0">
        <span className="font-mono text-[9px] text-neutral-400 truncate select-text cursor-text" title={`Request ${task.taskId}`}>
          {task.taskId}
        </span>
        <button
          type="button"
          onClick={copyId}
          className="shrink-0 w-4 h-4 flex items-center justify-center rounded text-neutral-500 hover:text-white hover:bg-white/10 transition-colors"
          title="Copy request id"
          aria-label="Copy request id"
        >
          {copied ? <Check size={12} strokeWidth={1.5} /> : <Copy size={12} strokeWidth={1.5} />}
        </button>
      </div>
      <PanelButton
        primary
        className={compact ? undefined : "mt-1"}
        onClick={onPickUp}
        disabled={disabled}
        title={disabled ? "Wait for the run to finish" : `Ask ${pollProviderName(task.provider)} for the result`}
      >
        Pick up
      </PanelButton>
    </div>
  );
}
