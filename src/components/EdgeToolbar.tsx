"use client";

import { Eye, EyeOff, Minus, Pause, Play, Plus, Crosshair, Trash2 } from "lucide-react";
import { MenuSurface } from "@/components/ui/Menu";
import { useEffect, useMemo, useRef, useState } from "react";
import { useViewport } from "@xyflow/react";
import { EdgeLabelRenderer } from "@/components/flowPortals";
import { useWorkflowStore } from "@/store/workflowStore";
import { getImageSequenceNumber } from "@/lib/edges/labels";
import { edgeGraphIndex } from "@/lib/edges/graphIndex";
import { bundleIdAt, bundleMembership, sharedEnd } from "@/lib/edges/bundles";

export { getImageSequenceNumber };

/**
 * The toolbar for a selected connection. It is rendered by the edge itself
 * (through React Flow's EdgeLabelRenderer) above the last click, in flow
 * coordinates so the anchor follows pan and zoom. Keyboard selections fall
 * back to the path's midpoint. Only the first selected edge carries it;
 * when several edges are selected its actions apply to all of them.
 */

interface EdgeToolbarProps {
  edgeId: string;
  /** Anchor in flow coordinates, normally the path's label position. */
  x: number;
  y: number;
  /** Shown on a hidden connection's downstream pill: brings its upstream end into view. */
  onGoUpstream?: () => void;
}

/** True for the edge that should carry the toolbar: the first selected one. */
export function useIsToolbarEdge(edgeId: string): boolean {
  return useWorkflowStore((state) => edgeGraphIndex(state.edges).toolbarEdgeId === edgeId);
}

const iconButton =
  "p-1.5 rounded hover:bg-neutral-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed";

export function EdgeToolbar({ edgeId, x, y, onGoUpstream }: EdgeToolbarProps) {
  const edges = useWorkflowStore((state) => state.edges);
  const clickAnchor = useWorkflowStore((state) => state.edgeMenuAnchor);
  const toggleEdgePause = useWorkflowStore((state) => state.toggleEdgePause);
  const setEdgesPause = useWorkflowStore((state) => state.setEdgesPause);
  const removeEdges = useWorkflowStore((state) => state.removeEdges);
  const setLoopCount = useWorkflowStore((state) => state.setLoopCount);
  const setEdgesHidden = useWorkflowStore((state) => state.setEdgesHidden);
  const setEdgeLabel = useWorkflowStore((state) => state.setEdgeLabel);
  const hookEdges = useWorkflowStore((state) => state.hookEdges);
  const unbundleEdges = useWorkflowStore((state) => state.unbundleEdges);
  const { zoom } = useViewport();

  const edgeLabel = useWorkflowStore((state) => state.edges.find((e) => e.id === edgeId)?.data?.label ?? "");
  const [draftLabel, setDraftLabel] = useState(edgeLabel);
  useEffect(() => setDraftLabel(edgeLabel), [edgeLabel, edgeId]);
  // Escape blurs the field, and that blur must not commit the draft it discards
  const discardingRef = useRef(false);

  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges]);
  const anchor = clickAnchor && selectedEdges.some((e) => e.id === clickAnchor.edgeId) ? clickAnchor : { x, y };
  const bundle = useMemo(() => bundleMembership(edgeId, edges), [edgeId, edges]);
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
  // Gather any visible multi-selection into a movable bundle.
  const selectedEnd = multi ? sharedEnd(selectedEdges) : null;
  const alreadyBundled =
    selectedEnd !== null &&
    Boolean(bundleIdAt(selectedEdges[0], selectedEnd)) &&
    selectedEdges.every((e) => bundleIdAt(e, selectedEnd) === bundleIdAt(selectedEdges[0], selectedEnd));
  const canBundle = multi && !alreadyBundled && selectedEdges.every((e) => !e.hidden && !e.data?.hidden && e.type !== "reference");
  const canUnbundle = bundle !== null && (bundled || multi);
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
        // Above selected nodes (1000) and the hidden-connection pills and bundle clamps (2001)
        style={{ position: "absolute", transform: `translate(${anchor.x}px, ${anchor.y}px)`, pointerEvents: "none", zIndex: 2100 }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <MenuSurface
          variant="bar"
          floating={false}
          className="relative edge-overlay"
          style={{ transform: `translate(-50%, calc(-100% - 12px)) scale(${1 / zoom})`, transformOrigin: "bottom center", pointerEvents: "all" }}
        >
          {grouped && (
            <span className="text-[10px] font-medium text-neutral-300 px-2 border-r border-neutral-600 whitespace-nowrap">
              {selectedIds.length} noodles
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
                <Minus size={12} strokeWidth={2} />
              </button>
              <span className="text-[11px] font-mono text-fuchsia-100 min-w-[20px] text-center">{loopCount}</span>
              <button
                onClick={() => setLoopCount(edge.id, loopCount + 1)}
                disabled={loopCount >= 100}
                className={`p-1 rounded hover:bg-neutral-700 text-fuchsia-300 hover:text-fuchsia-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed`}
                title="Increase loop count"
              >
                <Plus size={12} strokeWidth={2} />
              </button>
              <div className="w-px h-4 bg-neutral-600" />
            </>
          )}
          {!grouped && (
            <input
              type="text"
              value={draftLabel}
              // The image order is the name an unlabelled connection goes by
              placeholder={sequenceNumber !== null ? `Image ${sequenceNumber}` : "Label"}
              aria-label="Connection label"
              onChange={(e) => setDraftLabel(e.target.value)}
              onBlur={() => {
                if (!discardingRef.current) setEdgeLabel(edge.id, draftLabel);
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  setEdgeLabel(edge.id, draftLabel);
                  (e.target as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setDraftLabel(edgeLabel);
                  // blur() fires the handler synchronously, before the reset draft renders
                  discardingRef.current = true;
                  (e.target as HTMLInputElement).blur();
                  discardingRef.current = false;
                }
              }}
              className="nodrag nopan nokey w-24 h-6 px-2 text-[11px] text-neutral-100 bg-neutral-900 border border-neutral-600 rounded placeholder:text-neutral-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
            />
          )}
          {canBundle && (
            <button
              onClick={() => hookEdges(selectedIds, { x: anchor.x, y: anchor.y })}
              className={`${iconButton} px-2 text-xs font-medium text-neutral-300 hover:text-neutral-100`}
              title={`Bundle ${selectedIds.length} connections`}
            >
              Bundle
            </button>
          )}
          {canUnbundle && (
            <button
              onClick={() => unbundleEdges(selectedIds, bundle?.end)}
              className={`${iconButton} px-2 text-xs font-medium text-neutral-300 hover:text-neutral-100`}
              title="Unbundle"
            >
              Unbundle
            </button>
          )}
          {onGoUpstream && !grouped && (
            <button
              onClick={onGoUpstream}
              className={`${iconButton} text-neutral-400 hover:text-neutral-100`}
              title="Go to upstream connection"
              aria-label="Go to upstream connection"
            >
              <Crosshair size={16} strokeWidth={1.5} />
            </button>
          )}
          {isHiddenEdge ? (
            <button
              onClick={() => setEdgesHidden(selectedIds, false)}
              className={`${iconButton} text-neutral-400 hover:text-neutral-100`}
              title={grouped ? `Show ${selectedIds.length} connections` : "Show connection"}
            >
              <Eye size={16} strokeWidth={1.5} />
            </button>
          ) : (
            <button
              onClick={() => setEdgesHidden(selectedIds, true)}
              className={`${iconButton} text-neutral-400 hover:text-neutral-100`}
              title={grouped ? `Hide ${selectedIds.length} connections` : "Hide connection"}
            >
              <EyeOff size={16} strokeWidth={1.5} />
            </button>
          )}
          {!isLoop && (
            <button
              onClick={handleTogglePause}
              className={`${iconButton} ${hasPause ? "text-amber-400 hover:text-amber-300" : "text-neutral-400 hover:text-neutral-100"}`}
              title={hasPause ? (grouped ? "Remove pauses" : "Remove pause") : grouped ? "Pause all" : "Add pause"}
            >
              {hasPause ? (
                <Play size={16} strokeWidth={0} fill="currentColor" />
              ) : (
                <Pause size={16} strokeWidth={0} fill="currentColor" />
              )}
            </button>
          )}
          <button
            onClick={() => removeEdges(selectedIds)}
            className={`${iconButton} text-neutral-400 hover:text-red-400`}
            title={grouped ? `Delete ${selectedIds.length} connections` : "Delete"}
          >
            <Trash2 size={16} strokeWidth={1.5} />
          </button>
          {/* Pointer down to the noodle */}
          <span
            aria-hidden="true"
            className="absolute left-1/2 -bottom-[5px] w-2 h-2 -ml-1 bg-neutral-800 border-r border-b border-neutral-600 rotate-45"
          />
        </MenuSurface>
      </div>
    </EdgeLabelRenderer>
  );
}
