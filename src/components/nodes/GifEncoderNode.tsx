"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import type { GifEncoderNodeData, WorkflowNode } from "@/types";
import {
  CheckboxField,
  ControlsCard,
  EmptyState,
  FieldRow,
  NumberField,
  PanelButton,
  SummaryValues,
  type SocketSpec,
} from "./ui";
import { generateThumbnail } from "@/utils/imageThumbnail";
import {
  getThumbnail,
  setThumbnail,
  getPending,
  setPending,
  removePending,
} from "@/store/thumbnailCache";

type GifEncoderNodeType = Node<GifEncoderNodeData, "gifEncoder">;

const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "GIF Out" }];
const EMPTY_HEIGHT = 120;

/**
 * Filmstrip tiles are tiny (~70px squares) but the source frames may be full
 * 2-4K images. Route each tile through the shared thumbnail cache so tiles
 * render a ~256px cached JPEG instead of decoding/holding full-resolution
 * base64 on every canvas paint. Falls back to the full src until the
 * thumbnail is ready.
 */
function useThumbnailSrc(fullSrc: string | null): string | null {
  const [thumb, setThumb] = useState<string | null>(() =>
    fullSrc ? getThumbnail(fullSrc) ?? null : null
  );

  useEffect(() => {
    if (!fullSrc) {
      setThumb(null);
      return;
    }

    const cached = getThumbnail(fullSrc);
    if (cached) {
      setThumb(cached);
      return;
    }

    let cancelled = false;
    const existing = getPending(fullSrc);
    const promise =
      existing ??
      generateThumbnail(fullSrc)
        .then((t) => {
          setThumbnail(fullSrc, t);
          return t;
        })
        // Clear the pending entry on both success and failure so a failed
        // thumbnail can be retried instead of leaking a permanent entry.
        .finally(() => {
          removePending(fullSrc);
        });
    if (!existing) setPending(fullSrc, promise);

    setThumb(null);
    promise
      .then((t) => {
        if (!cancelled) setThumb(t);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [fullSrc]);

  return thumb ?? fullSrc;
}

function FrameThumbnail({ src, alt }: { src: string; alt: string }) {
  const thumbSrc = useThumbnailSrc(src);
  return (
    <img src={thumbSrc ?? src} alt={alt} className="w-full h-full object-cover rounded" />
  );
}

function getImageFromSourceNode(node: WorkflowNode): string | null {
  const d = node.data as Record<string, unknown>;
  // Common image-producing fields (outputGif lets a GIF encoder feed another)
  return (
    (d.outputImage as string | null) ??
    (d.image as string | null) ??
    (d.capturedImage as string | null) ??
    (d.outputGif as string | null) ??
    null
  );
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function GifEncoderNode({ id, data, selected }: NodeProps<GifEncoderNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const removeEdge = useWorkflowStore((state) => state.removeEdge);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [expanded, setExpanded] = useState(true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Dynamic image input edges
  const imageEdges = useMemo(() => {
    return edges.filter((e) => e.target === id && e.targetHandle?.startsWith("image-"));
  }, [edges, id]);

  // Sync clipOrder with current edges
  const lastWritten = useRef<string[]>([]);
  useEffect(() => {
    const ids = imageEdges.map((e) => e.id);
    const current = nodeData.clipOrder || [];
    const validExisting = current.filter((eid) => ids.includes(eid));
    const newOnes = ids.filter((eid) => !current.includes(eid));
    const next = [...validExisting, ...newOnes];
    const same =
      next.length === lastWritten.current.length &&
      next.every((eid, i) => eid === lastWritten.current[i]);
    if (same) return;
    if (
      next.length !== current.length ||
      !next.every((eid, i) => eid === current[i])
    ) {
      lastWritten.current = next;
      updateNodeData(id, { clipOrder: next });
    }
  }, [imageEdges, nodeData.clipOrder, id, updateNodeData]);

  // Build ordered frame list for the filmstrip
  const orderedFrames = useMemo(() => {
    const map = new Map<string, { edgeId: string; src: string | null }>();
    imageEdges.forEach((edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      if (!sourceNode) return;
      map.set(edge.id, { edgeId: edge.id, src: getImageFromSourceNode(sourceNode) });
    });
    const order = nodeData.clipOrder?.length ? nodeData.clipOrder : imageEdges.map((e) => e.id);
    const ordered: { edgeId: string; src: string | null }[] = [];
    for (const eid of order) {
      const f = map.get(eid);
      if (f) ordered.push(f);
    }
    // Append any new edges not yet in clipOrder
    imageEdges.forEach((edge) => {
      if (!order.includes(edge.id)) {
        const f = map.get(edge.id);
        if (f) ordered.push(f);
      }
    });
    return ordered;
  }, [imageEdges, nodes, nodeData.clipOrder]);

  // Pointer-based drag reorder (HTML5 drag doesn't work inside React Flow)
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent, edgeId: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setDraggedId(edgeId);
    setHoverId(null);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggedId) return;
    const elementsUnder = document.elementsFromPoint(e.clientX, e.clientY);
    for (const el of elementsUnder) {
      const clipEl = (el as HTMLElement).closest("[data-frame-id]") as HTMLElement | null;
      if (clipEl) {
        const targetId = clipEl.dataset.frameId!;
        if (targetId !== draggedId) setHoverId(targetId);
        return;
      }
    }
    setHoverId(null);
  }, [draggedId]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (!draggedId || !hoverId || draggedId === hoverId) {
      setDraggedId(null);
      setHoverId(null);
      return;
    }
    const order = [...(nodeData.clipOrder || [])];
    const a = order.indexOf(draggedId);
    const b = order.indexOf(hoverId);
    if (a !== -1 && b !== -1) {
      order.splice(a, 1);
      order.splice(b, 0, draggedId);
      updateNodeData(id, { clipOrder: order });
    }
    setDraggedId(null);
    setHoverId(null);
  }, [draggedId, hoverId, nodeData.clipOrder, id, updateNodeData]);

  // Dynamic image sockets: up to the highest referenced "image-N" plus one
  // free slot, so a high-index edge keeps its socket after an earlier one goes.
  const inputSockets = useMemo<SocketSpec[]>(() => {
    let maxIndex = -1;
    for (const e of imageEdges) {
      const match = e.targetHandle?.match(/^image-(\d+)$/);
      if (match) {
        const idx = Number(match[1]);
        if (idx > maxIndex) maxIndex = idx;
      }
    }
    const count = Math.max(maxIndex + 2, 2);
    return Array.from({ length: count }, (_, i) => ({ id: `image-${i}`, type: "image", label: `Frame ${i + 1}` }));
  }, [imageEdges]);

  const targetKB = nodeData.targetMaxBytes !== null
    ? Math.round(nodeData.targetMaxBytes / 1024)
    : 0;
  const frameCount = orderedFrames.filter((f) => f.src).length;

  const media = nodeData.outputGif
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === nodeData.outputGif ? loadedAspect.aspect : 1 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  const filmstrip = (
    <div className="overflow-y-auto nowheel grid grid-cols-6 content-start gap-1 p-1.5 bg-well rounded-well squircle shadow-well max-h-[110px]">
      {orderedFrames.map((frame, i) => (
        <div
          key={frame.edgeId}
          data-frame-id={frame.edgeId}
          onPointerDown={(e) => handlePointerDown(e, frame.edgeId)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          className={`nodrag relative aspect-square bg-neutral-800 border rounded cursor-move transition-colors group ${
            draggedId === frame.edgeId
              ? "opacity-50 border-blue-500"
              : hoverId === frame.edgeId && draggedId
                ? "border-blue-400 ring-1 ring-blue-400/50"
                : "border-neutral-600 hover:border-neutral-500"
          }`}
        >
          {frame.src ? (
            <FrameThumbnail src={frame.src} alt={`Frame ${i + 1}`} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[8px] text-neutral-500">—</div>
          )}
          <div className="absolute bottom-0 left-0 bg-black/70 px-0.5 text-[8px] text-white rounded-tr">{i + 1}</div>
          <button
            onClick={() => removeEdge(frame.edgeId)}
            className="absolute top-0 right-0 w-3.5 h-3.5 bg-red-600/80 hover:bg-red-500 rounded text-white opacity-0 group-hover:opacity-100 flex items-center justify-center"
            title="Disconnect"
          >
            <svg className="w-2 h-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      media={media}
      inputs={inputSockets}
      outputs={OUTPUT_SOCKETS}
      minWidth={300}
      mediaClassName="group"
      controls={
        <ControlsCard
          id={id}
          summary={{
            title: `${frameCount} frame${frameCount === 1 ? "" : "s"}`,
            values: (
              <SummaryValues
                items={[
                  `${nodeData.fps} fps`,
                  `${nodeData.colorCount} colors`,
                  nodeData.outputDimensions
                    ? `${nodeData.outputDimensions.width}×${nodeData.outputDimensions.height} · ${formatBytes(nodeData.outputBytes)}`
                    : null,
                ]}
              />
            ),
          }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          {orderedFrames.length > 0 ? (
            <FieldRow className="h-auto">
              <div className="w-full">{filmstrip}</div>
            </FieldRow>
          ) : (
            <span className="text-node text-neutral-500 py-1">Connect image frames</span>
          )}
          <NumberField
            label="FPS"
            value={nodeData.fps}
            min={1}
            max={30}
            integer
            allowEmpty={false}
            onChange={(v) => updateNodeData(id, { fps: Math.max(1, Math.min(30, v || 1)) })}
          />
          <NumberField
            label="Colors"
            value={nodeData.colorCount}
            min={2}
            max={256}
            integer
            allowEmpty={false}
            onChange={(v) => updateNodeData(id, { colorCount: Math.max(2, Math.min(256, v || 2)) })}
          />
          <CheckboxField label="Dither" checked={nodeData.dither} onChange={(dither) => updateNodeData(id, { dither })} />
          <CheckboxField
            label="Target size"
            checked={nodeData.targetMaxBytes !== null}
            onChange={(on) => updateNodeData(id, { targetMaxBytes: on ? 128 * 1024 : null })}
          />
          {nodeData.targetMaxBytes !== null && (
            <NumberField
              label="Max size"
              unit="KB"
              value={targetKB || 128}
              min={1}
              integer
              allowEmpty={false}
              onChange={(v) => updateNodeData(id, { targetMaxBytes: Math.max(1, v || 1) * 1024 })}
            />
          )}
          <FieldRow className="justify-end">
            <PanelButton
              primary
              onClick={() => regenerateNode(id)}
              disabled={frameCount < 2 || nodeData.status === "loading" || isRunning}
            >
              {nodeData.status === "loading" ? "Encoding..." : "Encode GIF"}
            </PanelButton>
          </FieldRow>
        </ControlsCard>
      }
    >
      {nodeData.outputGif ? (
        <>
          <img
            src={nodeData.outputGif}
            alt="GIF preview"
            className="absolute inset-0 w-full h-full object-cover"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0 && nodeData.outputGif) {
                setLoadedAspect({ src: nodeData.outputGif, aspect: img.naturalWidth / img.naturalHeight });
              }
            }}
          />
          <button
            onClick={() => updateNodeData(id, { outputGif: null, status: "idle", outputBytes: null, outputDimensions: null })}
            className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Clear GIF"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </>
      ) : (
        <EmptyState message={nodeData.status === "loading" ? `Encoding... ${Math.round(nodeData.progress)}%` : "No GIF yet"} />
      )}

      {nodeData.status === "error" && nodeData.error && (
        <div className="absolute bottom-2 left-2 right-2 px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
          <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
        </div>
      )}
    </NodeShell>
  );
}
