"use client";

import { memo, useMemo, useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { Handle, Position, useUpdateNodeInternals, useReactFlow, NodeProps } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { evaluateRule } from "@/store/utils/ruleEvaluation";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import type { WorkflowNode, ConditionalSwitchNodeData, ConditionalSwitchRule, MatchMode } from "@/types";

export const ConditionalSwitchNode = memo(({ id, data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data as ConditionalSwitchNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const updateNodeInternals = useUpdateNodeInternals();
  const { setNodes, setEdges } = useReactFlow();
  const [editingId, setEditingId] = useState<string | null>(null);

  // Get incoming text via store selector so it recomputes when upstream node data changes
  // (useMemo with edges as dependency missed upstream data changes, causing stale evaluations)
  const incomingText = useWorkflowStore(
    useCallback((state) =>
      getConnectedInputsPure(id, state.nodes, state.edges, undefined, state.dimmedNodeIds).text,
    [id])
  );

  // Evaluate all rules and update match status
  useEffect(() => {
    // Skip re-evaluation when paused — prevents upstream text from re-setting isMatched
    if (nodeData.evaluationPaused) return;

    const updatedRules = nodeData.rules.map(rule => ({
      ...rule,
      isMatched: evaluateRule(incomingText, rule.value, rule.mode)
    }));

    // Check if any rule matched
    const anyMatched = updatedRules.some(r => r.isMatched);

    // Only update if something changed
    const hasChanges =
      nodeData.incomingText !== incomingText ||
      updatedRules.some((r, i) => r.isMatched !== nodeData.rules[i].isMatched);

    if (hasChanges) {
      updateNodeData(id, {
        incomingText,
        rules: updatedRules
      });
    }
  }, [incomingText, nodeData.rules, nodeData.incomingText, nodeData.evaluationPaused, id, updateNodeData]);

  // Ref-based handle positioning — measure actual row DOM positions
  const ruleRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const defaultRowRef = useRef<HTMLDivElement | null>(null);
  const [handleTops, setHandleTops] = useState<Record<string, number>>({});

  // Track rule IDs for re-measurement on add/remove/reorder
  const ruleIds = useMemo(() => nodeData.rules.map(r => r.id).join(','), [nodeData.rules]);

  // Measure actual row centers relative to the node element (before paint)
  useLayoutEffect(() => {
    const positions: Record<string, number> = {};

    for (const [ruleId, el] of Object.entries(ruleRowRefs.current)) {
      if (el) {
        positions[ruleId] = el.offsetTop + el.offsetHeight / 2;
      }
    }

    const defaultEl = defaultRowRef.current;
    if (defaultEl) {
      positions['default'] = defaultEl.offsetTop + defaultEl.offsetHeight / 2;
    }

    setHandleTops(positions);
  }, [ruleIds]);

  // Fallback handle positioning (used before first measurement)
  const handleSpacing = 32;
  const fallbackBase = 70; // approximate: header + padding + text preview + half row

  // Dynamic height based on rule count (rules + default)
  const ruleCount = nodeData.rules.length;
  const totalOutputs = ruleCount + 1; // rules + default
  const lastHandleTop = fallbackBase + totalOutputs * handleSpacing;
  const minHeight = lastHandleTop + 40; // Extra space for add button

  // Resize node and notify React Flow when rule count changes
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
  }, [ruleCount, id, minHeight, setNodes, updateNodeInternals]);

  // Handle rule value change (auto-unpauses evaluation)
  const handleRuleValueChange = useCallback(
    (ruleId: string, newValue: string) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, value: newValue } : rule
      );
      updateNodeData(id, { rules: updatedRules, evaluationPaused: false });
    },
    [id, nodeData.rules, updateNodeData]
  );

  // Handle mode change (auto-unpauses evaluation)
  const handleModeChange = useCallback(
    (ruleId: string, newMode: MatchMode) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, mode: newMode } : rule
      );
      updateNodeData(id, { rules: updatedRules, evaluationPaused: false });
    },
    [id, nodeData.rules, updateNodeData]
  );

  // Handle label edit
  const handleLabelEdit = useCallback(
    (ruleId: string, newLabel: string) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, label: newLabel } : rule
      );
      updateNodeData(id, { rules: updatedRules });
      setEditingId(null);
    },
    [id, nodeData.rules, updateNodeData]
  );

  // Handle delete rule
  const handleDelete = useCallback(
    (ruleId: string) => {
      // Don't allow deletion if only one rule
      if (nodeData.rules.length <= 1) return;

      const updatedRules = nodeData.rules.filter((rule) => rule.id !== ruleId);
      updateNodeData(id, { rules: updatedRules });

      // Remove edges connected to this handle
      setEdges((edges) => edges.filter((e) => !(e.source === id && e.sourceHandle === ruleId)));
    },
    [id, nodeData.rules, updateNodeData, setEdges]
  );

  // Handle add rule
  const handleAddRule = useCallback(() => {
    const newRule: ConditionalSwitchRule = {
      id: "rule-" + Math.random().toString(36).slice(2, 9),
      value: "",
      mode: "contains",
      label: `Rule ${nodeData.rules.length + 1}`,
      isMatched: false,
    };
    updateNodeData(id, { rules: [...nodeData.rules, newRule] });
  }, [id, nodeData.rules, updateNodeData]);

  // Clear evaluation state — pauses re-evaluation, resets all matches, un-dims downstream
  const handleClear = useCallback(() => {
    const clearedRules = nodeData.rules.map(rule => ({
      ...rule,
      isMatched: false,
    }));
    updateNodeData(id, {
      evaluationPaused: true,
      incomingText: null,
      rules: clearedRules,
    });
  }, [id, nodeData.rules, updateNodeData]);

  // Show clear button when there's evaluation state to clear and not already paused
  const showClearButton = !nodeData.evaluationPaused && nodeData.incomingText !== null;

  // Handle reorder (move up)
  const handleMoveUp = useCallback(
    (index: number) => {
      if (index === 0) return;
      const updatedRules = [...nodeData.rules];
      [updatedRules[index - 1], updatedRules[index]] = [updatedRules[index], updatedRules[index - 1]];
      updateNodeData(id, { rules: updatedRules });
    },
    [id, nodeData.rules, updateNodeData]
  );

  // Handle reorder (move down)
  const handleMoveDown = useCallback(
    (index: number) => {
      if (index === nodeData.rules.length - 1) return;
      const updatedRules = [...nodeData.rules];
      [updatedRules[index + 1], updatedRules[index]] = [updatedRules[index], updatedRules[index + 1]];
      updateNodeData(id, { rules: updatedRules });
    },
    [id, nodeData.rules, updateNodeData]
  );

  // Check if default is matched (no rules matched) — suppress when paused
  const defaultMatched = !nodeData.evaluationPaused && !nodeData.rules.some(r => r.isMatched);

  return (
    <BaseNode
      id={id}
      selected={selected}
      minWidth={260}
      minHeight={minHeight}
      className="bg-teal-950/80 border-teal-600"
    >
      {/* Clear button - floating absolute positioned */}
      {showClearButton && (
        <div className="absolute top-2 right-2 z-10">
          <button
            onClick={handleClear}
            className="nodrag nopan p-0.5 rounded transition-all duration-200 ease-in-out flex items-center overflow-hidden group pr-2 text-neutral-500 hover:text-neutral-200 border border-neutral-600 bg-neutral-800/90"
            title="Clear evaluation"
          >
            <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            <span className="text-[9px] whitespace-nowrap ml-1">
              Clear
            </span>
          </button>
        </div>
      )}

      {/* Input handle (left) - text only, aligned with header */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        data-handletype="text"
        style={{
          top: 38,
          backgroundColor: "#3b82f6", // blue for text
          width: 12,
          height: 12,
          border: "2px solid #1e1e1e",
        }}
      />

      {/* Body content */}
      <div className="px-2 py-1">
        {/* Text preview — fixed height, above the handle-aligned area */}
        <div className="text-[10px] text-neutral-400 truncate h-5 flex items-center">
          {nodeData.evaluationPaused ? (
            <span className="text-yellow-400">Evaluation paused</span>
          ) : incomingText ? (
            <>Input: &quot;{incomingText.slice(0, 50)}{incomingText.length > 50 ? "..." : ""}&quot;</>
          ) : (
            "No input connected"
          )}
        </div>

        {/* Rule rows — each 32px tall to align with output handles */}
        {nodeData.rules.map((rule, index) => (
          <div
            key={rule.id}
            ref={(el) => {
              if (el) ruleRowRefs.current[rule.id] = el;
              else delete ruleRowRefs.current[rule.id];
            }}
            className="flex items-center gap-1 group h-8"
          >
            {/* Match status indicator */}
            <div className="w-3 h-3 flex items-center justify-center flex-shrink-0">
              {rule.isMatched ? (
                <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <div className="w-2 h-2 rounded-full bg-neutral-600" />
              )}
            </div>

            {/* Reorder buttons */}
            <div className="flex flex-col gap-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                className="text-neutral-400 hover:text-white disabled:opacity-30 disabled:hover:text-neutral-400"
                onClick={() => handleMoveUp(index)}
                disabled={index === 0}
                title="Move up"
              >
                <svg className="w-2 h-2" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 14l5-5 5 5z" />
                </svg>
              </button>
              <button
                className="text-neutral-400 hover:text-white disabled:opacity-30 disabled:hover:text-neutral-400"
                onClick={() => handleMoveDown(index)}
                disabled={index === nodeData.rules.length - 1}
                title="Move down"
              >
                <svg className="w-2 h-2" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M7 10l5 5 5-5z" />
                </svg>
              </button>
            </div>

            {/* Label */}
            {editingId === rule.id ? (
              <input
                type="text"
                className="w-14 bg-neutral-700 text-neutral-100 text-[10px] px-1 py-0.5 rounded border border-teal-500 outline-none"
                defaultValue={rule.label}
                autoFocus
                onBlur={(e) => handleLabelEdit(rule.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleLabelEdit(rule.id, e.currentTarget.value);
                  } else if (e.key === "Escape") {
                    setEditingId(null);
                  }
                }}
              />
            ) : (
              <span
                className="w-14 text-[10px] text-neutral-300 cursor-text truncate"
                onDoubleClick={() => setEditingId(rule.id)}
                title={rule.label}
              >
                {rule.label}
              </span>
            )}

            {/* Mode dropdown */}
            <select
              className="bg-neutral-700 text-neutral-100 text-[9px] px-1 py-0.5 rounded border border-neutral-600 outline-none"
              value={rule.mode}
              onChange={(e) => handleModeChange(rule.id, e.target.value as MatchMode)}
            >
              <option value="exact">exact</option>
              <option value="contains">contains</option>
              <option value="starts-with">starts</option>
              <option value="ends-with">ends</option>
            </select>

            {/* Value input */}
            <input
              type="text"
              className="flex-1 bg-neutral-700 text-neutral-100 text-[10px] px-1 py-0.5 rounded border border-neutral-600 outline-none"
              placeholder="value,value2,..."
              value={rule.value}
              onChange={(e) => handleRuleValueChange(rule.id, e.target.value)}
            />

            {/* Delete button (hidden if only one rule) */}
            {nodeData.rules.length > 1 && (
              <button
                className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-400 transition-opacity flex-shrink-0"
                onClick={() => handleDelete(rule.id)}
                title="Delete rule"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        ))}

        {/* Default output row — 32px tall, immediately after rules to align with handle */}
        <div ref={defaultRowRef} className="flex items-center gap-1 h-8 border-t border-neutral-700">
          <div className="w-3 h-3 flex items-center justify-center flex-shrink-0">
            {defaultMatched ? (
              <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <div className="w-2 h-2 rounded-full bg-neutral-600" />
            )}
          </div>

          <span className="text-[10px] text-neutral-300 ml-4">Fallback</span>
        </div>

        {/* Add rule button — after Default so it doesn't displace handle alignment */}
        <button
          className="w-full flex items-center justify-center gap-1 text-neutral-400 hover:text-white text-[10px] py-1 mt-1 rounded hover:bg-teal-900/30 transition-colors"
          onClick={handleAddRule}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Rule
        </button>
      </div>

      {/* Output handles (right) - one per rule + default */}
      {nodeData.rules.map((rule, index) => (
        <Handle
          key={`output-${rule.id}`}
          type="source"
          position={Position.Right}
          id={rule.id}
          data-handletype="text"
          style={{
            top: handleTops[rule.id] ?? (fallbackBase + index * handleSpacing),
            backgroundColor: "#3b82f6", // blue for text
            width: 12,
            height: 12,
            border: "2px solid #1e1e1e",
          }}
        />
      ))}

      {/* Default output handle (always at bottom) */}
      <Handle
        type="source"
        position={Position.Right}
        id="default"
        data-handletype="text"
        style={{
          top: handleTops['default'] ?? (fallbackBase + ruleCount * handleSpacing),
          backgroundColor: "#3b82f6", // blue for text
          width: 12,
          height: 12,
          border: "2px solid #1e1e1e",
        }}
      />
    </BaseNode>
  );
});

ConditionalSwitchNode.displayName = "ConditionalSwitchNode";
