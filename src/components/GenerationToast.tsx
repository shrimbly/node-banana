"use client";

import { Toaster, toast } from "sonner";
import { CHROME_SURFACE } from "./chromeStyles";
import { producerName, setHistoryDragData } from "./GlobalImageHistory";
import { STACK_RIGHT_CSS, STACK_TOP } from "./Toast";

/** One finished generation, or a burst of them collapsed into a single card. */
export interface GenerationToastItem {
  id: string;
  /** Newest first; more than one when a batch landed together. */
  images: string[];
  /** Producer, as recorded in the history item (a Gemini model id or an app name). */
  model: string;
  aspectRatio: string;
  /** Last time the card was created or extended; the dismiss timer runs from here. */
  shownAt: number;
}

/** How long a card stays before dismissing itself. */
export const GENERATION_TOAST_DURATION_MS = 5000;
/** Generations from the same producer landing within this window share a card. */
export const GENERATION_TOAST_BATCH_MS = 1500;
const CARD_WIDTH = 268;
const MAX_VISIBLE = 3;

/**
 * The card most recently shown, so a burst from the same producer extends it
 * instead of stacking. Session state, never written into a saved workflow.
 */
let latest: GenerationToastItem | null = null;

const forget = (t: { id: string | number }) => {
  if (latest?.id === t.id) latest = null;
};

/** Announce a finished generation under the history button. */
export function pushGenerationToast({
  image,
  model,
  aspectRatio,
}: {
  image: string;
  model: string;
  aspectRatio: string;
}) {
  const now = Date.now();
  const item: GenerationToastItem =
    latest && latest.model === model && now - latest.shownAt < GENERATION_TOAST_BATCH_MS
      ? { ...latest, images: [image, ...latest.images], shownAt: now }
      : {
          id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
          images: [image],
          model,
          aspectRatio,
          shownAt: now,
        };
  latest = item;
  // Re-issuing under the same id replaces the card in place and restarts its timer.
  toast.custom(() => <GenerationToastCard toast={item} />, {
    id: item.id,
    duration: GENERATION_TOAST_DURATION_MS,
    onDismiss: forget,
    onAutoClose: forget,
  });
}

/** Drop every card. Sonner carries only generation toasts today. */
export function clearGenerationToasts() {
  latest = null;
  toast.dismiss();
}

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

export function GenerationToastCard({ toast: item }: { toast: GenerationToastItem }) {
  const count = item.images.length;
  const dismiss = () => toast.dismiss(item.id);

  return (
    <div
      role="status"
      draggable
      // The card drags natively as a history image; keep sonner's swipe gesture
      // from claiming the pointer first.
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        setHistoryDragData(e, { image: item.images[0], prompt: "", timestamp: item.shownAt });
        dismiss();
      }}
      className={`${CHROME_SURFACE} relative flex cursor-grab items-center gap-2.5 overflow-hidden rounded-xl p-1.5 active:cursor-grabbing`}
      style={{ width: CARD_WIDTH }}
      data-testid="generation-toast"
    >
      <Thumbs images={item.images} />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[11px] font-medium leading-[14px] text-neutral-200">
          {count > 1 ? `${count} images generated` : "Image generated"}
        </span>
        <span className="truncate text-[10px] leading-[13px] text-neutral-500">
          {producerName(item.model)} · {item.aspectRatio}
        </span>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors duration-[120ms] hover:bg-white/7 hover:text-white"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" aria-hidden="true">
          <path d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
      <span
        // Keyed on shownAt so a batch extension restarts the countdown
        key={item.shownAt}
        aria-hidden="true"
        className="animate-toast-timer pointer-events-none absolute bottom-0 left-0 h-0.5 bg-blue-500/90"
        style={{ animationDuration: `${GENERATION_TOAST_DURATION_MS}ms` }}
      />
    </div>
  );
}

/**
 * The stack of generation cards, newest on top, anchored under the history
 * button like the message toast. Mount once, in the root layout.
 */
export function GenerationToaster() {
  return (
    <Toaster
      position="top-right"
      theme="dark"
      // Every card in full, newest on top, as the stack read before sonner.
      expand
      gap={8}
      visibleToasts={MAX_VISIBLE}
      // Follows the history button when the agent window moves it.
      offset={{ top: STACK_TOP, right: STACK_RIGHT_CSS }}
      mobileOffset={{ top: STACK_TOP, right: STACK_RIGHT_CSS }}
      style={{ "--width": `${CARD_WIDTH}px`, zIndex: 200 } as React.CSSProperties}
    />
  );
}
