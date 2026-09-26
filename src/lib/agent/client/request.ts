/**
 * The body of one POST /api/agent/chat, built from the live canvas at send
 * time (not when the message was typed), so the agent always sees what is on
 * screen right now.
 */

import type { ProviderSettings, WorkflowNode } from "@/types";
import type { NodeGroup, WorkflowEdge } from "@/types/workflow";
import { desktopCredentialsReady } from "@/lib/desktop/credentials";
import { buildModelsApiHeaders, type ModelsApiKeys } from "@/store/utils/buildApiHeaders";
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

/** The store fields the provider keys live in. */
export interface AgentKeySource {
  providerSettings: ProviderSettings;
  /** The Comfy Cloud key from the ComfyUI settings; Comfy Router accepts it too. */
  comfyCloudApiKey?: string | null;
}

/**
 * The provider keys the agent may list models with: the same keys the nodes'
 * model browser uses (useProviderApiKeys), Comfy falling back to the Comfy
 * Cloud key.
 */
export function agentProviderKeys({ providerSettings, comfyCloudApiKey }: AgentKeySource): ModelsApiKeys {
  const providers = providerSettings.providers;
  return {
    gemini: providers.gemini?.apiKey || null,
    openai: providers.openai?.apiKey || null,
    replicate: providers.replicate?.apiKey || null,
    fal: providers.fal?.apiKey || null,
    kie: providers.kie?.apiKey || null,
    wavespeed: providers.wavespeed?.apiKey || null,
    comfy: providers.comfy?.apiKey || comfyCloudApiKey || null,
  };
}

/**
 * Headers for POST /api/agent/chat carrying those keys, named as the models
 * routes read them. They travel in headers, never in the body: the body's
 * messages and canvas are what the agent reads.
 */
export function agentProviderHeaders(source: AgentKeySource): Record<string, string> {
  return buildModelsApiHeaders(agentProviderKeys(source));
}

const DESKTOP_KEYS_WAIT_MS = 10_000;
const DESKTOP_KEYS_POLL_MS = 100;

/**
 * On desktop, provider keys come from the OS keychain after startup; a turn
 * sent before they are in memory would reach the server without them. Wait
 * (briefly) until they are, like the nodes, which refuse to run before.
 * Resolves at once in the browser.
 */
export async function whenProviderKeysReady(
  isReady: () => boolean = desktopCredentialsReady,
  timeoutMs = DESKTOP_KEYS_WAIT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isReady() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, DESKTOP_KEYS_POLL_MS));
  }
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
