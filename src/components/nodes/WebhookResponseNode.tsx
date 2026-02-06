"use client";

import { useMemo } from "react";
import { Handle, Position, NodeProps, Node } from "@xyflow/react";
import { BaseNode } from "./BaseNode";
import { useCommentNavigation } from "@/hooks/useCommentNavigation";
import { useWorkflowStore } from "@/store/workflowStore";
import { WebhookResponseNodeData } from "@/types";

type WebhookResponseNodeType = Node<WebhookResponseNodeData, "webhookResponse">;

export function WebhookResponseNode({ id, data, selected }: NodeProps<WebhookResponseNodeType>) {
  const nodeData = data;
  const commentNavigation = useCommentNavigation(id);
  const updateNodeData = useWorkflowStore((state) => state.updateNodeData);

  const isVideo = useMemo(() => {
    if (nodeData.video) return true;
    if (nodeData.contentType === "video") return true;
    if (nodeData.image?.startsWith("data:video/")) return true;
    if (nodeData.image?.includes(".mp4") || nodeData.image?.includes(".webm")) return true;
    return false;
  }, [nodeData.video, nodeData.contentType, nodeData.image]);

  const contentSrc = useMemo(() => {
    if (nodeData.video) return nodeData.video;
    return nodeData.image;
  }, [nodeData.video, nodeData.image]);

  const hasContent = contentSrc || nodeData.text;

  return (
    <BaseNode
      id={id}
      title="Webhook Response"
      customTitle={nodeData.customTitle}
      comment={nodeData.comment}
      onCustomTitleChange={(title) => updateNodeData(id, { customTitle: title || undefined })}
      onCommentChange={(comment) => updateNodeData(id, { comment: comment || undefined })}
      selected={selected}
      commentNavigation={commentNavigation ?? undefined}
    >
      {/* Image input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="image"
        data-handletype="image"
      />

      {/* Text input handle */}
      <Handle
        type="target"
        position={Position.Left}
        id="text"
        data-handletype="text"
        style={{ top: "70%" }}
      />

      {hasContent ? (
        <div className="flex-1 flex flex-col min-h-0 gap-2">
          {contentSrc && (
            <div className="flex-1 min-h-0">
              {isVideo ? (
                <video
                  src={contentSrc}
                  controls
                  loop
                  muted
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain rounded"
                />
              ) : (
                <img
                  src={contentSrc}
                  alt="Webhook response"
                  className="w-full h-full object-contain rounded"
                />
              )}
            </div>
          )}
          {nodeData.text && (
            <div className="p-2 bg-neutral-900/50 border border-neutral-700 rounded">
              <div className="text-[9px] text-neutral-500 uppercase tracking-wider mb-1">Text output</div>
              <div className="text-[10px] text-neutral-300 line-clamp-4">{nodeData.text}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="w-full flex-1 min-h-[100px] border border-dashed border-neutral-600 rounded flex flex-col items-center justify-center gap-1">
          <svg className="w-5 h-5 text-neutral-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 7.5h-.75A2.25 2.25 0 004.5 9.75v7.5a2.25 2.25 0 002.25 2.25h7.5a2.25 2.25 0 002.25-2.25v-7.5a2.25 2.25 0 00-2.25-2.25h-.75m-6 3.75l3 3m0 0l3-3m-3 3V1.5m6 9h.75a2.25 2.25 0 012.25 2.25v7.5a2.25 2.25 0 01-2.25 2.25h-7.5a2.25 2.25 0 01-2.25-2.25v-.75" />
          </svg>
          <span className="text-neutral-500 text-[10px]">Waiting for webhook data</span>
        </div>
      )}

      {/* Status indicator */}
      <div className="mt-1 flex items-center gap-1.5">
        <div className={`w-1.5 h-1.5 rounded-full ${hasContent ? "bg-emerald-500" : "bg-neutral-600"}`} />
        <span className="text-[9px] text-neutral-500">
          {hasContent ? "Data captured" : "No data yet"}
        </span>
      </div>
    </BaseNode>
  );
}
