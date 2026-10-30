"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuItem, MenuSurface } from "@/components/ui/Menu";
import { EDIT_MENU_ROW, EDIT_MENU_SURFACE } from "../editorStyles";

export interface RadioMenuOption<T> {
  value: T;
  label: string;
}

const EDGE = 8;
const MENU_GAP = 4;

/**
 * A button that opens a one-choice menu under it, on the edit menus' skin:
 * the library's project menu, in its filter popover. The arrows, Home and End move
 * between the choices, Enter picks one, and choosing closes it. Escape, Tab,
 * a press outside, a wheel or a resize close it too; Escape closes only the
 * menu, not the dialog it is in. Focus goes back to the button.
 */
export function RadioMenu<T>({
  label,
  buttonLabel,
  value,
  options,
  onChange,
  width,
  className,
  align = "start",
}: {
  /** The button's accessible name, e.g. "Project: All projects". */
  label: string;
  /** What the button shows. */
  buttonLabel: ReactNode;
  value: T;
  options: readonly RadioMenuOption<T>[];
  onChange: (value: T) => void;
  width: number;
  className?: string;
  /** Which edge of the button the menu lines up with: "end" for a button at the right end of a row. */
  align?: "start" | "end";
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const close = (refocus: boolean) => {
    setAnchor(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const toggle = () => {
    if (anchor) return close(false);
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: align === "end" ? rect.right - width : rect.left, y: rect.bottom + MENU_GAP });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={label}
        onClick={toggle}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
          className,
        )}
      >
        {buttonLabel}
        <ChevronDown size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-ink-3" />
      </button>
      {anchor && (
        <OpenRadioMenu
          anchor={anchor}
          trigger={triggerRef}
          value={value}
          options={options}
          width={width}
          ariaLabel={label}
          onPick={(next) => {
            close(true);
            if (next !== value) onChange(next);
          }}
          onDismiss={close}
        />
      )}
    </>
  );
}

function OpenRadioMenu<T>({
  anchor,
  trigger,
  value,
  options,
  width,
  ariaLabel,
  onPick,
  onDismiss,
}: {
  anchor: { x: number; y: number };
  trigger: RefObject<HTMLButtonElement | null>;
  value: T;
  options: readonly RadioMenuOption<T>[];
  width: number;
  ariaLabel: string;
  onPick: (value: T) => void;
  onDismiss: (refocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y });

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setPosition({
      left: Math.max(EDGE, Math.min(anchor.x, window.innerWidth - width - EDGE)),
      top: Math.max(EDGE, Math.min(anchor.y, window.innerHeight - height - EDGE)),
    });
  }, [anchor, width]);

  // Latest dismiss for the listeners, which are bound once
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true });
    // The trigger toggles the menu itself; a press on it is not "outside"
    const outside = (target: EventTarget | null) =>
      !!ref.current && !ref.current.contains(target as Node) && !trigger.current?.contains(target as Node);
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event.target)) dismiss.current(false);
    };
    const onWheel = (event: WheelEvent) => {
      if (outside(event.target)) dismiss.current(false);
    };
    const onResize = () => dismiss.current(false);
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    // Capture on the document: the dialog stops the wheel in its own capture phase, so a window or bubble
    // listener never hears a wheel over the grid
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, { capture: true });
      document.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, [trigger]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
    const index = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % rows.length;
    else if (event.key === "ArrowUp") next = index <= 0 ? rows.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key === "Escape" || event.key === "Tab") {
      // Handled here, so the dialog's own Escape (a window listener after this one) leaves it open
      event.preventDefault();
      onDismiss(true);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    rows[next]?.focus();
  };

  return (
    <MenuSurface
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(EDIT_MENU_SURFACE, "max-h-[320px] overflow-y-auto")}
      style={{ left: position.left, top: position.top, width }}
    >
      {options.map((option, i) => {
        const active = option.value === value;
        return (
          <MenuItem key={i} role="menuitemradio" aria-checked={active} className={EDIT_MENU_ROW} onClick={() => onPick(option.value)}>
            <span className="truncate">{option.label}</span>
            {active && <Check size={14} strokeWidth={1.5} aria-hidden="true" className="ml-auto shrink-0" />}
          </MenuItem>
        );
      })}
    </MenuSurface>
  );
}
