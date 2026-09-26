import { describe, it, expect } from "vitest";
import type { AgentHarnessId, AgentUIMessage } from "../../types";
import { findLatestAgentSession, sessionIdForHarness } from "../session";

let counter = 0;
const user = (text: string): AgentUIMessage => ({
  id: `u${++counter}`,
  role: "user",
  parts: [{ type: "text", text }],
});
const reply = (harness: AgentHarnessId, sessionId?: string): AgentUIMessage => ({
  id: `a${++counter}`,
  role: "assistant",
  metadata: { harness },
  parts: [
    { type: "text", text: "ok" },
    ...(sessionId
      ? [{ type: "data-agent-session" as const, id: "session", data: { harness, sessionId } }]
      : []),
  ],
});

describe("sessionIdForHarness", () => {
  it("is undefined for a new chat", () => {
    expect(sessionIdForHarness([], "claude")).toBeUndefined();
    expect(sessionIdForHarness([user("hi")], "claude")).toBeUndefined();
  });

  it("resumes the latest session on the same harness", () => {
    const messages = [user("a"), reply("claude", "s1"), user("b"), reply("claude", "s2"), user("c")];
    expect(sessionIdForHarness(messages, "claude")).toBe("s2");
    expect(findLatestAgentSession(messages)).toEqual({ harness: "claude", sessionId: "s2" });
  });

  it("starts fresh after a switch, so the other harness gets the full history", () => {
    const messages = [user("a"), reply("claude", "s1"), user("b"), reply("codex", "t1"), user("c")];
    expect(sessionIdForHarness(messages, "codex")).toBe("t1");
    // Back on Claude: its session never saw the Codex turn.
    expect(sessionIdForHarness(messages, "claude")).toBeUndefined();
  });

  it("looks past replies that carried no session (e.g. a sign-in notice)", () => {
    const messages = [user("a"), reply("claude", "s1"), user("b"), reply("codex"), user("c")];
    expect(sessionIdForHarness(messages, "claude")).toBe("s1");
  });
});
