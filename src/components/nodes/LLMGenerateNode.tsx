"use client";

import { useCallback, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useWorkflowStore } from "@/store/workflowStore";
import { LLMGenerateNodeData } from "@/types";

type LLMGenerateNodeType = Node<LLMGenerateNodeData, "llmGenerate">;

export function LLMGenerateNode({ id, data, selected }: NodeProps<LLMGenerateNodeType>) {
  const nodeData = data;
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const regenerateNode = useWorkflowStore((state) => state.regenerateNode);
  const isRunning = useWorkflowStore((state) => state.isRunning);

  const handleRegenerate = useCallback(() => {
    regenerateNode(id);
  }, [id, regenerateNode]);

  const handleClearOutput = useCallback(() => {
    updateNodeData(id, { outputText: null, status: "idle", error: null });
  }, [id, updateNodeData]);

  const [copied, setCopied] = useState(false);

  const handleCopyOutput = useCallback(async () => {
    if (nodeData.outputText) {
      try {
        await navigator.clipboard.writeText(nodeData.outputText);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch (err) {
        console.error("Failed to copy text:", err);
      }
    }
  }, [nodeData.outputText]);

  return (
    <BaseNode
      id={id}
      selected={selected}
      hasError={nodeData.status === "error"}
      isExecuting={isRunning}
      fullBleed
    >
      {/* Image input - optional */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        style={{ top: "35%" }}
        data-handletype="image"
      />
      {/* Text input */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        style={{ top: "65%" }}
        data-handletype="text"
      />
      {/* Text output */}
      <Handle
        type="source"
        position={Position.Right}
        id="text"
        data-handletype="text"
      />

      <div className="relative w-full h-full min-h-0 overflow-hidden rounded-lg">
        {nodeData.status === "loading" ? (
          <div className="w-full h-full bg-neutral-900/40 flex items-center justify-center">
            <svg
              className="w-4 h-4 animate-spin text-neutral-400"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="3"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          </div>
        ) : nodeData.status === "error" ? (
          <div className="w-full h-full bg-red-900/40 flex flex-col items-center justify-center gap-1">
            <svg
              className="w-6 h-6 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-white text-xs font-medium">Generation failed</span>
          </div>
        ) : nodeData.outputText ? (
          <div className="relative w-full h-full bg-neutral-900/40 p-2 overflow-auto nodrag nopan nowheel">
            <p className="text-[10px] text-neutral-300 whitespace-pre-wrap break-words pr-6">
              {nodeData.outputText}
            </p>
            <div className="absolute top-1 right-1 flex gap-1">
              <button
                onClick={handleCopyOutput}
                className={`w-5 h-5 ${copied ? "bg-green-600/80" : "bg-neutral-900/80 hover:bg-neutral-700/80"} rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors`}
                title={copied ? "Copied!" : "Copy to clipboard"}
              >
                {copied ? (
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
              <button
                onClick={handleRegenerate}
                disabled={isRunning}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-blue-600/80 disabled:opacity-50 disabled:cursor-not-allowed rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Regenerate"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
              <button
                onClick={handleClearOutput}
                className="w-5 h-5 bg-neutral-900/80 hover:bg-red-600/80 rounded flex items-center justify-center text-neutral-400 hover:text-white transition-colors"
                title="Clear output"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          <div className="w-full h-full bg-neutral-900/40 flex items-center justify-center">
            <span className="text-neutral-500 text-[10px]">
              Run to generate
            </span>
          </div>
        )}
      </div>
    </BaseNode>
  );
}
