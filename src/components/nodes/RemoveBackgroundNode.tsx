"use client";

import { useMemo, useState } from "react";
import { NodeProps, Node } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { BackgroundRemovalModel, RemoveBackgroundNodeData } from "@/types";
import { useAdaptiveImageSrc } from "@/hooks/useAdaptiveImageSrc";
import { ChipGroup, ControlsCard, EmptyState, Field, Spinner, type SocketSpec } from "./ui";

type RemoveBackgroundNodeType = Node<RemoveBackgroundNodeData, "removeBackground">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image In" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "image", type: "image", label: "Image Out" }];
const EMPTY_HEIGHT = 140;

const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: "#262626",
  backgroundImage:
    "linear-gradient(45deg, #404040 25%, transparent 25%), linear-gradient(-45deg, #404040 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #404040 75%), linear-gradient(-45deg, transparent 75%, #404040 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
};

const MODEL_OPTIONS: { value: BackgroundRemovalModel; label: string }[] = [
  { value: "isnet_quint8", label: "Fast" },
  { value: "isnet_fp16", label: "Balanced" },
  { value: "isnet", label: "Quality" },
];

export function RemoveBackgroundNode({ id, data, selected }: NodeProps<RemoveBackgroundNodeType>) {
  const nodeData = data;
  const adaptiveOutputImage = useAdaptiveImageSrc(nodeData.outputImage, id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const isRunning = useWorkflowStore((state) => state.isRunning);
  const getConnectedInputs = useWorkflowStore((state) => state.getConnectedInputs);
  const edges = useWorkflowStore((state) => state.edges);
  const nodes = useWorkflowStore((state) => state.nodes);
  const [expanded, setExpanded] = useState(true);
  const [loadedAspect, setLoadedAspect] = useState<{ src: string; aspect: number } | null>(null);

  const hasIncomingImageConnection = useMemo(() => {
    return edges.some((edge) => edge.target === id && edge.targetHandle === "image");
  }, [edges, id]);

  const hasSourceImage = useMemo(() => {
    if (!hasIncomingImageConnection) return false;
    const { images } = getConnectedInputs(id);
    return images.length > 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasIncomingImageConnection, id, getConnectedInputs, nodes, edges]);

  const media = nodeData.outputImage
    ? { kind: "aspect" as const, aspect: loadedAspect?.src === nodeData.outputImage ? loadedAspect.aspect : 1 }
    : { kind: "fixed" as const, height: EMPTY_HEIGHT };
  const modelLabel = MODEL_OPTIONS.find((o) => o.value === nodeData.model)?.label ?? "Balanced";

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
          summary={{ title: `Remove background · ${modelLabel}` }}
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
        >
          <Field label="Model">
            <ChipGroup
              value={nodeData.model}
              options={MODEL_OPTIONS}
              onChange={(model) => updateNodeData(id, { model, outputImage: null, status: "idle", progress: 0 })}
            />
          </Field>
        </ControlsCard>
      }
    >
      <div className="absolute inset-0" style={CHECKERBOARD_STYLE} />
      {nodeData.outputImage ? (
        <>
          <img
            src={adaptiveOutputImage ?? undefined}
            className="absolute inset-0 w-full h-full object-cover"
            alt="Background removed"
            onLoad={(e) => {
              const img = e.currentTarget;
              if (img.naturalWidth > 0 && img.naturalHeight > 0 && nodeData.outputImage) {
                setLoadedAspect({ src: nodeData.outputImage, aspect: img.naturalWidth / img.naturalHeight });
              }
            }}
          />
          <button
            onClick={() => updateNodeData(id, { outputImage: null, status: "idle", progress: 0 })}
            className="absolute top-1 right-1 w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
            title="Clear result"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </>
      ) : (
        <EmptyState className="bg-transparent" message={hasSourceImage ? "Run to remove background" : "Connect an image input"} />
      )}

      {nodeData.status === "loading" && (
        <div className="absolute inset-0 bg-neutral-900/70 flex flex-col items-center justify-center gap-2">
          <Spinner size={24} className="text-white" />
          <span className="text-white text-xs">
            {nodeData.progress > 0 ? `Processing... ${nodeData.progress}%` : "Loading model..."}
          </span>
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
