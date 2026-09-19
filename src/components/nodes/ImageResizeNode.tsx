"use client";

import { useEffect, useMemo, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import type { ImageResizeNodeData, ImageResizeFit, ImageResizeFormat, ImageResizeMode } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import {
  ChipGroup,
  ControlsCard,
  EmptyState,
  Field,
  FieldRow,
  LoadingOverlay,
  NumberField,
  PanelButton,
  RangeField,
  SelectField,
  SummaryValues,
  type SocketSpec,
} from "./ui";

type ImageResizeNodeType = Node<ImageResizeNodeData, "imageResize">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image In" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image Out" }];
const EMPTY_HEIGHT = 120;

const MODE_OPTIONS: { value: ImageResizeMode; label: string }[] = [
  { value: "exact", label: "Exact" },
  { value: "maxEdge", label: "Max edge" },
  { value: "scale", label: "Scale %" },
];
const FIT_OPTIONS: { value: ImageResizeFit; label: string }[] = [
  { value: "contain", label: "Contain" },
  { value: "cover", label: "Cover" },
  { value: "stretch", label: "Stretch" },
];
const FORMAT_OPTIONS: { value: ImageResizeFormat; label: string }[] = [
  { value: "keep", label: "Keep" },
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPEG" },
  { value: "webp", label: "WEBP" },
];

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ImageResizeNode({ id, data, selected }: NodeProps<ImageResizeNodeType>) {
  const nodeData = data;
  const adaptiveOutput = useAdaptiveImageSrc(nodeData.outputImage, id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const edges = useWorkflowStore((state) => state.edges);
  const [expanded, setExpanded] = useState(true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Sync upstream image into sourceImage so the executor + UI both see it
  const hasIncomingImage = useMemo(
    () => edges.some((e) => e.target === id && e.targetHandle === "image"),
    [edges, id],
  );

  // Read through the store so it follows the upstream image, not the nodes array
  const upstreamImage = useWorkflowStore((state) => (hasIncomingImage ? state.getConnectedInputs(id).images[0] ?? null : null));

  useEffect(() => {
    if (upstreamImage !== nodeData.sourceImage) {
      updateNodeData(id, { sourceImage: upstreamImage });
    }
  }, [upstreamImage, id, updateNodeData, nodeData.sourceImage]);

  const previewSrc = nodeData.outputImage ?? nodeData.sourceImage ?? null;
  const previewDisplaySrc = nodeData.outputImage ? adaptiveOutput ?? nodeData.outputImage : nodeData.sourceImage;
  const media = previewSrc
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === previewSrc ? loadedAspect.aspect : 1 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  const modeSummary =
    nodeData.mode === "exact"
      ? `Exact ${nodeData.width}×${nodeData.height}`
      : nodeData.mode === "maxEdge"
        ? `Max edge ${nodeData.maxEdge}px`
        : `Scale ${nodeData.scalePct}%`;
  const outputInfo = nodeData.outputDimensions
    ? `${nodeData.outputDimensions.width}×${nodeData.outputDimensions.height} · ${formatBytes(nodeData.outputBytes)}`
    : null;

  return (
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      media={media}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      minWidth={260}
      controls={
        <ControlsCard
          id={id}
          summary={{ title: modeSummary, values: <SummaryValues items={[outputInfo]} /> }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          <Field label="Mode">
            <ChipGroup value={nodeData.mode} options={MODE_OPTIONS} onChange={(m) => updateNodeData(id, { mode: m })} />
          </Field>
          {nodeData.mode === "exact" && (
            <>
              <NumberField label="Width" unit="px" value={nodeData.width} min={1} integer allowEmpty={false} onChange={(v) => updateNodeData(id, { width: v || 1 })} />
              <NumberField label="Height" unit="px" value={nodeData.height} min={1} integer allowEmpty={false} onChange={(v) => updateNodeData(id, { height: v || 1 })} />
              <Field label="Fit">
                <ChipGroup value={nodeData.fit} options={FIT_OPTIONS} onChange={(f) => updateNodeData(id, { fit: f })} />
              </Field>
            </>
          )}
          {nodeData.mode === "maxEdge" && (
            <NumberField label="Max edge" unit="px" value={nodeData.maxEdge} min={1} integer allowEmpty={false} onChange={(v) => updateNodeData(id, { maxEdge: v || 1 })} />
          )}
          {nodeData.mode === "scale" && (
            <NumberField
              label="Scale"
              unit="%"
              value={nodeData.scalePct}
              min={1}
              max={400}
              integer
              allowEmpty={false}
              onChange={(v) => updateNodeData(id, { scalePct: Math.min(400, Math.max(1, v || 1)) })}
            />
          )}
          <SelectField
            label="Format"
            value={nodeData.format}
            options={FORMAT_OPTIONS}
            onChange={(f) => updateNodeData(id, { format: f as ImageResizeFormat })}
          />
          {(nodeData.format === "jpeg" || nodeData.format === "webp") && (
            <RangeField
              label="Quality"
              value={nodeData.quality}
              min={0.1}
              max={1}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(v) => updateNodeData(id, { quality: v })}
            />
          )}
          <FieldRow className="justify-end">
            <PanelButton
              primary
              onClick={() => regenerateNode(id)}
              disabled={!nodeData.sourceImage || nodeData.status === "loading" || isRunning}
            >
              {nodeData.status === "loading" ? "Resizing..." : "Resize"}
            </PanelButton>
          </FieldRow>
        </ControlsCard>
      }
    >
      {previewSrc ? (
        <img
          src={previewDisplaySrc ?? undefined}
          alt="Resize preview"
          className="absolute inset-0 w-full h-full object-cover"
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              setLoadedAspect({ src: previewSrc, aspect: img.naturalWidth / img.naturalHeight });
            }
          }}
        />
      ) : (
        <EmptyState message="Connect an image" />
      )}
      {nodeData.status === "loading" && <LoadingOverlay size={20} />}
      {nodeData.status === "error" && nodeData.error && (
        <div className="absolute bottom-2 left-2 right-2 px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
          <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
        </div>
      )}
    </NodeShell>
  );
}
