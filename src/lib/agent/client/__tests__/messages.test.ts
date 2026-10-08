import { describe, it, expect } from "vitest";
import type { DynamicToolUIPart } from "ai";
import type { AgentUIMessage } from "../../types";
import {
  agentSuggestions,
  builtWorkflows,
  countRenderedParts,
  findHarnessSwitches,
  hasVisibleParts,
  humanizeToolName,
  isRunWorkflowPart,
  latestTurnRejectedSignIn,
  readToolOutput,
  selectionLabel,
  toolCanvasTarget,
  toolDisplayState,
  toolDisplayTitle,
  toolGraphPreview,
  toolGroupSummary,
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

  it("knows a run_workflow call, with or without the MCP prefix", () => {
    expect(isRunWorkflowPart({ toolName: "run_workflow" })).toBe(true);
    expect(isRunWorkflowPart({ toolName: "mcp__node_banana__run_workflow" })).toBe(true);
    expect(isRunWorkflowPart({ toolName: "edit_workflow" })).toBe(false);
  });

  it("reads where Show on canvas goes: a finished call's nodes, and its tab", () => {
    const done = (output: unknown) => tool({ state: "output-available", output });
    expect(toolCanvasTarget(done({ ok: true, summary: "", tabId: "tab-a", nodeIds: ["n1", "n2"] }))).toEqual({
      tabId: "tab-a",
      nodeIds: ["n1", "n2"],
    });
    expect(toolCanvasTarget(done({ ok: true, summary: "", nodeIds: ["n1", 7, ""] }))).toEqual({ nodeIds: ["n1"] });
    expect(toolCanvasTarget(done({ ok: true, summary: "", nodeIds: [] }))).toBeNull();
    expect(toolCanvasTarget(done({ ok: false, summary: "", nodeIds: ["n1"] }))).toBeNull();
    expect(toolCanvasTarget(tool({ state: "input-available" }))).toBeNull();
  });
});

describe("toolGroupSummary", () => {
  const done = (toolName: string, output: unknown, toolCallId = toolName) =>
    tool({ toolName, toolCallId, state: "output-available", output });
  const read = done("get_workflow", { ok: true, summary: "Read the workflow (3 nodes)" });

  it("counts the calls and says what the one edit did, to follow the count", () => {
    const edit = done("edit_workflow", { ok: true, summary: "Updated 4 nodes", nodeIds: ["a", "b", "c", "d"] });
    expect(toolGroupSummary([read, edit])).toEqual({ label: "Used 2 tools", running: null, result: "updated 4 nodes", failed: null });
  });

  it("counts the nodes several edits touched between them, each once and per tab", () => {
    const create = done("create_workflow", { ok: true, summary: "Added 3 nodes", tabId: "t1", nodeIds: ["a", "b", "c"] }, "c1");
    const edit = done("edit_workflow", { ok: true, summary: "Updated 2 nodes", tabId: "t1", nodeIds: ["b", "c"] }, "c2");
    const other = done("edit_workflow", { ok: true, summary: "Updated 1 node", tabId: "t2", nodeIds: ["a"] }, "c3");
    expect(toolGroupSummary([create, edit, other]).result).toBe("changed 4 nodes");
  });

  it("gives a lone call's own result, and nothing for reads alone", () => {
    expect(toolGroupSummary([read])).toMatchObject({ label: "Used 1 tool", result: "read the workflow (3 nodes)" });
    expect(toolGroupSummary([read, done("search_models", { ok: true, summary: "Found 4 models" })]).result).toBeNull();
  });

  it("falls back to the run a call started", () => {
    const run = done("mcp__node_banana__run_workflow", { ok: true, summary: "Started the workflow" });
    expect(toolGroupSummary([read, run]).result).toBe("started the workflow");
  });

  it("keeps a capital that starts a name", () => {
    expect(toolGroupSummary([done("edit_workflow", { ok: true, summary: "LLM prompt set", nodeIds: ["a"] })]).result).toBe(
      "LLM prompt set",
    );
  });

  it("counts failed and refused calls", () => {
    const refused = done("run_workflow", { ok: false, summary: "Inputs not ready" });
    const errored = tool({ toolCallId: "e", state: "output-error", errorText: "Bad handle" });
    expect(toolGroupSummary([read, refused, errored]).failed).toBe("2 failed");
    expect(toolGroupSummary([refused])).toMatchObject({ result: null, failed: "failed" });
  });

  it("names the call still running", () => {
    const running = tool({ toolCallId: "r", title: "Edit workflow", state: "input-available" });
    expect(toolGroupSummary([read, running]).running).toBe("Edit workflow…");
    expect(toolGroupSummary([read]).running).toBeNull();
  });
});

describe("built workflows", () => {
  const graph = (count: number, name?: string) => ({
    ...(name ? { name } : {}),
    nodes: Array.from({ length: count }, (_, i) => ["prompt", i * 400, 0, 320, 220]),
    edges: count > 1 ? [[0, 1]] : [],
  });
  const done = (toolName: string, toolCallId: string, output: unknown) => tool({ toolName, toolCallId, state: "output-available", output });

  it("reads a call's graph, and nothing from a malformed one", () => {
    expect(toolGraphPreview(done("create_workflow", "c", { ok: true, summary: "", graph: graph(2, " Cats ") }))).toEqual({
      name: "Cats",
      nodes: graph(2).nodes,
      edges: [[0, 1]],
    });
    for (const bad of [
      { nodes: [], edges: [] },
      { nodes: [["prompt", 0, 0, 320]], edges: [] },
      { nodes: [["prompt", 0, 0, 320, "tall"]], edges: [] },
      { nodes: graph(2).nodes, edges: [[0, 2]] },
      { nodes: graph(2).nodes, edges: [[0.5, 1]] },
      { nodes: graph(2).nodes },
    ]) {
      expect(toolGraphPreview(done("create_workflow", "c", { ok: true, summary: "", graph: bad }))).toBeNull();
    }
    expect(toolGraphPreview(done("create_workflow", "c", { ok: false, summary: "", graph: graph(2) }))).toBeNull();
    expect(toolGraphPreview(tool({ state: "input-available" }))).toBeNull();
  });

  it("puts one workflow per tab on the call that built it, as the reply's last edit to that tab left it", () => {
    const parts = [
      done("update_node", "u0", { ok: true, summary: "", tabId: "tab-a", graph: graph(9) }),
      done("mcp__node_banana__create_workflow", "c1", { ok: true, summary: "", tabId: "tab-b", graph: graph(2) }),
      done("create_workflow", "c2", { ok: true, summary: "", tabId: "tab-c", graph: graph(1) }),
      done("edit_workflow", "e1", { ok: true, summary: "", tabId: "tab-b", graph: graph(3) }),
    ] as AgentUIMessage["parts"];
    const built = builtWorkflows(parts);
    expect([...built.keys()]).toEqual(["c1", "c2"]);
    expect(built.get("c1")).toMatchObject({ tabId: "tab-b" });
    expect(built.get("c1")!.graph.nodes).toHaveLength(3);
    expect(built.get("c2")!.graph.nodes).toHaveLength(1);
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

  it("draws the Run card", () => {
    const offer = {
      type: "data-run-offer",
      id: "run-offer",
      data: { offerId: "o1", primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: [] }, alternatives: [] },
    } as Part;
    expect(hasVisibleParts(assistant([offer]))).toBe(true);
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
    expect(selectionLabel(1)).toBe("1 selected");
    expect(selectionLabel(3)).toBe("3 selected");
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
