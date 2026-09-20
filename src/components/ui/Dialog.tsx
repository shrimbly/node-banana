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
 * The scale is the compact one from the design canvas: 20px sides, 32px
 * footer buttons at 13px, a 16px semibold title. Nothing about *what* a
 * dialog does lives here: content, actions and data flow are the caller's. Pass `onClose` undefined to make a dialog
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
  /**
   * Render in a body portal. Off by default: top-level dialogs mount inline
   * where they are used, as they always have; node-local dialogs turn this on
   * so they escape the canvas's transformed stacking context.
   */
  portal?: boolean;
  /** Extra classes on the panel — width, height, transitions. */
  className?: string;
  /** Extra classes on the backdrop (the `fixed inset-0` layer). */
  overlayClassName?: string;
  /**
   * Handlers on the backdrop, for a dialog with its own rules about what a
   * backdrop click means (the split-grid editor: a drag that ends outside
   * the panel is not a click).
   */
  overlayProps?: HTMLAttributes<HTMLDivElement>;
  /**
   * Stop wheel events in the capture phase so the canvas behind never scrolls.
   * Off for a dialog whose own content has native wheel listeners that must
   * run first (the split-grid mini canvas); it then stops the bubble itself.
   */
  stopWheel?: boolean;
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
  portal = false,
  className,
  overlayClassName,
  overlayProps,
  stopWheel = true,
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
  // Optional calls: component tests stub the store with a bare state object.
  useEffect(() => {
    if (!open) return;
    incrementModalCount?.();
    const overlay = overlayRef.current;
    if (overlay) openOverlays.add(overlay);
    return () => {
      if (overlay) openOverlays.delete(overlay);
      decrementModalCount?.();
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
        {...overlayProps}
        ref={overlayRef}
        data-dialog-overlay=""
        className={cn(
          "fixed inset-0 z-100 flex items-center justify-center animate-dialog-backdrop",
          isLightbox ? "bg-scrim-heavy p-8" : "bg-scrim",
          overlayClassName,
          overlayProps?.className
        )}
        onClick={(event) => {
          onBackdropClick(event);
          overlayProps?.onClick?.(event);
        }}
        onWheelCapture={stopWheel ? (event) => event.stopPropagation() : overlayProps?.onWheelCapture}
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
        compact ? "px-4 pt-3 pb-1" : "px-5 pt-3.5 pb-2.5",
        divider && "border-b border-chrome-border/50",
        className
      )}
    >
      {icon && <div className="shrink-0 flex items-center h-6 [&>*]:w-5 [&>*]:h-5">{icon}</div>}
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
        compact ? "text-[13px] leading-5" : "text-base leading-6",
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
        "w-7 h-7 flex items-center justify-center rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-700/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
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
        compact ? "px-4 py-2" : "px-5 py-3",
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
        compact ? "px-4 py-2.5" : "px-5 py-3",
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

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  /** Ink fill, as the site's primary action. */
  primary: "bg-neutral-200 text-neutral-900 hover:bg-[#ededed]",
  secondary: "bg-neutral-700 text-neutral-200 hover:bg-neutral-600",
  /** Hairline border on a transparent ground — the split dialogs' second action. */
  outline: "border border-card-border text-neutral-200 hover:border-neutral-600 hover:bg-white/[0.03]",
  ghost: "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-700/40",
  danger: "text-red-400 hover:text-red-300 hover:bg-red-500/10",
};

export interface DialogButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** Smaller button for the xs popover dialogs. */
  compact?: boolean;
  /**
   * `sm` is the compact scale every dialog used before the split design;
   * `md` is the split dialogs' 36px button in the display face.
   */
  size?: "sm" | "md";
}

/** Footer action. One set of sizes and colours for every dialog. */
export function DialogButton({
  variant = "secondary",
  compact = false,
  size = "sm",
  className,
  type = "button",
  children,
  ...rest
}: DialogButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 font-medium rounded-lg transition-colors whitespace-nowrap",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        compact
          ? "h-7 px-2.5 text-xs"
          : size === "md"
            ? "h-9 px-4 font-display text-[13px] font-semibold tracking-[-0.01em]"
            : "h-8 px-3.5 text-[13px]",
        BUTTON_VARIANT[variant],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ----------------------------------------------------------------- split */

/**
 * The split dialog: a #0a0a0a pane beside the page. The welcome screen,
 * settings and first use are all this shape, drawn on the design canvas as
 * "C · Split". The pane carries identity or navigation (the mark, the
 * wordmark, a rail, filters), the page carries a display heading, a lead
 * and ruled rows. Pass these as the panel's children; the panel itself
 * takes `splitPanelClass` so the pane can run edge to edge.
 */
export const splitPanelClass = "bg-canvas-bg border-white/[0.08] flex-row";

export function DialogPane({
  width = 224,
  className,
  children,
}: {
  /** Pane width in px. 224 for a rail, 240–300 for identity or filters. */
  width?: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("shrink-0 bg-pane p-6 flex flex-col justify-between gap-6 min-h-0", className)}
      style={{ width }}
    >
      {children}
    </div>
  );
}

/** The right-hand column of a split dialog. */
export function DialogPage({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("flex-1 min-w-0 min-h-0 flex flex-col relative", className)}>
      {children}
    </div>
  );
}

/** Top strip of the page: a mono eyebrow on the left, the close button (or anything) on the right. */
export function DialogPageHead({
  eyebrow,
  actions,
  closeButton,
  className,
}: {
  eyebrow?: ReactNode;
  actions?: ReactNode;
  /** Show the close button. Defaults to on when the dialog has `onClose`. */
  closeButton?: boolean;
  className?: string;
}) {
  const { onClose } = useContext(DialogContext);
  const showClose = closeButton ?? onClose !== undefined;
  return (
    <div className={cn("flex items-center justify-between gap-3 pl-8 pr-6 pt-5 shrink-0 min-h-[28px]", className)}>
      <div className="min-w-0">{eyebrow && <DialogEyebrow>{eyebrow}</DialogEyebrow>}</div>
      <div className="flex items-center gap-1 -my-0.5">
        {actions}
        {showClose && <DialogCloseButton />}
      </div>
    </div>
  );
}

/** Small mono uppercase label: section eyebrows, status lines, meta. */
export function DialogEyebrow({ className, children, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn("font-mono text-[11px] leading-4 tracking-eyebrow uppercase text-ink-3", className)}
    >
      {children}
    </span>
  );
}

/** Display heading of a split page. Carries the dialog's title id unless `asTitle` is off. */
export function DialogHeading({
  asTitle = true,
  size = "lg",
  className,
  children,
}: {
  asTitle?: boolean;
  /** `lg` 28px for settings pages and first use; `md` 24px for welcome views. */
  size?: "md" | "lg";
  className?: string;
  children: ReactNode;
}) {
  const { titleId } = useContext(DialogContext);
  return (
    <h2
      id={asTitle ? titleId : undefined}
      className={cn(
        "font-display font-bold tracking-display text-neutral-100 flex items-center gap-2.5",
        size === "lg" ? "text-[28px] leading-8" : "text-2xl leading-7",
        className
      )}
    >
      {children}
    </h2>
  );
}

/** One-line lead under a heading, in the display face. */
export function DialogLead({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn("font-display text-sm leading-5 font-medium text-neutral-400", className)}>{children}</p>
  );
}

/** Heading and lead together, with the page's side padding. */
export function DialogPageTitle({
  heading,
  lead,
  size,
  className,
}: {
  heading: ReactNode;
  lead?: ReactNode;
  size?: "md" | "lg";
  className?: string;
}) {
  return (
    <div className={cn("px-8 pt-3 shrink-0", className)}>
      <DialogHeading size={size}>{heading}</DialogHeading>
      {lead && <DialogLead className="mt-1">{lead}</DialogLead>}
    </div>
  );
}

/** Scrolling content of a split page. */
export function DialogPageBody({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn("flex-1 min-h-0 overflow-y-auto px-8 pt-4 pb-2", className)}>
      {children}
    </div>
  );
}

/** Footer of a split page: no rule, actions right unless `between`. */
export function DialogPageFooter({
  between = false,
  className,
  children,
}: {
  between?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 shrink-0 pl-8 pr-6 pt-4 pb-5",
        between ? "justify-between" : "justify-end",
        className
      )}
    >
      {children}
    </div>
  );
}

/** A rail entry in the pane: dot marker, display face, current page in ink. */
export function DialogRailItem({
  active = false,
  done = false,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; done?: boolean }) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      {...rest}
      className={cn(
        "flex items-center gap-2.5 h-9 -mx-6 px-6 text-left font-display text-sm font-medium tracking-[-0.01em] transition-colors",
        "focus-visible:outline-none focus-visible:bg-white/[0.04]",
        active ? "text-neutral-100" : "text-neutral-400 hover:text-neutral-200",
        "disabled:text-neutral-600 disabled:hover:text-neutral-600 disabled:cursor-default",
        className
      )}
    >
      <span
        aria-hidden="true"
        className={cn("w-1.5 h-1.5 rounded-full shrink-0", active ? "bg-neutral-200" : done ? "bg-neutral-500" : "bg-transparent")}
      />
      {children}
    </button>
  );
}

/** Title of a ruled row: display face at 14px. */
export function DialogRowTitle({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("font-display text-sm leading-[18px] font-semibold tracking-[-0.01em] text-neutral-100", className)}>
      {children}
    </div>
  );
}

/**
 * Ruled row: a title and description on the left, controls on the right,
 * a hairline above every row but the first. Settings pages are stacks of
 * these instead of cards.
 */
export function DialogRow({
  title,
  description,
  first = false,
  align = "center",
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  first?: boolean;
  align?: "center" | "start";
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-6 py-3.5",
        align === "center" ? "items-center" : "items-start",
        !first && "border-t border-card",
        className
      )}
    >
      {(title || description) && (
        <div className="min-w-0">
          {title && <DialogRowTitle>{title}</DialogRowTitle>}
          {description && <p className={cn("text-xs leading-4 text-ink-3", title && "mt-0.5")}>{description}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

/** Mono status with a coloured dot: "Configured via .env", "Connected · 634 node types". */
export function DialogStatus({
  tone = "ok",
  className,
  children,
}: {
  tone?: "ok" | "error" | "neutral";
  className?: string;
  children: ReactNode;
}) {
  const dotColor = tone === "ok" ? "bg-handle-image" : tone === "error" ? "bg-error" : "bg-neutral-500";
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-[11px] leading-4 tracking-eyebrow uppercase text-neutral-400", className)}>
      <span aria-hidden="true" className={cn("w-1.5 h-1.5 rounded-full shrink-0", dotColor)} />
      {children}
    </span>
  );
}

/** Small mono chip: "Beta", a template category. */
export function DialogChip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center h-[18px] px-1.5 border border-chrome-border rounded font-mono text-[10px] tracking-eyebrow uppercase text-ink-3 whitespace-nowrap",
        className
      )}
    >
      {children}
    </span>
  );
}

/** Text-only action inside a row: "Override", "Clear", "Change folder". */
export function DialogTextButton({ className, type = "button", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type={type}
      className={cn(
        "h-7 px-1.5 rounded font-display text-[13px] font-medium text-neutral-400 hover:text-neutral-100 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-selection",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
    >
      {children}
    </button>
  );
}

/** The Nb mark with the version beside it, for the foot of a pane. */
export function DialogPaneFoot({ version, className }: { version?: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/banana_icon.png" alt="" className="w-5 h-5 rounded-[5px]" />
      {version && <DialogEyebrow className="text-neutral-500">{version}</DialogEyebrow>}
    </div>
  );
}

/** The stacked wordmark from the site, for the identity pane. */
export function DialogWordmark({ size = 46, className }: { size?: number; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("font-display font-bold uppercase text-neutral-200 leading-[0.9] tracking-[-0.05em]", className)}
      style={{ fontSize: size }}
    >
      Node
      <br />
      Banana
    </div>
  );
}
