"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { bundleIdAt, edgesOnHandle } from "@/lib/edges/bundles";
import { edgeColorForHandles } from "@/lib/edges/colors";

/**
 * The bar a single click on a handle opens, centred above it: a count of the
 * connections on that handle, then Bundle (or Unbundle), Hide (or Show) and
 * Remove all as icons. A drag on the handle still starts a connection.
 */

export interface HandleMenuTarget {
  nodeId: string;
  handleId: string | null;
  type: "source" | "target";
  /** The handle's centre on screen. */
  position: { x: number; y: number };
}

interface HandleMenuProps {
  target: HandleMenuTarget;
  onClose: () => void;
}

/** Gap between the handle's centre and the bar's bottom edge. */
const GAP = 14;

const iconButton =
  "p-1.5 rounded transition-colors hover:bg-neutral-700 text-neutral-400 hover:text-neutral-100 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent";

export function HandleMenu({ target, onClose }: HandleMenuProps) {
  const edges = useWorkflowStore((state) => state.edges);
  const bundleEdges = useWorkflowStore((state) => state.bundleEdges);
  const unbundleEdges = useWorkflowStore((state) => state.unbundleEdges);
  const setEdgesHidden = useWorkflowStore((state) => state.setEdgesHidden);
  const removeEdges = useWorkflowStore((state) => state.removeEdges);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Measure on mount so the first paint is already centred above the handle
  const measure = useCallback((el: HTMLDivElement | null) => {
    menuRef.current = el;
    if (el) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  }, []);

  const onHandle = useMemo(() => edgesOnHandle(edges, target.nodeId, target.type, target.handleId), [edges, target]);
  const ids = onHandle.map((e) => e.id);
  const bundleable = onHandle.filter((e) => !e.data?.hidden && e.type !== "reference");
  const bundled = bundleable.filter((e) => bundleIdAt(e, target.type));
  const allInOneBundle =
    bundleable.length >= 2 && bundled.length === bundleable.length && new Set(bundled.map((e) => bundleIdAt(e, target.type))).size === 1;
  const hiddenCount = onHandle.filter((e) => e.data?.hidden).length;
  const allHidden = onHandle.length > 0 && hiddenCount === onHandle.length;
  const count = onHandle.length;
  const color = edgeColorForHandles(target.type === "source" ? target.handleId : null, target.type === "target" ? target.handleId : null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const run = (action: () => void) => {
    action();
    onClose();
  };

  // Centred above the handle, kept inside the viewport
  const left = Math.max(8, Math.min(window.innerWidth - size.width - 8, target.position.x - size.width / 2));
  const top = Math.max(8, target.position.y - GAP - size.height);

  return (
    <div
      ref={measure}
      role="menu"
      aria-label="Handle connections"
      data-testid="handle-menu"
      className="fixed z-100 flex items-center gap-1 p-1 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl"
      style={{ left, top }}
    >
      <span
        className="inline-flex items-center gap-1.5 pl-2 pr-2.5 text-[10px] font-medium text-neutral-300 border-r border-neutral-600 whitespace-nowrap"
        data-testid="handle-menu-count"
      >
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        {count}
      </span>

      {allInOneBundle ? (
        <button type="button" role="menuitem" className={iconButton} title="Unbundle" aria-label="Unbundle" onClick={() => run(() => unbundleEdges(bundled.map((e) => e.id), target.type))}>
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <path d="M2 8h3.5c2 0 2-4 4-4H14M9.5 8H14M5.5 8c2 0 2 4 4 4H14" />
          </svg>
        </button>
      ) : (
        <button type="button" role="menuitem" className={iconButton} title="Bundle" aria-label="Bundle" disabled={bundleable.length < 2} onClick={() => run(() => bundleEdges(bundleable.map((e) => e.id), target.type))}>
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
            <path d="M2 4h3.5c2 0 2 4 4 4H14M2 8h3.5M2 12h3.5c2 0 2-4 4-4" />
          </svg>
        </button>
      )}

      {allHidden ? (
        <button type="button" role="menuitem" className={iconButton} title="Show" aria-label="Show" onClick={() => run(() => setEdgesHidden(ids, false))}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.4 12C3.7 7.9 7.5 5 12 5s8.3 2.9 9.6 7c-1.3 4.1-5.1 7-9.6 7s-8.3-2.9-9.6-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      ) : (
        <button type="button" role="menuitem" className={iconButton} title="Hide" aria-label="Hide" disabled={count === 0} onClick={() => run(() => setEdgesHidden(ids, true))}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c4.5 0 8.3 2.9 9.6 7a10 10 0 01-2.2 3.6M6.6 6.6A10 10 0 002.4 12c1.3 4.1 5.1 7 9.6 7 1.4 0 2.8-.3 4-.8" />
          </svg>
        </button>
      )}

      <div className="w-px h-4 bg-neutral-600" />

      <button type="button" role="menuitem" className={`${iconButton} hover:text-red-400`} title="Remove all" aria-label="Remove all" disabled={count === 0} onClick={() => run(() => removeEdges(ids))}>
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
        </svg>
      </button>
    </div>
  );
}
