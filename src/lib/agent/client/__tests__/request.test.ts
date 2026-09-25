import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WorkflowNode } from "@/types";
import type { AgentUIMessage } from "../../types";

const buildAgentSnapshotMock = vi.hoisted(() => vi.fn());
vi.mock("../../graph/snapshot", () => ({ buildAgentSnapshot: buildAgentSnapshotMock }));

import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import { buildAgentChatRequestBody, safeExternalUrl } from "../request";

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
