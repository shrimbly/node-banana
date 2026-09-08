"use client";

import { useEffect } from "react";
import {
  GENERATION_TOAST_DURATION_MS,
  useGenerationToast,
  type GenerationToastItem,
} from "@/store/generationToastStore";
import { CHROME_SURFACE } from "./chromeStyles";
import { producerName, setHistoryDragData } from "./GlobalImageHistory";

const THUMB = "h-10 w-10 rounded-lg squircle object-cover shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]";

/** Up to three thumbnails, fanned so a batch reads as a stack. */
function Thumbs({ images }: { images: string[] }) {
  const shown = images.slice(0, 3);
  if (shown.length === 1) {
    return <img src={shown[0]} alt="" className={`${THUMB} shrink-0`} draggable={false} />;
  }
  return (
    <div className="relative h-10 shrink-0" style={{ width: 40 + (shown.length - 1) * 6 }}>
      {shown.map((src, i) => (
        <img
          key={i}
          src={src}
          alt=""
          draggable={false}
          className={`${THUMB} absolute top-0`}
          style={{ left: i * 6, zIndex: shown.length - i, opacity: 1 - i * 0.22 }}
        />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: GenerationToastItem }) {
  const dismiss = useGenerationToast((s) => s.dismiss);
  const count = toast.images.length;

  // Auto-dismiss, restarted whenever the card is extended by a batch
  useEffect(() => {
    const remaining = Math.max(0, toast.shownAt + GENERATION_TOAST_DURATION_MS - Date.now());
    const timer = setTimeout(() => dismiss(toast.id), remaining);
    return () => clearTimeout(timer);
  }, [toast.id, toast.shownAt, dismiss]);

  return (
    <div
      role="status"
      draggable
      onDragStart={(e) => {
        setHistoryDragData(e, { image: toast.images[0], prompt: "", timestamp: toast.shownAt });
        dismiss(toast.id);
      }}
      className={`${CHROME_SURFACE} animate-drop-in relative flex w-[268px] cursor-grab items-center gap-2.5 overflow-hidden rounded-xl p-1.5 active:cursor-grabbing`}
      data-testid="generation-toast"
    >
      <Thumbs images={toast.images} />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[11px] font-medium leading-[14px] text-neutral-200">
          {count > 1 ? `${count} images generated` : "Image generated"}
        </span>
        <span className="truncate text-[10px] leading-[13px] text-neutral-500">
          {producerName(toast.model)} · {toast.aspectRatio}
        </span>
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true">
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <span
        // Keyed on shownAt so a batch extension restarts the countdown
        key={toast.shownAt}
        aria-hidden="true"
        className="animate-toast-timer pointer-events-none absolute bottom-0 left-0 h-0.5 bg-blue-500/90"
        style={{ animationDuration: `${GENERATION_TOAST_DURATION_MS}ms` }}
      />
    </div>
  );
}

/** Cards for finished generations, newest on top. Empty when nothing has landed. */
export function GenerationToasts() {
  const toasts = useGenerationToast((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <>
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </>
  );
}
