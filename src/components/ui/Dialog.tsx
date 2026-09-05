"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useWorkflowStore } from "@/store/workflowStore";
import { cn } from "@/components/nodes/ui/cn";

/**
 * The one dialog shell. Every modal in the app — settings, editors, the
 * welcome screen, node-local popovers, lightboxes — is this scrim and this
 * panel, so they share a surface, a radius, a type scale and one set of
 * keyboard rules:
 *
 * - Escape closes, from anywhere in the document (nested inputs included).
 * - Tab cycles inside the panel; focus lands in the panel on open and goes
 *   back to whatever opened it on close.
 * - Body scroll is locked, wheel events do not reach the canvas, and the
 *   store's modal count is held so canvas shortcuts stay off.
 *
 * Nothing about *what* a dialog does lives here: content, actions and data
 * flow are the caller's. Pass `onClose` undefined to make a dialog
 * undismissable (no Escape, no backdrop click), as the onboarding flow is.
 */

type DialogSize = "xs" | "sm" | "md" | "lg" | "xl";

/** Widths, matching what the dialogs used before they shared a shell. */
const SIZE_CLASS: Record<DialogSize, string> = {
  xs: "w-80",
  sm: "w-[400px]",
  md: "w-[580px]",
  lg: "w-full max-w-3xl",
  xl: "w-full max-w-5xl",
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogContextValue {
  titleId: string;
  onClose?: () => void;
}

const DialogContext = createContext<DialogContextValue>({ titleId: "" });

/**
 * Every open dialog's overlay. Escape is a document-level listener so it
 * works from any focused input, which means every open dialog hears it —
 * only the one on top may act, or closing a model picker would also close
 * the settings it was opened from. "On top" is document order: overlays
 * share a z-index, so the one painted last is the one the user sees.
 */
const openOverlays = new Set<HTMLElement>();

function topmostOverlay(): HTMLElement | null {
  let top: HTMLElement | null = null;
  for (const overlay of openOverlays) {
    if (!overlay.isConnected) continue;
    if (!top || top.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING) {
      top = overlay;
    }
  }
  return top;
}

export interface DialogProps {
  open: boolean;
  /** Absent: the dialog cannot be dismissed by Escape or the backdrop. */
  onClose?: () => void;
  /** Preset width; `className` on the panel overrides it. */
  size?: DialogSize;
  /** Heavier scrim and no panel chrome — the media lightboxes. */
  variant?: "panel" | "lightbox";
  /** Close when the backdrop itself is clicked. Defaults to on when `onClose` is given. */
  closeOnBackdrop?: boolean;
  /** Escape closes. Defaults to on when `onClose` is given. */
  closeOnEscape?: boolean;
  /** Put focus here on open instead of the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Render inline (inside the caller's tree) rather than in a body portal. */
  portal?: boolean;
  /** Extra classes on the panel — width, height, transitions. */
  className?: string;
  /** Extra classes on the backdrop (the `fixed inset-0` layer). */
  overlayClassName?: string;
  /** `aria-labelledby` target when the title is not a `<DialogTitle>`. */
  labelledBy?: string;
  /** `aria-label` when the dialog has no visible title. */
  label?: string;
  /** Marker attributes for tests and tutorials on the panel. */
  panelProps?: HTMLAttributes<HTMLDivElement>;
  children: ReactNode;
}

export function Dialog({
  open,
  onClose,
  size = "md",
  variant = "panel",
  closeOnBackdrop = onClose !== undefined,
  closeOnEscape = onClose !== undefined,
  initialFocusRef,
  portal = true,
  className,
  overlayClassName,
  labelledBy,
  label,
  panelProps,
  children,
}: DialogProps) {
  const generatedTitleId = useId();
  const titleId = labelledBy ?? generatedTitleId;
  const panelRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // The element that had focus when the dialog opened — it gets focus back.
  const openerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const incrementModalCount = useWorkflowStore((state) => state.incrementModalCount);
  const decrementModalCount = useWorkflowStore((state) => state.decrementModalCount);

  // Canvas shortcuts (delete, pan, zoom) are off while any dialog is open.
  useEffect(() => {
    if (!open) return;
    incrementModalCount();
    const overlay = overlayRef.current;
    if (overlay) openOverlays.add(overlay);
    return () => {
      if (overlay) openOverlays.delete(overlay);
      decrementModalCount();
    };
  }, [open, incrementModalCount, decrementModalCount]);

  // Scroll lock on the document; the canvas behind must not move.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Focus in on open, back to the opener on close.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferred = initialFocusRef?.current;
      const target =
        preferred ?? panel.querySelector<HTMLElement>("[autofocus]") ?? panel;
      // A caller's autoFocus element may already have taken focus.
      if (!panel.contains(document.activeElement)) target.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      const opener = openerRef.current;
      if (opener && opener.isConnected && typeof opener.focus === "function") {
        opener.focus();
      }
    };
    // initialFocusRef is a ref object; its identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Escape closes from anywhere, so a focused input inside still dismisses.
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (topmostOverlay() !== overlayRef.current) return;
      event.preventDefault();
      onCloseRef.current?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeOnEscape]);

  const trapFocus = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const onBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && event.target === event.currentTarget) onClose?.();
  };

  if (!open) return null;

  const isLightbox = variant === "lightbox";

  const node = (
    <DialogContext.Provider value={{ titleId, onClose }}>
      <div
        ref={overlayRef}
        data-dialog-overlay=""
        className={cn(
          "fixed inset-0 z-100 flex items-center justify-center animate-dialog-backdrop",
          isLightbox ? "bg-scrim-heavy p-8" : "bg-scrim",
          overlayClassName
        )}
        onClick={onBackdropClick}
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <div
          {...panelProps}
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={label ? undefined : titleId}
          aria-label={label}
          tabIndex={-1}
          className={cn(
            "relative focus:outline-none animate-dialog-panel",
            isLightbox
              ? "max-w-full max-h-full"
              : "flex flex-col bg-card border border-chrome-border rounded-card shadow-dialog overflow-clip max-h-[85vh] mx-4",
            !isLightbox && SIZE_CLASS[size],
            className,
            panelProps?.className
          )}
          onKeyDown={(event) => {
            trapFocus(event);
            panelProps?.onKeyDown?.(event);
          }}
        >
          {children}
        </div>
      </div>
    </DialogContext.Provider>
  );

  if (!portal || typeof document === "undefined") return node;
  return createPortal(node, document.body);
}

/* ---------------------------------------------------------------- pieces */

interface DialogHeaderProps {
  /** Small mark before the title (the banana, the Comfy logo). */
  icon?: ReactNode;
  /** Right-hand slot next to the close button (badges, help toggles). */
  actions?: ReactNode;
  /** Show the close button. Defaults to on when the dialog has `onClose`. */
  closeButton?: boolean;
  /** Separate the header from the body with a rule. */
  divider?: boolean;
  /** Tight spacing for the xs popover dialogs. */
  compact?: boolean;
  className?: string;
  children: ReactNode;
}

export function DialogHeader({
  icon,
  actions,
  closeButton,
  divider = false,
  compact = false,
  className,
  children,
}: DialogHeaderProps) {
  const { onClose } = useContext(DialogContext);
  const showClose = closeButton ?? onClose !== undefined;
  return (
    <div
      className={cn(
        "flex items-start gap-3 shrink-0",
        compact ? "px-5 pt-4 pb-1" : "px-6 pt-5 pb-4",
        divider && "border-b border-chrome-border/50",
        className
      )}
    >
      {icon && <div className="shrink-0 flex items-center h-6">{icon}</div>}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">{children}</div>
      {(actions || showClose) && (
        <div className="shrink-0 flex items-center gap-1 -my-0.5">
          {actions}
          {showClose && <DialogCloseButton />}
        </div>
      )}
    </div>
  );
}

export function DialogTitle({
  compact = false,
  className,
  children,
}: {
  compact?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { titleId } = useContext(DialogContext);
  return (
    <h2
      id={titleId}
      className={cn(
        "font-semibold text-neutral-100 truncate",
        compact ? "text-sm leading-5" : "text-base leading-6",
        className
      )}
    >
      {children}
    </h2>
  );
}

export function DialogDescription({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("text-xs leading-4 text-neutral-400", className)}>{children}</p>;
}

export function DialogCloseButton({ className, label = "Close" }: { className?: string; label?: string }) {
  const { onClose } = useContext(DialogContext);
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={label}
      className={cn(
        "w-7 h-7 flex items-center justify-center rounded-lg text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
        className
      )}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );
}

export function DialogBody({
  compact = false,
  scroll = true,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { compact?: boolean; scroll?: boolean }) {
  return (
    <div
      {...rest}
      className={cn(
        "flex-1 min-h-0",
        scroll && "overflow-y-auto",
        compact ? "px-5 py-2" : "px-6 py-4",
        className
      )}
    >
      {children}
    </div>
  );
}

export function DialogFooter({
  compact = false,
  divider = true,
  className,
  children,
}: {
  compact?: boolean;
  divider?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 shrink-0",
        compact ? "px-5 py-3" : "px-6 py-4",
        divider && "border-t border-chrome-border/50",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Uppercase label above a group of fields or rows inside a dialog body. */
export function DialogSectionHeader({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <h3 className={cn("text-[11px] font-semibold uppercase tracking-wider text-neutral-500", className)}>
      {children}
    </h3>
  );
}

/* --------------------------------------------------------------- buttons */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-white text-neutral-900 hover:bg-neutral-200",
  secondary: "bg-neutral-700 text-neutral-200 hover:bg-neutral-600",
  ghost: "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700/40",
  danger: "text-red-400 hover:text-red-300 hover:bg-red-500/10",
};

export interface DialogButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Smaller button for the xs popover dialogs. */
  compact?: boolean;
}

/** Footer action. One set of sizes and colours for every dialog. */
export function DialogButton({
  variant = "secondary",
  compact = false,
  className,
  type = "button",
  children,
  ...rest
}: DialogButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center font-medium rounded-lg transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        compact ? "h-[30px] px-3 text-xs" : "h-9 px-4 text-sm",
        BUTTON_VARIANT[variant],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
