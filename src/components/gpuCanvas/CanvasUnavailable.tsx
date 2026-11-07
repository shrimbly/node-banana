"use client";

/**
 * Shown in the canvas's place when the GPU canvas cannot draw
 * (src/lib/gpuCanvas/failure.ts): why, and a way to try again. The workflow
 * itself is untouched, so saving, Assets and the chat keep working.
 */
import { MonitorX } from "lucide-react";

/** The reason as a sentence: a capital, and one full stop. */
function sentence(reason: string) {
  const text = reason.trim().replace(/\.+$/, "");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

export function CanvasUnavailable({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div role="alert" className="absolute inset-0 flex items-center justify-center bg-canvas-bg">
      <div className="flex max-w-[360px] flex-col items-center gap-3 px-6 text-center">
        <MonitorX size={20} strokeWidth={1.5} className="text-neutral-400" />
        <p className="text-sm font-medium text-neutral-200">The canvas can&apos;t draw on this computer</p>
        <p className="text-xs leading-5 text-neutral-400">
          {sentence(reason)} Your workflow is safe, and saving, Assets and the chat still work.
          Updating your graphics driver or turning on hardware acceleration in your browser may help.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-md border border-chrome-border px-3 py-1.5 text-xs text-neutral-200 hover:bg-panel"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
