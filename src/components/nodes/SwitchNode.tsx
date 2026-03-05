"use client";

import { memo, useMemo, useEffect, useState, useCallback } from "react";
import { Handle, Position, useUpdateNodeInternals, useReactFlow, NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode, SwitchNodeData, HandleType } from "@/types";

const HANDLE_COLORS: Record<HandleType, string> = {
  image: "#10b981",             // emerald — matches globals.css
  text: "#3b82f6",              // blue — matches globals.css
  video: "#ffffff",             // white — default handle style
  audio: "rgb(167, 139, 250)", // violet — matches GenerateAudioNode/OutputNode
  "3d": "#f97316",              // orange — matches globals.css
  easeCurve: "#ffffff",         // white — default handle style
};

export const SwitchNode = memo(({ id, data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data as SwitchNodeData;
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes, setEdges } = useReactFlow();
  const [editingId, setEditingId] = useState<string | null>(null);

  // Derive inputType from incoming edge connection
  const derivedInputType = useMemo(() => {
    const inputEdge = edges.find((e) => e.target === id);
    const handle = inputEdge?.targetHandle;
    // "generic-input" means the edge hasn't been resolved to a real type yet
    if (!handle || handle === "generic-input") return undefined;
    return handle as HandleType;
  }, [edges, id]);

  // Update stored inputType when derived type changes
  useEffect(() => {
    const newType = derivedInputType || null;
    if (newType !== nodeData.inputType) {
      updateNodeData(id, { inputType: newType });
    }
  }, [derivedInputType, id, nodeData.inputType, updateNodeData]);

  // Calculate handle positioning
  const handleSpacing = 32;
  const baseOffset = 38; // Clear the header bar

  // Dynamic height based on switch count and whether we have input
  const switchCount = nodeData.switches.length;
  const showOutputs = nodeData.inputType !== null;
  const lastHandleTop = baseOffset + (showOutputs ? switchCount * handleSpacing : handleSpacing);
  const minHeight = lastHandleTop + 40; // Extra space for add button

  // Resize node and notify React Flow when switch count or inputType changes
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
  }, [switchCount, showOutputs, id, minHeight, setNodes, updateNodeInternals]);

  // Handle toggle change
  const handleToggle = useCallback(
    (switchId: string) => {
      const updatedSwitches = nodeData.switches.map((sw) =>
        sw.id === switchId ? { ...sw, enabled: !sw.enabled } : sw
      );
      updateNodeData(id, { switches: updatedSwitches });
    },
    [id, nodeData.switches, updateNodeData]
  );

  // Handle name edit
  const handleNameEdit = useCallback(
    (switchId: string, newName: string) => {
      const updatedSwitches = nodeData.switches.map((sw) =>
        sw.id === switchId ? { ...sw, name: newName } : sw
      );
      updateNodeData(id, { switches: updatedSwitches });
      setEditingId(null);
    },
    [id, nodeData.switches, updateNodeData]
  );

  // Handle delete switch
  const handleDelete = useCallback(
    (switchId: string) => {
      if (nodeData.switches.length <= 1) return;
      const updatedSwitches = nodeData.switches.filter((sw) => sw.id !== switchId);
      updateNodeData(id, { switches: updatedSwitches });

      // Remove edges connected to this handle
      setEdges((edges) => edges.filter((e) => !(e.source === id && e.sourceHandle === switchId)));
    },
    [id, nodeData.switches, updateNodeData, setEdges]
  );

  // Handle add switch
  const handleAddSwitch = useCallback(() => {
    const newSwitch = {
      id: Math.random().toString(36).slice(2, 9),
      name: `Output ${nodeData.switches.length + 1}`,
      enabled: true,
    };
    updateNodeData(id, { switches: [...nodeData.switches, newSwitch] });
  }, [id, nodeData.switches, updateNodeData]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      minWidth={220}
      minHeight={minHeight}
      className="bg-violet-950/80 border-violet-600"
    >
      {/* Input handle (left) */}
      {nodeData.inputType ? (
        <Handle
          type="target"
          position={Position.Left}
          id={nodeData.inputType}
          data-handletype={nodeData.inputType}
          style={{
            top: baseOffset,
            backgroundColor: HANDLE_COLORS[nodeData.inputType],
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      ) : (
        <Handle
          type="target"
          position={Position.Left}
          id="generic-input"
          style={{
            top: baseOffset,
            backgroundColor: "#6b7280",
            width: 12,
            height: 12,
            border: "2px dashed #1e1e1e",
          }}
        />
      )}

      {/* Output handles (right) - only when input connected */}
      {showOutputs &&
        nodeData.switches.map((sw, index) => (
          <Handle
            key={`output-${sw.id}`}
            type="source"
            position={Position.Right}
            id={sw.id}
            data-handletype={nodeData.inputType}
            style={{
              top: baseOffset + index * handleSpacing,
              backgroundColor: HANDLE_COLORS[nodeData.inputType!],
              opacity: sw.enabled ? 1 : 0.3,
              width: 12,
              height: 12,
              border: "2px solid #1e1e1e",
            }}
          />
        ))}

      {/* Body content */}
      <div className="px-2 py-1 space-y-1">
        {!showOutputs ? (
          <div className="text-[10px] text-neutral-500 text-center py-2">
            Connect input to enable outputs
          </div>
        ) : (
          <>
            {nodeData.switches.map((sw, index) => (
              <div
                key={sw.id}
                className="flex items-center gap-2 group py-0.5"
              >
                {/* Toggle */}
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={sw.enabled}
                    onChange={() => handleToggle(sw.id)}
                  />
                  <div className="w-8 h-4 bg-neutral-600 peer-checked:bg-violet-500 rounded-full transition-colors relative">
                    <div className={`absolute top-0.5 left-0.5 bg-white h-3 w-3 rounded-full transition-transform ${sw.enabled ? "translate-x-4" : ""}`} />
                  </div>
                </label>

                {/* Name */}
                {editingId === sw.id ? (
                  <input
                    type="text"
                    className="flex-1 bg-neutral-700 text-neutral-100 text-xs px-1 py-0.5 rounded border border-violet-500 outline-none"
                    defaultValue={sw.name}
                    autoFocus
                    onBlur={(e) => handleNameEdit(sw.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        handleNameEdit(sw.id, e.currentTarget.value);
                      } else if (e.key === "Escape") {
                        setEditingId(null);
                      }
                    }}
                  />
                ) : (
                  <span
                    className={`flex-1 text-xs cursor-text ${
                      sw.enabled ? "text-neutral-300" : "text-neutral-500"
                    }`}
                    onDoubleClick={() => setEditingId(sw.id)}
                  >
                    {sw.name}
                  </span>
                )}

                {/* Delete button (hidden if only one switch) */}
                {nodeData.switches.length > 1 && (
                  <button
                    className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-400 transition-opacity"
                    onClick={() => handleDelete(sw.id)}
                    title="Delete switch"
                  >
                    <svg
                      className="w-3 h-3"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                )}
              </div>
            ))}

            {/* Add switch button */}
            <button
              className="w-full flex items-center justify-center gap-1 text-neutral-400 hover:text-white text-xs py-1 mt-2 rounded hover:bg-violet-900/30 transition-colors"
              onClick={handleAddSwitch}
            >
              <svg
                className="w-3 h-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Add Switch
            </button>
          </>
        )}
      </div>
    </BaseNode>
  );
});

SwitchNode.displayName = "SwitchNode";
