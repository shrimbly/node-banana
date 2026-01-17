"use client";

import { useCallback, useMemo, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import {
  ConditionalBranchNodeData,
  ImagePropertyType,
  ConditionOperator,
  BranchCondition,
  ConditionGroup,
} from "@/types";

type ConditionalBranchNodeType = Node<ConditionalBranchNodeData, "conditionalBranch">;

const PROPERTY_OPTIONS: { value: ImagePropertyType; label: string }[] = [
  { value: "width", label: "Width" },
  { value: "height", label: "Height" },
  { value: "aspect_ratio", label: "Aspect Ratio" },
  { value: "brightness", label: "Brightness" },
  { value: "dominant_color", label: "Dominant Color" },
  { value: "is_grayscale", label: "Is Grayscale" },
  { value: "has_transparency", label: "Has Transparency" },
];

const OPERATOR_OPTIONS: { value: ConditionOperator; label: string }[] = [
  { value: "equals", label: "=" },
  { value: "not_equals", label: "≠" },
  { value: "greater_than", label: ">" },
  { value: "less_than", label: "<" },
  { value: "greater_or_equal", label: "≥" },
  { value: "less_or_equal", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
];

// Returns appropriate operators based on property type
function getOperatorsForProperty(property: ImagePropertyType): ConditionOperator[] {
  switch (property) {
    case "width":
    case "height":
    case "aspect_ratio":
    case "brightness":
      return ["equals", "not_equals", "greater_than", "less_than", "greater_or_equal", "less_or_equal"];
    case "dominant_color":
      return ["equals", "not_equals", "contains", "not_contains"];
    case "is_grayscale":
    case "has_transparency":
      return ["equals", "not_equals"];
    default:
      return ["equals", "not_equals"];
  }
}

// Returns input type for property value
function getInputTypeForProperty(property: ImagePropertyType): "number" | "text" | "boolean" {
  switch (property) {
    case "width":
    case "height":
    case "brightness":
      return "number";
    case "aspect_ratio":
      return "number";
    case "dominant_color":
      return "text";
    case "is_grayscale":
    case "has_transparency":
      return "boolean";
    default:
      return "text";
  }
}

export function ConditionalBranchNode({
  id,
  data,
  selected,
}: NodeProps<ConditionalBranchNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Toggle group expansion
  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  // Add a new condition group
  const addConditionGroup = useCallback(() => {
    const newGroup: ConditionGroup = {
      id: crypto.randomUUID(),
      logic: "AND",
      conditions: [
        {
          id: crypto.randomUUID(),
          property: "width",
          operator: "greater_than",
          value: 512,
        },
      ],
    };
    updateNodeData(id, {
      conditionGroups: [...nodeData.conditionGroups, newGroup],
    });
    setExpandedGroups((prev) => new Set([...prev, newGroup.id]));
  }, [id, nodeData.conditionGroups, updateNodeData]);

  // Remove a condition group
  const removeConditionGroup = useCallback(
    (groupId: string) => {
      if (nodeData.conditionGroups.length <= 1) return;
      updateNodeData(id, {
        conditionGroups: nodeData.conditionGroups.filter((g) => g.id !== groupId),
      });
    },
    [id, nodeData.conditionGroups, updateNodeData]
  );

  // Update group logic (AND/OR)
  const updateGroupLogic = useCallback(
    (groupId: string, logic: "AND" | "OR") => {
      updateNodeData(id, {
        conditionGroups: nodeData.conditionGroups.map((g) =>
          g.id === groupId ? { ...g, logic } : g
        ),
      });
    },
    [id, nodeData.conditionGroups, updateNodeData]
  );

  // Add a condition to a group
  const addCondition = useCallback(
    (groupId: string) => {
      const newCondition: BranchCondition = {
        id: crypto.randomUUID(),
        property: "width",
        operator: "greater_than",
        value: 512,
      };
      updateNodeData(id, {
        conditionGroups: nodeData.conditionGroups.map((g) =>
          g.id === groupId
            ? { ...g, conditions: [...g.conditions, newCondition] }
            : g
        ),
      });
    },
    [id, nodeData.conditionGroups, updateNodeData]
  );

  // Remove a condition from a group
  const removeCondition = useCallback(
    (groupId: string, conditionId: string) => {
      updateNodeData(id, {
        conditionGroups: nodeData.conditionGroups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                conditions: g.conditions.filter((c) => c.id !== conditionId),
              }
            : g
        ),
      });
    },
    [id, nodeData.conditionGroups, updateNodeData]
  );

  // Update a condition
  const updateCondition = useCallback(
    (
      groupId: string,
      conditionId: string,
      updates: Partial<BranchCondition>
    ) => {
      updateNodeData(id, {
        conditionGroups: nodeData.conditionGroups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                conditions: g.conditions.map((c) =>
                  c.id === conditionId ? { ...c, ...updates } : c
                ),
              }
            : g
        ),
      });
    },
    [id, nodeData.conditionGroups, updateNodeData]
  );

  // Update group logic between groups
  const updateGroupsLogic = useCallback(
    (logic: "AND" | "OR") => {
      updateNodeData(id, { groupLogic: logic });
    },
    [id, updateNodeData]
  );

  // Status indicator
  const statusDisplay = useMemo(() => {
    if (nodeData.status === "loading") {
      return (
        <div className="flex items-center gap-1 text-blue-400">
          <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-[9px]">Analyzing...</span>
        </div>
      );
    }

    if (nodeData.status === "error") {
      return (
        <div className="flex items-center gap-1 text-red-400">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[9px]">{nodeData.error || "Error"}</span>
        </div>
      );
    }

    if (nodeData.lastEvaluationResult !== null) {
      return (
        <div className={`flex items-center gap-1 ${nodeData.lastEvaluationResult ? "text-green-400" : "text-amber-400"}`}>
          {nodeData.lastEvaluationResult ? (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          )}
          <span className="text-[9px]">
            {nodeData.lastEvaluationResult ? "TRUE → Image passed" : "FALSE → Image blocked"}
          </span>
        </div>
      );
    }

    return (
      <span className="text-[9px] text-neutral-500">
        Connect image to evaluate
      </span>
    );
  }, [nodeData.status, nodeData.error, nodeData.lastEvaluationResult]);

  return (
    <BaseNode
      id={id}
      title="Conditional Branch"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) =>
        updateNodeData(id, { customTitle: title || undefined })
      }
      onCommentChange={(comment) =>
        updateNodeData(id, { comment: comment || undefined })
      }
      selected={selected}
      hasError={nodeData.status === "error"}
      minWidth={360}
      minHeight={200}
    >
      {/* Image input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
      />

      {/* TRUE output handle (top right) */}
      <Handle
        type="source"
        position={Position.Right}
        id="image-true"
        style={{ top: "30%" }}
        data-handletype="image"
        title="True branch"
      />

      {/* FALSE output handle (bottom right) */}
      <Handle
        type="source"
        position={Position.Right}
        id="image-false"
        style={{ top: "70%" }}
        data-handletype="image"
        title="False branch"
      />

      <div className="flex-1 flex flex-col min-h-0 gap-2 overflow-hidden">
        {/* Status display */}
        <div className="flex items-center justify-between shrink-0">
          {statusDisplay}
          <div className="flex items-center gap-1">
            <span className="text-[9px] text-neutral-500">Groups:</span>
            <select
              value={nodeData.groupLogic}
              onChange={(e) => updateGroupsLogic(e.target.value as "AND" | "OR")}
              className="text-[9px] py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 text-neutral-300"
            >
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          </div>
        </div>

        {/* Handle labels */}
        <div className="flex justify-end gap-4 text-[8px] text-neutral-500 shrink-0 pr-1">
          <span className="text-green-500">→ TRUE</span>
          <span className="text-amber-500">→ FALSE</span>
        </div>

        {/* Condition groups */}
        <div className="nodrag nopan nowheel flex-1 overflow-auto min-h-0 space-y-2 pr-1">
          {nodeData.conditionGroups.map((group, groupIndex) => (
            <div
              key={group.id}
              className="border border-neutral-700 rounded p-2 bg-neutral-900/30"
            >
              {/* Group header */}
              <div className="flex items-center justify-between mb-2">
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="flex items-center gap-1 text-[10px] text-neutral-300 hover:text-white"
                >
                  <svg
                    className={`w-3 h-3 transition-transform ${
                      expandedGroups.has(group.id) ? "rotate-90" : ""
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 5l7 7-7 7"
                    />
                  </svg>
                  Group {groupIndex + 1}
                </button>

                <div className="flex items-center gap-2">
                  {/* Group internal logic */}
                  <select
                    value={group.logic}
                    onChange={(e) =>
                      updateGroupLogic(group.id, e.target.value as "AND" | "OR")
                    }
                    className="text-[9px] py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 text-neutral-300"
                  >
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>

                  {/* Add condition button */}
                  <button
                    onClick={() => addCondition(group.id)}
                    className="p-0.5 text-neutral-500 hover:text-green-400"
                    title="Add condition"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                  </button>

                  {/* Remove group button */}
                  {nodeData.conditionGroups.length > 1 && (
                    <button
                      onClick={() => removeConditionGroup(group.id)}
                      className="p-0.5 text-neutral-500 hover:text-red-400"
                      title="Remove group"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Conditions list (collapsible) */}
              {expandedGroups.has(group.id) && (
                <div className="space-y-1.5">
                  {group.conditions.map((condition, condIndex) => {
                    const validOperators = getOperatorsForProperty(condition.property);
                    const inputType = getInputTypeForProperty(condition.property);

                    return (
                      <div
                        key={condition.id}
                        className="flex items-center gap-1 text-[9px]"
                      >
                        {condIndex > 0 && (
                          <span className="text-neutral-500 w-6 text-center">
                            {group.logic}
                          </span>
                        )}

                        {/* Property selector */}
                        <select
                          value={condition.property}
                          onChange={(e) => {
                            const newProperty = e.target.value as ImagePropertyType;
                            const newOperators = getOperatorsForProperty(newProperty);
                            const newOperator = newOperators.includes(condition.operator)
                              ? condition.operator
                              : newOperators[0];
                            const defaultValue = getInputTypeForProperty(newProperty) === "boolean" ? true : "";
                            updateCondition(group.id, condition.id, {
                              property: newProperty,
                              operator: newOperator,
                              value: defaultValue,
                            });
                          }}
                          className="flex-1 min-w-0 py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 text-neutral-300"
                        >
                          {PROPERTY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>

                        {/* Operator selector */}
                        <select
                          value={condition.operator}
                          onChange={(e) =>
                            updateCondition(group.id, condition.id, {
                              operator: e.target.value as ConditionOperator,
                            })
                          }
                          className="w-14 py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 text-neutral-300"
                        >
                          {OPERATOR_OPTIONS.filter((opt) =>
                            validOperators.includes(opt.value)
                          ).map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>

                        {/* Value input */}
                        {inputType === "boolean" ? (
                          <select
                            value={condition.value === true ? "true" : "false"}
                            onChange={(e) =>
                              updateCondition(group.id, condition.id, {
                                value: e.target.value === "true",
                              })
                            }
                            className="w-14 py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 text-neutral-300"
                          >
                            <option value="true">Yes</option>
                            <option value="false">No</option>
                          </select>
                        ) : inputType === "number" ? (
                          <input
                            type="number"
                            value={condition.value as number}
                            onChange={(e) =>
                              updateCondition(group.id, condition.id, {
                                value: parseFloat(e.target.value) || 0,
                              })
                            }
                            className="w-16 py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 text-neutral-300"
                          />
                        ) : (
                          <input
                            type="text"
                            value={condition.value as string}
                            onChange={(e) =>
                              updateCondition(group.id, condition.id, {
                                value: e.target.value,
                              })
                            }
                            placeholder={condition.property === "dominant_color" ? "red, #ff0000" : "value"}
                            className="w-20 py-0.5 px-1 border border-neutral-700 rounded bg-neutral-900/50 text-neutral-300 placeholder:text-neutral-600"
                          />
                        )}

                        {/* Remove condition button */}
                        {group.conditions.length > 1 && (
                          <button
                            onClick={() => removeCondition(group.id, condition.id)}
                            className="p-0.5 text-neutral-500 hover:text-red-400"
                            title="Remove condition"
                          >
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Collapsed summary */}
              {!expandedGroups.has(group.id) && (
                <div className="text-[9px] text-neutral-500">
                  {group.conditions.length} condition{group.conditions.length > 1 ? "s" : ""}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Add group button */}
        <button
          onClick={addConditionGroup}
          className="shrink-0 w-full py-1 text-[10px] text-neutral-500 hover:text-neutral-300 border border-dashed border-neutral-700 hover:border-neutral-500 rounded transition-colors"
        >
          + Add Condition Group
        </button>

        {/* Analysis results preview (when available) */}
        {nodeData.analysisResults && (
          <div className="shrink-0 mt-1 p-1.5 bg-neutral-900/50 rounded border border-neutral-700">
            <div className="text-[8px] text-neutral-500 mb-1">Image Analysis:</div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[8px]">
              <span className="text-neutral-400">Size:</span>
              <span className="text-neutral-300">
                {nodeData.analysisResults.width}×{nodeData.analysisResults.height}
              </span>
              <span className="text-neutral-400">Brightness:</span>
              <span className="text-neutral-300">{nodeData.analysisResults.brightness}%</span>
              <span className="text-neutral-400">Color:</span>
              <span className="text-neutral-300 flex items-center gap-1">
                <span
                  className="inline-block w-2 h-2 rounded-sm"
                  style={{ backgroundColor: nodeData.analysisResults.dominant_color as string }}
                />
                {nodeData.analysisResults.dominant_color}
              </span>
            </div>
          </div>
        )}
      </div>
    </BaseNode>
  );
}
