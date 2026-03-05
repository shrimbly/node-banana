"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Handle, Node, NodeProps, Position, useReactFlow } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { ArrayNodeData } from "@/types";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { parseTextToArray } from "@/utils/arrayParser";

type ArrayNodeType = Node<ArrayNodeData, "array">;

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function ArrayNode({ id, data, selected }: NodeProps<ArrayNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const onConnect = useWorkflowStore((state) => state.onConnect);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const { setNodes, getNodes } = useReactFlow();
  const lastSyncedInputRef = useRef<string | null>(null);
  const lastDerivedWriteRef = useRef<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const hasIncomingTextConnection = useMemo(
    () =>
      edges.some((edge) => {
        if (edge.target !== id) return false;
        const handle = edge.targetHandle || "text";
        return handle === "text" || handle.startsWith("text-") || handle.includes("prompt");
      }),
    [edges, id]
  );

  const connectedText = useMemo(() => {
    if (!hasIncomingTextConnection) return null;
    return getConnectedInputsPure(id, nodes, edges).text;
  }, [edges, hasIncomingTextConnection, id, nodes]);

  // Pull upstream text into this node whenever the connected input changes.
  useEffect(() => {
    if (!hasIncomingTextConnection) {
      // Array node has no manual input field; clear stale upstream text on disconnect.
      if (nodeData.inputText !== null && nodeData.inputText !== "") {
        lastSyncedInputRef.current = null;
        updateNodeData(id, { inputText: null });
      }
      return;
    }
    const text = connectedText;
    if (
      text !== null &&
      text !== nodeData.inputText &&
      text !== lastSyncedInputRef.current
    ) {
      lastSyncedInputRef.current = text;
      updateNodeData(id, { inputText: text });
    }
  }, [connectedText, hasIncomingTextConnection, id, nodeData.inputText, updateNodeData]);

  const parsed = useMemo(() => {
    return parseTextToArray(nodeData.inputText, {
      splitMode: nodeData.splitMode,
      delimiter: nodeData.delimiter,
      regexPattern: nodeData.regexPattern,
      trimItems: nodeData.trimItems,
      removeEmpty: nodeData.removeEmpty,
    });
  }, [
    nodeData.inputText,
    nodeData.splitMode,
    nodeData.delimiter,
    nodeData.regexPattern,
    nodeData.trimItems,
    nodeData.removeEmpty,
  ]);

  // Keep derived outputs in node data so execution/edges always read the latest values.
  useEffect(() => {
    const nextOutputText = JSON.stringify(parsed.items);
    const writeSignature = `${parsed.error ?? ""}::${nextOutputText}`;
    const needsSync =
      parsed.error !== nodeData.error ||
      nextOutputText !== (nodeData.outputText ?? "[]") ||
      !arraysEqual(parsed.items, nodeData.outputItems || []);

    if (!needsSync) return;
    if (lastDerivedWriteRef.current === writeSignature) return;
    lastDerivedWriteRef.current = writeSignature;

    updateNodeData(id, {
      outputItems: parsed.items,
      outputText: nextOutputText,
      error: parsed.error,
    });
  }, [id, nodeData.error, nodeData.outputItems, nodeData.outputText, parsed.error, parsed.items, updateNodeData]);

  const handleBasicModeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      updateNodeData(id, { splitMode: e.target.value as ArrayNodeData["splitMode"] });
    },
    [id, updateNodeData]
  );

  const previewItems = parsed.items;

  const handleAutoRouteToPrompts = useCallback(() => {
    const items = previewItems;
    if (items.length === 0) return;

    const sourceNode = getNodes().find((n) => n.id === id);
    if (!sourceNode) return;

    const sourceWidth = (sourceNode.style?.width as number) || 360;
    const baseX = sourceNode.position.x + sourceWidth + 220;
    const baseY = sourceNode.position.y;
    const promptHeight = 220;
    const verticalGap = 24;

    items.forEach((item, index) => {
      const promptNodeId = addNode(
        "prompt",
        { x: baseX, y: baseY + index * (promptHeight + verticalGap) },
        { prompt: item }
      );

      // Pass the array item index directly as an edge data override
      // instead of mutating selectedOutputIndex in a loop.
      onConnect(
        {
          source: id,
          sourceHandle: "text",
          target: promptNodeId,
          targetHandle: "text",
        },
        { arrayItemIndex: index }
      );
    });
  }, [addNode, getNodes, id, onConnect, previewItems]);

  // Reset selection if it no longer points to a valid parsed item.
  useEffect(() => {
    const currentSelection = nodeData.selectedOutputIndex;
    if (currentSelection !== null && (currentSelection < 0 || currentSelection >= previewItems.length)) {
      updateNodeData(id, { selectedOutputIndex: null });
    }
  }, [id, nodeData.selectedOutputIndex, previewItems.length, updateNodeData]);

  // Auto-resize node height to fit all parsed lines so users don't need to scroll.
  useEffect(() => {
    const baseHeight = 360;
    const perItemHeight = 30;
    const newHeight = Math.max(baseHeight, 270 + previewItems.length * perItemHeight);

    setNodes((nodes) =>
      nodes.map((node) => {
        if (node.id !== id) return node;
        if ((node.style?.height as number) === newHeight) return node;
        return { ...node, style: { ...node.style, height: newHeight } };
      })
    );
  }, [id, previewItems.length, setNodes]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      hasError={!!nodeData.error}
      minWidth={320}
      minHeight={300}
    >
      <Handle type="target" position={Position.Left} id="text" data-handletype="text" />

      {/* Single text output point (each outgoing edge receives a separate item) */}
      <Handle type="source" position={Position.Right} id="text" data-handletype="text" style={{ top: 48 }} />

      {/* Auto-route button - floating absolute positioned */}
      <button
        type="button"
        onClick={handleAutoRouteToPrompts}
        disabled={previewItems.length === 0}
        className="nodrag nopan absolute top-2 right-2 z-10 shrink-0 p-1 rounded border border-neutral-600 bg-neutral-800/90 text-neutral-300 hover:bg-neutral-700 hover:text-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Auto-route to Prompts"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 3v6m0 0a2 2 0 104 0 2 2 0 00-4 0zm0 0v7a3 3 0 003 3h6m0 0a2 2 0 100 4 2 2 0 000-4zm0 0v-6a3 3 0 013-3h0" />
        </svg>
      </button>

      <div className="flex flex-col gap-2 flex-1 min-h-0">
        <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
          <label className="text-[11px] text-neutral-400">Split</label>
          <select
            value={nodeData.splitMode}
            onChange={handleBasicModeChange}
            className="nodrag nopan bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-600"
          >
            <option value="delimiter">Delimiter</option>
            <option value="newline">Newline</option>
            <option value="regex">Regex (Advanced)</option>
          </select>
        </div>

        {nodeData.splitMode === "delimiter" && (
          <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
            <label className="text-[11px] text-neutral-400">By</label>
            <input
              value={nodeData.delimiter}
              onChange={(e) => updateNodeData(id, { delimiter: e.target.value })}
              placeholder="*"
              className="nodrag nopan bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-600"
            />
          </div>
        )}

        {nodeData.splitMode === "regex" && (
          <div className="grid grid-cols-[auto_1fr] gap-2 items-center">
            <label className="text-[11px] text-neutral-400">By</label>
            <input
              value={nodeData.regexPattern}
              onChange={(e) => updateNodeData(id, { regexPattern: e.target.value })}
              placeholder="/\\n+/"
              className="nodrag nopan bg-neutral-900 border border-neutral-700 rounded px-2 py-1 text-[11px] text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-600"
            />
          </div>
        )}

        <div className="border border-neutral-700 rounded">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="nodrag nopan w-full flex items-center justify-between px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800/50"
          >
            <span>Advanced</span>
            <span className="text-[10px] text-neutral-500">{showAdvanced ? "Hide" : "Show"}</span>
          </button>

          {showAdvanced && (
            <div className="px-2 pb-2 pt-1 flex flex-col gap-2 border-t border-neutral-700">
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                  <input
                    type="checkbox"
                    checked={nodeData.trimItems}
                    onChange={(e) => updateNodeData(id, { trimItems: e.target.checked })}
                    className="nodrag nopan w-3 h-3"
                  />
                  Trim
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-neutral-300">
                  <input
                    type="checkbox"
                    checked={nodeData.removeEmpty}
                    onChange={(e) => updateNodeData(id, { removeEmpty: e.target.checked })}
                    className="nodrag nopan w-3 h-3"
                  />
                  Remove empty
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="text-[10px] uppercase tracking-wide text-neutral-500">
          Parsed Items ({previewItems.length})
        </div>
        <div className="relative flex-1 min-h-[90px] border border-neutral-700 rounded bg-neutral-900/40">
          {nodeData.error ? (
            <div className="p-2 text-[11px] text-red-400">{nodeData.error}</div>
          ) : previewItems.length === 0 ? (
            <div className="p-2 text-[11px] text-neutral-500">No items parsed</div>
          ) : (
            <div className="py-1">
              {previewItems.map((item, index) => {
                const isSelected = nodeData.selectedOutputIndex === index;
                return (
                  <div key={`${index}-${item}`} className="relative pr-8">
                    <button
                      type="button"
                      onClick={() =>
                        updateNodeData(id, {
                          selectedOutputIndex: isSelected ? null : index,
                        })
                      }
                      className={`nodrag nopan w-[calc(100%-1rem)] mx-2 my-1 rounded border px-2 py-1 text-[11px] text-left truncate transition-colors ${
                        isSelected
                          ? "border-blue-500 bg-blue-900/40 text-blue-200"
                          : "border-neutral-700 bg-neutral-900/80 text-neutral-200 hover:bg-neutral-800"
                      }`}
                      title={isSelected ? "Selected for next connection (click to unselect)" : "Click to select for next connection"}
                    >
                      {index + 1}. {item}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="text-[10px] text-neutral-500">
          {nodeData.selectedOutputIndex !== null
            ? `Next wire uses item ${nodeData.selectedOutputIndex + 1}`
            : "No selection: wires advance in order from item 1"}
        </div>
      </div>
    </BaseNode>
  );
}
