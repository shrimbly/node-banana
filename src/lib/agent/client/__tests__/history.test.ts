import { describe, expect, it } from "vitest";
import type { AgentUIMessage } from "../../types";
import { conversationLabel, conversationSummary, fitHistory, MAX_CONVERSATIONS, type AgentConversation } from "../history";

const user = (id: string, text: string): AgentUIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const reply = (id: string, summary?: string, input: unknown = {}): AgentUIMessage => ({
  id,
  role: "assistant",
  parts: [
    ...(summary ? [{ type: "data-agent-summary" as const, id: "summary", data: { summary } }] : []),
    { type: "dynamic-tool", toolName: "edit_workflow", toolCallId: `c-${id}`, state: "output-available", input, output: {} },
    { type: "text", text: "Done." },
  ] as AgentUIMessage["parts"],
});
const conversation = (id: string, updatedAt: number, messages: AgentUIMessage[]): AgentConversation => ({
  id,
  createdAt: updatedAt,
  updatedAt,
  messages,
});

describe("conversation labels", () => {
  it("uses the agent's latest summary, else the first message", () => {
    const messages = [user("u1", "Build a hero  film\\n please"), reply("a1", "Hero film"), user("u2", "now a set"), reply("a2", "Hero film and scene set")];
    expect(conversationSummary(messages)).toBe("Hero film and scene set");
    expect(conversationLabel({ messages: [user("u1", "Build a hero film")] })).toBe("Build a hero film");
  });
});

describe("fitHistory", () => {
  it("keeps the newest conversations within the count cap", () => {
    const many = Array.from({ length: MAX_CONVERSATIONS + 5 }, (_, i) => conversation(`c${i}`, i, [user("u", "hi")]));
    const kept = fitHistory(many);
    expect(kept).toHaveLength(MAX_CONVERSATIONS);
    expect(kept[0].id).toBe(`c${MAX_CONVERSATIONS + 4}`);
  });

  it("drops tool inputs from an oversized conversation before dropping it", () => {
    const big = conversation("big", 2, [user("u", "hi"), reply("a", undefined, { workflow: "x".repeat(5_000) })]);
    const small = conversation("small", 1, [user("u", "hi")]);
    const [first, second] = fitHistory([big, small], 3_000);
    expect(first.id).toBe("big");
    expect(JSON.stringify(first)).not.toContain("xxxx");
    expect(second.id).toBe("small");
  });
});
