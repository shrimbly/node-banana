"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Node, NodeProps, useReactFlow } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { CheckboxField, Field, LogicRow, LogicRows, SelectWell, TextField, type SocketSpec } from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { ArrayNodeData } from "@/types";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { parseTextToArray } from "@/utils/arrayParser";

type ArrayNodeType = Node<ArrayNodeData, "array">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Text" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Items" }];
const SPLIT_OPTIONS = [
  { value: "delimiter", label: "Delimiter" },
  { value: "newline", label: "Newline" },
  { value: "regex", label: "Regex (Advanced)" },
];

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function ArrayNode({ id, data, selected }: NodeProps<ArrayNodeType>) {
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const addNode = useWorkflowStore((state) => state.addNode);
  const onConnect = useWorkflowStore((state) => state.onConnect);
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);

  // Derive nodeData from the Zustand store (already subscribed via `nodes`)
  // rather than React Flow props, so settings changes are reflected immediately.
  const nodeData = useMemo(() => {
    const n = nodes.find((nd) => nd.id === id);
    return (n?.data as ArrayNodeData) ?? data;
  }, [nodes, id, data]);
  const { getNodes } = useReactFlow();
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

  // Helper: reparse and update outputs atomically whenever any split setting changes.
  // Reads fresh data from the Zustand store (not React Flow props) to avoid stale closures.
  const updateSettingsAndReparse = useCallback(
    (partialSettings: Partial<Pick<ArrayNodeData, "splitMode" | "delimiter" | "regexPattern" | "trimItems" | "removeEmpty">>) => {
      const freshNode = useWorkflowStore.getState().nodes.find((n) => n.id === id);
      if (!freshNode) return;
      const fresh = freshNode.data as ArrayNodeData;
      const merged = {
        splitMode: partialSettings.splitMode ?? fresh.splitMode,
        delimiter: partialSettings.delimiter ?? fresh.delimiter,
        regexPattern: partialSettings.regexPattern ?? fresh.regexPattern,
        trimItems: partialSettings.trimItems ?? fresh.trimItems,
        removeEmpty: partialSettings.removeEmpty ?? fresh.removeEmpty,
      };
      const result = parseTextToArray(fresh.inputText, merged);
      updateNodeData(id, {
        ...partialSettings,
        outputItems: result.items,
        outputText: JSON.stringify(result.items),
        error: result.error,
      });
    },
    [id, updateNodeData]
  );

  const handleBasicModeChange = useCallback(
    (value: string) => {
      updateSettingsAndReparse({ splitMode: value as ArrayNodeData["splitMode"] });
    },
    [updateSettingsAndReparse]
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

    const promptNodeIds: string[] = [];

    items.forEach((item, index) => {
      const promptNodeId = addNode(
        "prompt",
        { x: baseX, y: baseY + index * (promptHeight + verticalGap) },
        { prompt: item }
      );
      promptNodeIds.push(promptNodeId);

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

    // Deferred fix-up: the PromptNode text-sync effect may overwrite the
    // individual item text before the edge arrayItemIndex data is fully
    // settled. Re-apply the correct per-item text after effects have run.
    setTimeout(() => {
      items.forEach((item, index) => {
        updateNodeData(promptNodeIds[index], { prompt: item });
      });
    }, 0);
  }, [addNode, getNodes, id, onConnect, previewItems, updateNodeData]);

  // Reset selection if it no longer points to a valid parsed item.
  useEffect(() => {
    const currentSelection = nodeData.selectedOutputIndex;
    if (currentSelection !== null && (currentSelection < 0 || currentSelection >= previewItems.length)) {
      updateNodeData(id, { selectedOutputIndex: null });
    }
  }, [id, nodeData.selectedOutputIndex, previewItems.length, updateNodeData]);

  return (
    <NodeShell
      id={id}
      selected={selected}
      hasError={!!nodeData.error}
      media={{ kind: "auto" }}
      inputs={INPUT_SOCKETS}
      outputs={OUTPUT_SOCKETS}
      minWidth={280}
      cardClassName="rounded-controls"
    >
      <LogicRows>
        {/* Row 0: split mode, where the text sockets land */}
        <LogicRow>
          <span className="text-node text-neutral-400 shrink-0">Split</span>
          <SelectWell className="flex-1" value={nodeData.splitMode} options={SPLIT_OPTIONS} onChange={handleBasicModeChange} />
          <button
            type="button"
            onClick={() => updateNodeData(id, { batchMode: !nodeData.batchMode })}
            className={`nodrag nopan shrink-0 h-[22px] px-2 rounded-well squircle text-node font-medium transition-colors ${
              nodeData.batchMode ? "bg-blue-600/80 text-blue-100" : "bg-well shadow-well text-neutral-500 hover:text-neutral-300"
            }`}
            title={nodeData.batchMode ? "Batch mode: all items sent to one downstream node" : "Enable batch mode"}
          >
            Batch
          </button>
          {!nodeData.batchMode && (
            <button
              type="button"
              onClick={handleAutoRouteToPrompts}
              disabled={previewItems.length === 0}
              className="nodrag nopan shrink-0 w-[22px] h-[22px] flex items-center justify-center bg-well shadow-well rounded-well squircle text-neutral-400 hover:text-neutral-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title="Auto-route to Prompts"
            >
              <svg className="w-3 h-3 rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M16 3h5v5" />
                <path d="M8 3H3v5" />
                <path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" />
                <path d="m15 9 6-6" />
              </svg>
            </button>
          )}
        </LogicRow>

        <div className="px-2 flex flex-col gap-1">
          {nodeData.splitMode === "delimiter" && (
            <TextField
              label="By"
              value={nodeData.delimiter}
              placeholder="*"
              onChange={(v) => updateSettingsAndReparse({ delimiter: v ?? "" })}
            />
          )}
          {nodeData.splitMode === "regex" && (
            <TextField
              label="By"
              value={nodeData.regexPattern}
              placeholder="/\\n+/"
              onChange={(v) => updateSettingsAndReparse({ regexPattern: v ?? "" })}
            />
          )}

          <Field label="Advanced">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="nodrag nopan flex items-center gap-1 h-[22px] text-node text-neutral-500 hover:text-neutral-300 transition-colors"
              aria-expanded={showAdvanced}
            >
              <svg className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <span>{showAdvanced ? "Hide" : "Show"}</span>
            </button>
          </Field>
          {showAdvanced && (
            <>
              <CheckboxField label="Trim" checked={nodeData.trimItems} onChange={(v) => updateSettingsAndReparse({ trimItems: v })} />
              <CheckboxField label="Remove empty" checked={nodeData.removeEmpty} onChange={(v) => updateSettingsAndReparse({ removeEmpty: v })} />
            </>
          )}

          <div className="mt-1 text-node text-neutral-500">Parsed items ({previewItems.length})</div>
          <div className="relative min-h-[40px] rounded-well squircle bg-well shadow-well">
            {nodeData.error ? (
              <div className="p-2 text-node text-red-400">{nodeData.error}</div>
            ) : previewItems.length === 0 ? (
              <div className="p-2 text-node text-neutral-500">No items parsed</div>
            ) : (
              <div className="py-1 max-h-[240px] overflow-y-auto nowheel">
                {previewItems.map((item, index) => {
                  const isSelected = nodeData.selectedOutputIndex === index;
                  return (
                    <button
                      key={`${index}-${item}`}
                      type="button"
                      onClick={() =>
                        updateNodeData(id, {
                          selectedOutputIndex: isSelected ? null : index,
                        })
                      }
                      className={`nodrag nopan w-[calc(100%-0.5rem)] mx-1 my-0.5 rounded-[6px] squircle px-2 h-[22px] text-node text-left truncate transition-colors ${
                        isSelected
                          ? "bg-blue-900/40 text-blue-200 ring-1 ring-blue-500/60"
                          : "bg-neutral-800/60 text-neutral-300 hover:bg-neutral-700/60"
                      }`}
                      title={isSelected ? "Selected for next connection (click to unselect)" : "Click to select for next connection"}
                    >
                      {index + 1}. {item}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="text-node text-neutral-500 pb-1">
            {nodeData.batchMode
              ? "Batch: all items sent to downstream node"
              : nodeData.selectedOutputIndex !== null
                ? `Next wire uses item ${nodeData.selectedOutputIndex + 1}`
                : "No selection: wires advance in order from item 1"}
          </div>
        </div>
      </LogicRows>
    </NodeShell>
  );
}
