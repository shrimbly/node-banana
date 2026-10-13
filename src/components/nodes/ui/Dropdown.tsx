"use client";

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { menuSurfaceClass } from "@/components/ui/Menu";
import { cn } from "./cn";
import { useHoldLive } from "../paintMode";

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Options sharing a group get a section label above the first of them. */
  group?: string;
  /** Right-aligned mono detail: a size, a price, a provider hint. */
  meta?: ReactNode;
  /** Leading glyph, at the row's type size. */
  icon?: ReactNode;
}

export type DropdownSize = "node" | "dialog";

export interface DropdownProps {
  id?: string;
  value: string;
  options: ReadonlyArray<DropdownOption | string>;
  onChange: (value: string) => void;
  /** Adds a leading option with this label and an empty value. */
  emptyLabel?: string;
  /** Shown in the trigger when the value matches no option. */
  placeholder?: string;
  disabled?: boolean;
  /** `node`: 22px rows and 10px type in the settings panel. `dialog`: 28px rows and 12px type. */
  size?: DropdownSize;
  /** A search well above the list. Defaults to on past eight options. */
  searchable?: boolean;
  className?: string;
  /** Classes on the trigger button, replacing the default well. */
  triggerClassName?: string;
  /** What the trigger shows, replacing the chosen label and chevron (an icon button). */
  trigger?: ReactNode;
  /** Which edge of the trigger the list lines up with; `end` for a trigger at a card's right edge. */
  align?: "start" | "end";
  "aria-label"?: string;
  "data-tutorial"?: string;
}

/** Above this many options the list gets a search well and typing filters instead of jumping. */
const SEARCH_THRESHOLD = 8;
/** Flow px between the trigger and the list. */
const GAP = 4;
/** Flow px the list may grow to before it scrolls. */
const MAX_LIST_H = 240;
/** Type-ahead buffer lifetime. */
const TYPEAHEAD_MS = 700;

const SIZES = {
  node: {
    trigger:
      "nodrag nopan h-[22px] w-full min-w-0 pl-[7px] pr-[6px] rounded-well squircle bg-well shadow-well " +
      "text-node text-neutral-200 text-left flex items-center justify-between gap-1.5 " +
      "focus:outline-none focus:ring-1 focus:ring-neutral-600 disabled:opacity-50 disabled:cursor-not-allowed " +
      "hover:enabled:bg-[#1f1f1f] transition-colors cursor-pointer",
    chevron: 10,
    row: "h-[22px] px-2 text-node gap-1.5",
    check: 10,
    section: "px-2 pt-1.5 pb-0.5 font-mono text-[9px] leading-3 uppercase tracking-eyebrow text-ink-3",
    meta: "text-[9px]",
    search: "h-[22px] mx-1 mt-1 px-[7px] rounded-well squircle bg-well shadow-well text-node gap-1.5",
    searchIcon: 10,
    list: "py-1",
    minW: 160,
    maxW: 280,
  },
  dialog: {
    trigger:
      "h-9 w-full px-3 rounded-lg border border-card-border bg-card text-[13px] text-neutral-100 text-left " +
      "flex items-center justify-between gap-2 outline-none transition-colors focus:border-neutral-500 " +
      "focus-visible:ring-2 focus-visible:ring-selection disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
    chevron: 16,
    row: "min-h-7 px-2.5 py-1 text-xs gap-2",
    check: 12,
    section: "px-2.5 pt-2 pb-1 font-mono text-[10px] leading-[14px] uppercase tracking-eyebrow text-ink-3",
    meta: "text-[11px]",
    search: "h-7 mx-1 mt-1 px-2 rounded-md bg-well border border-card-border text-xs gap-2",
    searchIcon: 12,
    list: "py-1",
    minW: 180,
    maxW: 360,
  },
} as const;

function normalize(options: ReadonlyArray<DropdownOption | string>, emptyLabel?: string): DropdownOption[] {
  const list = options.map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  return emptyLabel !== undefined ? [{ value: "", label: emptyLabel }, ...list] : list;
}

interface Placement {
  /** Where the list is mounted: the flow viewport (scales with zoom) or the body (dialogs). */
  container: HTMLElement;
  style: CSSProperties;
}

/**
 * Anchor the list under (or above) the trigger.
 *
 * Inside React Flow the list goes into the viewport element, in flow
 * coordinates, so it zooms and pans with the node and escapes the controls
 * card's overflow clip. Elsewhere it is fixed to the body in screen pixels.
 */
function place(trigger: HTMLElement, minW: number, maxW: number, align: "start" | "end"): Placement {
  const rect = trigger.getBoundingClientRect();
  const viewport = trigger.closest(".react-flow")?.querySelector<HTMLElement>(".react-flow__viewport") ?? null;
  const spaceBelow = window.innerHeight - rect.bottom;
  const flipUp = spaceBelow < rect.top && spaceBelow < MAX_LIST_H;

  if (viewport) {
    const vp = viewport.getBoundingClientRect();
    const zoom = zoomOf(viewport);
    const width = Math.min(maxW, Math.max(minW, rect.width / zoom));
    return {
      container: viewport,
      style: {
        position: "absolute",
        left: align === "end" ? (rect.right - vp.left) / zoom - width : (rect.left - vp.left) / zoom,
        top: (flipUp ? rect.top - vp.top : rect.bottom - vp.top) / zoom + (flipUp ? -GAP : GAP),
        width,
        transform: flipUp ? "translateY(-100%)" : undefined,
        zIndex: 1000,
        pointerEvents: "auto",
      },
    };
  }
  const width = Math.min(maxW, Math.max(minW, rect.width));
  return {
    container: document.body,
    style: {
      position: "fixed",
      left: align === "end" ? rect.right - width : rect.left,
      top: flipUp ? rect.top - GAP : rect.bottom + GAP,
      width,
      transform: flipUp ? "translateY(-100%)" : undefined,
      zIndex: 200,
    },
  };
}

function zoomOf(viewport: HTMLElement): number {
  const t = getComputedStyle(viewport).transform;
  const m = t.match(/matrix\(([^,]+),/);
  const zoom = m ? parseFloat(m[1]) : 1;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * A select on the Instrument menu skin: the well is the trigger, the list
 * opens under it at the same width with a check on the chosen row. Arrow
 * keys, Home/End, Enter, Space, Escape and type-to-jump work as on a
 * native select; long lists gain a search well.
 */
export function Dropdown({
  id: idProp,
  value,
  options,
  onChange,
  emptyLabel,
  placeholder,
  disabled,
  size = "node",
  searchable,
  className,
  triggerClassName,
  trigger,
  align = "start",
  "aria-label": ariaLabel,
  "data-tutorial": dataTutorial,
}: DropdownProps) {
  const S = SIZES[size];
  const reactId = useId();
  const id = idProp ?? `dropdown-${reactId}`;
  const listId = `${id}-list`;
  const all = useMemo(() => normalize(options, emptyLabel), [options, emptyLabel]);
  const hasSearch = searchable ?? all.length > SEARCH_THRESHOLD;

  const [open, setOpen] = useState(false);
  // The list is in a portal: the node stays live while it is open.
  useHoldLive(open);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [scrollable, setScrollable] = useState(false);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typeahead = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? all.filter((o) => o.label.toLowerCase().includes(q)) : all;
  }, [all, query]);
  const selected = all.find((o) => o.value === value);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(-1);
    setPlacement(null);
  }, []);

  const openList = useCallback(() => {
    const button = triggerRef.current;
    if (!button || disabled) return;
    setPlacement(place(button, S.minW, S.maxW, align));
    const current = all.findIndex((o) => o.value === value);
    setActive(current >= 0 ? current : all.findIndex((o) => !o.disabled));
    setOpen(true);
  }, [all, disabled, value, S.minW, S.maxW, align]);

  const pick = useCallback(
    (option: DropdownOption | undefined) => {
      if (!option || option.disabled) return;
      if (option.value !== value) onChange(option.value);
      close();
      triggerRef.current?.focus();
    },
    [close, onChange, value]
  );

  // Focus the search well once the list is up; keep it on the trigger otherwise.
  useEffect(() => {
    if (!open) return;
    if (hasSearch) searchRef.current?.focus();
    else triggerRef.current?.focus();
  }, [open, hasSearch]);

  // Fade the clipped edge only when there is something to scroll to.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!open || !el) return;
    setScrollable(el.scrollHeight > el.clientHeight + 1);
  }, [open, visible.length]);

  // Keep the active row in view as the keys move it.
  useEffect(() => {
    if (!open || active < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  // Outside pointer, Escape from anywhere, or the window changing shape all dismiss.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    const onResize = () => close();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  const move = useCallback(
    (from: number, step: 1 | -1, wrapToEnds = false) => {
      const n = visible.length;
      if (n === 0) return;
      let i = from;
      for (let k = 0; k < n; k++) {
        i = wrapToEnds && from === -1 ? (step === 1 ? 0 : n - 1) : (i + step + n) % n;
        wrapToEnds = false;
        if (!visible[i]?.disabled) {
          setActive(i);
          return;
        }
      }
    },
    [visible]
  );

  const jumpTo = useCallback(
    (char: string) => {
      const now = Date.now();
      const buf = now - typeahead.current.at < TYPEAHEAD_MS ? typeahead.current.text + char : char;
      typeahead.current = { text: buf.toLowerCase(), at: now };
      const start = buf.length === 1 ? active + 1 : active;
      const n = visible.length;
      for (let k = 0; k < n; k++) {
        const i = (start + k + n) % n;
        const o = visible[i];
        if (!o.disabled && o.label.toLowerCase().startsWith(typeahead.current.text)) {
          setActive(i);
          if (!open) pick(o);
          return;
        }
      }
    },
    [active, open, pick, visible]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const inSearch = e.target === searchRef.current;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!open) openList();
        else move(active, 1, true);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (!open) openList();
        else move(active, -1, true);
        return;
      case "Home":
        if (!open) return;
        e.preventDefault();
        move(-1, 1, true);
        return;
      case "End":
        if (!open) return;
        e.preventDefault();
        move(-1, -1, true);
        return;
      case "Enter":
        e.preventDefault();
        if (!open) openList();
        else pick(visible[active]);
        return;
      case " ":
        if (inSearch) return;
        e.preventDefault();
        if (!open) openList();
        else pick(visible[active]);
        return;
      case "Escape":
        if (!open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
        return;
      case "Tab":
        if (open) {
          if (active >= 0) pick(visible[active]);
          else close();
        }
        return;
      default:
        if (inSearch || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
        e.preventDefault();
        jumpTo(e.key);
    }
  };

  // Section labels appear where the group changes, in the order given.
  let lastGroup: string | undefined;

  const list = placement && open && (
    <div
      ref={listRef}
      id={listId}
      role="listbox"
      aria-labelledby={ariaLabel ? undefined : id}
      aria-label={ariaLabel}
      data-dropdown-list
      className={cn(menuSurfaceClass, "nodrag nopan nowheel overflow-hidden outline-none")}
      style={placement.style}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        // Clicking a row must not steal focus from the trigger/search.
        if (e.target !== searchRef.current) e.preventDefault();
      }}
    >
      {hasSearch && (
        <div className={cn("flex items-center text-neutral-200", S.search)}>
          <Search size={S.searchIcon} strokeWidth={2.5} className="shrink-0 text-neutral-500" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search"
            aria-label="Search options"
            aria-controls={listId}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-neutral-500"
          />
        </div>
      )}
      <div
        ref={scrollRef}
        className={cn("overflow-y-auto overscroll-contain", S.list)}
        style={{
          maxHeight: MAX_LIST_H,
          maskImage: scrollable ? "linear-gradient(to bottom, black calc(100% - 12px), transparent)" : undefined,
        }}
      >
        {visible.length === 0 && (
          <div className={cn("flex items-center text-neutral-500", S.row)}>No matches</div>
        )}
        {visible.map((o, i) => {
          const isSelected = o.value === value;
          const isActive = i === active;
          const label =
            o.group && o.group !== lastGroup ? <div className={S.section}>{o.group}</div> : null;
          lastGroup = o.group ?? lastGroup;
          return (
            <React.Fragment key={o.value || "\u0000empty"}>
              {label}
              <div
                role="option"
                id={`${listId}-${i}`}
                data-index={i}
                data-value={o.value}
                aria-selected={isSelected}
                aria-disabled={o.disabled || undefined}
                onMouseEnter={() => !o.disabled && setActive(i)}
                onClick={() => pick(o)}
                className={cn(
                  "flex items-center whitespace-nowrap cursor-pointer",
                  S.row,
                  isActive ? "bg-neutral-700 text-neutral-100" : "text-neutral-300",
                  o.disabled && "opacity-30 cursor-not-allowed"
                )}
              >
                {o.icon !== undefined && o.icon !== null && (
                  <span aria-hidden className="flex shrink-0 justify-center" style={{ width: S.check }}>
                    {o.icon}
                  </span>
                )}
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{o.label}</span>
                {o.meta !== undefined && o.meta !== null && (
                  <span className={cn("font-mono text-ink-3 whitespace-nowrap", S.meta)}>{o.meta}</span>
                )}
                <span className="flex shrink-0 justify-center" style={{ width: S.check }}>
                  {isSelected && <Check size={S.check} strokeWidth={2.5} className="text-neutral-200" />}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className={cn("relative min-w-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        data-tutorial={dataTutorial}
        data-value={value}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
        className={cn(triggerClassName ?? S.trigger, open && size === "node" && "ring-1 ring-neutral-600")}
      >
        {trigger ?? (
          <>
            <span className={cn("min-w-0 flex-1 whitespace-nowrap overflow-hidden text-ellipsis", !selected && "text-neutral-500")}>
              {selected ? selected.label : placeholder ?? ""}
            </span>
            <ChevronDown
              size={S.chevron}
              strokeWidth={size === "node" ? 2.5 : 1.75}
              className={cn("shrink-0 transition-transform duration-150", open ? "rotate-180 text-neutral-300" : "text-neutral-500")}
            />
          </>
        )}
      </button>
      {list && createPortal(list, placement.container)}
    </div>
  );
}
