"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";

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
  }, [message]);

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

  if (!message) return null;

  return (
    <div className="fixed top-14 right-6 z-[200] animate-in fade-in slide-in-from-top-4 duration-300 max-w-md">
      <div
        className={`flex flex-col rounded-lg border shadow-xl ${typeStyles[type]}`}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          {typeIcons[type]}
          <span className="text-sm font-medium flex-1">{message}</span>
          <button
            onClick={handleCopy}
            className="p-1 rounded hover:bg-white/10 transition-colors"
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
            className="p-1 rounded hover:bg-white/10 transition-colors"
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
              className="px-4 py-1 text-xs opacity-70 hover:opacity-100 transition-opacity text-left border-t border-white/10"
            >
              {isExpanded ? "Hide details" : "Show details"}
            </button>
            {isExpanded && (
              <div className="px-4 pb-3">
                <pre className="bg-black/30 rounded p-2 max-h-40 overflow-auto text-xs font-mono whitespace-pre-wrap break-words">
                  {details}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
