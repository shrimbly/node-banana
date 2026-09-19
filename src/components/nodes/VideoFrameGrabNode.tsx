"use client";

import React, { useMemo, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { VideoFrameGrabNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { ChipGroup, ControlsCard, EmptyState, Field, FieldRow, PanelButton, Spinner, type SocketSpec } from "./ui";

type VideoFrameGrabNodeType = Node<VideoFrameGrabNodeData, "videoFrameGrab">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "video", type: "video", label: "Video In" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image Out" }];
const EMPTY_HEIGHT = 120;

const POSITION_OPTIONS = [
  { value: "first" as const, label: "First" },
  { value: "last" as const, label: "Last" },
];

export function VideoFrameGrabNode({ id, data, selected }: NodeProps<VideoFrameGrabNodeType>) {
  const nodeData = data;
  const adaptiveOutputImage = useAdaptiveImageSrc(nodeData.outputImage, id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [expanded, setExpanded] = useState(true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  // Find connected source video from incoming edges
  const sourceVideoUrl = useMemo(() => {
    const incomingEdge = edges.find((e) => e.target === id && e.targetHandle === "video");
    if (!incomingEdge) return null;

    const sourceNode = nodes.find((n) => n.id === incomingEdge.source);
    if (!sourceNode) return null;

    const d = sourceNode.data as Record<string, unknown>;
    return (d.outputVideo as string | null) ?? null;
  }, [edges, nodes, id]);

  const hasSourceVideo = Boolean(sourceVideoUrl);
  const canExtract = hasSourceVideo && nodeData.status !== "loading" && !isRunning;

  const media = nodeData.outputImage
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === nodeData.outputImage ? loadedAspect.aspect : 16 / 9 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };

  return (
    <NodeShell
      id={id}
      selected={selected}
      isExecuting={isRunning}
      hasError={nodeData.status === "error"}
      media={media}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      mediaClassName="group"
      controls={
        <ControlsCard
          id={id}
          summary={{ title: `${nodeData.framePosition === "last" ? "Last" : "First"} frame` }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          <Field label="Frame">
            <ChipGroup
              value={nodeData.framePosition === "last" ? "last" : "first"}
              options={POSITION_OPTIONS}
              onChange={(framePosition) => updateNodeData(id, { framePosition, outputImage: null })}
            />
          </Field>
          <FieldRow className="justify-end">
            <PanelButton primary onClick={() => regenerateNode(id)} disabled={!canExtract}>
              {nodeData.status === "loading" ? "Extracting..." : "Extract Frame"}
            </PanelButton>
          </FieldRow>
        </ControlsCard>
      }
    >
      {nodeData.outputImage ? (
        <>
          <img
            src={adaptiveOutputImage ?? undefined}
            className="absolute inset-0 w-full h-full object-cover"
            alt="Extracted frame"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0 && nodeData.outputImage) {
                setLoadedAspect({ src: nodeData.outputImage, aspect: img.naturalWidth / img.naturalHeight });
              }
            }}
          />
          <button
            onClick={() => updateNodeData(id, { outputImage: null, status: "idle" })}
            className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Clear extracted frame"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </>
      ) : (
        <EmptyState message="Connect a video and extract a frame" />
      )}

      {nodeData.status === "loading" && (
        <div className="absolute inset-0 bg-neutral-900/70 flex flex-col items-center justify-center gap-2">
          <Spinner size={24} className="text-white" />
          <span className="text-white text-xs">Extracting frame...</span>
        </div>
      )}

      {nodeData.status === "error" && nodeData.error && (
        <div className="absolute bottom-2 left-2 right-2 px-2 py-1.5 bg-red-900/30 border border-red-700/50 rounded">
          <p className="text-[10px] text-red-400 break-words">{nodeData.error}</p>
        </div>
      )}
    </NodeShell>
  );
}
