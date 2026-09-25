import { describe, it, expect } from "vitest";
import type { DynamicToolUIPart } from "ai";
import type { AgentUIMessage } from "../../types";
import {
  agentSuggestions,
  countRenderedParts,
  findHarnessSwitches,
  hasVisibleParts,
  humanizeToolName,
  latestTurnRejectedSignIn,
  readToolOutput,
  selectionLabel,
  toolDisplayState,
  toolDisplayTitle,
  toolSummaryLine,
  turnIndicatorText,
} from "../messages";

type Part = AgentUIMessage["parts"][number];

const assistant = (parts: Part[], harness?: "claude" | "codex", id = "a1"): AgentUIMessage => ({
  id,
  role: "assistant",
  parts,
  ...(harness ? { metadata: { harness } } : {}),
});
const user = (id = "u1"): AgentUIMessage => ({ id, role: "user", parts: [{ type: "text", text: "hi" }] });

const tool = (overrides: Partial<DynamicToolUIPart> & Pick<DynamicToolUIPart, "state">): DynamicToolUIPart =>
  ({
    type: "dynamic-tool",
    toolName: "edit_workflow",
    toolCallId: "call-1",
    input: {},
    ...overrides,
  }) as DynamicToolUIPart;

describe("tool display", () => {
  it("humanizes tool names, with or without the MCP prefix", () => {
    expect(humanizeToolName("mcp__node_banana__edit_workflow")).toBe("Edit workflow");
    expect(humanizeToolName("create_workflow")).toBe("Create workflow");
    expect(humanizeToolName("")).toBe("Tool");
  });

  it("prefers the route's title", () => {
    expect(toolDisplayTitle({ title: "Update node", toolName: "update_node" })).toBe("Update node");
    expect(toolDisplayTitle({ title: "  ", toolName: "update_node" })).toBe("Update node");
    expect(toolDisplayTitle({ toolName: "get_workflow" })).toBe("Get workflow");
  });

  it("reads only the { ok, summary } output shape", () => {
    expect(readToolOutput({ ok: true, summary: "Added 2 nodes" })).toEqual({ ok: true, summary: "Added 2 nodes" });
    expect(readToolOutput({ ok: false })).toEqual({ ok: false, summary: "" });
    expect(readToolOutput("text")).toBeNull();
    expect(readToolOutput({ summary: "no ok" })).toBeNull();
  });

  it("shows a rejected call as an error", () => {
    expect(toolDisplayState(tool({ state: "output-available", output: { ok: false, summary: "Unknown node" } }))).toBe(
      "output-error",
    );
    expect(toolDisplayState(tool({ state: "output-available", output: { ok: true, summary: "Done" } }))).toBe(
      "output-available",
    );
    expect(toolDisplayState(tool({ state: "input-available" }))).toBe("input-available");
  });

  it("summarizes results and errors in one line", () => {
    expect(toolSummaryLine(tool({ state: "output-available", output: { ok: true, summary: "Added 4 nodes" } }))).toBe(
      "Added 4 nodes",
    );
    expect(toolSummaryLine(tool({ state: "output-error", errorText: "Bad handle" }))).toBe("Bad handle");
    expect(toolSummaryLine(tool({ state: "input-available" }))).toBeNull();
  });
});

describe("rendered parts", () => {
  it("skips empty reasoning (hidden thinking) and bookkeeping parts", () => {
    const message = assistant([
      { type: "step-start" },
      { type: "reasoning", text: "" },
      { type: "data-agent-session", id: "session", data: { harness: "claude", sessionId: "s" } },
    ]);
    expect(hasVisibleParts(message)).toBe(false);
    expect(countRenderedParts([user(), message])).toBe(0);
  });

  it("counts text, reasoning, tools and notices of the current reply only", () => {
    const message = assistant([
      { type: "reasoning", text: "Thinking about it" },
      { type: "text", text: "Sure." },
      tool({ state: "output-available", output: { ok: true, summary: "ok" } }),
      { type: "data-agent-notice", data: { code: "usage_limit", message: "Limit", harness: "claude" } },
    ]);
    expect(countRenderedParts([user(), message])).toBe(4);
    expect(countRenderedParts([message, user("u2")])).toBe(0);
  });
});

describe("turnIndicatorText", () => {
  it("is empty when idle", () => {
    expect(turnIndicatorText([user()], false, null)).toBeNull();
  });

  it("says Thinking… until something renders", () => {
    expect(turnIndicatorText([user()], true, null)).toBe("Thinking…");
    expect(turnIndicatorText([user(), assistant([{ type: "reasoning", text: "" }])], true, null)).toBe("Thinking…");
  });

  it("shows the server's status line until something new renders", () => {
    const line = { text: "Planning edits…", renderedParts: 1 };
    const oneText = [user(), assistant([{ type: "text", text: "On it.", state: "done" }])];
    expect(turnIndicatorText(oneText, true, line)).toBe("Planning edits…");
    const withTool = [
      user(),
      assistant([{ type: "text", text: "On it.", state: "done" }, tool({ state: "input-available" })]),
    ];
    expect(turnIndicatorText(withTool, true, line)).toBeNull();
  });

  it("stays quiet while text streams or a tool runs, and says Working… in between", () => {
    expect(turnIndicatorText([user(), assistant([{ type: "text", text: "Hel", state: "streaming" }])], true, null)).toBeNull();
    expect(turnIndicatorText([user(), assistant([tool({ state: "input-available" })])], true, null)).toBeNull();
    expect(
      turnIndicatorText([user(), assistant([tool({ state: "output-available", output: { ok: true, summary: "" } })])], true, null),
    ).toBe("Working…");
  });
});

describe("findHarnessSwitches", () => {
  it("marks the first reply after a harness change", () => {
    const messages = [
      user("u1"),
      assistant([], "claude", "a1"),
      user("u2"),
      assistant([], "claude", "a2"),
      user("u3"),
      assistant([], "codex", "a3"),
      user("u4"),
      assistant([], undefined, "a4"),
      user("u5"),
      assistant([], "claude", "a5"),
    ];
    // Keyed on the user message each new harness answered: the divider goes above the question.
    expect([...findHarnessSwitches(messages)]).toEqual([
      ["u3", "codex"],
      ["u5", "claude"],
    ]);
  });

  it("marks the reply itself when no user message leads its turn", () => {
    const messages = [user("u1"), assistant([], "claude", "a1"), assistant([], "codex", "a2")];
    expect([...findHarnessSwitches(messages)]).toEqual([["a2", "codex"]]);
  });
});

describe("labels", () => {
  it("describes the selection", () => {
    expect(selectionLabel(0)).toBeNull();
    expect(selectionLabel(1)).toBe("1 node selected — the agent will focus on it");
    expect(selectionLabel(3)).toBe("3 nodes selected — the agent will focus on them");
  });

  it("suggests building on an empty canvas and editing a full one", () => {
    expect(agentSuggestions(false)[0]).toMatch(/Build/);
    expect(agentSuggestions(true)[0]).toMatch(/Explain/);
    expect(agentSuggestions(true)).toHaveLength(4);
  });
});

describe("latestTurnRejectedSignIn", () => {
  const notice = (code: "not_signed_in" | "wrong_billing" | "usage_limit", harness: "claude" | "codex" = "claude"): Part =>
    ({ type: "data-agent-notice", id: "notice", data: { code, message: "x", harness } }) as Part;
  const text: Part = { type: "text", text: "Done." };

  it("is true when the latest assistant message carries a not_signed_in notice for the harness", () => {
    const messages = [user("u1"), assistant([notice("not_signed_in")], "claude", "a1")];
    expect(latestTurnRejectedSignIn(messages, "claude")).toBe(true);
    expect(latestTurnRejectedSignIn(messages, "codex")).toBe(false);
    // A follow-up the user just sent doesn't hide it.
    expect(latestTurnRejectedSignIn([...messages, user("u2")], "claude")).toBe(true);
  });

  it("is false after a later turn ran, for other notices, and for an empty chat", () => {
    const rejected = assistant([notice("not_signed_in")], "claude", "a1");
    expect(latestTurnRejectedSignIn([user("u1"), rejected, user("u2"), assistant([text], "claude", "a2")], "claude")).toBe(false);
    expect(latestTurnRejectedSignIn([user("u1"), assistant([notice("wrong_billing")], "claude")], "claude")).toBe(false);
    expect(latestTurnRejectedSignIn([user("u1"), assistant([notice("usage_limit")], "claude")], "claude")).toBe(false);
    expect(latestTurnRejectedSignIn([], "claude")).toBe(false);
  });
});
