"use client";

import { useMemo } from "react";
import { EdgeLabelRenderer, useViewport } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { WorkflowEdge, WorkflowEdgeData } from "@/types";

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

/**
 * For image connections that share a target handle, the 1-based order in
 * which they were made (the order images are sent to the model). Null when
 * the connection is alone or not an image.
 */
export function getImageSequenceNumber(edge: WorkflowEdge, edges: WorkflowEdge[]): number | null {
  const sourceHandle = edge.sourceHandle;
  const targetHandle = edge.targetHandle;
  const isImageConnection =
    sourceHandle === "image" || sourceHandle?.startsWith("image-") ||
    targetHandle === "image" || targetHandle?.startsWith("image-");
  if (!isImageConnection) return null;

  const siblings = edges.filter((e) => e.target === edge.target && e.targetHandle === edge.targetHandle);
  if (siblings.length <= 1) return null;

  // Sort by creation time (fallback to edge id for legacy edges without a timestamp)
  const sorted = [...siblings].sort((a, b) => {
    const timeA = (a.data as WorkflowEdgeData)?.createdAt || 0;
    const timeB = (b.data as WorkflowEdgeData)?.createdAt || 0;
    if (timeA !== timeB) return timeA - timeB;
    return a.id.localeCompare(b.id);
  });
  const index = sorted.findIndex((e) => e.id === edge.id);
  return index >= 0 ? index + 1 : null;
}

const iconButton =
  "p-1.5 rounded hover:bg-neutral-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed";

export function EdgeToolbar({ edgeId, x, y }: EdgeToolbarProps) {
  const edges = useWorkflowStore((state) => state.edges);
  const toggleEdgePause = useWorkflowStore((state) => state.toggleEdgePause);
  const setEdgesPause = useWorkflowStore((state) => state.setEdgesPause);
  const removeEdges = useWorkflowStore((state) => state.removeEdges);
  const setLoopCount = useWorkflowStore((state) => state.setLoopCount);
  const { zoom } = useViewport();

  const selectedEdges = useMemo(() => edges.filter((e) => e.selected), [edges]);
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) return null;

  const multi = selectedEdges.length > 1;
  const selectedIds = multi ? selectedEdges.map((e) => e.id) : [edge.id];
  const sequenceNumber = multi ? null : getImageSequenceNumber(edge, edges);
  const isLoop = !multi && Boolean(edge.data?.isLoop);
  const loopCount = edge.data?.loopCount ?? 3;
  const allPaused = selectedEdges.length > 0 ? selectedEdges.every((e) => e.data?.hasPause) : Boolean(edge.data?.hasPause);
  const hasPause = multi ? allPaused : Boolean(edge.data?.hasPause);

  const handleTogglePause = () => {
    if (multi) setEdgesPause(selectedIds, !allPaused);
    else toggleEdgePause(edge.id);
  };

  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan"
        data-testid="edge-toolbar"
        style={{ position: "absolute", transform: `translate(${x}px, ${y}px)`, pointerEvents: "all", zIndex: 1000 }}
      >
        <div
          className="relative flex items-center gap-1 bg-neutral-800 border border-neutral-600 rounded-lg shadow-xl p-1"
          style={{ transform: `translate(-50%, calc(-100% - 12px)) scale(${1 / zoom})`, transformOrigin: "bottom center" }}
        >
          {multi && (
            <span className="text-[10px] font-medium text-neutral-300 px-2 border-r border-neutral-600 whitespace-nowrap">
              {selectedEdges.length} connections
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
          {!isLoop && (
            <button
              onClick={handleTogglePause}
              className={`${iconButton} ${hasPause ? "text-amber-400 hover:text-amber-300" : "text-neutral-400 hover:text-neutral-100"}`}
              title={hasPause ? (multi ? "Remove pauses" : "Remove pause") : multi ? "Pause all" : "Add pause"}
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
          <button
            onClick={() => removeEdges(selectedIds)}
            className={`${iconButton} text-neutral-400 hover:text-red-400`}
            title={multi ? `Delete ${selectedEdges.length} connections` : "Delete"}
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
