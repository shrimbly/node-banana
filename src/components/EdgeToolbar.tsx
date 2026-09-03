"use client";

import { useEffect, useMemo, useState } from "react";
import { EdgeLabelRenderer, useViewport } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { getImageSequenceNumber } from "@/lib/edges/labels";
import { bundleMembership, shareHandle } from "@/lib/edges/bundles";

export { getImageSequenceNumber };

/**
 * The toolbar for a selected connection. It is rendered by the edge itself
 * (through React Flow's EdgeLabelRenderer) at the path's midpoint, so it
 * follows the noodle through pans, zooms and node drags instead of sitting
 * where the mouse last went down. Only the first selected edge carries it;
 * when several edges are selected its actions apply to all of them.
 */

interface EdgeToolbarProps {
  edgeId: string;
  /** Anchor in flow coordinates, normally the path's label position. */
  x: number;
  y: number;
}

/** True for the edge that should carry the toolbar: the first selected one. */
export function useIsToolbarEdge(edgeId: string): boolean {
  return useWorkflowStore((state) => state.edges.find((e) => e.selected)?.id === edgeId);
}

const iconButton =
  "p-1.5 rounded hover:bg-neutral-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed";

export function EdgeToolbar({ edgeId, x, y }: EdgeToolbarProps) {
  const edges = useWorkflowStore((state) => state.edges);
  const toggleEdgePause = useWorkflowStore((state) => state.toggleEdgePause);
  const setEdgesPause = useWorkflowStore((state) => state.setEdgesPause);
  const removeEdges = useWorkflowStore((state) => state.removeEdges);
  const setLoopCount = useWorkflowStore((state) => state.setLoopCount);
  const setEdgesHidden = useWorkflowStore((state) => state.setEdgesHidden);
  const setEdgeLabel = useWorkflowStore((state) => state.setEdgeLabel);
  const bundleEdges = useWorkflowStore((state) => state.bundleEdges);
  const unbundleEdges = useWorkflowStore((state) => state.unbundleEdges);
  const bundlingMode = useWorkflowStore((state) => state.edgeAppearance.bundling);
  const { zoom } = useViewport();

  const edgeLabel = useWorkflowStore((state) => state.edges.find((e) => e.id === edgeId)?.data?.label ?? "");
  const [draftLabel, setDraftLabel] = useState(edgeLabel);
  useEffect(() => setDraftLabel(edgeLabel), [edgeLabel, edgeId]);

  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges]);
  const bundle = useMemo(() => bundleMembership(edgeId, edges, bundlingMode), [edgeId, edges, bundlingMode]);
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return null;

  // A lone selection inside a bundle acts on the whole bundle
  const multi = selectedEdges.length > 1;
  const bundled = !multi && bundle !== null;
  const grouped = multi || bundled;
  const selectedIds = multi ? selectedEdges.map((e) => e.id) : bundled ? bundle.members : [edge.id];
  const groupEdges = grouped ? edges.filter((e) => selectedIds.includes(e.id)) : [edge];
  const sequenceNumber = grouped ? null : getImageSequenceNumber(edge, edges);
  const isLoop = !grouped && Boolean(edge.data?.isLoop);
  const loopCount = edge.data?.loopCount ?? 3;
  const allPaused = groupEdges.every((e) => e.data?.hasPause);
  const hasPause = grouped ? allPaused : Boolean(edge.data?.hasPause);
  const canBundle = multi && !bundle?.manual && shareHandle(selectedEdges) && selectedEdges.every((e) => !e.data?.hidden && e.type !== "reference");
  const canUnbundle = Boolean(bundle?.manual) && (bundled || multi);
  const isHiddenEdge = Boolean(edge.data?.hidden);

  const handleTogglePause = () => {
    if (grouped) setEdgesPause(selectedIds, !allPaused);
    else toggleEdgePause(edge.id);
  };

  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan nokey"
        data-testid="edge-toolbar"
        style={{ position: "absolute", transform: `translate(${x}px, ${y}px)`, pointerEvents: "all", zIndex: 1000 }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div
          className="relative flex items-center gap-1 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-1"
          style={{ transform: `translate(-50%, calc(-100% - 12px)) scale(${1 / zoom})`, transformOrigin: "bottom center" }}
        >
          {grouped && (
            <span className="text-[10px] font-medium text-neutral-300 px-2 border-r border-neutral-600 whitespace-nowrap">
              {selectedIds.length} connections
            </span>
          )}
          {sequenceNumber !== null && (
            <span className="text-[10px] font-medium text-neutral-300 px-2 border-r border-neutral-600 whitespace-nowrap">
              Image {sequenceNumber}
            </span>
          )}
          {isLoop && (
            <>
              <span className="text-[10px] font-medium text-fuchsia-300 px-1.5">Loop</span>
              <button
                onClick={() => setLoopCount(edge.id, loopCount - 1)}
                disabled={loopCount <= 1}
                className={`p-1 rounded hover:bg-neutral-700 text-fuchsia-300 hover:text-fuchsia-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
                title="Decrease loop count"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M5 12h14" />
                </svg>
              </button>
              <span className="text-[11px] font-mono text-fuchsia-100 min-w-[20px] text-center">{loopCount}</span>
              <button
                onClick={() => setLoopCount(edge.id, loopCount + 1)}
                disabled={loopCount >= 100}
                className={`p-1 rounded hover:bg-neutral-700 text-fuchsia-300 hover:text-fuchsia-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
                title="Increase loop count"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M12 5v14M5 12h14" />
                </svg>
              </button>
              <div className="w-px h-4 bg-neutral-600" />
            </>
          )}
          {!grouped && (
            <input
              type="text"
              value={draftLabel}
              placeholder="Label"
              aria-label="Connection label"
              onChange={(e) => setDraftLabel(e.target.value)}
              onBlur={() => setEdgeLabel(edge.id, draftLabel)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  setEdgeLabel(edge.id, draftLabel);
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setDraftLabel(edgeLabel);
                  (e.target as HTMLInputElement).blur();
                }
              }}
              className="nodrag nopan nokey w-24 h-6 px-2 text-[11px] text-neutral-100 bg-neutral-900 border border-neutral-600 rounded placeholder:text-neutral-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
            />
          )}
          {!isLoop && (
            <button
              onClick={handleTogglePause}
              className={`${iconButton} ${hasPause ? "text-amber-400 hover:text-amber-300" : "text-neutral-400 hover:text-neutral-100"}`}
              title={hasPause ? (grouped ? "Remove pauses" : "Remove pause") : grouped ? "Pause all" : "Add pause"}
            >
              {hasPause ? (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              )}
            </button>
          )}
          {canBundle && (
            <button
              onClick={() => bundleEdges(selectedIds)}
              className={`${iconButton} text-neutral-400 hover:text-neutral-100`}
              title={`Bundle ${selectedIds.length} connections`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <path d="M2 4h3.5c2 0 2 4 4 4H14M2 8h3.5M2 12h3.5c2 0 2-4 4-4" />
              </svg>
            </button>
          )}
          {canUnbundle && (
            <button
              onClick={() => unbundleEdges(selectedIds)}
              className={`${iconButton} text-neutral-400 hover:text-neutral-100`}
              title="Unbundle"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
                <path d="M2 8h3.5c2 0 2-4 4-4H14M9.5 8H14M5.5 8c2 0 2 4 4 4H14" />
              </svg>
            </button>
          )}
          {isHiddenEdge ? (
            <button
              onClick={() => setEdgesHidden(selectedIds, false)}
              className={`${iconButton} text-neutral-400 hover:text-neutral-100`}
              title={grouped ? `Show ${selectedIds.length} connections` : "Show connection"}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.4 12C3.7 7.9 7.5 5 12 5s8.3 2.9 9.6 7c-1.3 4.1-5.1 7-9.6 7s-8.3-2.9-9.6-7z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => setEdgesHidden(selectedIds, true)}
              className={`${iconButton} text-neutral-400 hover:text-neutral-100`}
              title={grouped ? `Hide ${selectedIds.length} connections` : "Hide connection"}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c4.5 0 8.3 2.9 9.6 7a10 10 0 01-2.2 3.6M6.6 6.6A10 10 0 002.4 12c1.3 4.1 5.1 7 9.6 7 1.4 0 2.8-.3 4-.8" />
              </svg>
            </button>
          )}
          <button
            onClick={() => removeEdges(selectedIds)}
            className={`${iconButton} text-neutral-400 hover:text-red-400`}
            title={grouped ? `Delete ${selectedIds.length} connections` : "Delete"}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
              />
            </svg>
          </button>
          {/* Pointer down to the noodle */}
          <span
            aria-hidden="true"
            className="absolute left-1/2 -bottom-[5px] w-2 h-2 -ml-1 bg-neutral-800 border-r border-b border-neutral-600 rotate-45"
          />
        </div>
      </div>
    </EdgeLabelRenderer>
  );
}
