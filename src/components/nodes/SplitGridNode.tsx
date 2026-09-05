"use client";

import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ControlsCard, EmptyState, Field, FieldRow, PanelButton, Spinner, SummaryValues, type SocketSpec } from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { SplitGridNodeData } from "@/types";
import { SplitGridTemplateModal } from "../splitgrid/SplitGridTemplateModal";
import {
  clampGridDimension,
  getSplitGridCells,
  needsMaterialization,
  resolveGridOffsets,
  gridFractions,
  MIN_GRID_DIMENSION,
  MAX_GRID_DIMENSION,
  MIN_SLICE_GAP,
} from "@/store/utils/splitGridTemplate";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";

type SplitGridNodeType = Node<SplitGridNodeData, "splitGrid">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "reference", type: "reference", label: "Ref" }];
const EMPTY_HEIGHT = 120;

interface GridDimFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

function GridDimField({ label, value, onChange, disabled }: GridDimFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);

  const commit = useCallback(
    (raw: string) => {
      setDraft(null);
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed)) onChange(clampGridDimension(parsed));
    },
    [onChange]
  );

  return (
    <Field label={label}>
      <div className="flex items-stretch h-[22px] rounded-well squircle bg-well shadow-well overflow-hidden focus-within:ring-1 focus-within:ring-neutral-600">
        <button
          onClick={() => onChange(clampGridDimension(value - 1))}
          disabled={disabled || value <= MIN_GRID_DIMENSION}
          className="nodrag nopan px-2 text-neutral-400 hover:text-neutral-100 hover:bg-white/5 disabled:text-neutral-700 disabled:hover:bg-transparent transition-colors"
          aria-label={`Decrease ${label.toLowerCase()}`}
        >
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
          </svg>
        </button>
        <input
          type="text"
          inputMode="numeric"
          value={draft ?? String(value)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") (event.target as HTMLInputElement).blur();
          }}
          disabled={disabled}
          className="nodrag nopan w-full min-w-0 bg-transparent text-center text-node font-medium text-neutral-100 focus:outline-none disabled:text-neutral-600"
          aria-label={label}
        />
        <button
          onClick={() => onChange(clampGridDimension(value + 1))}
          disabled={disabled || value >= MAX_GRID_DIMENSION}
          className="nodrag nopan px-2 text-neutral-400 hover:text-neutral-100 hover:bg-white/5 disabled:text-neutral-700 disabled:hover:bg-transparent transition-colors"
          aria-label={`Increase ${label.toLowerCase()}`}
        >
          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    </Field>
  );
}

export function SplitGridNode({ id, data, selected }: NodeProps<SplitGridNodeType>) {
  const nodeData = data;
  const adaptiveSourceImage = useAdaptiveImageSrc(nodeData.sourceImage, id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [showEditor, setShowEditor] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const gridRows = clampGridDimension(nodeData.gridRows);
  const gridCols = clampGridDimension(nodeData.gridCols);
  const cellCount = gridRows * gridCols;

  // The clip takes the image's own proportions, so the grid overlay filling
  // the clip tracks the image exactly.
  const [imageAspect, setImageAspect] = useState<number | null>(null);

  // A new source image invalidates the measured aspect until it re-loads.
  useEffect(() => {
    setImageAspect(null);
  }, [adaptiveSourceImage]);

  // Reactively track the connected source image
  const hasIncomingImageConnection = useMemo(() => {
    return edges.some((edge) => edge.target === id && edge.targetHandle === "image");
  }, [edges, id]);

  const connectedSourceImage = useMemo(() => {
    if (!hasIncomingImageConnection) return null;
    const { images } = getConnectedInputs(id);
    return images[0] || null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasIncomingImageConnection, id, getConnectedInputs, nodes]);

  useEffect(() => {
    if (connectedSourceImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: connectedSourceImage });
    }
  }, [connectedSourceImage, id, updateNodeData, nodeData.sourceImage]);

  const cells = getSplitGridCells(nodeData);
  const cellsAreStale = useMemo(() => {
    const existingIds = new Set(nodes.map((node) => node.id));
    const existingRouterNodeIds = new Set(
      nodes.filter((node) => node.type === "router").map((node) => node.id)
    );
    return needsMaterialization(nodeData, existingIds, { existingRouterNodeIds });
  }, [nodeData, nodes]);

  // Custom interior line positions (from dragging); fall back to uniform.
  const colOffsets = useMemo(
    () => resolveGridOffsets(gridCols, nodeData.colOffsets),
    [gridCols, nodeData.colOffsets]
  );
  const rowOffsets = useMemo(
    () => resolveGridOffsets(gridRows, nodeData.rowOffsets),
    [gridRows, nodeData.rowOffsets]
  );

  // Live positions while dragging a grid line (null when idle).
  const innerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ axis: "col" | "row"; offsets: number[] } | null>(null);
  const activeColOffsets = drag?.axis === "col" ? drag.offsets : colOffsets;
  const activeRowOffsets = drag?.axis === "row" ? drag.offsets : rowOffsets;
  const colFractions = gridFractions(gridCols, activeColOffsets);
  const rowFractions = gridFractions(gridRows, activeRowOffsets);

  const startLineDrag = useCallback(
    (axis: "col" | "row", index: number, e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const inner = innerRef.current;
      if (!inner) return;
      const base = axis === "col" ? colOffsets : rowOffsets;
      let working = [...base];
      setDrag({ axis, offsets: working });

      const onMove = (ev: PointerEvent) => {
        const rect = inner.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const norm =
          axis === "col"
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;
        const lower = index > 0 ? working[index - 1] : 0;
        const upper = index < working.length - 1 ? working[index + 1] : 1;
        const clamped = Math.min(upper - MIN_SLICE_GAP, Math.max(lower + MIN_SLICE_GAP, norm));
        working = working.map((v, i) => (i === index ? clamped : v));
        setDrag({ axis, offsets: working });
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDrag(null);
        updateNodeData(id, axis === "col" ? { colOffsets: working } : { rowOffsets: working });
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [colOffsets, rowOffsets, id, updateNodeData]
  );

  const handleRowsChange = useCallback(
    (value: number) => {
      if (value === gridRows) return;
      // Row count changed: custom row lines no longer fit — reset to uniform.
      updateNodeData(id, { gridRows: value, rowOffsets: undefined });
    },
    [id, updateNodeData, gridRows]
  );
  const handleColsChange = useCallback(
    (value: number) => {
      if (value === gridCols) return;
      updateNodeData(id, { gridCols: value, colOffsets: undefined });
    },
    [id, updateNodeData, gridCols]
  );

  const handleSplit = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const statusText = nodeData.status === "error"
    ? nodeData.error || "Error"
    : cells.length > 0
      ? cellsAreStale
        ? "Cells out of date — Split rebuilds"
        : `${cells.length} cell group${cells.length === 1 ? "" : "s"}`
      : "Split creates a group per cell";

  const media = nodeData.sourceImage
    ? { kind: "aspect" as const, aspect: imageAspect ?? 1 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  return (
    <>
      <NodeShell
        id={id}
        selected={selected}
        hasError={nodeData.status === "error"}
        media={media}
        inputs={INPUT_SOCKETS}
        outputs={OUTPUT_SOCKETS}
        minWidth={240}
        controls={
          <ControlsCard
            id={id}
            summary={{
              title: `${gridRows}×${gridCols} grid`,
              values: <SummaryValues items={[cells.length > 0 ? `${cells.length} cells` : null]} />,
            }}
            expanded={expanded}
            onToggle={() => setExpanded((v) => !v)}
          >
            <GridDimField label="Rows" value={gridRows} onChange={handleRowsChange} disabled={isRunning} />
            <GridDimField label="Columns" value={gridCols} onChange={handleColsChange} disabled={isRunning} />
            <Field label="Cell nodes">
              <div className="flex items-center justify-end">
                <PanelButton
                  onClick={() => setShowEditor(true)}
                  disabled={isRunning}
                  title={isRunning ? "Wait for the current run to finish" : "Edit the nodes created for each cell"}
                  className="shrink-0 flex items-center gap-1.5"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 16.875h3.375m0 0h3.375m-3.375 0V13.5m0 3.375v3.375M6 10.5h2.25a2.25 2.25 0 002.25-2.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v2.25A2.25 2.25 0 006 10.5zm0 9.75h2.25A2.25 2.25 0 0010.5 18v-2.25a2.25 2.25 0 00-2.25-2.25H6a2.25 2.25 0 00-2.25 2.25V18A2.25 2.25 0 006 20.25zm9.75-9.75H18a2.25 2.25 0 002.25-2.25V6A2.25 2.25 0 0018 3.75h-2.25A2.25 2.25 0 0013.5 6v2.25a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  Open cell editor
                </PanelButton>
              </div>
            </Field>
            <FieldRow className="justify-between gap-2">
              <span
                className={`text-node truncate ${
                  nodeData.status === "error"
                    ? "text-red-400"
                    : cellsAreStale && cells.length > 0
                      ? "text-amber-400"
                      : "text-neutral-500"
                }`}
                title={statusText}
              >
                {statusText}
              </span>
              <PanelButton
                primary
                onClick={handleSplit}
                disabled={isRunning || !nodeData.sourceImage}
                title={!nodeData.sourceImage ? "Connect an image first" : `Split into ${gridRows}×${gridCols}`}
                className="shrink-0"
              >
                Split {gridRows}×{gridCols} now
              </PanelButton>
            </FieldRow>
          </ControlsCard>
        }
      >
        {nodeData.sourceImage ? (
          <div ref={innerRef} className="absolute inset-0">
            <img
              src={adaptiveSourceImage ?? undefined}
              alt="Source grid"
              className="absolute inset-0 w-full h-full object-cover select-none"
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth, naturalHeight } = e.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0) {
                  setImageAspect(naturalWidth / naturalHeight);
                }
              }}
            />
            {/* Cell outlines (non-uniform when lines have been dragged) */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                display: "grid",
                gridTemplateColumns: colFractions.map((f) => `${f}fr`).join(" "),
                gridTemplateRows: rowFractions.map((f) => `${f}fr`).join(" "),
              }}
            >
              {Array.from({ length: cellCount }).map((_, index) => (
                <div key={index} className="border border-blue-400/50" />
              ))}
            </div>
            {/* Draggable interior grid lines */}
            {!isRunning && (
              <>
                {activeColOffsets.map((offset, index) => (
                  <div
                    key={`v-${index}`}
                    className="nodrag nopan group absolute top-0 bottom-0"
                    style={{
                      left: `${offset * 100}%`,
                      width: 12,
                      transform: "translateX(-50%)",
                      cursor: "col-resize",
                    }}
                    onPointerDown={(e) => startLineDrag("col", index, e)}
                  >
                    <div
                      className={`absolute inset-y-0 left-1/2 -translate-x-1/2 transition-all ${
                        drag?.axis === "col"
                          ? "w-[2px] bg-blue-300"
                          : "w-px bg-blue-400/70 group-hover:w-[2px] group-hover:bg-blue-300"
                      }`}
                    />
                  </div>
                ))}
                {activeRowOffsets.map((offset, index) => (
                  <div
                    key={`h-${index}`}
                    className="nodrag nopan group absolute left-0 right-0"
                    style={{
                      top: `${offset * 100}%`,
                      height: 12,
                      transform: "translateY(-50%)",
                      cursor: "row-resize",
                    }}
                    onPointerDown={(e) => startLineDrag("row", index, e)}
                  >
                    <div
                      className={`absolute inset-x-0 top-1/2 -translate-y-1/2 transition-all ${
                        drag?.axis === "row"
                          ? "h-[2px] bg-blue-300"
                          : "h-px bg-blue-400/70 group-hover:h-[2px] group-hover:bg-blue-300"
                      }`}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <EmptyState
            message="Connect image"
            icon={
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
              </svg>
            }
          />
        )}
        {nodeData.status === "loading" && (
          <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center">
            <Spinner size={24} className="text-white" />
          </div>
        )}
      </NodeShell>

      {/* Cell template editor */}
      {showEditor && (
        <SplitGridTemplateModal
          nodeId={id}
          nodeData={nodeData}
          onClose={() => setShowEditor(false)}
        />
      )}
    </>
  );
}
