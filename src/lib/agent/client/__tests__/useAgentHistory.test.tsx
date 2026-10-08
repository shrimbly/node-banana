import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

const forgetChatRuns = vi.hoisted(() => vi.fn());
vi.mock("../runs", () => ({ forgetChatRuns }));

import type { AgentUIMessage } from "../../types";
import { useAgentHistory } from "../useAgentHistory";

const messages: AgentUIMessage[] = [{ id: "u1", role: "user", parts: [{ type: "text", text: "make a fox" }] }];

describe("useAgentHistory", () => {
  beforeEach(() => {
    localStorage.clear();
    forgetChatRuns.mockClear();
  });

  it("records a conversation with its workflow's tab and id", () => {
    const { result } = renderHook(() => useAgentHistory());
    act(() => result.current.record({ id: "chat-1", messages, workflowName: "Fox", tabId: "tab-1", workflowId: "wf-1" }));
    expect(result.current.conversations).toMatchObject([{ id: "chat-1", workflowName: "Fox", tabId: "tab-1", workflowId: "wf-1" }]);
  });

  it("deleting a conversation forgets the runs it started", () => {
    const { result } = renderHook(() => useAgentHistory());
    act(() => result.current.record({ id: "chat-1", messages }));
    act(() => result.current.remove("chat-1"));
    expect(result.current.conversations).toEqual([]);
    expect(forgetChatRuns).toHaveBeenCalledWith("chat-1");
  });

  it("never brings back a deleted conversation when its turn's late record lands", () => {
    const { result } = renderHook(() => useAgentHistory());
    act(() => result.current.record({ id: "chat-1", messages }));
    act(() => result.current.remove("chat-1"));
    // The turn's save waited for its steps (a save, a tab switch) and arrives after the delete.
    const later: AgentUIMessage[] = [...messages, { id: "a1", role: "assistant", parts: [{ type: "text", text: "Done." }] }];
    act(() => result.current.record({ id: "chat-1", messages: later }));
    expect(result.current.conversations).toEqual([]);
    expect(JSON.parse(localStorage.getItem("node-banana-agent-conversations") ?? "[]")).toEqual([]);
    // Others still record.
    act(() => result.current.record({ id: "chat-2", messages }));
    expect(result.current.conversations.map((conversation) => conversation.id)).toEqual(["chat-2"]);
  });
});
