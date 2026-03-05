"use client";

import { memo, useMemo, useEffect } from "react";
import { Handle, Position, useUpdateNodeInternals, useReactFlow, NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode, RouterNodeData } from "@/types";

const ALL_HANDLE_TYPES = ["image", "text", "video", "audio", "3d", "easeCurve"] as const;

const HANDLE_COLORS: Record<(typeof ALL_HANDLE_TYPES)[number], string> = {
  image: "#10b981",             // emerald — matches globals.css
  text: "#3b82f6",              // blue — matches globals.css
  video: "#ffffff",             // white — default handle style
  audio: "rgb(167, 139, 250)", // violet — matches GenerateAudioNode/OutputNode
  "3d": "#f97316",              // orange — matches globals.css
  easeCurve: "#ffffff",         // white — default handle style
};

export const RouterNode = memo(({ id, data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data as RouterNodeData;
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes } = useReactFlow();

  // Derive active input types from incoming edge connections
  const activeInputTypes = useMemo(() => {
    const typeSet = new Set<(typeof ALL_HANDLE_TYPES)[number]>();

    edges
      .filter((edge) => edge.target === id)
      .forEach((edge) => {
        const handleType = edge.targetHandle;
        if (handleType && ALL_HANDLE_TYPES.includes(handleType as typeof ALL_HANDLE_TYPES[number])) {
          typeSet.add(handleType as typeof ALL_HANDLE_TYPES[number]);
        }
      });

    return Array.from(typeSet).sort();
  }, [edges, id]);

  // Show generic handles when not all types are connected
  const showGenericHandles = activeInputTypes.length < ALL_HANDLE_TYPES.length;

  // Calculate handle positioning
  const handleSpacing = 24;
  const baseOffset = 38; // Clear the header bar

  // Dynamic height based on total handle count (active + placeholder)
  const totalHandleSlots = activeInputTypes.length + (showGenericHandles ? 1 : 0);
  const lastHandleTop = baseOffset + (Math.max(totalHandleSlots, 1) - 1) * handleSpacing;
  const minHeight = lastHandleTop + 20;

  // Resize node and notify React Flow when handle count changes
  useEffect(() => {
    setNodes((nodes) =>
      nodes.map((node) => {
        if (node.id === id) {
          const currentHeight = (node.style?.height as number) || 0;
          if (currentHeight < minHeight) {
            return { ...node, style: { ...node.style, height: minHeight } };
          }
        }
        return node;
      })
    );
    updateNodeInternals(id);
  }, [activeInputTypes.length, id, minHeight, setNodes, updateNodeInternals]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      minWidth={200}
      minHeight={minHeight}
      className="bg-neutral-800/80 border-neutral-600"
    >
      {/* Input handles (left) */}
      {activeInputTypes.map((type, index) => (
        <Handle
          key={`input-${type}`}
          type="target"
          position={Position.Left}
          id={type}
          data-handletype={type}
          style={{
            top: baseOffset + index * handleSpacing,
            backgroundColor: HANDLE_COLORS[type],
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      ))}
      {showGenericHandles && (
        <Handle
          type="target"
          position={Position.Left}
          id="generic-input"
          style={{
            top: baseOffset + activeInputTypes.length * handleSpacing,
            backgroundColor: "#6b7280",
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      )}

      {/* Output handles (right) */}
      {activeInputTypes.map((type, index) => (
        <Handle
          key={`output-${type}`}
          type="source"
          position={Position.Right}
          id={type}
          data-handletype={type}
          style={{
            top: baseOffset + index * handleSpacing,
            backgroundColor: HANDLE_COLORS[type],
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      ))}

      {/* Body content */}
      <div className="text-[10px] text-neutral-500 text-center py-1">
        {activeInputTypes.length > 0
          ? `${activeInputTypes.length} type${activeInputTypes.length !== 1 ? "s" : ""} routed`
          : "Drop connections here"}
      </div>
    </BaseNode>
  );
});

RouterNode.displayName = "RouterNode";
