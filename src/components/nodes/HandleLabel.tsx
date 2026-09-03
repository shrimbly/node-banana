import { useConnection, useNodeId } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";

interface HandleLabelProps {
  label: string;
  side: "target" | "source";
  color: string;
  top?: string;
  visible: boolean;
  opacity?: number;
}

export function HandleLabel({ label, side, color, top = "calc(50% - 18px)", visible, opacity }: HandleLabelProps) {
  // Hidden noodles leave labelled stubs beside the handles on this side, so the
  // handle labels stay out of their way until a connection drag replaces them
  const nodeId = useNodeId();
  const isConnecting = useConnection((c) => c.inProgress);
  const hasHiddenStubs = useWorkflowStore(
    (state) => state.edges?.some((e) => e.data?.hidden && (side === "source" ? e.source : e.target) === nodeId) ?? false
  );
  const shown = visible && (isConnecting || !hasHiddenStubs);
  const positionStyle = side === "target"
    ? { right: "calc(100% + 8px)" }
    : { left: "calc(100% + 8px)" };

  return (
    <div
      className={`absolute text-[10px] font-medium whitespace-nowrap pointer-events-none${side === "target" ? " text-right" : ""}`}
      style={{
        ...positionStyle,
        top,
        color,
        zIndex: 10,
        opacity: shown ? (opacity ?? 1) : 0,
        transition: "opacity 150ms ease-in-out",
      }}
    >
      {label}
    </div>
  );
}
