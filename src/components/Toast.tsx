"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";

/**
 * Where notifications stack (this toast and the generation cards): under the
 * history button, which sits at the canvas's top-right inset (tab strip 38px + frame border 1px + 16px margin,
 * then the 42px button and an 8px gap; 4px frame margin + 1px border + 16px
 * from the right).
 */
export const STACK_TOP = 38 + 1 + 16 + 42 + 8;
export const STACK_RIGHT = 4 + 1 + 16;
/**
 * The history button's distance from the canvas's right edge, published by
 * the button while it is moved (the agent window covers the corner), so the
 * notifications keep hanging beneath it.
 */
export const HISTORY_RIGHT_VAR = "--nb-history-right";
/** STACK_RIGHT as CSS, following the history button when it moves. */
export const STACK_RIGHT_CSS = `calc(${STACK_RIGHT - 16}px + var(${HISTORY_RIGHT_VAR}, 16px))`;

interface ToastState {
  message: string | null;
  type: "info" | "success" | "warning" | "error";
  persistent: boolean;
  details: string | null;
  show: (message: string, type?: "info" | "success" | "warning" | "error", persistent?: boolean, details?: string | null) => void;
  hide: () => void;
}

export const useToast = create<ToastState>((set) => ({
  message: null,
  type: "info",
  persistent: false,
  details: null,
  show: (message, type = "info", persistent = false, details = null) => set({ message, type, persistent, details }),
  hide: () => set({ message: null, persistent: false, details: null }),
}));

const typeStyles = {
  info: "bg-neutral-800 border-neutral-600 text-neutral-100",
  success: "bg-green-900 border-green-700 text-green-100",
  warning: "bg-orange-900 border-orange-600 text-orange-100",
  error: "bg-red-900 border-red-700 text-red-100",
};

const typeIcons = {
  info: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  success: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  warning: (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  ),
  error: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

export function Toast() {
  const { message, type, persistent, details, hide } = useToast();
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Reset expanded state when toast changes
    setIsExpanded(false);
    setCopied(false);
  }, [message, details]);

  const handleCopy = async () => {
    const textToCopy = details ? `${message}\n\n${details}` : message;
    if (textToCopy) {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  useEffect(() => {
    if (message && !persistent) {
      const timer = setTimeout(() => {
        hide();
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [message, persistent, hide]);

  return (
    <div
      className="pointer-events-none fixed z-[200] flex w-96 min-w-0 flex-col items-end gap-2 [&>*]:pointer-events-auto"
      style={{ top: STACK_TOP, right: STACK_RIGHT_CSS, maxWidth: `calc(100vw - ${STACK_RIGHT * 2}px)` }}
    >
      {message && (
      <div
        className={`animate-drop-in flex w-full min-w-0 flex-col overflow-hidden rounded-lg border shadow-xl ${typeStyles[type]}`}
        style={{ maxHeight: `min(360px, calc(100dvh - ${STACK_TOP + 16}px))` }}
      >
        <div className="flex shrink-0 items-start gap-3 px-4 py-3">
          <span className="shrink-0 pt-0.5">{typeIcons[type]}</span>
          <span className="min-w-0 max-h-24 flex-1 overflow-y-auto overscroll-contain text-sm font-medium [overflow-wrap:anywhere]">{message}</span>
          <button
            onClick={handleCopy}
            className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
            title="Copy message"
          >
            {copied ? (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
          <button
            onClick={hide}
            className="shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
            title="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {details && (
          <>
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              aria-expanded={isExpanded}
              className="shrink-0 px-4 py-1 text-xs opacity-70 hover:opacity-100 transition-opacity text-left border-t border-white/10"
            >
              {isExpanded ? "Hide details" : "Show details"}
            </button>
            {isExpanded && (
              <div className="min-h-0 overflow-y-auto overscroll-contain px-4 pb-3">
                <pre className="max-h-40 overflow-auto overscroll-contain whitespace-pre-wrap rounded bg-black/30 p-2 text-xs font-mono [overflow-wrap:anywhere]">
                  {details}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
      )}
    </div>
  );
}
