"use client";

import { memo, useMemo, useEffect, useState, useCallback } from "react";
import { useReactFlow, NodeProps } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import type { WorkflowNode, SwitchNodeData, HandleType } from "@/types";
import { LogicRow, LogicRows, type SocketSpec } from "./ui";

/**
 * Toggle-controlled fan-out. The input lands on the first row; every switch
 * is a row with its own output socket, dimmed while the switch is off.
 */
export const SwitchNode = memo(({ id, data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data as SwitchNodeData;
  const edges = useWorkflowStore((state) => state.edges);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { setEdges } = useReactFlow();
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

  const showOutputs = nodeData.inputType !== null;

  const handleToggle = useCallback(
    (switchId: string) => {
      const updatedSwitches = nodeData.switches.map((sw) =>
        sw.id === switchId ? { ...sw, enabled: !sw.enabled } : sw
      );
      updateNodeData(id, { switches: updatedSwitches });
    },
    [id, nodeData.switches, updateNodeData]
  );

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

  const handleAddSwitch = useCallback(() => {
    const newSwitch = {
      id: Math.random().toString(36).slice(2, 9),
      name: `Output ${nodeData.switches.length + 1}`,
      enabled: true,
    };
    updateNodeData(id, { switches: [...nodeData.switches, newSwitch] });
  }, [id, nodeData.switches, updateNodeData]);

  const inputs = useMemo<SocketSpec[]>(
    () =>
      nodeData.inputType
        ? [{ id: nodeData.inputType, type: nodeData.inputType, label: "In" }]
        : [{ id: "generic-input", type: "reference", label: "In" }],
    [nodeData.inputType]
  );

  const outputs = useMemo<SocketSpec[]>(
    () =>
      showOutputs
        ? nodeData.switches.map((sw) => ({
            id: sw.id,
            type: nodeData.inputType!,
            label: sw.name,
            placeholder: !sw.enabled,
          }))
        : [],
    [showOutputs, nodeData.switches, nodeData.inputType]
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      media={{ kind: "auto" }}
      inputs={inputs}
      outputs={outputs}
      minWidth={220}
      cardClassName="rounded-controls"
    >
      <LogicRows>
        {!showOutputs ? (
          <LogicRow>
            <span className="text-node text-neutral-500">Connect input to enable outputs</span>
          </LogicRow>
        ) : (
          nodeData.switches.map((sw) => (
            <LogicRow key={sw.id} className="group">
              <label className="relative inline-flex items-center cursor-pointer nodrag nopan shrink-0">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={sw.enabled}
                  onChange={() => handleToggle(sw.id)}
                  aria-label={`Toggle ${sw.name}`}
                />
                <div className="w-7 h-3.5 bg-neutral-600 peer-checked:bg-violet-500 rounded-full transition-colors relative">
                  <div className={`absolute top-0.5 left-0.5 bg-white h-2.5 w-2.5 rounded-full transition-transform ${sw.enabled ? "translate-x-3.5" : ""}`} />
                </div>
              </label>

              {editingId === sw.id ? (
                <input
                  type="text"
                  className="nodrag nopan flex-1 min-w-0 h-[22px] bg-well rounded-well squircle shadow-well text-neutral-100 text-node px-[7px] outline-none focus:ring-1 focus:ring-violet-500"
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
                  className={`flex-1 min-w-0 truncate text-node cursor-text ${sw.enabled ? "text-neutral-300" : "text-neutral-500"}`}
                  onDoubleClick={() => setEditingId(sw.id)}
                  title="Double-click to rename"
                >
                  {sw.name}
                </span>
              )}

              {nodeData.switches.length > 1 && (
                <button
                  className="nodrag nopan opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-400 transition-opacity shrink-0"
                  onClick={() => handleDelete(sw.id)}
                  title="Delete switch"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </LogicRow>
          ))
        )}
        {showOutputs && (
          <div className="px-2 pt-1">
            <button
              className="nodrag nopan w-full h-[22px] flex items-center justify-center gap-1 text-neutral-400 hover:text-white text-node rounded-well squircle hover:bg-white/5 transition-colors"
              onClick={handleAddSwitch}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Switch
            </button>
          </div>
        )}
      </LogicRows>
    </NodeShell>
  );
});

SwitchNode.displayName = "SwitchNode";
