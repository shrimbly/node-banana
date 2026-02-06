"use client";

import { useCallback, useState } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { WebhookTriggerNodeData } from "@/types";

type WebhookTriggerNodeType = Node<WebhookTriggerNodeData, "webhookTrigger">;

export function WebhookTriggerNode({ id, data, selected }: NodeProps<WebhookTriggerNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);
  const workflowName = useWorkflowStore((state) => state.workflowName);
  const [showSecret, setShowSecret] = useState(false);

  const handleImageCountChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const count = parseInt(e.target.value, 10);
      // Resize images array to match new count
      const images = Array.from({ length: count }, (_, i) => nodeData.images[i] ?? null);
      updateNodeData(id, { imageCount: count, images });
    },
    [id, nodeData.images, updateNodeData]
  );

  const handleTextToggle = useCallback(() => {
    updateNodeData(id, { hasTextOutput: !nodeData.hasTextOutput });
  }, [id, nodeData.hasTextOutput, updateNodeData]);

  const handleSecretChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      updateNodeData(id, { webhookSecret: e.target.value || undefined });
    },
    [id, updateNodeData]
  );

  const webhookUrl = workflowName
    ? `/api/webhook/${encodeURIComponent(workflowName.replace(/\.json$/, ""))}`
    : "/api/webhook/<workflow-name>";

  const examplePayload = JSON.stringify(
    {
      images: Array.from({ length: Math.min(nodeData.imageCount, 2) }, () => "https://example.com/image.jpg"),
      ...(nodeData.hasTextOutput ? { text: "your prompt here" } : {}),
    },
    null,
    2
  );

  return (
    <BaseNode
      id={id}
      title="Webhook Trigger"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      commentNavigation={commentNavigation ?? undefined}
    >
      <div className="flex flex-col gap-2">
        {/* Webhook URL display */}
        <div className="p-2 bg-neutral-900/70 border border-neutral-700 rounded">
          <div className="text-[9px] text-neutral-500 uppercase tracking-wider mb-1">Webhook URL</div>
          <div className="text-[10px] text-emerald-400 font-mono break-all select-all">
            POST {webhookUrl}
          </div>
        </div>

        {/* Image count selector */}
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-neutral-400">Image inputs</label>
          <select
            value={nodeData.imageCount}
            onChange={handleImageCountChange}
            className="nodrag nopan bg-neutral-800 border border-neutral-700 rounded px-2 py-1 text-[10px] text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-600"
          >
            {Array.from({ length: 10 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
        </div>

        {/* Text output toggle */}
        <div className="flex items-center justify-between">
          <label className="text-[10px] text-neutral-400">Text output</label>
          <button
            onClick={handleTextToggle}
            className={`nodrag nopan px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              nodeData.hasTextOutput
                ? "bg-emerald-600/30 text-emerald-400 border border-emerald-500/50"
                : "bg-neutral-800 text-neutral-500 border border-neutral-700"
            }`}
          >
            {nodeData.hasTextOutput ? "ON" : "OFF"}
          </button>
        </div>

        {/* Secret token */}
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-neutral-400">Auth secret (optional)</label>
          <div className="flex items-center gap-1">
            <input
              type={showSecret ? "text" : "password"}
              value={nodeData.webhookSecret || ""}
              onChange={handleSecretChange}
              placeholder="Bearer token"
              className="nodrag nopan flex-1 px-2 py-1 text-[10px] bg-neutral-900/50 border border-neutral-700 rounded text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-600"
            />
            <button
              onClick={() => setShowSecret(!showSecret)}
              className="nodrag nopan p-1 text-neutral-500 hover:text-neutral-300 transition-colors"
              title={showSecret ? "Hide" : "Show"}
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                {showSecret ? (
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                ) : (
                  <>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Example payload */}
        <details className="group">
          <summary className="text-[10px] text-neutral-500 cursor-pointer hover:text-neutral-400 transition-colors">
            Example payload
          </summary>
          <pre className="mt-1 p-2 bg-neutral-900/70 border border-neutral-700 rounded text-[9px] text-neutral-400 font-mono overflow-x-auto whitespace-pre">
            {examplePayload}
          </pre>
        </details>
      </div>

      {/* Image output handles */}
      {Array.from({ length: nodeData.imageCount }, (_, i) => (
        <Handle
          key={`image-${i}`}
          type="source"
          position={Position.Right}
          id={`image-${i}`}
          data-handletype="image"
          style={{ top: `${30 + ((i + 1) / (nodeData.imageCount + (nodeData.hasTextOutput ? 1 : 0) + 1)) * 70}%` }}
        />
      ))}

      {/* Text output handle */}
      {nodeData.hasTextOutput && (
        <Handle
          type="source"
          position={Position.Right}
          id="text"
          data-handletype="text"
          style={{ top: `${30 + ((nodeData.imageCount + 1) / (nodeData.imageCount + 2)) * 70}%` }}
        />
      )}
    </BaseNode>
  );
}
