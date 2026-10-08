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
});
