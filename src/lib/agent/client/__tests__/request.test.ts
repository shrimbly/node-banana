import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowNode } from "@/types";
import type { AgentUIMessage } from "../../types";

const buildAgentSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock("../../graph/snapshot", () => ({ buildAgentSnapshot: buildAgentSnapshotMock }));

import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import type { ProviderSettings } from "@/types";
import type { WorkflowTabSnapshot } from "@/store/utils/workflowTabs";
import { agentProviderHeaders, agentProviderKeys, buildAgentChatRequestBody, safeExternalUrl, whenProviderKeysReady } from "../request";

const snapshot = { nodes: [], edges: [], groups: [], selectedNodeIds: [] };

describe("buildAgentChatRequestBody", () => {
  beforeEach(() => {
    buildAgentSnapshotMock.mockReset();
    buildAgentSnapshotMock.mockReturnValue(snapshot);
  });

  const node = { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, data: {} } as WorkflowNode;
  const messages: AgentUIMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "data-agent-session", id: "session", data: { harness: "claude", sessionId: "s1" } }],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "again" }] },
  ];
  const viewport = { x: 0, y: 0, width: 900, height: 700, zoom: 1 };

  it("sends the chat, harness, model, resumable session and a snapshot of the live canvas", () => {
    const body = buildAgentChatRequestBody({
      chatId: "chat-1",
      messages,
      harness: "claude",
      model: "sonnet",
      canvas: { nodes: [node], edges: [], groups: {}, workflowName: "My flow" },
      viewport,
    });

    expect(body).toEqual({
      id: "chat-1",
      messages,
      harness: "claude",
      model: "sonnet",
      sessionId: "s1",
      workflow: snapshot,
    });
    expect(buildAgentSnapshotMock).toHaveBeenCalledWith({
      nodes: [node],
      edges: [],
      groups: {},
      viewport,
      workflowName: "My flow",
      createDefaultNodeData,
    });
  });

  it("omits the model when none is chosen and drops another harness's session", () => {
    const body = buildAgentChatRequestBody({
      chatId: "chat-1",
      messages,
      harness: "codex",
      canvas: { nodes: [], edges: [], groups: {}, workflowName: null },
    });
    expect("model" in body).toBe(false);
    expect(body.sessionId).toBeUndefined();
    expect(buildAgentSnapshotMock.mock.calls[0][0].workflowName).toBeUndefined();
  });

  it("says when a run is going", () => {
    buildAgentChatRequestBody({
      chatId: "chat-1",
      messages,
      harness: "claude",
      canvas: { nodes: [], edges: [], groups: {}, workflowName: null, running: true },
    });
    expect(buildAgentSnapshotMock.mock.calls[0][0].running).toBe(true);
  });
});

describe("buildAgentChatRequestBody: the tab strip", () => {
  beforeEach(() => {
    buildAgentSnapshotMock.mockReset();
    buildAgentSnapshotMock.mockImplementation((input: { workflowName?: string }) => ({ ...snapshot, workflowName: input.workflowName }));
  });

  const node = (id: string) => ({ id, type: "prompt", position: { x: 0, y: 0 }, data: {} }) as WorkflowNode;
  const parked = (fields: Partial<WorkflowTabSnapshot>): WorkflowTabSnapshot =>
    ({
      nodes: [],
      edges: [],
      groups: {},
      workflowName: null,
      saveDirectoryPath: null,
      hasUnsavedChanges: false,
      canvasViewport: null,
      ...fields,
    }) as WorkflowTabSnapshot;
  const tabs = [
    { id: "tab-a", snapshot: parked({ nodes: [node("p1"), node("p2")], workflowName: "Fox", saveDirectoryPath: "/w/Fox", canvasViewport: { x: -200, y: 100, zoom: 0.5 } }) },
    { id: "tab-live", snapshot: null },
    { id: "tab-b", snapshot: parked({ hasUnsavedChanges: true }) },
  ];
  const viewport = { x: 0, y: 0, width: 900, height: 600, zoom: 2 };

  function build() {
    return buildAgentChatRequestBody({
      chatId: "chat-1",
      messages: [],
      harness: "claude",
      canvas: { nodes: [node("live-1")], edges: [], groups: {}, workflowName: "Live" },
      viewport,
      strip: { tabs, activeTabId: "tab-live", hasUnsavedChanges: true, saveDirectoryPath: null },
    });
  }

  it("names the live tab and lists every tab in strip order", () => {
    const body = build();
    expect(body.workflow).toMatchObject({ tabId: "tab-live", workflowName: "Live" });
    expect(body.tabs).toEqual([
      { id: "tab-a", name: "Fox", nodeCount: 2, saved: true },
      { id: "tab-live", name: "Live", active: true, nodeCount: 1, unsaved: true },
      { id: "tab-b", nodeCount: 0, unsaved: true },
    ]);
  });

  it("sends the parked tabs' snapshots, each at its own pan and zoom in the live pane's size", () => {
    const body = build();
    expect(Object.keys(body.parkedWorkflows ?? {})).toEqual(["tab-a", "tab-b"]);
    expect(body.parkedWorkflows?.["tab-a"]).toMatchObject({ tabId: "tab-a", workflowName: "Fox" });
    const calls = buildAgentSnapshotMock.mock.calls.map(([input]) => input);
    // The live pane is 1800×1200 px (900×600 flow units at zoom 2); tab A shows it at zoom 0.5 from (-200, 100).
    expect(calls[0]).toMatchObject({ nodes: tabs[0].snapshot!.nodes, viewport: { x: 400, y: -200, width: 3600, height: 2400, zoom: 0.5 } });
    expect(calls[0].createDefaultNodeData).toBeUndefined();
    // Never shown: no viewport, so it is fitted when it is.
    expect(calls[1].viewport).toBeUndefined();
    // The live canvas is built last, with the user's node defaults.
    expect(calls.at(-1)).toMatchObject({ workflowName: "Live", viewport, createDefaultNodeData });
  });

  it("leaves the tabs out without a strip (old clients)", () => {
    const body = buildAgentChatRequestBody({
      chatId: "chat-1",
      messages: [],
      harness: "claude",
      canvas: { nodes: [], edges: [], groups: {}, workflowName: null },
    });
    expect(body.workflow.tabId).toBeUndefined();
    expect("tabs" in body).toBe(false);
    expect("parkedWorkflows" in body).toBe(false);
  });
});

describe("agentProviderHeaders", () => {
  const settings = (keys: Record<string, string | null>): ProviderSettings =>
    ({
      providers: Object.fromEntries(
        Object.entries(keys).map(([id, apiKey]) => [id, { id, name: id, enabled: false, apiKey, apiKeyEnvVar: "" }]),
      ),
    }) as unknown as ProviderSettings;

  it("sends every key the user has, named as the models routes read them, whether or not the provider is enabled", () => {
    const headers = agentProviderHeaders({
      providerSettings: settings({ gemini: "g-key", openai: "sk-openai", replicate: "r8-key", fal: "fal-key", kie: "kie-key", wavespeed: "ws-key", comfy: "comfyui-key", anthropic: "sk-ant" }),
      comfyCloudApiKey: "comfyui-cloud",
    });
    expect(headers).toEqual({
      "X-Gemini-API-Key": "g-key",
      "X-OpenAI-API-Key": "sk-openai",
      "X-Replicate-Key": "r8-key",
      "X-Fal-Key": "fal-key",
      "X-Kie-Key": "kie-key",
      "X-WaveSpeed-Key": "ws-key",
      "X-Comfy-Router-Key": "comfyui-key",
    });
  });

  it("falls back to the Comfy Cloud key for Comfy Router, and leaves out empty keys", () => {
    expect(agentProviderKeys({ providerSettings: settings({ openai: "", comfy: null }), comfyCloudApiKey: "comfyui-cloud" })).toMatchObject({ openai: null, comfy: "comfyui-cloud" });
    expect(agentProviderHeaders({ providerSettings: settings({ openai: "", comfy: null }), comfyCloudApiKey: "comfyui-cloud" })).toEqual({ "X-Comfy-Router-Key": "comfyui-cloud" });
    expect(agentProviderHeaders({ providerSettings: settings({}) })).toEqual({});
  });

  it("waits for the desktop keychain before reading keys, but not forever", async () => {
    let ready = false;
    setTimeout(() => (ready = true), 150);
    const started = Date.now();
    await whenProviderKeysReady(() => ready, 2_000);
    expect(ready).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    await whenProviderKeysReady(() => false, 150);
  });
});

describe("safeExternalUrl", () => {
  it("allows http(s) only", () => {
    expect(safeExternalUrl("https://claude.ai/oauth/authorize?x=1")).toBe("https://claude.ai/oauth/authorize?x=1");
    expect(safeExternalUrl("http://localhost:1455/auth")).toBe("http://localhost:1455/auth");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
  });
});
