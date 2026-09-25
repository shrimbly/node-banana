/**
 * The body of one POST /api/agent/chat, built from the live canvas at send
 * time (not when the message was typed), so the agent always sees what is on
 * screen right now.
 */

import type { WorkflowNode } from "@/types";
import type { NodeGroup, WorkflowEdge } from "@/types/workflow";
import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import { buildAgentSnapshot } from "../graph/snapshot";
import type { AgentChatRequestBody, AgentHarnessId, AgentUIMessage, AgentWorkflowSnapshot } from "../types";
import { sessionIdForHarness } from "./session";

export interface AgentCanvasState {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
  workflowName: string | null;
}

export interface BuildAgentChatRequestInput {
  chatId: string;
  messages: AgentUIMessage[];
  harness: AgentHarnessId;
  model?: string;
  canvas: AgentCanvasState;
  viewport?: AgentWorkflowSnapshot["viewport"];
}

export function buildAgentChatRequestBody({
  chatId,
  messages,
  harness,
  model,
  canvas,
  viewport,
}: BuildAgentChatRequestInput): AgentChatRequestBody {
  return {
    id: chatId,
    messages,
    harness,
    ...(model ? { model } : {}),
    sessionId: sessionIdForHarness(messages, harness),
    workflow: buildAgentSnapshot({
      nodes: canvas.nodes,
      edges: canvas.edges,
      groups: canvas.groups,
      viewport,
      workflowName: canvas.workflowName ?? undefined,
      // The user's saved models and settings, so the agent's new nodes are described as they will appear.
      createDefaultNodeData,
    }),
  };
}

/**
 * Only http(s) links from a CLI's sign-in output are opened or rendered, so a
 * garbled or hostile line can never become a `javascript:` link.
 */
export function safeExternalUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
