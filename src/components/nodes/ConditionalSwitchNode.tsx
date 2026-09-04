"use client";

import { memo, useMemo, useEffect, useState, useCallback } from "react";
import { useReactFlow, NodeProps } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { useWorkflowStore } from "@/store/workflowStore";
import { evaluateRule } from "@/store/utils/ruleEvaluation";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import type { WorkflowNode, ConditionalSwitchNodeData, ConditionalSwitchRule, MatchMode } from "@/types";
import { LogicRow, LogicRows, SelectWell, ellipsisClass, type SocketSpec } from "./ui";

const INPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Text" }];

const MODE_OPTIONS = [
  { value: "exact", label: "exact" },
  { value: "contains", label: "contains" },
  { value: "starts-with", label: "starts" },
  { value: "ends-with", label: "ends" },
];

/**
 * Routes text by rule. Row 0 shows the incoming text (the input socket sits
 * there); every rule is a row with its own output socket, and the fallback
 * row carries the `default` socket.
 */
export const ConditionalSwitchNode = memo(({ id, data, selected }: NodeProps<WorkflowNode>) => {
  const nodeData = data as ConditionalSwitchNodeData;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const { setEdges } = useReactFlow();
  const [editingId, setEditingId] = useState<string | null>(null);

  // Get incoming text via store selector so it recomputes when upstream node data changes
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

  const handleRuleValueChange = useCallback(
    (ruleId: string, newValue: string) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, value: newValue } : rule
      );
      updateNodeData(id, { rules: updatedRules, evaluationPaused: false });
    },
    [id, nodeData.rules, updateNodeData]
  );

  const handleModeChange = useCallback(
    (ruleId: string, newMode: MatchMode) => {
      const updatedRules = nodeData.rules.map((rule) =>
        rule.id === ruleId ? { ...rule, mode: newMode } : rule
      );
      updateNodeData(id, { rules: updatedRules, evaluationPaused: false });
    },
    [id, nodeData.rules, updateNodeData]
  );

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

  const handleDelete = useCallback(
    (ruleId: string) => {
      if (nodeData.rules.length <= 1) return;
      const updatedRules = nodeData.rules.filter((rule) => rule.id !== ruleId);
      updateNodeData(id, { rules: updatedRules });
      setEdges((edges) => edges.filter((e) => !(e.source === id && e.sourceHandle === ruleId)));
    },
    [id, nodeData.rules, updateNodeData, setEdges]
  );

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
    const clearedRules = nodeData.rules.map(rule => ({ ...rule, isMatched: false }));
    updateNodeData(id, { evaluationPaused: true, incomingText: null, rules: clearedRules });
  }, [id, nodeData.rules, updateNodeData]);

  const showClearButton = !nodeData.evaluationPaused && nodeData.incomingText !== null;

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index === 0) return;
      const updatedRules = [...nodeData.rules];
      [updatedRules[index - 1], updatedRules[index]] = [updatedRules[index], updatedRules[index - 1]];
      updateNodeData(id, { rules: updatedRules });
    },
    [id, nodeData.rules, updateNodeData]
  );

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index === nodeData.rules.length - 1) return;
      const updatedRules = [...nodeData.rules];
      [updatedRules[index + 1], updatedRules[index]] = [updatedRules[index], updatedRules[index + 1]];
      updateNodeData(id, { rules: updatedRules });
    },
    [id, nodeData.rules, updateNodeData]
  );

  const defaultMatched = !nodeData.evaluationPaused && !nodeData.rules.some(r => r.isMatched);

  // Output sockets: rules on rows 1..n, then the fallback.
  const outputs = useMemo<SocketSpec[]>(
    () => [
      ...nodeData.rules.map((rule, i) => ({ id: rule.id, type: "text" as const, label: rule.label, row: i + 1 })),
      { id: "default", type: "text" as const, label: "Fallback", row: nodeData.rules.length + 1 },
    ],
    [nodeData.rules]
  );

  const Match = ({ on }: { on: boolean }) => (
    <div className="w-3 h-3 flex items-center justify-center shrink-0">
      {on ? (
        <svg className="w-3 h-3 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <div className="w-2 h-2 rounded-full bg-neutral-600" />
      )}
    </div>
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      media={{ kind: "auto" }}
      inputs={INPUT_SOCKETS}
      outputs={outputs}
      minWidth={280}
      cardClassName="rounded-controls"
    >
      <LogicRows>
        {/* Row 0: incoming text, where the input socket lands */}
        <LogicRow className="justify-between">
          <span className={`text-node text-neutral-400 min-w-0 ${ellipsisClass}`}>
            {nodeData.evaluationPaused ? (
              <span className="text-yellow-400">Evaluation paused</span>
            ) : incomingText ? (
              <>Input: &quot;{incomingText.slice(0, 50)}{incomingText.length > 50 ? "..." : ""}&quot;</>
            ) : (
              "No input connected"
            )}
          </span>
          {showClearButton && (
            <button
              onClick={handleClear}
              className="nodrag nopan shrink-0 h-[18px] px-1.5 rounded-[6px] squircle text-[9px] text-neutral-400 hover:text-neutral-100 bg-well shadow-well transition-colors"
              title="Clear evaluation"
            >
              Clear
            </button>
          )}
        </LogicRow>

        {nodeData.rules.map((rule, index) => (
          <LogicRow key={rule.id} className="group gap-1">
            <Match on={rule.isMatched} />
            <div className="flex flex-col w-3 h-[26px] opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
              <button
                className="nodrag nopan flex-1 flex items-center justify-center rounded-[3px] text-neutral-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:text-neutral-400 disabled:hover:bg-transparent"
                onClick={() => handleMoveUp(index)}
                disabled={index === 0}
                title="Move up"
                aria-label="Move rule up"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden><path d="M6 15l6-6 6 6" /></svg>
              </button>
              <button
                className="nodrag nopan flex-1 flex items-center justify-center rounded-[3px] text-neutral-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:text-neutral-400 disabled:hover:bg-transparent"
                onClick={() => handleMoveDown(index)}
                disabled={index === nodeData.rules.length - 1}
                title="Move down"
                aria-label="Move rule down"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
              </button>
            </div>

            {editingId === rule.id ? (
              <input
                type="text"
                className="nodrag nopan w-14 h-[22px] bg-well rounded-well squircle shadow-well text-neutral-100 text-node px-[7px] outline-none focus:ring-1 focus:ring-teal-500"
                defaultValue={rule.label}
                autoFocus
                onBlur={(e) => handleLabelEdit(rule.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleLabelEdit(rule.id, e.currentTarget.value);
                  else if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <span
                className="w-14 text-node text-neutral-300 cursor-text truncate shrink-0"
                onDoubleClick={() => setEditingId(rule.id)}
                title={rule.label}
              >
                {rule.label}
              </span>
            )}

            <SelectWell
              className="w-[74px] shrink-0"
              value={rule.mode}
              options={MODE_OPTIONS}
              onChange={(v) => handleModeChange(rule.id, v as MatchMode)}
            />

            <input
              type="text"
              className="nodrag nopan flex-1 min-w-0 h-[22px] bg-well rounded-well squircle shadow-well text-neutral-100 text-node px-[7px] outline-none focus:ring-1 focus:ring-neutral-600 placeholder:text-neutral-500"
              placeholder="value,value2,..."
              value={rule.value}
              onChange={(e) => handleRuleValueChange(rule.id, e.target.value)}
            />

            {nodeData.rules.length > 1 && (
              <button
                className="nodrag nopan opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-400 transition-opacity shrink-0"
                onClick={() => handleDelete(rule.id)}
                title="Delete rule"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </LogicRow>
        ))}

        <LogicRow className="border-t border-neutral-700/60 gap-1">
          <Match on={defaultMatched} />
          {/* Same leading space as a rule row's reorder column, so the labels line up. */}
          <span className="w-3 shrink-0" aria-hidden />
          <span className="text-node text-neutral-300">Fallback</span>
        </LogicRow>

        <div className="px-2 pt-1">
          <button
            className="nodrag nopan w-full h-[22px] flex items-center justify-center gap-1 text-neutral-400 hover:text-white text-node rounded-well squircle hover:bg-white/5 transition-colors"
            onClick={handleAddRule}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Rule
          </button>
        </div>
      </LogicRows>
    </NodeShell>
  );
});

ConditionalSwitchNode.displayName = "ConditionalSwitchNode";
