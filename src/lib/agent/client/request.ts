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
import type { WorkflowTab } from "@/store/utils/workflowTabs";
import { buildAgentSnapshot } from "../graph/snapshot";
import type { AgentChatRequestBody, AgentHarnessId, AgentTabSummary, AgentUIMessage, AgentWorkflowSnapshot } from "../types";
import { getVisibleFlowRect } from "./layout";
import { sessionIdForHarness } from "./session";

export interface AgentCanvasState {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  groups: Record<string, NodeGroup>;
  workflowName: string | null;
  /** A run (or a batch of runs) is going. */
  running?: boolean;
}

/** The tab strip: the parked tabs' state, and the live tab's save state (its nodes and name are the canvas). */
export interface AgentTabStrip {
  tabs: WorkflowTab[];
  activeTabId: string;
  hasUnsavedChanges: boolean;
  saveDirectoryPath: string | null;
}

export interface BuildAgentChatRequestInput {
  chatId: string;
  messages: AgentUIMessage[];
  harness: AgentHarnessId;
  model?: string;
  effort?: string;
  canvas: AgentCanvasState;
  viewport?: AgentWorkflowSnapshot["viewport"];
  /** The open tabs; without it the request describes the live canvas alone. */
  strip?: AgentTabStrip;
}

export function buildAgentChatRequestBody({
  chatId,
  messages,
  harness,
  model,
  effort,
  canvas,
  viewport,
  strip,
}: BuildAgentChatRequestInput): AgentChatRequestBody {
  // Parked first, so the live canvas is the last snapshot built.
  const parkedWorkflows = strip ? parkedSnapshots(strip, viewport) : null;
  const workflow = buildAgentSnapshot({
    nodes: canvas.nodes,
    edges: canvas.edges,
    groups: canvas.groups,
    viewport,
    workflowName: canvas.workflowName ?? undefined,
    running: canvas.running,
    // The user's saved models and settings, so the agent's new nodes are described as they will appear.
    createDefaultNodeData,
  });
  return {
    id: chatId,
    messages,
    harness,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    sessionId: sessionIdForHarness(messages, harness),
    workflow: strip ? { ...workflow, tabId: strip.activeTabId } : workflow,
    ...(strip && parkedWorkflows ? { tabs: tabSummaries(strip, canvas), parkedWorkflows } : {}),
  };
}

/** Every open tab in strip order; the live one reads from the canvas. */
export function tabSummaries(strip: AgentTabStrip, canvas: Pick<AgentCanvasState, "nodes" | "workflowName">): AgentTabSummary[] {
  const live = {
    nodes: canvas.nodes,
    workflowName: canvas.workflowName,
    saveDirectoryPath: strip.saveDirectoryPath,
    hasUnsavedChanges: strip.hasUnsavedChanges,
  };
  return strip.tabs.map((tab) => {
    const active = tab.id === strip.activeTabId;
    const source = (!active && tab.snapshot) || live;
    return {
      id: tab.id,
      ...(source.workflowName ? { name: source.workflowName } : {}),
      ...(active ? { active: true as const } : {}),
      nodeCount: source.nodes.length,
      ...(source.saveDirectoryPath ? { saved: true as const } : {}),
      ...(source.hasUnsavedChanges ? { unsaved: true as const } : {}),
    };
  });
}

/**
 * The parked tabs as the agent would see them once switched in: the live
 * pane's size at each tab's own last pan and zoom (none when it was never
 * shown, so it is fitted to view when it is).
 */
function parkedSnapshots(
  strip: AgentTabStrip,
  liveViewport: AgentWorkflowSnapshot["viewport"],
): Record<string, AgentWorkflowSnapshot> {
  const parked: Record<string, AgentWorkflowSnapshot> = {};
  for (const tab of strip.tabs) {
    if (tab.id === strip.activeTabId || !tab.snapshot) continue;
    const { nodes, edges, groups, workflowName, canvasViewport } = tab.snapshot;
    parked[tab.id] = {
      ...buildAgentSnapshot({
        nodes,
        edges,
        groups,
        viewport: parkedViewport(liveViewport, canvasViewport),
        workflowName: workflowName ?? undefined,
      }),
      tabId: tab.id,
    };
  }
  return parked;
}

function parkedViewport(
  live: AgentWorkflowSnapshot["viewport"],
  pan: { x: number; y: number; zoom: number } | null,
): AgentWorkflowSnapshot["viewport"] {
  if (!live || !pan) return undefined;
  // The live rect is in flow units at the live zoom: back to pane pixels, then through the tab's own transform.
  return getVisibleFlowRect({
    transform: [pan.x, pan.y, pan.zoom],
    paneWidth: live.width * live.zoom,
    paneHeight: live.height * live.zoom,
  });
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
