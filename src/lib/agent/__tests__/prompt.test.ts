import { describe, expect, it } from "vitest";
import { getSettings, NODE_CATALOG, NODE_TYPES } from "../graph/catalog";
import { compactCatalog } from "../graph/describe";
import { buildAgentSystemPrompt, buildTurnPrompt, describeCanvas } from "../prompt";
import { emptySnapshot, snapshotOf, storeEdge, storeNode } from "../tools/__tests__/testUtils";

describe("buildAgentSystemPrompt", () => {
  const prompt = buildAgentSystemPrompt({ harness: "claude" });

  it("introduces the agent, its tools and every node type", () => {
    expect(prompt).toMatch(/^You are the workflow agent built into Node Banana/);
    expect(prompt).toContain("get_workflow, describe_node_types, list_models, create_workflow, edit_workflow, update_node, arrange_workflow");
    expect(prompt).toContain("mcp__node_banana__");
    for (const type of NODE_TYPES) expect(prompt).toContain(`- ${type} (`);
  });

  it("states the rules the agent must follow", () => {
    expect(prompt).toContain("Act only through tools");
    expect(prompt).toContain("<canvas> block");
    expect(prompt).toContain("authoritative and fresh");
    expect(prompt).toContain("replaceCanvas deletes every node");
    expect(prompt).toContain("You never run or generate anything yourself");
    expect(prompt).toContain("Keep replies short");
  });

  it("teaches the LLM chain, the Array delimiter and where comments and API keys go (review C30, C31, C37)", () => {
    expect(prompt).toContain("that Prompt holds the LLM's whole instruction plus the user's idea");
    expect(prompt).toContain("Reply with only the prompt.");
    expect(prompt).toContain("Exception: a Prompt that feeds LLM Generate is the LLM's instruction");
    expect(prompt).toContain("node comments never reach any model");
    expect(prompt).toContain('Prompt "cat, dog, bird" → Array (delimiter ",")');
    expect(prompt).toContain("the Array's delimiter must match the list's separator");
    expect(prompt).toContain("API keys are added by the user in Settings");
  });

  it("covers removals, placeholders, settings and questions about nodes (review C32-C37, C40)", () => {
    expect(prompt).toContain("including to get around a tool error");
    expect(prompt).toContain("never needs an existing connection or node removed");
    expect(prompt).toMatch(/replaced the canvas, say so, name any lost uploads or generated results, and mention that Ctrl\+Z \(one step per change\) or "Revert AI Changes" \(everything from this reply\)/);
    // Reasoning streams into the panel: no "as per rule 4" or raw tool names there.
    expect(prompt).toMatch(/never cite these rules or their numbers/);
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
    expect(prompt.length).toBeLessThan(13_000);
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
