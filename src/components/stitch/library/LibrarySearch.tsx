"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { ListFilter, Search } from "lucide-react";
import { cn } from "@/components/nodes/ui/cn";
import { MenuDivider } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";
import type { AssetSort } from "@/lib/assets/types";
import { EDIT_MENU_DIVIDER, EDIT_MENU_SURFACE, SEGMENT, SEGMENT_OFF, SEGMENT_ON, SEGMENTS } from "../editorStyles";
import { RailSwitch } from "../railParts";

/** The popover's accessible name, and the button's. */
const FILTER_LABEL = "Filter and sort";
/** What the dot on the button says. */
const FILTERS_ON = "Filters are on";

/** The Assets view's own two orders, as the popover's Sort segments. */
export const SORT_OPTIONS: readonly { value: AssetSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
];

const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), [tabindex="0"]';

/**
 * The library's one search: a 32px field on the field ground, a search glyph,
 * and inside it at the right the filter button, which opens a small popover
 * under the field with the rest of the list's controls (`filters`: project,
 * kind, favourites, sort). A dot on the button says something in it is not
 * at its default. The library picker uses it.
 *
 * The popover takes focus as it opens. Escape closes it and gives focus back
 * to the button (a menu open inside it hears its own Escape first); a press
 * outside it, or focus leaving it and the button for anything else, closes
 * it. A press on its own padding or a row's label keeps focus in it (it is
 * focusable itself), so it stays open and still hears Escape. The picker
 * around it keeps the editor's keys off while it is up, so Space toggles a
 * switch in it rather than playing. It closes when the search is turned off,
 * and stays closed when it comes back.
 */
export function LibrarySearch({
  inputRef,
  label,
  placeholder = "Search",
  value,
  onChange,
  onKeyDown,
  disabled = false,
  filtered,
  filters,
  className,
}: {
  inputRef?: Ref<HTMLInputElement>;
  /** The field's accessible name ("Search the library"). */
  label: string;
  placeholder?: string;
  value: string;
  onChange: (q: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  /** Something in the popover is not at its default. */
  filtered: boolean;
  /** The popover's rows: FilterRow, FilterSegments, FilterSwitch, ProjectMenu. */
  filters: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // Turned off (the library went away) while open: closed for good, so it never comes back by itself and takes focus
  if (disabled && open) setOpen(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const popoverId = `${id}-filters`;
  const noteId = `${id}-note`;
  const shown = open && !disabled;

  return (
    <div className={cn("relative", className)}>
      <div className="flex h-8 items-center gap-2 rounded-lg bg-edit-field pl-2.5 pr-1 transition-shadow has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-white/40">
        <Search size={14} strokeWidth={1.5} aria-hidden="true" className="shrink-0 text-ink-3" />
        <input
          ref={inputRef}
          type="text"
          aria-label={label}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] text-neutral-200 outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
        />
        <div className="group relative flex shrink-0">
          <button
            ref={triggerRef}
            type="button"
            aria-label={FILTER_LABEL}
            aria-haspopup="dialog"
            aria-expanded={shown}
            aria-controls={shown ? popoverId : undefined}
            aria-describedby={filtered ? noteId : undefined}
            data-filtered={filtered || undefined}
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
            // Focus that leaves the button for anything but the popover (Shift+Tab back to the field) closes it: one
            // left open with focus elsewhere would keep the editor's keys
            onBlur={(event) => {
              const next = event.relatedTarget as Node | null;
              if (!shown || !next || popoverRef.current?.contains(next)) return;
              setOpen(false);
            }}
            className="relative flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-white/6 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 aria-expanded:bg-edit-pressed aria-expanded:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-3"
          >
            <ListFilter size={14} strokeWidth={1.5} aria-hidden="true" />
            {filtered && <span aria-hidden="true" className="absolute right-[3px] top-[3px] h-[5px] w-[5px] rounded-full bg-neutral-100" />}
          </button>
          {/* Under the button, in the list: focus coming back from the popover shows it, and above it would cover the
              title row's hide button */}
          {!shown && <Tooltip label={FILTER_LABEL} detail={filtered ? FILTERS_ON : undefined} placement="bottom" align="end" />}
        </div>
        {filtered && (
          <span id={noteId} className="sr-only">
            {FILTERS_ON}
          </span>
        )}
      </div>
      {shown && (
        <FilterPopover
          ref={popoverRef}
          id={popoverId}
          triggerRef={triggerRef}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) triggerRef.current?.focus({ preventScroll: true });
          }}
        >
          {filters}
        </FilterPopover>
      )}
    </div>
  );
}

function FilterPopover({
  ref,
  id,
  triggerRef,
  onClose,
  children,
}: {
  ref: RefObject<HTMLDivElement | null>;
  id: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}) {
  // Latest close for the listener, which is bound once
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    // The button toggles the popover itself; a press on it is not "outside"
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (ref.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close.current(false);
    };
    document.addEventListener("pointerdown", onPointerDown, { capture: true });
    return () => document.removeEventListener("pointerdown", onPointerDown, { capture: true });
  }, [ref, triggerRef]);

  return (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={FILTER_LABEL}
      // Focusable, though not a tab stop: a press on its padding or a label focuses it, as a browser focuses the
      // nearest focusable ancestor, rather than the dialog around the picker (which would close it) or the page (where
      // its Escape would no longer be heard)
      tabIndex={-1}
      // Under the field and as wide as it is
      className={cn(EDIT_MENU_SURFACE, "absolute left-0 top-full z-50 mt-1.5 w-full border p-1.5 outline-none")}
      onKeyDown={(event) => {
        // A menu open in it (the project's) closes itself first and marks the key handled; the dialog around the
        // picker leaves a handled Escape alone
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        close.current(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || ref.current?.contains(next) || triggerRef.current?.contains(next)) return;
        close.current(false);
      }}
    >
      {children}
    </div>
  );
}

/** One of the popover's rows: its label at the left, the control filling the rest (as the rail's rows). */
export function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-9 items-center gap-3 px-1.5">
      <span aria-hidden="true" className="w-14 shrink-0 text-[13px] text-neutral-300">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 justify-end">{children}</div>
    </div>
  );
}

/** A switch row (Favorites, This workflow): a click on its label toggles it too. */
export function FilterSwitch({
  label,
  checked,
  onChange,
  disabled,
  title,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Why it is off: the row's tooltip, and the switch's accessible description. */
  title?: string;
}) {
  return (
    <label
      title={title}
      className={cn("flex h-9 items-center justify-between gap-3 px-1.5", disabled ? "cursor-not-allowed" : "cursor-pointer")}
    >
      <span className={cn("text-[13px]", disabled ? "text-neutral-600" : "text-neutral-300")}>{label}</span>
      <RailSwitch label={label} checked={checked} onChange={onChange} disabled={disabled} title={title} />
    </label>
  );
}

/** The hairline between the filters and the sort, as between the edit menus' groups. */
export function FilterDivider() {
  return <MenuDivider role="separator" className={cn(EDIT_MENU_DIVIDER, "mx-1.5")} />;
}

/**
 * One of a few choices (Kind: All | Video | Audio; Sort: Newest | Oldest) as segments on the field ground, the
 * chosen one lifted. A radio group: one tab stop, the arrows, Home and End move the choice.
 */
export function FilterSegments<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = options.findIndex((o) => o.value === value);
    const last = options.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index >= last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index <= 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    if (next !== index) onChange(options[next].value);
    ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={cn(SEGMENTS, "w-full")} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
            className={cn(SEGMENT, checked ? SEGMENT_ON : SEGMENT_OFF)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
