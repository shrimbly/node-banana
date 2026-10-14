"use client";

import { useCallback, useState, useEffect, useMemo, useRef } from "react";
import { Grid2x2Plus, LayoutGrid, Minus, Plus } from "lucide-react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { ControlsCard, EmptyState, Field, FieldRow, PanelButton, Spinner, SummaryValues, type SocketSpec } from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { SplitGridNodeData } from "@/types";
import { SplitGridTemplateModal } from "../splitgrid/SplitGridTemplateModal";
import {
  clampGridDimension,
  getSplitGridCells,
  resolveGridOffsets,
  gridFractions,
  MIN_GRID_DIMENSION,
  MAX_GRID_DIMENSION,
  MIN_SLICE_GAP,
} from "@/store/utils/splitGridTemplate";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { useHoldLive, useIsPaintedNode, useDerivedNodeData, useUpdateNodeData, useNodeUiState } from "./paintMode";

type SplitGridNodeType = Node<SplitGridNodeData, "splitGrid">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "reference", type: "reference", label: "Ref" }];
const EMPTY_HEIGHT = 120;
/** Both action buttons share one width so they stack in a column. */
const ACTION_W = "w-[136px]";

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
          <Minus size={10} strokeWidth={2} />
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
          <Plus size={10} strokeWidth={2} />
        </button>
      </div>
    </Field>
  );
}

export function SplitGridNode({ id, data, selected }: NodeProps<SplitGridNodeType>) {
  const nodeData = data;
  const updateNodeData = useUpdateNodeData();
  const deriveNodeData = useDerivedNodeData();
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const edges = useWorkflowStore((state) => state.edges);
  const [showEditor, setShowEditor] = useState(false);
  useHoldLive(showEditor);
  const [expanded, setExpanded] = useNodeUiState(id, "expanded", true);

  const gridRows = clampGridDimension(nodeData.gridRows);
  const gridCols = clampGridDimension(nodeData.gridCols);
  const cellCount = gridRows * gridCols;

  // The clip takes the image's own proportions, so the grid overlay filling
  // the clip tracks the image exactly.
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Reactively track the connected source image
  const hasIncomingImageConnection = useMemo(() => {
    return edges.some((edge) => edge.target === id && edge.targetHandle === "image");
  }, [edges, id]);

  // Read through the store so it follows the upstream image, not the nodes array
  const connectedSourceImage = useWorkflowStore((state) =>
    hasIncomingImageConnection ? state.getConnectedInputs(id).images[0] || null : null
  );

  useEffect(() => {
    if (connectedSourceImage !== nodeData.sourceImage) {
      deriveNodeData(id, { sourceImage: connectedSourceImage });
    }
  }, [connectedSourceImage, id, deriveNodeData, nodeData.sourceImage]);

  // A painted copy cannot save the upstream image, so it shows the one it would save.
  const painted = useIsPaintedNode();
  const sourceImage = painted ? connectedSourceImage : nodeData.sourceImage;
  const adaptiveSourceImage = useAdaptiveImageSrc(sourceImage, id);
  // Thumbnail swaps and cached load events must not reset the source geometry.
  const imageAspect = loadedAspect?.src === sourceImage ? loadedAspect?.aspect : null;

  const cells = getSplitGridCells(nodeData);

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
  // The drag measures the grid as the pointer goes, off the node as well: the node stays live until it ends.
  useHoldLive(drag !== null);
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

  const media = sourceImage
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
                  className={`shrink-0 flex items-center justify-center gap-1.5 ${ACTION_W}`}
                >
                  <Grid2x2Plus size={12} strokeWidth={1.5} />
                  Open cell editor
                </PanelButton>
              </div>
            </Field>
            <FieldRow className="justify-between gap-2">
              <span className="text-node text-red-400 truncate" title={nodeData.status === "error" ? nodeData.error || "Error" : undefined}>
                {nodeData.status === "error" ? nodeData.error || "Error" : ""}
              </span>
              <PanelButton
                primary
                onClick={handleSplit}
                disabled={isRunning || !sourceImage}
                title={!sourceImage ? "Connect an image first" : `Split into ${gridRows}×${gridCols}`}
                className={`shrink-0 ${ACTION_W} justify-center`}
              >
                Split {gridRows}×{gridCols} now
              </PanelButton>
            </FieldRow>
          </ControlsCard>
        }
      >
        {sourceImage ? (
          <div ref={innerRef} className="absolute inset-0">
            <img
              src={adaptiveSourceImage ?? undefined}
              alt="Source grid"
              className="absolute inset-0 w-full h-full object-cover select-none"
              draggable={false}
              onLoad={(e) => {
                const { naturalWidth, naturalHeight } = e.currentTarget;
                if (naturalWidth > 0 && naturalHeight > 0 && sourceImage) {
                  setLoadedAspect({ src: sourceImage, aspect: naturalWidth / naturalHeight });
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
              <LayoutGrid size={20} strokeWidth={1.5} />
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
