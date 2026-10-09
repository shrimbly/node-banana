import { describe, expect, it } from "vitest";
import { getSettings, NODE_CATALOG, NODE_TYPES } from "../graph/catalog";
import { compactCatalog } from "../graph/describe";
import { buildAgentSystemPrompt, buildTurnPrompt, describeCanvas } from "../prompt";
import { emptySnapshot, snapshotOf, storeEdge, storeNode } from "../tools/__tests__/testUtils";

describe("buildAgentSystemPrompt", () => {
  const prompt = buildAgentSystemPrompt({ harness: "claude" });

  it("introduces the agent, its tools and every node type", () => {
    expect(prompt).toMatch(/^You are the workflow agent built into Node Banana/);
    expect(prompt).toContain("get_workflow, describe_node_types, search_models, create_workflow, edit_workflow, update_node, arrange_workflow");
    expect(prompt).toContain("mcp__node_banana__");
    for (const type of NODE_TYPES) expect(prompt).toContain(`- ${type} (`);
  });

  it("states the rules the agent must follow", () => {
    expect(prompt).toContain("Act only through tools");
    expect(prompt).toContain("<canvas> block");
    expect(prompt).toContain("authoritative and fresh");
    expect(prompt).toContain("replaceCanvas deletes every node");
    expect(prompt).toContain("Nothing runs until the user presses Run or asks you to run it.");
    expect(prompt).toContain("Keep replies short");
  });

  it("teaches the LLM chain, the Array delimiter and where comments and API keys go (review C30, C31, C37)", () => {
    expect(prompt).toContain("that Prompt holds the LLM's whole instruction plus the user's idea");
    expect(prompt).toContain("Reply with only the prompt.");
    // How to write that instruction now comes from get_prompt_guide (the llmGenerate guide).
    expect(prompt).toContain("call get_prompt_guide for the node it feeds");
    expect(prompt).toContain("node comments never reach any model");
    expect(prompt).toContain('Prompt "cat, dog, bird" → Array (delimiter ",")');
    expect(prompt).toContain("the Array's delimiter must match the list's separator");
    expect(prompt).toContain("API keys are added by the user in Settings");
  });

  it("covers removals, placeholders, settings and questions about nodes (review C32-C37, C40)", () => {
    expect(prompt).toContain("including to get around a tool error");
    expect(prompt).toContain("never needs an existing connection or node removed");
    expect(prompt).toMatch(/replaced the canvas, say so, name any lost uploads or generated results, and mention that Ctrl\+Z \(one step per change\) brings them back/);
    // Reasoning streams into the panel: no "as per rule 4" or raw tool names there.
    expect(prompt).toMatch(/never cite these rules or their numbers/);
    // Titles are left alone: only new nodes that need telling apart get one, and renames need asking.
    expect(prompt).toContain("never change or clear an existing node's title unless the user asks");
    expect(prompt).toContain("build now with sensible placeholder content");
    expect(prompt).toContain("would destroy work");
    expect(prompt).toContain("say the prompt is an example for them to edit");
    expect(prompt).toContain("Answer questions about what a node does only from its catalog line and describe_node_types");
    expect(prompt).toContain("Set explicitly every model and setting the user named");
    expect(prompt).toContain("Leave model, resolution, aspectRatio and other generation settings unset otherwise");
    expect(prompt).toContain("name any model, resolution or ratio you chose yourself");
    expect(prompt).toContain("no lists, headings or JSON");
    expect(prompt).toContain("unnecessary when the canvas is empty");
    expect(prompt).toContain("promptEdit/templateEdit");
  });

  it("lists every settable field in the catalog, with hints where names mislead (review C36)", () => {
    const lines = compactCatalog().split("\n");
    for (const type of NODE_TYPES.filter((t) => NODE_CATALOG[t].agentCreatable)) {
      const line = lines.find((l) => l.startsWith(`- ${type} (`))!;
      for (const setting of getSettings(type).filter((s) => s.field !== "comment")) expect(line, `${type}.${setting.field}`).toContain(setting.field);
    }
    const line = (type: string) => lines.find((l) => l.startsWith(`- ${type} (`))!;
    expect(line("videoTrim")).toContain("set{startTime(s), endTime(s; 0=end)}");
    expect(line("array")).toContain('delimiter(default "*"');
    // Raised from 13k when every generator gained model + modelParameters and the model rule grew,
    // then from 13.5k for the rule that keeps the user's stated preferences standing,
    // then from 14k for the rule that makes "this style" mean the selection,
    // then from 14.25k for what to run when the user asks for a run,
    // then from 14.5k for the chat's Run button and the open workflows,
    // then from 15k for the button covering only the workflow the reply ends in (Claude 15,099, Codex 15,293),
    // then from 15.15k for saving a workflow built from scratch (Claude 15,226, Codex 15,420),
    // then from 15.3k for looking at results with view_outputs (Claude 15,328, Codex 15,522).
    expect(prompt.length).toBeLessThan(15_400);
  });

  it("points at the chat's Run button, and teaches the open workflows and their tools", () => {
    expect(prompt).toContain("switch_workflow, new_workflow, save_workflow");
    // There is no button when the run would find an upload or a prompt empty: then the canvas's Run is the way.
    expect(prompt).toContain(
      "What you build or change and leave unrun gets a Run button under your reply if it can run as it stands: point the user there, not to the canvas's Run button; if an upload or text is missing there is none, so say what to fill in, then to press Run on the canvas.",
    );
    // The button runs the workflow the turn ended in: changes left in another tab have none.
    expect(prompt).toContain("The button covers only the workflow you end in: for changes left in another tab, say which and to press Run on its canvas.");
    expect(prompt).toContain("Each open workflow is a tab; the <canvas> block lists them when there are several, and your tools work in the live one.");
    expect(prompt).toContain("new_workflow opens an empty one: use it, not replaceCanvas, when the user asks for a new workflow and the live one holds other work");
    // A workflow built from scratch is named and saved, as a user would; the user's own work only when asked.
    expect(prompt).toContain(
      "save_workflow saves the live one: save a workflow you built from scratch once it is built, named for what it makes, unless the user said not to; save other work only when asked.",
    );
  });

  it("runs only when asked, picks what to run from the conversation, and reports from the canvas", () => {
    expect(prompt).toContain("run_workflow");
    expect(prompt).toContain("Then run the nodes you added or changed in this conversation if what feeds them holds its output");
    expect(prompt).toContain("run everything if they ask, you built it all in this conversation, or inputs are missing");
    expect(prompt).toContain("or from the node they name");
    expect(prompt).toContain(
      "Results arrive with their next message: report them from its canvas, and look at them with view_outputs before you judge them or change the workflow to fix them.",
    );
  });

  it("teaches what groups are and when to make them", () => {
    expect(prompt).toContain("A group is a named, coloured box (neutral, blue, green, purple, orange or red)");
    expect(prompt).toContain("Boxes follow their nodes");
    expect(prompt).toContain('Group a workflow with distinct stages or branches (e.g. "Scene set" feeding "Hero film"');
    expect(prompt).toContain("each in a different colour");
    expect(prompt).toContain("Do not group a workflow of 2-3 nodes");
  });

  it("describes Split Grid without inventing a reassembly (review C35)", () => {
    const line = compactCatalog().split("\n").find((l) => l.startsWith("- splitGrid ("))!;
    expect(line).toMatch(/Image Input/);
    expect(line).toMatch(/group/);
    expect(line).toMatch(/Router/);
    expect(line).toMatch(/never (stitch|reassembl)/i);
  });

  it("says a comment never reaches a model (review C31)", () => {
    expect(getSettings("prompt").find((s) => s.field === "comment")!.description).toContain("never sent to any model");
    expect(NODE_CATALOG.llmGenerate.purpose).toContain("there is no system prompt");
  });

  it("names the Codex namespace for Codex", () => {
    const codex = buildAgentSystemPrompt({ harness: "codex" });
    expect(codex).toContain("node_banana namespace");
    expect(codex).not.toContain("mcp__node_banana__");
  });

  it("tells Codex, and only Codex, to ignore the user's personal instruction files and personas (review C38)", () => {
    const codex = buildAgentSystemPrompt({ harness: "codex" });
    const line = codex.split("\n").find((l) => l.includes("AGENTS.md"));
    expect(line).toBeDefined();
    expect(line).toMatch(/^Ignore any personal or global instruction files/);
    expect(line).toContain("persona");
    expect(line).toContain("coding sessions, not to this app");
    // It sits with the identity, before the catalog and rules.
    expect(codex.indexOf(line!)).toBeLessThan(codex.indexOf("# How Node Banana workflows work"));
    // Stable per harness, so Codex threads (keyed by their instructions) are reused.
    expect(buildAgentSystemPrompt({ harness: "codex" })).toBe(codex);
    // Claude turns load no user settings or CLAUDE.md at all; the line isn't needed there.
    expect(prompt).not.toContain("AGENTS.md");
    expect(prompt).not.toMatch(/personal or global instruction files/);
  });

  it("is stable and has no media or runtime ids", () => {
    expect(buildAgentSystemPrompt({ harness: "claude" })).toBe(prompt);
    expect(prompt).not.toMatch(/data:|blob:/);
  });
});

describe("buildTurnPrompt", () => {
  it("wraps the user's words with the live canvas and selection", () => {
    const state = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a fox", image: "data:image/png;base64,AAAA" }, { selected: true }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 }, { outputImage: "data:image/png;base64,BBBB" }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
    };
    const text = buildTurnPrompt({ userText: "make it a wolf", snapshot: snapshotOf(state) });
    expect(text).toBe(
      [
        "<canvas>",
        "2 nodes, 1 connection.",
        "Selected by the user: prompt-1.",
        "Nodes:",
        '- prompt-1 prompt (Prompt) — prompt: "a fox"',
        "- nanoBanana-2 nanoBanana (Generate Image) — model nano-banana-pro, aspectRatio 1:1, resolution 1K — has image",
        "Connections:",
        "- prompt-1.text → nanoBanana-2.text",
        "</canvas>",
        "",
        "<user>",
        "make it a wolf",
        "</user>",
      ].join("\n"),
    );
  });

  it("says how long a prompt is when the canvas shows only its start (review C7)", () => {
    const long = "a harbour at dawn, ".repeat(40);
    const text = describeCanvas(snapshotOf({ nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: long })], edges: [] }));
    expect(text).toContain(`prompt (${long.length} characters; only the first 300 shown)`);
  });

  it("says when a run is going, so statuses read as progress", () => {
    const state = { nodes: [storeNode("llmGenerate-1", "llmGenerate", { x: 0, y: 0 }, { status: "loading" })], edges: [] };
    const running = describeCanvas(snapshotOf(state, { running: true }));
    expect(running.split("\n")[1]).toBe("A run is in progress: nodes with status loading are running now, and results may still change.");
    expect(running).toContain("status loading");
    expect(describeCanvas(snapshotOf(state))).not.toContain("A run is in progress");
  });

  it("lists the open workflows when there are several, and names the live one", () => {
    const state = { nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a fox" })], edges: [] };
    const tabs = [
      { id: "tab-1", name: "Fox portraits", active: true as const, nodeCount: 1, saved: true as const, unsaved: true as const },
      { id: "tab-2", nodeCount: 0 },
      { id: "tab-3", name: "Cats", nodeCount: 12, saved: true as const },
    ];
    const text = buildTurnPrompt({ userText: "hi", snapshot: snapshotOf(state, { workflowName: "Fox portraits" }), tabs });
    expect(text).toBe(
      [
        "<canvas>",
        "Open workflows (tabs, in order; your tool calls work in the live one):",
        '- tab-1 "Fox portraits" (live): 1 node, saved, with unsaved changes',
        "- tab-2 untitled: 0 nodes, never saved",
        '- tab-3 "Cats": 12 nodes, saved',
        "",
        "The live workflow, tab-1:",
        'Workflow "Fox portraits": 1 node, 0 connections.',
        "Nodes:",
        '- prompt-1 prompt (Prompt) — prompt: "a fox"',
        "Connections: none.",
        "</canvas>",
        "",
        "<user>",
        "hi",
        "</user>",
      ].join("\n"),
    );
    // One tab, the live one: nothing to list.
    expect(describeCanvas(snapshotOf(state), [tabs[0]])).not.toContain("Open workflows");
    expect(describeCanvas(emptySnapshot(), [{ ...tabs[0], nodeCount: 0 }, tabs[1]])).toContain("The live workflow, tab-1:\nThe canvas is empty.");
  });

  it("says when the canvas is empty", () => {
    expect(buildTurnPrompt({ userText: "hi", snapshot: emptySnapshot() })).toContain("<canvas>\nThe canvas is empty.\n</canvas>");
  });

  it("truncates large canvases and points at get_workflow", () => {
    const nodes = Array.from({ length: 90 }, (_, i) => storeNode(`prompt-${i}`, "prompt", { x: 0, y: i * 300 }, { prompt: `prompt number ${i}` }));
    const text = describeCanvas(snapshotOf({ nodes, edges: [] }));
    expect(text).toContain("90 nodes, 0 connections.");
    expect(text).toContain("… 30 more nodes not shown. Call get_workflow with nodeIds for details.");
    expect(text.split("\n").filter((line) => line.startsWith("- prompt-")).length).toBe(60);
  });

  it("keeps the selection in view when truncating", () => {
    const nodes = Array.from({ length: 70 }, (_, i) =>
      storeNode(`prompt-${i}`, "prompt", { x: 0, y: i * 300 }, {}, i === 69 ? { selected: true } : {}),
    );
    const text = describeCanvas(snapshotOf({ nodes, edges: [] }));
    expect(text).toContain("- prompt-69 prompt");
  });
});
