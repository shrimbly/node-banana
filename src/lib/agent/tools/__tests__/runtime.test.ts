import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@/types";
import { getConnectedInputsPure, validateWorkflowPure } from "@/store/utils/connectedInputs";
import { parseTextToArray } from "@/utils/arrayParser";
import type { AgentGraphOp } from "../../types";
import { isValidConnectionPort } from "../../graph/handles";
import { createAgentToolRuntime } from "../runtime";
import {
  applyResult,
  call,
  edgeKeys,
  emptySnapshot,
  runtimeFor,
  sequentialIds,
  snapshotOf,
  storeEdge,
  storeNode,
  type StoreState,
} from "./testUtils";

const EMPTY: StoreState = { nodes: [], edges: [] };
const VIEWPORT = { x: 0, y: 0, width: 1600, height: 900, zoom: 1 };

function addNodeOps(ops: AgentGraphOp[]) {
  return ops.filter((op): op is Extract<AgentGraphOp, { op: "addNode" }> => op.op === "addNode");
}
function addEdgeOps(ops: AgentGraphOp[]) {
  return ops.filter((op): op is Extract<AgentGraphOp, { op: "addEdge" }> => op.op === "addEdge");
}

describe("create_workflow", () => {
  it("describes and validates new nodes by the user's saved defaults, without forcing them", async () => {
    const runtime = createAgentToolRuntime({
      ...emptySnapshot(),
      nodeDefaults: {
        nanoBanana: {
          model: "nano-banana-pro",
          selectedModel: { provider: "gemini", modelId: "nano-banana-2", displayName: "Nano Banana 2" },
          aspectRatio: "16:9",
          resolution: "2K",
        },
      },
    });
    const created = await call(runtime, "create_workflow", { nodes: [{ ref: "g", type: "nanoBanana" }], connections: [] });
    expect(created.ok).toBe(true);
    expect(created.text).toContain("model nano-banana-2, aspectRatio 16:9, resolution 2K");
    // The browser applies its own defaults: nothing about the model is sent.
    expect(addNodeOps(created.ops)[0].data).toEqual({});
    // 512 exists only on nano-banana-2, the model this node really starts with.
    const updated = await call(runtime, "update_node", { node: "nanoBanana-ag1", settings: { resolution: "512" } });
    expect(updated.ok).toBe(true);
  });

  it("builds prompt → nanoBanana → output with resolved ids, handles and positions", async () => {
    const runtime = runtimeFor(EMPTY, { viewport: VIEWPORT });
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a red fox in snow" } },
        { ref: "g", type: "nanoBanana", settings: { aspectRatio: "16:9" } },
        { ref: "o", type: "output" },
      ],
      connections: [
        { from: "p", to: "g" },
        { from: "g", to: "o" },
      ],
    });

    expect(result.ok).toBe(true);
    const adds = addNodeOps(result.ops);
    expect(adds.map((op) => op.id)).toEqual(["prompt-ag1", "nanoBanana-ag2", "output-ag3"]);
    expect(adds[0].data).toMatchObject({ prompt: "a red fox in snow" });
    expect(adds[1].data).toMatchObject({ aspectRatio: "16:9" });
    // Sticky browser defaults must still apply: the model is not forced.
    expect(adds[1].data).not.toHaveProperty("selectedModel");
    expect(addEdgeOps(result.ops).map((op) => [op.id, op.sourceHandle, op.targetHandle])).toEqual([
      ["edge-prompt-ag1-nanoBanana-ag2-text-text", "text", "text"],
      ["edge-nanoBanana-ag2-output-ag3-image-image", "image", "image"],
    ]);
    // Laid out left to right without overlap.
    expect(adds[0].position.x).toBeLessThan(adds[1].position.x);
    expect(adds[1].position.x).toBeLessThan(adds[2].position.x);
    expect(adds[1].position.x - adds[0].position.x).toBeGreaterThanOrEqual(320 + 100);
    expect(result.text).toContain('ref "p" = prompt-ag1');
    expect(result.summary.length).toBeLessThanOrEqual(80);
    expect(result.summary).toBe("Added 3 nodes, 2 connections");
    expect(result.focusNodeIds).toEqual(["prompt-ag1", "nanoBanana-ag2", "output-ag3"]);

    const store = applyResult(EMPTY, result);
    expect(store.skipped).toEqual([]);
    expect(store.nodes).toHaveLength(3);
    expect(store.nodes[1].data).toMatchObject({ aspectRatio: "16:9", selectedModel: { provider: "gemini", modelId: "nano-banana-pro" } });
    expect(edgeKeys(store.edges)).toEqual([
      "nanoBanana-ag2.image -> output-ag3.image",
      "prompt-ag1.text -> nanoBanana-ag2.text",
    ]);
  });

  it("wires image input + prompt → nanoBanana → llmGenerate and tells the user to upload", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "photo", type: "imageInput", title: "Product photo" },
        { ref: "p", type: "prompt", settings: { prompt: "Place the product on a marble table" } },
        { ref: "gen", type: "nanoBanana", settings: { model: "nano-banana-2", aspectRatio: "4:1", resolution: "512" } },
        { ref: "ask", type: "prompt", settings: { prompt: "Describe this image as ad copy" } },
        { ref: "llm", type: "llmGenerate" },
      ],
      connections: [
        { from: "photo", to: "gen" },
        { from: "p", to: "gen" },
        { from: "gen", to: "llm" },
        { from: "ask", to: "llm" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(addEdgeOps(result.ops).map((op) => `${op.source}.${op.sourceHandle}->${op.target}.${op.targetHandle}`)).toEqual([
      "imageInput-ag1.image->nanoBanana-ag3.image",
      "prompt-ag2.text->nanoBanana-ag3.text",
      "nanoBanana-ag3.image->llmGenerate-ag5.image",
      "prompt-ag4.text->llmGenerate-ag5.text",
    ]);
    const gen = addNodeOps(result.ops).find((op) => op.id === "nanoBanana-ag3")!;
    expect(gen.data).toEqual({
      model: "nano-banana-2",
      selectedModel: { provider: "gemini", modelId: "nano-banana-2", displayName: "Nano Banana 2" },
      aspectRatio: "4:1",
      resolution: "512",
    });
    expect(addNodeOps(result.ops)[0].data).toEqual({ customTitle: "Product photo" });
    expect(result.text).toContain("upload media into imageInput-ag1");
  });

  it("fans an array out to several generators with round-robin item indices", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "list", type: "prompt", settings: { prompt: "a cat * a dog * a bird" } },
        { ref: "arr", type: "array" },
        { ref: "g1", type: "nanoBanana" },
        { ref: "g2", type: "nanoBanana" },
        { ref: "g3", type: "nanoBanana" },
        { ref: "g4", type: "nanoBanana" },
      ],
      connections: [
        { from: "list", to: "arr" },
        { from: "arr", to: "g1" },
        { from: "arr", to: "g2" },
        { from: "arr", to: "g3" },
        { from: "arr", to: "g4" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const fromArray = addEdgeOps(result.ops).filter((op) => op.source === "array-ag2");
    // Connections are numbered in order even past the three known items; the
    // mismatch is reported instead of silently wrapping.
    expect(fromArray.map((op) => op.data?.arrayItemIndex)).toEqual([0, 1, 2, 3]);
    expect(result.text).toContain("array-ag2 (Array) splits the text from prompt-ag1 into 3 items");
    expect(fromArray.every((op) => op.targetHandle === "text")).toBe(true);

    // Every generator lands in its own row of the same column.
    const positions = addNodeOps(result.ops).filter((op) => op.nodeType === "nanoBanana").map((op) => op.position);
    expect(new Set(positions.map((p) => p.x)).size).toBe(1);
    expect(new Set(positions.map((p) => p.y)).size).toBe(4);
  });

  it("numbers fan-out connections when the array's items are not known yet", async () => {
    const state: StoreState = { nodes: [storeNode("llmGenerate-1", "llmGenerate", { x: 0, y: 0 })], edges: [] };
    const runtime = runtimeFor(state);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "arr", type: "array", settings: { splitMode: "newline" } },
        { ref: "a", type: "prompt" },
        { ref: "b", type: "prompt" },
      ],
      connections: [
        { from: "llmGenerate-1", to: "arr" },
        { from: "arr", to: "a" },
        { from: "arr", to: "b", arrayItemIndex: 5 },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(addEdgeOps(result.ops).filter((op) => op.source === "array-ag1").map((op) => op.data?.arrayItemIndex)).toEqual([0, 5]);
  });

  it("routes through a router regardless of connection order", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "neon city" } },
        { ref: "r", type: "router" },
        { ref: "g1", type: "nanoBanana" },
        { ref: "g2", type: "nanoBanana" },
      ],
      // Router outputs are listed before its input: resolved at the end.
      connections: [
        { from: "r", to: "g1" },
        { from: "r", to: "g2" },
        { from: "p", to: "r" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(addEdgeOps(result.ops).map((op) => `${op.source}.${op.sourceHandle}->${op.target}.${op.targetHandle}`)).toEqual([
      "prompt-ag1.text->router-ag2.text",
      "router-ag2.text->nanoBanana-ag3.text",
      "router-ag2.text->nanoBanana-ag4.text",
    ]);
  });

  it("rejects a router output that never gets an input, explaining why", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "r", type: "router" },
        { ref: "o", type: "output" },
      ],
      connections: [{ from: "r", to: "o" }],
    });
    expect(result.ok).toBe(false);
    expect(result.ops).toEqual([]);
    expect(result.text).toContain("router output of type X exists only once an input of type X is connected");
  });

  it("sets up a switch with named outputs and connects by name", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "img", type: "imageInput" },
        { ref: "sw", type: "switch", settings: { switches: [{ name: "Upscale" }, { name: "Skip", enabled: false }] } },
        { ref: "resize", type: "imageResize", settings: { mode: "scale", scalePct: 200 } },
        { ref: "out", type: "output" },
      ],
      connections: [
        { from: "sw", fromHandle: "Upscale", to: "resize" },
        { from: "img", to: "sw" },
        { from: "sw", fromHandle: "skip", to: "out" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const sw = addNodeOps(result.ops).find((op) => op.nodeType === "switch")!;
    expect(sw.data).toEqual({
      switches: [
        { id: "id00000", name: "Upscale", enabled: true },
        { id: "id00001", name: "Skip", enabled: false },
      ],
      inputType: "image",
    });
    expect(addEdgeOps(result.ops).map((op) => `${op.source}.${op.sourceHandle}->${op.target}.${op.targetHandle}`)).toEqual([
      "imageInput-ag1.image->switch-ag2.image",
      "switch-ag2.id00001->output-ag4.image",
      "switch-ag2.id00000->imageResize-ag3.image",
    ]);
  });

  it("builds conditional switch rules and connects rule outputs by label and default", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "llm", type: "llmGenerate" },
        { ref: "q", type: "prompt", settings: { prompt: "Is this a cat or a dog? Answer with one word." } },
        { ref: "cs", type: "conditionalSwitch", settings: { rules: [{ label: "Cats", value: "cat, kitten" }, { label: "Dogs", value: "dog", mode: "exact" }] } },
        { ref: "catPrompt", type: "prompt" },
        { ref: "dogPrompt", type: "prompt" },
        { ref: "otherPrompt", type: "prompt" },
      ],
      connections: [
        { from: "q", to: "llm" },
        { from: "llm", to: "cs" },
        { from: "cs", fromHandle: "Cats", to: "catPrompt" },
        { from: "cs", fromHandle: "dogs", to: "dogPrompt" },
        { from: "cs", fromHandle: "default", to: "otherPrompt" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const cs = addNodeOps(result.ops).find((op) => op.nodeType === "conditionalSwitch")!;
    expect(cs.data.rules).toEqual([
      { id: "rule-id00000", value: "cat, kitten", mode: "contains", label: "Cats", isMatched: false },
      { id: "rule-id00001", value: "dog", mode: "exact", label: "Dogs", isMatched: false },
    ]);
    expect(addEdgeOps(result.ops).filter((op) => op.source === cs.id).map((op) => op.sourceHandle)).toEqual(["rule-id00000", "rule-id00001", "default"]);
  });

  it("is atomic: one bad connection rejects the whole call with every error and its fix", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt" },
        { ref: "g", type: "nanoBanana", settings: { aspectRatio: "4:1", prompt: "oops" } },
        { ref: "v", type: "videoTrim" },
        { ref: "x", type: "notAType" },
      ],
      connections: [
        { from: "p", to: "g" },
        { from: "p", to: "v" },
        { from: "g", to: "missing" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.ops).toEqual([]);
    expect(result.text).toMatch(/^No changes were made/);
    expect(result.text).toContain("aspectRatio \"4:1\" is not available on nano-banana-pro (1:4, 1:8, 4:1 and 8:1 need nano-banana-2)");
    expect(result.text).toContain('has no "prompt" setting: its prompt comes from the node connected to its text input');
    expect(result.text).toContain('unknown node type "notAType"');
    expect(result.text).toContain("has no input that takes text");
    expect(result.text).toContain('to "missing" does not exist');
    expect(result.summary.startsWith("Rejected:")).toBe(true);

    // The draft is untouched: the next read shows an empty canvas.
    const read = await call(runtime, "get_workflow", {});
    expect(read.text).toBe("The canvas is empty.");
  });

  it("refuses cycles unless a loop is asked for", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }),
        storeNode("llmGenerate-2", "llmGenerate", { x: 400, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "llmGenerate-2", "text")],
    };
    const runtime = runtimeFor(state);
    const refused = await call(runtime, "edit_workflow", { operations: [{ op: "connect", from: "llmGenerate-2", to: "prompt-1" }] });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("would create a cycle");

    const loop = await call(runtime, "edit_workflow", { operations: [{ op: "connect", from: "llmGenerate-2", to: "prompt-1", loop: true, loopCount: 2 }] });
    expect(loop.ok, loop.text).toBe(true);
    expect(addEdgeOps(loop.ops)[0].data).toEqual({ isLoop: true, loopCount: 2 });
  });

  it("replaces the canvas only when asked, and reports it", async () => {
    const state: StoreState = { nodes: [storeNode("prompt-1", "prompt", { x: 50, y: 50 })], edges: [] };
    const runtime = runtimeFor(state, { viewport: VIEWPORT });
    const result = await call(runtime, "create_workflow", {
      replaceCanvas: true,
      nodes: [{ ref: "p", type: "prompt", settings: { prompt: "hello" } }],
    });
    expect(result.ok).toBe(true);
    // Only the nodes the agent knew about go: one removeNode each, never a blanket clear.
    expect(result.ops[0]).toEqual({ op: "removeNode", id: "prompt-1" });
    expect(result.ops.some((op) => op.op === "clearCanvas")).toBe(false);
    expect(result.replacedCanvas).toBe(true);
    expect(result.text).toContain("1 node removed");
    expect(result.summary).toBe("Replaced canvas (1 removed): added 1 node");
    const store = applyResult(state, result);
    expect(store.nodes.map((n) => n.id)).toEqual(["prompt-ag1"]);
  });
});

describe("placement against rendered nodes", () => {
  it("keeps new nodes clear of the height the canvas measured, not the type default", async () => {
    // An Output showing a portrait image renders far taller than its 320 default.
    const state: StoreState = {
      nodes: [
        storeNode("nanoBanana-1", "nanoBanana", { x: 0, y: 0 }, {}, { measured: { width: 300, height: 452 } }),
        storeNode("output-2", "output", { x: 400, y: 0 }, {}, { measured: { width: 320, height: 700 } }),
      ],
      edges: [],
    };
    const result = await call(runtimeFor(state), "edit_workflow", {
      operations: [
        { op: "add_node", ref: "o", type: "output" },
        { op: "connect", from: "nanoBanana-1", to: "o" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const added = addNodeOps(result.ops)[0];
    expect(added.position.x).toBe(300 + 100);
    expect(added.position.y).toBeGreaterThanOrEqual(700);
    // And the node lands width-only, for the shell to size.
    const store = applyResult(state, result);
    expect(store.nodes.find((n) => n.id === added.id)).toMatchObject({ width: 320, style: { width: 320 } });
    expect(store.nodes.find((n) => n.id === added.id)).not.toHaveProperty("measured");
  });
});

describe("edit_workflow", () => {
  const base = (): StoreState => ({
    nodes: [
      storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a castle" }),
      storeNode("nanoBanana-2", "nanoBanana", { x: 420, y: 0 }),
      storeNode("output-3", "output", { x: 820, y: 0 }),
    ],
    edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text"), storeEdge("nanoBanana-2", "image", "output-3", "image")],
  });

  it("replaces a text edge when a second text source is connected, and says so", async () => {
    const state = base();
    const runtime = runtimeFor(state);
    const result = await call(runtime, "edit_workflow", {
      operations: [
        { op: "add_node", ref: "p2", type: "prompt", settings: { prompt: "a lighthouse" } },
        { op: "connect", from: "p2", to: "nanoBanana-2" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops.map((op) => op.op)).toEqual(["addNode", "removeEdge", "addEdge"]);
    expect(result.ops[1]).toEqual({ op: "removeEdge", id: "edge-prompt-1-nanoBanana-2-text-text" });
    expect(result.text).toContain("prompt-1.text → nanoBanana-2.text (replaced by prompt-ag1)");
    // Placed left of what it feeds.
    const add = addNodeOps(result.ops)[0];
    expect(add.position.x + 320).toBeLessThanOrEqual(420);

    const store = applyResult(state, result);
    expect(edgeKeys(store.edges)).toEqual(["nanoBanana-2.image -> output-3.image", "prompt-ag1.text -> nanoBanana-2.text"]);
  });

  it("adds a second image to a multi-image input without replacing the first", async () => {
    const state = base();
    state.nodes.push(storeNode("imageInput-4", "imageInput", { x: 0, y: 300 }), storeNode("imageInput-5", "imageInput", { x: 0, y: 600 }));
    const runtime = runtimeFor(state);
    const result = await call(runtime, "edit_workflow", {
      operations: [
        { op: "connect", from: "imageInput-4", to: "nanoBanana-2" },
        { op: "connect", from: "imageInput-5", to: "nanoBanana-2" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops.map((op) => op.op)).toEqual(["addEdge", "addEdge"]);
  });

  it("lets refs be used before the add_node that defines them", async () => {
    const runtime = runtimeFor(base());
    const result = await call(runtime, "edit_workflow", {
      operations: [
        { op: "connect", from: "nanoBanana-2", to: "gal" },
        { op: "add_node", ref: "gal", type: "outputGallery" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(addEdgeOps(result.ops)[0]).toMatchObject({ target: "outputGallery-ag1", targetHandle: "image" });
    // Placed right of its upstream generator.
    expect(addNodeOps(result.ops)[0].position.x).toBeGreaterThanOrEqual(420 + 300 + 100);
  });

  it("removes a node with its connections and disconnects by handle", async () => {
    const state = base();
    const runtime = runtimeFor(state);
    const result = await call(runtime, "edit_workflow", {
      operations: [
        { op: "disconnect", from: "prompt-1", to: "nanoBanana-2" },
        { op: "remove_node", node: "output-3" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops).toEqual([
      { op: "removeEdge", id: "edge-prompt-1-nanoBanana-2-text-text" },
      { op: "removeNode", id: "output-3" },
    ]);
    const store = applyResult(state, result);
    expect(store.edges).toEqual([]);
    expect(store.nodes.map((n) => n.id)).toEqual(["prompt-1", "nanoBanana-2"]);
    expect(result.text).toContain("has no text input yet");
  });

  it("reports a missing disconnect with the connections that do exist", async () => {
    const runtime = runtimeFor(base());
    const result = await call(runtime, "edit_workflow", { operations: [{ op: "disconnect", from: "prompt-1", to: "output-3" }] });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("no matching connection from prompt-1 to output-3");
    expect(result.text).toContain("prompt-1.text → nanoBanana-2.text");
  });

  it("moves nodes and later calls in the turn see earlier edits", async () => {
    const runtime = runtimeFor(base());
    const moved = await call(runtime, "edit_workflow", { operations: [{ op: "move_node", node: "output-3", position: { x: 1000, y: 40 } }] });
    expect(moved.ops).toEqual([{ op: "moveNode", id: "output-3", position: { x: 1000, y: 40 } }]);
    await call(runtime, "update_node", { node: "prompt-1", settings: { prompt: "a moonlit castle" } });
    const read = await call(runtime, "get_workflow", { detail: "full", nodeIds: ["prompt-1", "output-3"] });
    expect(read.text).toContain('"a moonlit castle"');
    expect(read.text).toContain("at (1000, 40)");
  });

  it("requires op-specific fields", async () => {
    const runtime = runtimeFor(base());
    const result = await call(runtime, "edit_workflow", {
      operations: [{ op: "add_node" }, { op: "connect", from: "prompt-1" }, { op: "move_node", node: "prompt-1" }, { op: "update_node", node: "prompt-1" }],
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('operations[0] (add_node): type is required');
    expect(result.text).toContain("operations[1] (connect): connect needs from and to");
    expect(result.text).toContain("operations[2] (move_node): move_node needs position");
    expect(result.text).toContain("operations[3] (update_node): nothing to change on prompt-1");
  });
});

describe("update_node", () => {
  it("switches a Veo model, rewires legacy handles and clamps parameters", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "waves" }),
        storeNode("imageInput-2", "imageInput", { x: 0, y: 300 }),
        storeNode("generateVideo-3", "generateVideo", { x: 400, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "generateVideo-3", "text"), storeEdge("imageInput-2", "image", "generateVideo-3", "image")],
    };
    const runtime = runtimeFor(state);
    const i2v = await call(runtime, "update_node", {
      node: "generateVideo-3",
      settings: { model: "veo-3.1-fast/image-to-video", aspectRatio: "9:16", durationSeconds: 6 },
    });
    expect(i2v.ok, i2v.text).toBe(true);
    // What the node ends up with once its schema loads: the schema's defaults
    // (with the call's values over them) and the schema's own inputs.
    expect(i2v.ops[0]).toEqual({
      op: "updateNode",
      id: "generateVideo-3",
      data: {
        selectedModel: { provider: "gemini", modelId: "veo-3.1-fast/image-to-video", displayName: "Veo 3.1 Fast I2V" },
        parameters: { aspectRatio: "9:16", durationSeconds: "6", resolution: "720p" },
        inputSchema: [
          { name: "prompt", type: "text", required: true, label: "Prompt" },
          { name: "negative_prompt", type: "text", required: false, label: "Neg. Prompt" },
          { name: "image", type: "image", required: true, label: "Image" },
        ],
      },
    });
    let store = applyResult(state, i2v);
    expect(edgeKeys(store.edges)).toEqual([
      "imageInput-2.image -> generateVideo-3.image-0",
      "prompt-1.text -> generateVideo-3.text-0",
    ]);

    // Negative prompt by schema name; then switch to text-to-video: the image edge goes.
    const runtime2 = runtimeFor(store);
    const neg = await call(runtime2, "edit_workflow", {
      operations: [
        { op: "add_node", ref: "neg", type: "prompt", settings: { prompt: "blurry" } },
        { op: "connect", from: "neg", to: "generateVideo-3", toHandle: "negative_prompt" },
        { op: "update_node", node: "generateVideo-3", settings: { model: "veo-3.1/text-to-video" } },
      ],
    });
    expect(neg.ok, neg.text).toBe(true);
    expect(addEdgeOps(neg.ops)[0]).toMatchObject({ targetHandle: "text-1" });
    expect(neg.text).toContain("Removed imageInput-2 → generateVideo-3 (image)");
    store = applyResult(store, neg);
    expect(edgeKeys(store.edges)).toEqual([
      "prompt-1.text -> generateVideo-3.text-0",
      "prompt-ag1.text -> generateVideo-3.text-1",
    ]);
  });

  it("rejects ambiguous and non-Gemini video models with the valid choices", async () => {
    const runtime = runtimeFor({ nodes: [storeNode("generateVideo-1", "generateVideo", { x: 0, y: 0 })], edges: [] });
    const ambiguous = await call(runtime, "update_node", { node: "generateVideo-1", settings: { model: "veo-3.1" } });
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.text).toContain('"veo-3.1/text-to-video" (prompt only) or "veo-3.1/image-to-video"');
    const kling = await call(runtime, "update_node", { node: "generateVideo-1", settings: { model: "kling-2.1" } });
    expect(kling.text).toContain('no model "kling-2.1" among the Gemini models');
    expect(kling.text).toContain("Call search_models");
    expect(kling.text).toContain("Providers without a key (the user adds one in Settings → Providers): OpenAI, Kie.ai");
    const params = await call(runtime, "update_node", { node: "generateVideo-1", settings: { durationSeconds: "8" } });
    expect(params.text).toContain("can only be set this way for Gemini video models (Veo, Gemini Omni)");
  });

  it("sets Gemini Omni with its own inputs and settings, and wires every media type", async () => {
    const runtime = runtimeFor(EMPTY, { viewport: VIEWPORT });
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a slow dolly shot through a greenhouse, rain on the glass" } },
        { ref: "ref", type: "imageInput" },
        { ref: "clip", type: "videoInput" },
        { ref: "v", type: "generateVideo", settings: { model: "Gemini Omni 1.1 Flash", resolution: "1080p", task: "edit" } },
        { ref: "o", type: "output" },
      ],
      connections: [
        { from: "p", to: "v" },
        { from: "ref", to: "v" },
        { from: "clip", to: "v" },
        { from: "v", to: "o" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const add = result.ops.find((op): op is Extract<AgentGraphOp, { op: "addNode" }> => op.op === "addNode" && op.nodeType === "generateVideo")!;
    expect(add.data).toMatchObject({
      selectedModel: { provider: "gemini", modelId: "gemini-omni-1.1-flash", displayName: "Gemini Omni 1.1 Flash" },
      parameters: { resolution: "1080p", task: "edit" },
    });
    expect((add.data.inputSchema as Array<{ name: string }>).map((i) => i.name)).toEqual(["prompt", "image", "video", "audio"]);
    expect(addEdgeOps(result.ops).map((op) => `${op.source}.${op.sourceHandle}->${op.target}.${op.targetHandle}`)).toEqual([
      "prompt-ag1.text->generateVideo-ag4.text-0",
      "imageInput-ag2.image->generateVideo-ag4.image-0",
      "videoInput-ag3.video->generateVideo-ag4.video-0",
      "generateVideo-ag4.video->output-ag5.video",
    ]);

    const veoOnly = await call(runtime, "update_node", { node: "generateVideo-ag4", settings: { durationSeconds: "8", resolution: "360p" } });
    expect(veoOnly.ok).toBe(false);
    expect(veoOnly.text).toContain("Gemini Omni 1.1 Flash has no durationSeconds setting (Omni takes the duration, 3-10 seconds, from the prompt)");
    const veo = await call(runtime, "update_node", { node: "generateVideo-ag4", settings: { model: "veo-3.1/text-to-video", resolution: "360p" } });
    expect(veo.ok).toBe(false);
    expect(veo.text).toContain("resolution must be one of: 720p, 1080p, 4k on Veo 3.1");
  });

  it("moves every image onto Omni's reference slot, but only one onto Veo's start image", async () => {
    const state = (): StoreState => ({
      nodes: [
        storeNode("imageInput-1", "imageInput", { x: 0, y: 0 }),
        storeNode("imageInput-2", "imageInput", { x: 0, y: 400 }),
        storeNode("generateVideo-3", "generateVideo", { x: 500, y: 0 }),
      ],
      edges: [storeEdge("imageInput-1", "image", "generateVideo-3", "image"), storeEdge("imageInput-2", "image", "generateVideo-3", "image")],
    });
    const omni = await call(runtimeFor(state()), "update_node", { node: "generateVideo-3", settings: { model: "gemini-omni-flash-preview" } });
    expect(omni.ok, omni.text).toBe(true);
    const afterOmni = applyResult(state(), omni);
    expect(edgeKeys(afterOmni.edges)).toEqual([
      "imageInput-1.image -> generateVideo-3.image-0",
      "imageInput-2.image -> generateVideo-3.image-0",
    ]);

    const veo = await call(runtimeFor(state()), "update_node", { node: "generateVideo-3", settings: { model: "veo-3.1/image-to-video" } });
    expect(veo.ok, veo.text).toBe(true);
    expect(edgeKeys(applyResult(state(), veo).edges)).toEqual(["imageInput-1.image -> generateVideo-3.image-0"]);
    expect(veo.text).toContain("Removed imageInput-2 → generateVideo-3 (image)");
  });

  it("clamps Generate Image options when the model changes", async () => {
    const state: StoreState = {
      nodes: [storeNode("nanoBanana-1", "nanoBanana", { x: 0, y: 0 }, { model: "nano-banana-2", selectedModel: { provider: "gemini", modelId: "nano-banana-2", displayName: "Nano Banana 2" }, aspectRatio: "1:8", resolution: "512", useImageSearch: true })],
      edges: [],
    };
    const runtime = runtimeFor(state);
    const result = await call(runtime, "update_node", { node: "nanoBanana-1", settings: { model: "Nano Banana Pro" } });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops[0]).toMatchObject({
      op: "updateNode",
      data: { model: "nano-banana-pro", aspectRatio: "9:16", resolution: "1K", useImageSearch: false },
    });
    expect(result.text).toContain("does not support aspect ratio 1:8; changed it to 9:16");
    expect(result.summary).toBe("Updated Generate Image (model, aspectRatio, resolution, useImageSearch)");
  });

  it("points at the valid settings when a field is wrong", async () => {
    const runtime = runtimeFor({ nodes: [storeNode("llmGenerate-1", "llmGenerate", { x: 0, y: 0 })], edges: [] });
    const result = await call(runtime, "update_node", { node: "llmGenerate-1", settings: { outputText: "x", temprature: 1 } });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('"outputText" cannot be set (produced when the workflow runs)');
    expect(result.text).toContain('has no setting "temprature". Settable: provider, model, temperature, maxTokens, comment');
  });

  it("switches the LLM provider when a model of another provider is chosen", async () => {
    const runtime = runtimeFor({ nodes: [storeNode("llmGenerate-1", "llmGenerate", { x: 0, y: 0 }, { temperature: 1.6 })], edges: [] });
    const result = await call(runtime, "update_node", { node: "llmGenerate-1", settings: { model: "claude-haiku-4-5" } });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops[0]).toMatchObject({ data: { model: "claude-haiku-4-5", provider: "anthropic", temperature: 1 } });
    expect(result.text).toContain("Anthropic models need an Anthropic API key");
  });

  it("removes connections of a switch output that was deleted", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }),
        storeNode("switch-2", "switch", { x: 400, y: 0 }, { inputType: "text", switches: [{ id: "aaaaaaa", name: "A", enabled: true }, { id: "bbbbbbb", name: "B", enabled: true }] }),
        storeNode("nanoBanana-3", "nanoBanana", { x: 800, y: 0 }),
        storeNode("nanoBanana-4", "nanoBanana", { x: 800, y: 400 }),
      ],
      edges: [
        storeEdge("prompt-1", "text", "switch-2", "text"),
        storeEdge("switch-2", "aaaaaaa", "nanoBanana-3", "text"),
        storeEdge("switch-2", "bbbbbbb", "nanoBanana-4", "text"),
      ],
    };
    const runtime = runtimeFor(state);
    const result = await call(runtime, "update_node", { node: "switch-2", settings: { switches: [{ name: "A", enabled: false }] } });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops).toEqual([
      { op: "updateNode", id: "switch-2", data: { switches: [{ id: "aaaaaaa", name: "A", enabled: false }] } },
      { op: "removeEdge", id: "edge-switch-2-nanoBanana-4-bbbbbbb-text" },
    ]);
  });
});

describe("more node kinds", () => {
  it("keeps a Conditional Switch from replacing a generator's prompt", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("conditionalSwitch-1", "conditionalSwitch", { x: 0, y: 0 }, { rules: [{ id: "rule-aaaaaaa", label: "Yes", value: "yes", mode: "contains", isMatched: false }] }),
        storeNode("prompt-2", "prompt", { x: 0, y: 300 }),
        storeNode("nanoBanana-3", "nanoBanana", { x: 400, y: 0 }),
        storeNode("nanoBanana-4", "nanoBanana", { x: 400, y: 400 }),
      ],
      edges: [storeEdge("prompt-2", "text", "nanoBanana-3", "text")],
    };
    const runtime = runtimeFor(state);
    const replaced = await call(runtime, "edit_workflow", { operations: [{ op: "connect", from: "conditionalSwitch-1", fromHandle: "Yes", to: "nanoBanana-3" }] });
    expect(replaced.ok).toBe(false);
    expect(replaced.text).toContain("gates nodes but passes no text");
    const warned = await call(runtime, "edit_workflow", { operations: [{ op: "connect", from: "conditionalSwitch-1", to: "nanoBanana-4" }] });
    expect(warned.ok).toBe(true);
    expect(warned.text).toContain("rule output → Prompt (text input) → nanoBanana-4");
    const gated = await call(runtime, "edit_workflow", { operations: [{ op: "connect", from: "conditionalSwitch-1", fromHandle: "default", to: "prompt-2" }] });
    expect(addEdgeOps(gated.ops)[0]).toMatchObject({ sourceHandle: "default", targetHandle: "text" });
    const unwired = await call(runtime, "edit_workflow", { operations: [{ op: "disconnect", from: "conditionalSwitch-1", fromHandle: "yes" }] });
    expect(unwired.ops).toEqual([{ op: "removeEdge", id: "edge-conditionalSwitch-1-nanoBanana-4-rule-aaaaaaa-text" }]);
  });

  it("fills comparison, stitch and GIF slots and routes video to outputs", async () => {
    const runtime = runtimeFor(EMPTY);
    const result = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "a", type: "imageInput" },
        { ref: "b", type: "imageInput" },
        { ref: "cmp", type: "imageCompare" },
        { ref: "gif", type: "gifEncoder", settings: { fps: 12 } },
        { ref: "v1", type: "videoInput" },
        { ref: "v2", type: "videoInput" },
        { ref: "stitch", type: "videoStitch", settings: { loopCount: "2" } },
        { ref: "trim", type: "videoTrim", settings: { startTime: 1, endTime: 4 } },
        { ref: "out", type: "output" },
      ],
      connections: [
        { from: "a", to: "cmp" },
        { from: "b", to: "cmp" },
        { from: "a", to: "gif" },
        { from: "b", to: "gif" },
        { from: "v1", to: "stitch" },
        { from: "v2", to: "stitch" },
        { from: "stitch", to: "trim" },
        { from: "trim", to: "out" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(addEdgeOps(result.ops).map((op) => `${op.target}.${op.targetHandle}`)).toEqual([
      "imageCompare-ag3.image",
      "imageCompare-ag3.image-1",
      "gifEncoder-ag4.image-0",
      "gifEncoder-ag4.image-1",
      "videoStitch-ag7.video-0",
      "videoStitch-ag7.video-1",
      "videoTrim-ag8.video",
      "output-ag9.video",
    ]);
    expect(addNodeOps(result.ops).find((op) => op.nodeType === "videoStitch")!.data).toEqual({ loopCount: 2 });
  });

  it("connects existing ComfyUI apps through their contract and sets their parameters", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("comfyApp-1", "comfyApp", { x: 400, y: 0 }, {
          app: {
            id: "x", name: "Relight", description: "", source: "upload", graph: {}, classTypes: [], nodeCount: 1, createdAt: 1,
            inputs: [
              { id: "3:image", name: "photo", label: "Photo", type: "image", nodeId: "3", inputKey: "image", required: true },
              { id: "4:text", name: "prompt", label: "Light", type: "text", nodeId: "4", inputKey: "text", required: false },
            ],
            params: [{ id: "5:strength", label: "Strength", type: "number", minimum: 0, maximum: 1, nodeId: "5", inputKey: "strength" }],
            outputs: [{ id: "9", label: "Relit", type: "image", nodeId: "9", classType: "SaveImage" }],
          },
          inputSchema: [{ name: "photo", type: "image", required: true, label: "Photo" }, { name: "prompt", type: "text", required: false, label: "Light" }],
        }),
        storeNode("imageInput-2", "imageInput", { x: 0, y: 0 }),
      ],
      edges: [],
    };
    const runtime = runtimeFor(state);
    const result = await call(runtime, "edit_workflow", {
      operations: [
        { op: "connect", from: "imageInput-2", to: "comfyApp-1" },
        { op: "add_node", ref: "light", type: "prompt", settings: { prompt: "golden hour" } },
        { op: "connect", from: "light", to: "comfyApp-1", toHandle: "Light" },
        { op: "add_node", ref: "out", type: "output" },
        { op: "connect", from: "comfyApp-1", fromHandle: "Relit", to: "out" },
        { op: "update_node", node: "comfyApp-1", settings: { paramValues: { Strength: 0.4 } } },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(addEdgeOps(result.ops).map((op) => `${op.source}.${op.sourceHandle}->${op.target}.${op.targetHandle}`)).toEqual([
      "imageInput-2.image->comfyApp-1.image-0",
      "prompt-ag1.text->comfyApp-1.text-0",
      "comfyApp-1.9->output-ag2.image",
    ]);
    expect(result.ops.find((op) => op.op === "updateNode")).toEqual({ op: "updateNode", id: "comfyApp-1", data: { paramValues: { "5:strength": 0.4 } } });

    const create = await call(runtime, "edit_workflow", { operations: [{ op: "add_node", type: "comfyApp" }] });
    expect(create.ok).toBe(false);
    expect(create.text).toContain("ComfyUI App nodes cannot be added by the agent");
  });

  it("resolves refs from an earlier call in the same turn", async () => {
    const runtime = runtimeFor(EMPTY);
    await call(runtime, "create_workflow", { nodes: [{ ref: "hero", type: "nanoBanana" }] });
    const result = await call(runtime, "edit_workflow", { operations: [{ op: "add_node", ref: "out", type: "output" }, { op: "connect", from: "hero", to: "out" }] });
    expect(result.ok, result.text).toBe(true);
    expect(addEdgeOps(result.ops)[0]).toMatchObject({ source: "nanoBanana-ag1", target: "output-ag2" });
  });

  it("tidies the layout with moveNode ops only", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("output-3", "output", { x: 0, y: 900 }),
        storeNode("prompt-1", "prompt", { x: 700, y: 0 }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 20, y: 400 }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text"), storeEdge("nanoBanana-2", "image", "output-3", "image")],
    };
    const runtime = runtimeFor(state);
    const result = await call(runtime, "arrange_workflow", {});
    expect(result.ok, result.text).toBe(true);
    expect(result.ops.every((op) => op.op === "moveNode")).toBe(true);
    const store = applyResult(state, result);
    const x = (id: string) => store.nodes.find((n) => n.id === id)!.position.x;
    expect(x("prompt-1")).toBeLessThan(x("nanoBanana-2"));
    expect(x("nanoBanana-2")).toBeLessThan(x("output-3"));
    const unknown = await call(runtime, "arrange_workflow", { nodeIds: ["nope"] });
    expect(unknown.ok).toBe(false);
  });
});

describe("read-only tools", () => {
  it("describes node types and models", async () => {
    const runtime = createAgentToolRuntime(emptySnapshot());
    const types = await call(runtime, "describe_node_types", { types: ["Generate Image", "llmGenerate", "bogus"] });
    expect(types.ok).toBe(true);
    expect(types.text).toContain("## nanoBanana — Generate Image");
    expect(types.text).toContain("aspectRatio: one of");
    expect(types.text).toContain("Unknown types skipped: bogus");
    const models = await call(runtime, "list_models", { kind: "video" });
    expect(models.text).toContain("veo-3.1-fast/image-to-video");
    expect(models.ops).toEqual([]);
  });

  it("reads the workflow with handles in full detail", async () => {
    const state: StoreState = {
      nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "hi" }), storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 })],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
    };
    const runtime = runtimeFor(state);
    const result = await call(runtime, "get_workflow", { detail: "full" });
    expect(result.text).toContain("inputs: image (image, accepts many); text (text, \"Prompt\") ← prompt-1.text");
    expect(result.summary).toBe("Read the workflow (2 nodes)");
  });
});

describe("argument handling", () => {
  it("never throws: unknown tools, bad args and JSON-string args", async () => {
    const runtime = createAgentToolRuntime(emptySnapshot());
    const unknown = await runtime.execute("delete_everything", {});
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("Available tools:");

    const bad = await runtime.execute("update_node", { settings: { prompt: "x" } });
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain("node:");

    const stringified = await runtime.execute(
      "mcp__node_banana__create_workflow",
      JSON.stringify({ nodes: [{ ref: "p", type: "prompt", settings: '{"prompt":"from a string"}' }] }),
    );
    expect(stringified.ok, stringified.text).toBe(true);
    expect(addNodeOps(stringified.ops)[0].data).toEqual({ prompt: "from a string" });
  });

  it("treats null optional fields as absent but keeps null settings", async () => {
    const state: StoreState = { nodes: [storeNode("gifEncoder-1", "gifEncoder", { x: 0, y: 0 }), storeNode("prompt-2", "prompt", { x: 0, y: 400 }, { variableName: "subject" })], edges: [] };
    const runtime = runtimeFor(state);
    const result = await runtime.execute("edit_workflow", {
      operations: [
        { op: "update_node", node: "gifEncoder-1", ref: null, type: null, title: null, settings: { targetMaxBytes: null }, from: null, to: null, position: null },
        { op: "update_node", node: "prompt-2", settings: { variableName: null }, edgeId: null },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops).toEqual([
      { op: "updateNode", id: "gifEncoder-1", data: { targetMaxBytes: null } },
      { op: "updateNode", id: "prompt-2", data: { variableName: null } },
    ]);
  });

  it("tolerates a malformed snapshot", async () => {
    const runtime = createAgentToolRuntime({ nodes: "nope", edges: null, groups: {}, selectedNodeIds: 3 } as never);
    expect((await call(runtime, "get_workflow", {})).text).toBe("The canvas is empty.");
    const partial = createAgentToolRuntime({
      nodes: [null, { id: "prompt-1", type: "prompt", position: { x: 0, y: 0 }, width: 320, height: 220, data: "x" }, { id: "x", type: "bogus" }],
      edges: [{ id: "e", source: "prompt-1", target: "gone", sourceHandle: "text", targetHandle: "text" }],
      groups: [],
      selectedNodeIds: ["prompt-1", "gone"],
    } as never);
    const read = await call(partial, "get_workflow", {});
    expect(read.text).toContain("1 node, 0 connections.");
    expect(read.text).toContain("Selected by the user: prompt-1.");
  });

  it("keeps new ids unique across calls and turns", async () => {
    const first = runtimeFor(EMPTY);
    const r1 = await call(first, "create_workflow", { nodes: [{ ref: "a", type: "prompt" }, { ref: "b", type: "prompt" }] });
    const state = applyResult(EMPTY, r1);
    const second = createAgentToolRuntime(snapshotOf(state), { randomId: sequentialIds() });
    const r2 = await call(second, "create_workflow", { nodes: [{ ref: "c", type: "prompt" }] });
    expect(addNodeOps(r2.ops)[0].id).toBe("prompt-ag3");
  });
});

function removeEdgeIds(ops: AgentGraphOp[]): string[] {
  return ops.filter((op): op is Extract<AgentGraphOp, { op: "removeEdge" }> => op.op === "removeEdge").map((op) => op.id);
}

describe("loop edges (review C6)", () => {
  // prompt-1 → nanoBanana-2 → llmGenerate-3, with the LLM looping back into the generator's prompt.
  const looped = (): StoreState => ({
    nodes: [
      storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a cat" }),
      storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 }),
      storeNode("llmGenerate-3", "llmGenerate", { x: 800, y: 0 }),
      storeNode("prompt-4", "prompt", { x: 400, y: 400 }, { prompt: "Improve this image prompt. Reply with only the prompt." }),
    ],
    edges: [
      storeEdge("prompt-1", "text", "nanoBanana-2", "text"),
      storeEdge("nanoBanana-2", "image", "llmGenerate-3", "image"),
      storeEdge("prompt-4", "text", "llmGenerate-3", "text"),
      storeEdge("llmGenerate-3", "text", "nanoBanana-2", "text", { isLoop: true, loopCount: 5 }),
    ],
  });

  it("keeps the user's loop when a new prompt replaces the forward edge", async () => {
    const state = looped();
    const result = await call(runtimeFor(state), "edit_workflow", {
      operations: [
        { op: "add_node", ref: "np", type: "prompt", settings: { prompt: "a dog" } },
        { op: "connect", from: "np", to: "nanoBanana-2" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(removeEdgeIds(result.ops)).toEqual(["edge-prompt-1-nanoBanana-2-text-text"]);
    const store = applyResult(state, result);
    expect(store.edges.find((e) => e.id === "edge-llmGenerate-3-nanoBanana-2-text-text")?.data).toMatchObject({ isLoop: true, loopCount: 5 });
    expect(validateWorkflowPure(store.nodes, store.edges).valid).toBe(true);
  });

  it("builds a loop into an input that already has a forward edge (create_workflow)", async () => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a cat" } },
        { ref: "g", type: "nanoBanana" },
        { ref: "l", type: "llmGenerate" },
        { ref: "p2", type: "prompt", settings: { prompt: "Improve this image prompt. Reply with only the prompt." } },
      ],
      connections: [
        { from: "p", to: "g" },
        { from: "g", to: "l" },
        { from: "p2", to: "l" },
        { from: "l", to: "g", loop: true },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    const edges = addEdgeOps(result.ops);
    expect(edges.find((op) => op.source === "prompt-ag1" && op.target === "nanoBanana-ag2")).toMatchObject({ targetHandle: "text" });
    expect(edges.find((op) => op.source === "llmGenerate-ag3" && op.target === "nanoBanana-ag2")).toMatchObject({ targetHandle: "text", data: { isLoop: true, loopCount: 3 } });
    expect(removeEdgeIds(result.ops)).toEqual([]);
    expect(result.text).not.toContain("has no text input yet");
    const store = applyResult(EMPTY, result);
    expect(validateWorkflowPure(store.nodes, store.edges)).toEqual({ valid: true, errors: [] });
  });

  it("adds a loop next to an existing forward edge without disconnecting it", async () => {
    const state = looped();
    state.edges.pop();
    const result = await call(runtimeFor(state), "edit_workflow", {
      operations: [{ op: "connect", from: "llmGenerate-3", to: "nanoBanana-2", loop: true, loopCount: 2 }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(removeEdgeIds(result.ops)).toEqual([]);
    expect(addEdgeOps(result.ops)).toEqual([expect.objectContaining({ id: "edge-llmGenerate-3-nanoBanana-2-text-text", data: { isLoop: true, loopCount: 2 } })]);
  });

  it("moves a loop edge along with a model change and keeps its loopCount", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("imageInput-1", "imageInput", { x: 0, y: 0 }),
        storeNode("prompt-2", "prompt", { x: 0, y: 400 }, { prompt: "waves" }),
        storeNode("generateVideo-3", "generateVideo", { x: 400, y: 0 }),
        storeNode("videoFrameGrab-4", "videoFrameGrab", { x: 800, y: 0 }),
      ],
      edges: [
        storeEdge("imageInput-1", "image", "generateVideo-3", "image"),
        storeEdge("prompt-2", "text", "generateVideo-3", "text"),
        storeEdge("generateVideo-3", "video", "videoFrameGrab-4", "video"),
        storeEdge("videoFrameGrab-4", "image", "generateVideo-3", "image", { isLoop: true, loopCount: 8 }),
      ],
    };
    const result = await call(runtimeFor(state), "update_node", { node: "generateVideo-3", settings: { model: "veo-3.1/image-to-video" } });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).not.toContain("has no image input");
    const adds = addEdgeOps(result.ops);
    expect(adds.find((op) => op.source === "videoFrameGrab-4")).toMatchObject({ targetHandle: "image-0", data: { isLoop: true, loopCount: 8 } });
    expect(adds.find((op) => op.source === "imageInput-1")).toMatchObject({ targetHandle: "image-0" });
  });
});

describe("Router and Switch inputs (review C9, C10)", () => {
  it("tells the browser a Switch lost its type when the node feeding it is removed", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }),
        storeNode("switch-2", "switch", { x: 400, y: 0 }, { inputType: "text", switches: [{ id: "aaaaaaa", name: "A", enabled: true }] }),
        storeNode("nanoBanana-3", "nanoBanana", { x: 800, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "switch-2", "text"), storeEdge("switch-2", "aaaaaaa", "nanoBanana-3", "text")],
    };
    const result = await call(runtimeFor(state), "edit_workflow", { operations: [{ op: "remove_node", node: "prompt-1" }] });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops).toContainEqual({ op: "updateNode", id: "switch-2", data: { inputType: null } });
    // Its output connection only goes dormant, as on the canvas.
    expect(removeEdgeIds(result.ops)).toEqual([]);
    const store = applyResult(state, result);
    expect(store.nodes.find((n) => n.id === "switch-2")!.data).toMatchObject({ inputType: null });
  });

  it("keeps a Router's downstream wiring dormant when its input goes, and live again once reconnected", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a fox" }),
        storeNode("router-2", "router", { x: 400, y: 0 }),
        storeNode("llmGenerate-3", "llmGenerate", { x: 800, y: 0 }),
      ],
      edges: [storeEdge("prompt-1", "text", "router-2", "text"), storeEdge("router-2", "text", "llmGenerate-3", "text")],
    };
    const removed = await call(runtimeFor(state), "edit_workflow", { operations: [{ op: "remove_node", node: "prompt-1" }] });
    expect(removed.ok, removed.text).toBe(true);
    expect(removeEdgeIds(removed.ops)).toEqual([]);
    expect(removed.text).toContain("router-2 (Router) has no text input now, so its connections to llmGenerate-3 stay on the canvas");
    const after = applyResult(state, removed);
    expect(edgeKeys(after.edges)).toEqual(["router-2.text -> llmGenerate-3.text"]);

    const next = runtimeFor(after);
    expect((await call(next, "get_workflow", {})).text).toContain("router-2.text → llmGenerate-3.text (inactive");
    const reconnected = await call(next, "edit_workflow", {
      operations: [
        { op: "add_node", ref: "p", type: "prompt", settings: { prompt: "a wolf" } },
        { op: "connect", from: "p", to: "router-2" },
      ],
    });
    expect(reconnected.ok, reconnected.text).toBe(true);
    const read = await call(next, "get_workflow", {});
    expect(read.text).toContain("- router-2.text → llmGenerate-3.text\n");
  });

  it("removes Switch outputs that a new input of another type would mistype, in one call", async () => {
    const runtime = runtimeFor(EMPTY);
    const built = await call(runtime, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a fox" } },
        { ref: "sw", type: "switch" },
        { ref: "g", type: "nanoBanana" },
      ],
      connections: [
        { from: "p", to: "sw" },
        { from: "sw", to: "g" },
      ],
    });
    expect(built.ok, built.text).toBe(true);
    let store = applyResult(EMPTY, built);
    const retyped = await call(runtime, "edit_workflow", {
      operations: [
        { op: "add_node", ref: "img", type: "imageInput" },
        { op: "disconnect", from: "prompt-ag1", to: "switch-ag2" },
        { op: "connect", from: "img", to: "switch-ag2" },
      ],
    });
    expect(retyped.ok, retyped.text).toBe(true);
    expect(removeEdgeIds(retyped.ops)).toContain("edge-switch-ag2-nanoBanana-ag3-id00000-text");
    expect(retyped.text).toContain("switch-ag2 now routes image, and that input takes text");
    expect(retyped.text).toContain("nanoBanana-ag3 (Generate Image) has no text input yet");
    store = applyResult(store, retyped);
    for (const edge of store.edges) {
      expect(isValidConnectionPort({ source: edge.source, sourceHandle: edge.sourceHandle ?? null, target: edge.target, targetHandle: edge.targetHandle ?? null }, store.nodes), edge.id).toBe(true);
    }
  });

  it("leaves a mistyped Switch connection the user already had alone", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("imageInput-1", "imageInput", { x: 0, y: 0 }),
        storeNode("switch-2", "switch", { x: 400, y: 0 }, { inputType: "image", switches: [{ id: "aaaaaaa", name: "A", enabled: true }] }),
        storeNode("nanoBanana-3", "nanoBanana", { x: 800, y: 0 }),
        storeNode("prompt-4", "prompt", { x: 0, y: 400 }),
      ],
      edges: [storeEdge("imageInput-1", "image", "switch-2", "image"), storeEdge("switch-2", "aaaaaaa", "nanoBanana-3", "text")],
    };
    const result = await call(runtimeFor(state), "update_node", { node: "prompt-4", settings: { prompt: "unrelated" } });
    expect(result.ok, result.text).toBe(true);
    expect(removeEdgeIds(result.ops)).toEqual([]);
  });
});

describe("lint accuracy (review C12)", () => {
  it("does not claim a Conditional Switch overwrites the Prompt it gates", async () => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", {
      nodes: [
        { ref: "q", type: "prompt", settings: { prompt: "Is this a cat? Answer yes or no." } },
        { ref: "llm", type: "llmGenerate" },
        { ref: "cs", type: "conditionalSwitch", settings: { rules: [{ label: "Cats", value: "yes" }] } },
        { ref: "p2", type: "prompt", settings: { prompt: "a cat astronaut" } },
        { ref: "g", type: "nanoBanana" },
      ],
      connections: [
        { from: "q", to: "llm" },
        { from: "llm", to: "cs" },
        { from: "cs", fromHandle: "Cats", to: "p2" },
        { from: "p2", to: "g" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).not.toContain("overwrites its prompt");

    const control = await call(runtimeFor(EMPTY), "create_workflow", {
      nodes: [
        { ref: "llm", type: "llmGenerate" },
        { ref: "p", type: "prompt", settings: { prompt: "a cat" } },
      ],
      connections: [{ from: "llm", to: "p" }],
    });
    expect(control.text).toContain("overwrites its prompt");
  });

  it.each(["router", "switch"])("resolves template variables through a %s like the executor", async (hub) => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a fox", variableName: "subject" } },
        { ref: "hub", type: hub },
        { ref: "pc", type: "promptConstructor", settings: { template: "photo of @subject" } },
      ],
      connections: [
        { from: "p", to: "hub" },
        { from: "hub", to: "pc" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).not.toContain("uses @subject");
  });

  it("still reports a variable nothing fills", async () => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a fox", variableName: "other" } },
        { ref: "r", type: "router" },
        { ref: "pc", type: "promptConstructor", settings: { template: "photo of @missing" } },
      ],
      connections: [
        { from: "p", to: "r" },
        { from: "r", to: "pc" },
      ],
    });
    expect(result.text).toContain("uses @missing but no connected Prompt (directly or through a Router/Switch) has that variableName");
  });
});

describe("array fan-out (review C30)", () => {
  const fanOut = (explicit: boolean, prompt = "cat, dog, bird, fish, horse", settings?: Record<string, unknown>) => ({
    nodes: [
      { ref: "list", type: "prompt", settings: { prompt } },
      { ref: "arr", type: "array", ...(settings ? { settings } : {}) },
      ...[1, 2, 3, 4, 5].map((i) => ({ ref: `g${i}`, type: "nanoBanana" })),
    ],
    connections: [
      { from: "list", to: "arr" },
      ...[1, 2, 3, 4, 5].map((i) => ({ from: "arr", to: `g${i}`, ...(explicit ? { arrayItemIndex: i - 1 } : {}) })),
    ],
  });

  it.each([true, false])("warns when the delimiter does not split the list (explicit indices: %s)", async (explicit) => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", fanOut(explicit));
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("into 1 item (delimiter \"*\")");
    expect(result.text).toContain('set delimiter "," to split it');
    expect(addEdgeOps(result.ops).filter((op) => op.source === "array-ag2").map((op) => op.data?.arrayItemIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("gives every generator its own item once the delimiter is fixed", async () => {
    const runtime = runtimeFor(EMPTY);
    const built = await call(runtime, "create_workflow", fanOut(false));
    const fixed = await call(runtime, "update_node", { node: "array-ag2", settings: { delimiter: "," } });
    expect(fixed.ok, fixed.text).toBe(true);
    expect(fixed.text).not.toContain("indices past the end");
    let store = applyResult(applyResult(EMPTY, built), fixed);
    // The Array node computes its items from its input; do the same here.
    store = {
      ...store,
      nodes: store.nodes.map((n) =>
        n.type === "array"
          ? ({ ...n, data: { ...n.data, outputItems: parseTextToArray("cat, dog, bird, fish, horse", { splitMode: "delimiter", delimiter: ",", regexPattern: "", trimItems: true, removeEmpty: true }).items } } as WorkflowNode)
          : n,
      ),
    };
    const texts = store.nodes.filter((n) => n.type === "nanoBanana").map((n) => getConnectedInputsPure(n.id, store.nodes, store.edges).text);
    expect(new Set(texts).size).toBe(5);
  });

  it("stays quiet when the split matches", async () => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", {
      nodes: [
        { ref: "list", type: "prompt", settings: { prompt: "a * b * c" } },
        { ref: "arr", type: "array" },
        { ref: "g1", type: "nanoBanana" },
        { ref: "g2", type: "nanoBanana" },
        { ref: "g3", type: "nanoBanana" },
      ],
      connections: [
        { from: "list", to: "arr" },
        { from: "arr", to: "g1" },
        { from: "arr", to: "g2" },
        { from: "arr", to: "g3" },
      ],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).not.toContain("(Array) splits");
  });

  it("re-checks the split when the Prompt feeding the Array changes", async () => {
    const runtime = runtimeFor(EMPTY);
    await call(runtime, "create_workflow", fanOut(false, "a * b * c * d * e"));
    const changed = await call(runtime, "update_node", { node: "prompt-ag1", settings: { prompt: "a, b, c, d, e" } });
    expect(changed.text).toContain("array-ag2 (Array) splits the text from prompt-ag1 into 1 item");
  });
});

describe("LLM instructions (review C31)", () => {
  const chain = (idea: string, llmSettings?: Record<string, unknown>) => ({
    nodes: [
      { ref: "idea", type: "prompt", settings: { prompt: idea } },
      { ref: "llm", type: "llmGenerate", ...(llmSettings ? { settings: llmSettings } : {}) },
      { ref: "g", type: "nanoBanana" },
    ],
    connections: [
      { from: "idea", to: "llm" },
      { from: "llm", to: "g" },
    ],
  });

  it("flags a bare idea on an LLM that writes an image prompt", async () => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", chain("a cabin at sunset"));
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain('llmGenerate-ag2 (LLM Generate) receives only "a cabin at sunset" from prompt-ag1, with no instruction');
  });

  it("accepts an instruction", async () => {
    const result = await call(
      runtimeFor(EMPTY),
      "create_workflow",
      chain("Write one detailed image-generation prompt for: a cabin at sunset. Reply with only the prompt."),
    );
    expect(result.text).not.toContain("with no instruction");
  });

  it("flags instructions left in the LLM's comment", async () => {
    const result = await call(
      runtimeFor(EMPTY),
      "create_workflow",
      chain("Write one detailed image prompt for: a cabin. Reply with only the prompt.", {
        comment: "Expand the short idea into a detailed, vivid image prompt and return only the final image prompt text.",
      }),
    );
    expect(result.text).toContain("has instructions in its comment, but comments are never sent to any model");
  });
});

describe("removals the user must hear about (review C32, C33)", () => {
  it("names removed uploads and results and how to get them back when the canvas is replaced", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("imageInput-1", "imageInput", { x: 0, y: 0 }, { image: "data:image/png;base64,AAAA" }),
        storeNode("prompt-3", "prompt", { x: 0, y: 400 }, { prompt: "a fox" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 }, { outputImage: "data:image/png;base64,BBBB", customTitle: "Hero" }),
      ],
      edges: [storeEdge("imageInput-1", "image", "nanoBanana-2", "image"), storeEdge("prompt-3", "text", "nanoBanana-2", "text")],
    };
    const result = await call(runtimeFor(state), "create_workflow", {
      replaceCanvas: true,
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a lighthouse" } },
        { ref: "g", type: "nanoBanana" },
      ],
      connections: [{ from: "p", to: "g" }],
    });
    expect(result.ok, result.text).toBe(true);
    const next = result.text.split("\n").find((line) => line.startsWith("Next:"))!;
    expect(next).toContain("Tell the user you removed 3 of their nodes, including imageInput-1 (uploaded image), nanoBanana-2 (\"Hero\") (generated image)");
    expect(next).toContain("Ctrl+Z (one step per change) brings them back");
    expect(result.summary).toMatch(/^Replaced canvas \(3 removed\)/);
  });

  it("asks the agent to mention a node it removed from the user's canvas", async () => {
    const state: StoreState = { nodes: [storeNode("output-1", "output", { x: 0, y: 0 })], edges: [] };
    const result = await call(runtimeFor(state), "edit_workflow", { operations: [{ op: "remove_node", node: "output-1" }] });
    expect(result.text).toContain("Tell the user you removed 1 of their nodes");
  });

  it("points at the upstream node when an end node is used as a source", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("nanoBanana-1", "nanoBanana", { x: 0, y: 0 }),
        storeNode("output-2", "output", { x: 400, y: 0 }),
        storeNode("imageCompare-3", "imageCompare", { x: 800, y: 0 }),
      ],
      edges: [storeEdge("nanoBanana-1", "image", "output-2", "image")],
    };
    const result = await call(runtimeFor(state), "edit_workflow", { operations: [{ op: "connect", from: "output-2", to: "imageCompare-3" }] });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("output-2 (Output) is an end node with no outputs");
    expect(result.text).toContain("keep output-2 connected and add imageCompare-3 next to it");
  });
});

describe("replacing an empty canvas (review C39)", () => {
  it("sends no removals and does not report a replaced canvas", async () => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", {
      replaceCanvas: true,
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a fox" } },
        { ref: "g", type: "nanoBanana" },
      ],
      connections: [{ from: "p", to: "g" }],
    });
    expect(result.ok, result.text).toBe(true);
    expect(result.ops.some((op) => op.op === "clearCanvas" || op.op === "removeNode")).toBe(false);
    expect(result.replacedCanvas).toBeUndefined();
    expect(result.summary).not.toMatch(/^Replaced canvas/);
    // A node the user added while the turn ran survives.
    const live: StoreState = { nodes: [storeNode("imageInput-1", "imageInput", { x: 0, y: 0 })], edges: [] };
    expect(applyResult(live, result).nodes.map((n) => n.id)).toEqual(["imageInput-1", "prompt-ag1", "nanoBanana-ag2"]);
  });

  it("removes only the nodes it knew about from a non-empty canvas", async () => {
    const snapshot: StoreState = { nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 })], edges: [] };
    const result = await call(runtimeFor(snapshot), "create_workflow", { replaceCanvas: true, nodes: [{ ref: "g", type: "nanoBanana" }] });
    expect(result.replacedCanvas).toBe(true);
    const live: StoreState = { nodes: [...snapshot.nodes, storeNode("imageInput-2", "imageInput", { x: 0, y: 400 })], edges: [] };
    expect(applyResult(live, result).nodes.map((n) => n.id)).toEqual(["imageInput-2", "nanoBanana-ag1"]);
  });
});

describe("saved defaults and chosen settings (review C37, C40)", () => {
  const withDefaults = () =>
    createAgentToolRuntime({
      ...emptySnapshot(),
      nodeDefaults: { nanoBanana: { selectedModel: { provider: "gemini", modelId: "nano-banana-2", displayName: "Nano Banana 2" }, resolution: "2K" } },
    });

  it("says when a new node's model comes from the user's saved default", async () => {
    const result = await call(withDefaults(), "create_workflow", { nodes: [{ ref: "g", type: "nanoBanana", settings: { aspectRatio: "16:9" } }] });
    expect(result.ok, result.text).toBe(true);
    expect(result.text).toContain("nanoBanana-ag1 has the user's saved defaults model nano-banana-2, resolution 2K (you did not set them)");
  });

  it("sends a model the user named, and flags one that differs from their default", async () => {
    const result = await call(withDefaults(), "create_workflow", { nodes: [{ ref: "g", type: "nanoBanana", settings: { model: "nano-banana-pro" } }] });
    expect(addNodeOps(result.ops)[0].data).toMatchObject({ model: "nano-banana-pro", selectedModel: { modelId: "nano-banana-pro" } });
    expect(result.text).toContain("nanoBanana-ag1: you set model nano-banana-pro, but new Generate Image nodes start with model nano-banana-2 (the user's saved defaults)");
  });

  it("sends nothing about the model when none was set", async () => {
    const result = await call(runtimeFor(EMPTY), "create_workflow", { nodes: [{ ref: "g", type: "nanoBanana" }] });
    const data = addNodeOps(result.ops)[0].data;
    expect(data).not.toHaveProperty("model");
    expect(data).not.toHaveProperty("resolution");
    expect(data).not.toHaveProperty("aspectRatio");
    expect(result.text).not.toContain("saved default");
  });
});

describe("long prompts end to end (review C7)", () => {
  const long = `A scene: ${"x".repeat(5390)}`; // 5399 characters, past the old 4000-character view
  const state = (): StoreState => ({
    nodes: [
      storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: long }),
      storeNode("promptConstructor-2", "promptConstructor", { x: 0, y: 400 }, { template: long }),
    ],
    edges: [],
  });

  it("shows the whole text in detail \"full\", so writing it back with an edit loses nothing", async () => {
    const before = state();
    const runtime = runtimeFor(before);
    const read = await call(runtime, "get_workflow", { nodeIds: ["prompt-1"], detail: "full" });
    const seen = JSON.parse(read.text.match(/ {2}data: (.*)$/m)![1]).prompt as string;
    expect(seen).toBe(long);
    const result = await call(runtime, "update_node", { node: "prompt-1", settings: { prompt: seen.replace("A scene:", "A watercolor scene:") } });
    expect(result.ok, result.text).toBe(true);
    const prompt = applyResult(before, result).nodes[0].data as { prompt: string };
    expect(prompt.prompt).toBe(long.replace("A scene:", "A watercolor scene:"));
    expect(prompt.prompt).not.toContain("[truncated");
  });

  it("refuses the canvas preview written back as the whole prompt, and edits in place instead", async () => {
    const before = state();
    const runtime = runtimeFor(before);
    const canvas = await call(runtime, "get_workflow", {});
    expect(canvas.text).toContain("prompt (5399 characters; only the first 400 shown)");
    const preview = long.slice(0, 400);
    const cut = await call(runtime, "update_node", { node: "prompt-1", settings: { prompt: `${preview} watercolor` } });
    expect(cut.ok).toBe(false);
    expect(cut.ops).toEqual([]);
    expect(cut.text).toContain("as if it was written from a cut preview");

    const edited = await call(runtime, "update_node", { node: "prompt-1", settings: { promptEdit: { find: "A scene:", replace: "A watercolor scene:" } } });
    expect(edited.ok, edited.text).toBe(true);
    const after = applyResult(before, edited).nodes[0].data as { prompt: string };
    expect(after.prompt.length).toBe(long.length + 11);
    expect(after.prompt.endsWith("x".repeat(100))).toBe(true);
  });

  it("guards a template through edit_workflow the same way", async () => {
    const runtime = runtimeFor(state());
    const result = await call(runtime, "edit_workflow", {
      operations: [{ op: "update_node", node: "promptConstructor-2", settings: { template: `${long.slice(0, 4000)}… [truncated: 1399 more characters; the full text is on the canvas]` } }],
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("marker");
  });
});
