"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, CircleAlert, SlidersHorizontal, Split } from "lucide-react";
import { Node, NodeProps, useReactFlow } from "@xyflow/react";
import { NodeShell } from "./NodeShell";
import { LogicRow, LogicRows, PanelButton, SelectWell, cn, ellipsisClass, useLocalEdit, wellClass, type SocketSpec } from "./ui";
import { useWorkflowStore } from "@/store/workflowStore";
import { nodeGraphIndex } from "@/lib/edges/graphIndex";
import { ArrayNodeData } from "@/types";
import { getConnectedInputsPure } from "@/store/utils/connectedInputs";
import { parseTextToArray } from "@/utils/arrayParser";
import { arrayItemWireCounts } from "@/lib/edges/arrayItems";
import { useIsPaintedNode, useUpdateNodeData } from "./paintMode";

type ArrayNodeType = Node<ArrayNodeData, "array">;

const INPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Text" }];
const OUTPUT_SOCKETS: SocketSpec[] = [{ id: "text", type: "text", label: "Items" }];
const SPLIT_OPTIONS = [
  { value: "delimiter", label: "By delimiter" },
  { value: "newline", label: "By line" },
  { value: "regex", label: "By regex" },
];
/** Items listed before the rest fold behind "n more". */
const PREVIEW_ITEMS = 5;

function itemCount(n: number): string {
  if (n === 0) return "No items";
  return n === 1 ? "1 item" : `${n} items`;
}

/** The delimiter or pattern, in a compact well beside the mode. Written on blur or Enter. */
function SplitParam({
  value,
  label,
  placeholder,
  invalid,
  onChange,
}: {
  value: string;
  label: string;
  placeholder: string;
  invalid?: boolean;
  onChange: (value: string) => void;
}) {
  const { text, setText, onFocus, onBlur } = useLocalEdit(value);
  return (
    <input
      type="text"
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={text}
      placeholder={placeholder}
      onFocus={onFocus}
      onChange={(e) => {
        setText(e.target.value);
        if (window.nodeBananaDesktop) onChange(e.target.value);
      }}
      onBlur={() => {
        onBlur();
        onChange(text);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={cn(wellClass, "font-mono", invalid && "ring-1 ring-red-500")}
    />
  );
}

/** One on/off chip in a shared well (the Advanced clean-up options). */
function ToggleChip({ label, pressed, onChange }: { label: string; pressed: boolean; onChange: (pressed: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={cn(
        "flex-1 min-w-0 h-full px-1.5 rounded-[6px] squircle text-node transition-colors",
        ellipsisClass,
        pressed ? "bg-neutral-600 text-white" : "text-neutral-400 hover:text-neutral-200"
      )}
    >
      {label}
    </button>
  );
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function ArrayNode({ id, data, selected }: NodeProps<ArrayNodeType>) {
  const updateNodeData = useUpdateNodeData();
  const addNode = useWorkflowStore((state) => state.addNode);
  const onConnect = useWorkflowStore((state) => state.onConnect);
  const edges = useWorkflowStore((state) => state.edges);

  // Derive nodeData from the Zustand store rather than React Flow props, so
  // settings changes are reflected immediately. Only this node's data: the
  // nodes array changes on every frame of a drag.
  const nodeData = useWorkflowStore((state) => (nodeGraphIndex(state.nodes).byId.get(id)?.data as ArrayNodeData | undefined) ?? data);
  const { getNodes } = useReactFlow();
  const lastSyncedInputRef = useRef<string | null>(null);
  const lastDerivedWriteRef = useRef<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showAllItems, setShowAllItems] = useState(false);
  // The item shown in full; the others stay one truncated line
  const [openItem, setOpenItem] = useState<number | null>(null);

  const hasIncomingTextConnection = useMemo(
    () =>
      edges.some((edge) => {
        if (edge.target !== id) return false;
        const handle = edge.targetHandle || "text";
        return handle === "text" || handle.startsWith("text-") || handle.includes("prompt");
      }),
    [edges, id]
  );

  const connectedText = useWorkflowStore((state) =>
    hasIncomingTextConnection ? getConnectedInputsPure(id, state.nodes, state.edges).text : null
  );

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

  // A painted copy cannot save the upstream text, so it splits that text itself.
  const painted = useIsPaintedNode();
  const inputText = painted && hasIncomingTextConnection && connectedText !== null ? connectedText : nodeData.inputText;

  const parsed = useMemo(() => {
    return parseTextToArray(inputText, {
      splitMode: nodeData.splitMode,
      delimiter: nodeData.delimiter,
      regexPattern: nodeData.regexPattern,
      trimItems: nodeData.trimItems,
      removeEmpty: nodeData.removeEmpty,
    });
  }, [
    inputText,
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

  // A new split closes the open item rather than opening whatever now sits at its index
  useEffect(() => {
    setOpenItem(null);
  }, [parsed.items]);

  const itemTotal = previewItems.length;
  const batch = nodeData.batchMode;
  const wireCounts = useMemo(() => arrayItemWireCounts(id, itemTotal, edges), [edges, id, itemTotal]);
  const visibleItems = showAllItems ? previewItems : previewItems.slice(0, PREVIEW_ITEMS);
  const hiddenCount = itemTotal - visibleItems.length;

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
        {/* Row 0, where the sockets land: how to split, and what comes out */}
        <LogicRow>
          <SelectWell
            className="w-[104px] shrink-0"
            value={nodeData.splitMode}
            options={SPLIT_OPTIONS}
            onChange={handleBasicModeChange}
          />
          {nodeData.splitMode === "delimiter" && (
            <div className="w-[44px] shrink-0">
              <SplitParam
                label="Delimiter"
                value={nodeData.delimiter}
                placeholder="*"
                onChange={(v) => updateSettingsAndReparse({ delimiter: v })}
              />
            </div>
          )}
          {nodeData.splitMode === "regex" && (
            <div className="flex-1 min-w-0">
              <SplitParam
                label="Regex pattern"
                value={nodeData.regexPattern}
                placeholder="/\\n+/"
                invalid={!!nodeData.error}
                onChange={(v) => updateSettingsAndReparse({ regexPattern: v })}
              />
            </div>
          )}
          {nodeData.splitMode !== "regex" && <span className="flex-1" />}
          <span
            className={cn("shrink-0 text-node tabular-nums", itemTotal > 0 ? "text-neutral-200 font-medium" : "text-neutral-500")}
            data-testid="array-item-count"
          >
            {itemCount(itemTotal)}
          </span>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
            aria-label="Clean-up options"
            title="Clean-up options"
            className={cn(
              "nodrag nopan shrink-0 w-[22px] h-[22px] flex items-center justify-center rounded-well squircle transition-colors",
              showAdvanced ? "bg-neutral-700 text-neutral-100" : "bg-well shadow-well text-neutral-400 hover:text-neutral-100"
            )}
          >
            <SlidersHorizontal size={12} strokeWidth={2} />
          </button>
        </LogicRow>

        <div className="px-2 flex flex-col gap-1">
          {showAdvanced && (
            <div
              role="group"
              aria-label="Clean up"
              className="nodrag nopan flex items-center h-[22px] p-[2px] gap-[2px] rounded-well squircle bg-well shadow-well"
            >
              <ToggleChip label="Trim spaces" pressed={nodeData.trimItems} onChange={(v) => updateSettingsAndReparse({ trimItems: v })} />
              <ToggleChip label="Drop empty" pressed={nodeData.removeEmpty} onChange={(v) => updateSettingsAndReparse({ removeEmpty: v })} />
            </div>
          )}

          <div className="relative rounded-well squircle bg-well shadow-well" data-testid="array-items">
            {nodeData.error ? (
              <div className="flex items-start gap-1.5 p-2 text-node text-red-400" role="alert">
                <CircleAlert size={12} strokeWidth={2} className="shrink-0 mt-px" />
                <span className="break-words min-w-0">{nodeData.error}</span>
              </div>
            ) : itemTotal === 0 ? (
              <div className="flex flex-col items-center justify-center gap-0.5 min-h-[56px] px-2 text-node text-center">
                {hasIncomingTextConnection ? (
                  <span className="text-neutral-500">Nothing to split yet</span>
                ) : (
                  <>
                    <span className="text-neutral-400">Connect text to split it</span>
                    <span className="text-neutral-500">A Prompt or LLM output, cut into one item per piece</span>
                  </>
                )}
              </div>
            ) : (
              <div className={cn("py-1", showAllItems && "max-h-[240px] overflow-y-auto nowheel")}>
                {visibleItems.map((item, index) => {
                  const open = openItem === index;
                  const wires = batch ? 0 : wireCounts.get(index) ?? 0;
                  return (
                    <button
                      key={`${index}-${item}`}
                      type="button"
                      onClick={() => setOpenItem(open ? null : index)}
                      aria-expanded={open}
                      className={cn(
                        "nodrag nopan w-[calc(100%-0.5rem)] mx-1 my-0.5 rounded-[6px] squircle pl-1.5 pr-1 flex gap-1.5 text-node text-left transition-colors",
                        open ? "items-start py-[4px] bg-neutral-700/60 text-neutral-100" : "items-center h-[22px] bg-neutral-800/60 text-neutral-300 hover:bg-neutral-700/60"
                      )}
                      title={open ? "Collapse" : "Show the full text"}
                    >
                      <span className="w-3 shrink-0 text-right text-neutral-500 tabular-nums">{index + 1}</span>
                      {open ? (
                        <span className="flex-1 min-w-0 max-h-[160px] overflow-y-auto nowheel whitespace-pre-wrap break-words" data-testid="array-item-full">
                          {item}
                        </span>
                      ) : (
                        <span className={cn("flex-1 min-w-0", ellipsisClass)}>{item}</span>
                      )}
                      {wires > 0 && (
                        <span
                          className={cn("shrink-0 w-1.5 h-1.5 mx-0.5 rounded-full bg-handle-text", open && "mt-[4px]")}
                          title={wires === 1 ? "On 1 connection" : `On ${wires} connections`}
                          data-testid="array-item-wired"
                        />
                      )}
                      <ChevronRight
                        size={12}
                        strokeWidth={2}
                        className={cn("shrink-0 text-neutral-500 transition-transform", open && "rotate-90 mt-px")}
                        aria-hidden
                      />
                    </button>
                  );
                })}
                {(hiddenCount > 0 || showAllItems) && itemTotal > PREVIEW_ITEMS && (
                  <button
                    type="button"
                    onClick={() => setShowAllItems((v) => !v)}
                    className="nodrag nopan w-full h-[22px] flex items-center justify-center text-node text-neutral-500 hover:text-neutral-300 transition-colors"
                  >
                    {showAllItems ? "Show fewer" : `${hiddenCount} more`}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Footer: what happens downstream */}
          <div className="flex items-center gap-1.5 mt-0.5 pt-1.5 border-t border-white/[0.06]">
            <label className="nodrag nopan relative inline-flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                role="switch"
                className="sr-only peer"
                checked={batch}
                onChange={() => updateNodeData(id, { batchMode: !batch })}
              />
              <span className="w-7 h-3.5 bg-neutral-600 peer-checked:bg-blue-500 rounded-full transition-colors relative">
                <span className={cn("absolute top-0.5 left-0.5 bg-white h-2.5 w-2.5 rounded-full transition-transform", batch && "translate-x-3.5")} />
              </span>
              <span className={cn("text-node", batch ? "text-neutral-200" : "text-neutral-400")}>Batch</span>
            </label>
            <span className="flex-1" />
            {!batch && (
              <PanelButton
                onClick={handleAutoRouteToPrompts}
                disabled={itemTotal === 0}
                className="flex items-center gap-1"
                title={
                  itemTotal > 0
                    ? `Creates ${itemTotal} Prompt ${itemTotal === 1 ? "node" : "nodes"}, each wired to its item`
                    : "Connect text to make Prompt nodes"
                }
              >
                <Split size={12} strokeWidth={2} className="rotate-90" />
                {itemTotal > 0 ? `Make ${itemTotal} ${itemTotal === 1 ? "Prompt" : "Prompts"}` : "Make Prompts"}
              </PanelButton>
            )}
          </div>
          <div className="text-node text-neutral-500 pb-1">
            {!batch
              ? "Each connection carries one item."
              : itemTotal > 1
                ? `Each connected Generate or LLM node runs ${itemTotal} times, once per item.`
                : "Each connected Generate or LLM node runs once per item."}
          </div>
        </div>
      </LogicRows>
    </NodeShell>
  );
}
