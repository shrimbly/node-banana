import { useConnection, useNodeId } from "@xyflow/react";
import { useWorkflowStore } from "@/store/workflowStore";
import { hasHiddenStubs } from "@/lib/edges/labels";

interface HandleLabelProps {
  label: string;
  side: "target" | "source";
  color: string;
  /** CSS top; a number is taken as px. */
  top?: string | number;
  /** Distance from the node edge. Sockets stick out, so they pass a larger one. */
  offset?: string;
  visible: boolean;
  opacity?: number;
}

export function HandleLabel({
  label,
  side,
  color,
  top = "calc(50% - 18px)",
  offset = "8px",
  visible,
  opacity,
}: HandleLabelProps) {
  // Hidden noodles leave labelled stubs beside the handles on this side, so the
  // handle labels stay out of their way until a connection drag replaces them
  const nodeId = useNodeId();
  const isConnecting = useConnection((c) => c.inProgress);
  const hiddenStubs = useWorkflowStore((state) => hasHiddenStubs(state.edges, nodeId, side));
  const shown = visible && (isConnecting || !hiddenStubs);
  const positionStyle = side === "target"
    ? { right: `calc(100% + ${offset})` }
    : { left: `calc(100% + ${offset})` };

  return (
    <div
      className={`absolute text-[10px] font-medium whitespace-nowrap pointer-events-none${side === "target" ? " text-right" : ""}`}
      style={{
        ...positionStyle,
        top: typeof top === "number" ? `${top}px` : top,
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
