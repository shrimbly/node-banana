"use client";

import { X } from "lucide-react";
import { Toaster, toast } from "sonner";
import { CHROME_SURFACE } from "./chromeStyles";
import { producerName, setHistoryDragData } from "./GlobalImageHistory";
import { STACK_RIGHT_CSS, STACK_TOP } from "./Toast";
import { useAssetStore } from "@/store/assetStore";

/** One finished generation. */
export interface GenerationToastItem {
  id: string;
  image: string;
  /** Producer, as recorded in the history item (a Gemini model id or an app name). */
  model: string;
  aspectRatio: string;
  shownAt: number;
}

/** How long a card stays before dismissing itself. */
export const GENERATION_TOAST_DURATION_MS = 5000;
const CARD_WIDTH = 268;
/** Cards past this many wait behind the stack until the front ones go. */
const MAX_VISIBLE = 4;

/** Cards still up. Sonner also carries the asset library's first-run hint, which clearing must leave. */
const shownCards = new Set<string>();
const forget = (t: { id: string | number }) => {
  shownCards.delete(String(t.id));
};

/** Announce a finished generation under the history button: one card each, stacked by sonner. */
export function pushGenerationToast({
  image,
  model,
  aspectRatio,
}: {
  image: string;
  model: string;
  aspectRatio: string;
}) {
  // Assets and the chat show what arrives themselves; cards would sit over their headers
  if (useAssetStore.getState().appView !== "canvas") return;
  const now = Date.now();
  const item: GenerationToastItem = {
    id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
    image,
    model,
    aspectRatio,
    shownAt: now,
  };
  shownCards.add(item.id);
  toast.custom(() => <GenerationToastCard toast={item} />, {
    id: item.id,
    duration: GENERATION_TOAST_DURATION_MS,
    onDismiss: forget,
    onAutoClose: forget,
  });
}

/** Drop every generation card (and only those). */
export function clearGenerationToasts() {
  for (const id of shownCards) toast.dismiss(id);
  shownCards.clear();
}

const THUMB = "h-10 w-10 shrink-0 rounded-lg squircle object-cover shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]";

export function GenerationToastCard({ toast: item }: { toast: GenerationToastItem }) {
  const dismiss = () => toast.dismiss(item.id);

  return (
    <div
      role="status"
      draggable
      // The card drags natively as a history image; keep sonner's swipe gesture
      // from claiming the pointer first.
      onPointerDown={(e) => e.stopPropagation()}
      onDragStart={(e) => {
        setHistoryDragData(e, { image: item.image, prompt: "", timestamp: item.shownAt });
        dismiss();
      }}
      className={`${CHROME_SURFACE} relative flex cursor-grab items-center gap-2.5 overflow-hidden rounded-xl p-1.5 active:cursor-grabbing`}
      style={{ width: CARD_WIDTH }}
      data-testid="generation-toast"
    >
      <img src={item.image} alt="" className={THUMB} draggable={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[11px] font-medium leading-[14px] text-neutral-200">Image generated</span>
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
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}

/**
 * The stack of generation cards, anchored under the history button like the
 * message toast. Sonner's own stacking: the newest card in front, the ones
 * behind peeking out beneath it, and the whole stack fanning open while the
 * pointer is over it. Mount once, in the root layout.
 */
export function GenerationToaster() {
  return (
    <Toaster
      position="top-right"
      theme="dark"
      gap={8}
      visibleToasts={MAX_VISIBLE}
      // Follows the history button when the agent window moves it.
      offset={{ top: STACK_TOP, right: STACK_RIGHT_CSS }}
      mobileOffset={{ top: STACK_TOP, right: STACK_RIGHT_CSS }}
      style={{ "--width": `${CARD_WIDTH}px`, zIndex: 200 } as React.CSSProperties}
    />
  );
}
