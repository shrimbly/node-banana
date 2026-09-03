"use client";

import { useEffect, useMemo, useRef } from "react";
import { useWorkflowStore } from "@/store/workflowStore";
import { edgesOnHandle } from "@/lib/edges/bundles";
import { edgeTypeLabel } from "@/lib/edges/labels";

/**
 * The menu a single click on a handle opens: act on every connection that
 * shares that handle. Bundle them into one stem, unbundle, hide or show
 * them, or remove them all. A drag on the handle still starts a connection.
 */

export interface HandleMenuTarget {
  nodeId: string;
  handleId: string | null;
  type: "source" | "target";
  position: { x: number; y: number };
}

interface HandleMenuProps {
  target: HandleMenuTarget;
  onClose: () => void;
}

const itemClass =
  "w-full px-3 py-2 text-left text-[11px] font-medium flex items-center gap-2 transition-colors text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent";

export function HandleMenu({ target, onClose }: HandleMenuProps) {
  const edges = useWorkflowStore((state) => state.edges);
  const bundleEdges = useWorkflowStore((state) => state.bundleEdges);
  const unbundleEdges = useWorkflowStore((state) => state.unbundleEdges);
  const setEdgesHidden = useWorkflowStore((state) => state.setEdgesHidden);
  const removeEdges = useWorkflowStore((state) => state.removeEdges);
  const menuRef = useRef<HTMLDivElement>(null);

  const onHandle = useMemo(() => edgesOnHandle(edges, target.nodeId, target.type, target.handleId), [edges, target]);
  const ids = onHandle.map((e) => e.id);
  const bundleable = onHandle.filter((e) => !e.data?.hidden && e.type !== "reference");
  const bundled = bundleable.filter((e) => e.data?.bundleId);
  const allInOneBundle = bundleable.length >= 2 && bundled.length === bundleable.length && new Set(bundled.map((e) => e.data?.bundleId)).size === 1;
  const canBundle = bundleable.length >= 2 && !allInOneBundle;
  const canUnbundle = bundled.length > 0;
  const hiddenCount = onHandle.filter((e) => e.data?.hidden).length;
  const visibleCount = onHandle.length - hiddenCount;

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

  const count = onHandle.length;
  const heading = count === 0 ? "No connections" : `${count} ${count === 1 ? "connection" : "connections"}`;

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="handle-menu"
      className="fixed z-100 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl overflow-hidden min-w-[180px] outline-none"
      style={{ left: target.position.x, top: target.position.y }}
    >
      <div className="px-3 py-1.5 border-b border-neutral-700">
        <span className="text-[10px] text-neutral-400 uppercase tracking-wide">
          {edgeTypeLabel(target.handleId)} {target.type === "source" ? "output" : "input"} · {heading}
        </span>
      </div>
      <div className="py-1">
        {canBundle && (
          <button type="button" role="menuitem" className={itemClass} onClick={() => run(() => bundleEdges(bundleable.map((e) => e.id)))}>
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <path d="M2 4h3.5c2 0 2 4 4 4H14M2 8h3.5M2 12h3.5c2 0 2-4 4-4" />
            </svg>
            Bundle connections
          </button>
        )}
        {canUnbundle && (
          <button type="button" role="menuitem" className={itemClass} onClick={() => run(() => unbundleEdges(bundled.map((e) => e.id)))}>
            <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
              <path d="M2 8h3.5c2 0 2-4 4-4H14M9.5 8H14M5.5 8c2 0 2 4 4 4H14" />
            </svg>
            Unbundle
          </button>
        )}
        {visibleCount > 0 && (
          <button type="button" role="menuitem" className={itemClass} onClick={() => run(() => setEdgesHidden(ids, true))}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c4.5 0 8.3 2.9 9.6 7a10 10 0 01-2.2 3.6M6.6 6.6A10 10 0 002.4 12c1.3 4.1 5.1 7 9.6 7 1.4 0 2.8-.3 4-.8" />
            </svg>
            {visibleCount === count ? "Hide connections" : `Hide ${visibleCount} visible`}
          </button>
        )}
        {hiddenCount > 0 && (
          <button type="button" role="menuitem" className={itemClass} onClick={() => run(() => setEdgesHidden(ids, false))}>
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.4 12C3.7 7.9 7.5 5 12 5s8.3 2.9 9.6 7c-1.3 4.1-5.1 7-9.6 7s-8.3-2.9-9.6-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {hiddenCount === count ? "Show connections" : `Show ${hiddenCount} hidden`}
          </button>
        )}
        <button
          type="button"
          role="menuitem"
          disabled={count === 0}
          className={`${itemClass} hover:text-red-400`}
          onClick={() => run(() => removeEdges(ids))}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3" />
          </svg>
          Remove all connections
        </button>
      </div>
    </div>
  );
}
