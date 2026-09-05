"use client";

import { MenuEmpty, MenuFooter, MenuHeader, MenuHint, MenuItem, MenuList, MenuSectionLabel, MenuSurface } from "@/components/ui/Menu";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { NodeType } from "@/types";
import { useSavedComfyNodes } from "@/hooks/useSavedComfyNodes";
import { ALL_NODE_OPTIONS, optionKey, savedComfyOptions } from "./ConnectionDropMenu";

interface NodeSearchMenuProps {
  /** Screen position (clientX/clientY) where the menu should anchor. */
  position: { x: number; y: number };
  /** `savedNodeId` is set when the pick is a saved Comfy node. */
  onSelect: (type: NodeType, savedNodeId?: string) => void;
  onClose: () => void;
}

const MENU_WIDTH = 224; // matches w-56
const MENU_MAX_HEIGHT = 336; // header + max-h-64 list + footer, approx

/**
 * Searchable list of every addable node type, shown when the user double-clicks
 * the empty canvas. Styled to match ConnectionDropMenu (the handle-drag menu).
 */
export function NodeSearchMenu({ position, onSelect, onClose }: NodeSearchMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Last real cursor position, used to ignore hover events that fire when the
  // list scrolls under a stationary cursor during keyboard navigation.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const [search, setSearch] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  const savedNodes = useSavedComfyNodes();

  // Saved nodes sit after the built-ins under their own heading rather than
  // being sorted in among them: the built-in list has a shape people learn, and
  // it should not shuffle every time a workflow is saved.
  const options = useMemo(
    () => [...ALL_NODE_OPTIONS, ...savedComfyOptions(savedNodes)],
    [savedNodes]
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(query) ||
        option.type.toLowerCase().includes(query)
    );
  }, [search, options]);

  // Reset the highlight to the top whenever the filtered list changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  // Focus the search box on open.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep the highlighted item scrolled into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${selectedIndex}"]`
    );
    el?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  // Close when clicking outside the menu.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Keep wheel scrolling contained to the menu. React Flow's wheel handler runs
  // on a wrapper listener that fires before React's synthetic onWheel, so stopping
  // propagation here (natively) prevents the canvas from panning/zooming when the
  // list is scrolled — including overscroll once it hits its top/bottom boundary.
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", stop, { passive: true });
    return () => el.removeEventListener("wheel", stop);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filtered.length ? (prev + 1) % filtered.length : 0
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) =>
        filtered.length ? (prev - 1 + filtered.length) % filtered.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = filtered[selectedIndex];
      if (option) onSelect(option.type as NodeType, option.savedNodeId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Clamp to the viewport so an edge double-click doesn't push the menu off-screen.
  const viewportW = typeof window !== "undefined" ? window.innerWidth : Infinity;
  const viewportH = typeof window !== "undefined" ? window.innerHeight : Infinity;
  const left = Math.max(8, Math.min(position.x, viewportW - MENU_WIDTH - 8));
  const top = Math.max(8, Math.min(position.y, viewportH - MENU_MAX_HEIGHT - 8));

  return (
    <MenuSurface
      ref={menuRef}
      className="w-56"
      style={{ left, top }}
    >
      <MenuHeader>
        <input
          ref={inputRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search nodes…"
          className="w-full bg-transparent text-[11px] text-neutral-100 placeholder-neutral-500 outline-none"
          aria-label="Search nodes"
        />
      </MenuHeader>
      <MenuList ref={listRef} className="max-h-64 overflow-y-auto overscroll-contain nowheel">
        {filtered.length === 0 ? (
          <MenuEmpty>No matching nodes</MenuEmpty>
        ) : (
          filtered.map((option, index) => (
            <Fragment key={optionKey(option)}>
              {/* Once, above the first of them — the built-ins above are a
                  fixed set, these are the user's own. */}
              {option.savedNodeId && !filtered[index - 1]?.savedNodeId && (
                <MenuSectionLabel className="px-3 pt-2 pb-1">Saved nodes</MenuSectionLabel>
              )}
            <MenuItem
              data-index={index}
              selected={index === selectedIndex}
              onClick={() => onSelect(option.type as NodeType, option.savedNodeId)}
              onMouseMove={(e) => {
                // Only re-select on genuine cursor movement. When keyboard nav
                // scrolls the list under a stationary cursor, the browser may
                // fire hover events with unchanged coordinates — ignore those so
                // the arrow-key selection isn't yanked back to the cursor.
                const last = lastPointerRef.current;
                if (last && last.x === e.clientX && last.y === e.clientY) return;
                lastPointerRef.current = { x: e.clientX, y: e.clientY };
                setSelectedIndex(index);
              }}
            >
              {option.icon}
              {/* min-w-0, or a long saved-node name pushes the menu wider
                  instead of ellipsing. */}
              <span className="min-w-0 truncate">{option.label}</span>
            </MenuItem>
            </Fragment>
          ))
        )}
      </MenuList>
      <MenuFooter>
        <MenuHint keys="↑↓">navigate</MenuHint>
        <MenuHint keys="↵">add</MenuHint>
      </MenuFooter>
    </MenuSurface>
  );
}
