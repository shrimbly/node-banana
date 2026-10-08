/**
 * The Run button a turn ends with (runtime.runOffer): what it runs, what it
 * is called, and when there is none.
 */

import { describe, expect, it } from "vitest";
import type { AgentTabSummary } from "../../types";
import { NODE_CATALOG } from "../../graph/catalog";
import { createAgentToolRuntime } from "../runtime";
import { call, runtimeFor, sequentialIds, snapshotOf, storeEdge, storeNode, type StoreState } from "./testUtils";

const EMPTY: StoreState = { nodes: [], edges: [] };
const GENERATE = NODE_CATALOG.nanoBanana.displayName;

/** prompt-1 → llmGenerate-2 → nanoBanana-3 → output-4: the LLM has answered unless `llmOutput` is false. */
const chain = (llmOutput = true): StoreState => ({
  nodes: [
    storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "write an image prompt about a fox" }),
    storeNode("llmGenerate-2", "llmGenerate", { x: 400, y: 0 }, llmOutput ? { outputText: "a red fox in snow" } : {}),
    storeNode("nanoBanana-3", "nanoBanana", { x: 800, y: 0 }),
    storeNode("output-4", "output", { x: 1200, y: 0 }),
  ],
  edges: [
    storeEdge("prompt-1", "text", "llmGenerate-2", "text"),
    storeEdge("llmGenerate-2", "text", "nanoBanana-3", "text"),
    storeEdge("nanoBanana-3", "image", "output-4", "image"),
  ],
});

/** The chain, plus a "Hero shots" group of two prompt → generator pairs (prompt-5 → nanoBanana-6, prompt-8 → nanoBanana-9). */
const withGroup = (locked = false): StoreState => {
  const state = chain();
  state.nodes.push(
    storeNode("prompt-5", "prompt", { x: 0, y: 600 }, { prompt: "a hero shot" }, { groupId: "group-1" }),
    storeNode("nanoBanana-6", "nanoBanana", { x: 400, y: 600 }, {}, { groupId: "group-1" }),
    storeNode("prompt-8", "prompt", { x: 0, y: 900 }, { prompt: "another hero shot" }, { groupId: "group-1" }),
    storeNode("nanoBanana-9", "nanoBanana", { x: 400, y: 900 }, {}, { groupId: "group-1" }),
  );
  state.edges.push(storeEdge("prompt-5", "text", "nanoBanana-6", "text"), storeEdge("prompt-8", "text", "nanoBanana-9", "text"));
  state.groups = { "group-1": { id: "group-1", name: "Hero shots", color: "blue", locked, position: { x: -40, y: 560 }, size: { width: 760, height: 700 } } };
  return state;
};

const ALL_CHAIN = ["prompt-1", "llmGenerate-2", "nanoBanana-3", "output-4"];

describe("runOffer", () => {
  it("offers the whole workflow for one built from an empty canvas", async () => {
    const runtime = runtimeFor(EMPTY);
    expect(runtime.runOffer!()).toBeNull();
    await call(runtime, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a fox" } },
        { ref: "g", type: "nanoBanana" },
        { ref: "o", type: "output" },
      ],
      connections: [
        { from: "p", to: "g" },
        { from: "g", to: "o" },
      ],
    });
    const offer = runtime.runOffer!();
    expect(offer).toEqual({
      offerId: expect.stringMatching(/^offer_./),
      primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ["prompt-ag1", "nanoBanana-ag2", "output-ag3"] },
      alternatives: [],
    });
    expect(runtime.runOffer!()!.offerId).not.toBe(offer!.offerId);
  });

  it("offers the whole workflow after the canvas was replaced", async () => {
    const runtime = runtimeFor(chain());
    await call(runtime, "create_workflow", {
      replaceCanvas: true,
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "a fox" } },
        { ref: "g", type: "nanoBanana" },
      ],
      connections: [{ from: "p", to: "g" }],
    });
    expect(runtime.runOffer!()?.primary).toMatchObject({ scope: { kind: "all" }, label: "Run workflow" });
  });

  it("offers a changed generator and what it feeds, with the whole workflow as the alternative", async () => {
    const runtime = runtimeFor(chain());
    await call(runtime, "update_node", { node: "nanoBanana-3", settings: { aspectRatio: "16:9" } });
    expect(runtime.runOffer!()).toEqual({
      offerId: expect.stringMatching(/^offer_/),
      primary: { scope: { kind: "nodes", nodeIds: ["nanoBanana-3", "output-4"] }, label: `Run ${GENERATE}`, nodeIds: ["nanoBanana-3", "output-4"] },
      alternatives: [{ scope: { kind: "all" }, label: "Run whole workflow", nodeIds: ALL_CHAIN }],
    });
  });

  it("names several changed nodes by their count, in run order", async () => {
    const state = chain();
    state.nodes.push(storeNode("prompt-5", "prompt", { x: 0, y: 600 }, { prompt: "a cat" }), storeNode("nanoBanana-6", "nanoBanana", { x: 400, y: 600 }));
    state.edges.push(storeEdge("prompt-5", "text", "nanoBanana-6", "text"));
    const runtime = runtimeFor(state);
    await call(runtime, "edit_workflow", {
      operations: [
        { op: "update_node", node: "nanoBanana-3", settings: { aspectRatio: "16:9" } },
        { op: "update_node", node: "nanoBanana-6", settings: { aspectRatio: "16:9" } },
      ],
    });
    expect(runtime.runOffer!()?.primary).toEqual({
      scope: { kind: "nodes", nodeIds: ["nanoBanana-6", "nanoBanana-3", "output-4"] },
      label: "Run 2 changed nodes",
      nodeIds: ["nanoBanana-6", "nanoBanana-3", "output-4"],
    });
  });

  it("widens changes inside one group to the whole group", async () => {
    const runtime = runtimeFor(withGroup());
    await call(runtime, "update_node", { node: "prompt-5", settings: { prompt: "a hero shot at dusk" } });
    const offer = runtime.runOffer!();
    expect(offer?.primary).toEqual({
      scope: { kind: "nodes", nodeIds: ["prompt-5", "prompt-8", "nanoBanana-6", "nanoBanana-9"] },
      label: "Run Hero shots",
      nodeIds: ["prompt-5", "prompt-8", "nanoBanana-6", "nanoBanana-9"],
    });
    expect(offer?.alternatives).toEqual([{ scope: { kind: "all" }, label: "Run whole workflow", nodeIds: expect.arrayContaining(ALL_CHAIN) }]);
  });

  it("offers the whole workflow when the changes reach every node", async () => {
    const runtime = runtimeFor(chain());
    await call(runtime, "update_node", { node: "prompt-1", settings: { prompt: "write an image prompt about a wolf" } });
    expect(runtime.runOffer!()).toMatchObject({ primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ALL_CHAIN }, alternatives: [] });
  });

  it("falls back to the whole workflow when the narrower run would find an input empty", async () => {
    const runtime = runtimeFor(chain(false));
    await call(runtime, "update_node", { node: "nanoBanana-3", settings: { aspectRatio: "16:9" } });
    expect(runtime.runOffer!()).toMatchObject({ primary: { scope: { kind: "all" }, label: "Run workflow" }, alternatives: [] });
  });

  it("offers nothing when even the whole workflow can't run yet", async () => {
    const state: StoreState = {
      nodes: [
        storeNode("imageInput-1", "imageInput", { x: 0, y: 0 }),
        storeNode("prompt-2", "prompt", { x: 0, y: 400 }, { prompt: "restyle it" }),
        storeNode("nanoBanana-3", "nanoBanana", { x: 400, y: 0 }),
      ],
      edges: [storeEdge("imageInput-1", "image", "nanoBanana-3", "image"), storeEdge("prompt-2", "text", "nanoBanana-3", "text")],
    };
    const runtime = runtimeFor(state);
    await call(runtime, "update_node", { node: "nanoBanana-3", settings: { aspectRatio: "16:9" } });
    expect(runtime.runOffer!()).toBeNull();
    // The same from scratch: nothing to offer until the upload is there.
    const fresh = runtimeFor(EMPTY);
    await call(fresh, "create_workflow", {
      nodes: [
        { ref: "i", type: "imageInput" },
        { ref: "p", type: "prompt", settings: { prompt: "restyle it" } },
        { ref: "g", type: "nanoBanana" },
      ],
      connections: [
        { from: "i", to: "g" },
        { from: "p", to: "g" },
      ],
    });
    expect(fresh.runOffer!()).toBeNull();
  });

  it("offers nothing when no generator would run", async () => {
    const lonePrompt = runtimeFor(chain());
    await call(lonePrompt, "create_workflow", { nodes: [{ ref: "p", type: "prompt", settings: { prompt: "notes" } }] });
    expect(lonePrompt.runOffer!()).toBeNull();

    const tidied = runtimeFor(chain());
    await call(tidied, "arrange_workflow", {});
    expect(tidied.runOffer!()).toBeNull();

    const locked = runtimeFor(withGroup(true));
    await call(locked, "update_node", { node: "prompt-5", settings: { prompt: "a hero shot at dusk" } });
    expect(locked.runOffer!()).toBeNull();
  });

  it("leaves out a node the turn only wired onward from, since its output stays what it was", async () => {
    // prompt-1 → nanoBanana-2, which already made its image.
    const made: StoreState = {
      nodes: [
        storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a fox in snow" }),
        storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 }, { outputImage: "data:image/png;base64,AAAA" }),
      ],
      edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
    };
    const animate = runtimeFor(made);
    const built = await call(animate, "create_workflow", {
      nodes: [
        { ref: "p", type: "prompt", settings: { prompt: "the fox turns its head" } },
        { ref: "v", type: "generateVideo" },
      ],
      connections: [
        { from: "nanoBanana-2", to: "v" },
        { from: "p", to: "v" },
      ],
    });
    expect(built.ok, built.text).toBe(true);
    expect(animate.runOffer!()?.primary).toEqual({
      scope: { kind: "nodes", nodeIds: ["prompt-ag1", "generateVideo-ag2"] },
      label: "Run 2 changed nodes",
      nodeIds: ["prompt-ag1", "generateVideo-ag2"],
    });

    // A viewer after it shows the image it has: nothing to generate.
    const viewer = runtimeFor(made);
    await call(viewer, "create_workflow", { nodes: [{ ref: "o", type: "output" }], connections: [{ from: "nanoBanana-2", to: "o" }] });
    expect(viewer.runOffer!()).toBeNull();
  });

  it("offers nothing for a new title or comment, which change no output", async () => {
    const renamed = runtimeFor(chain());
    expect((await call(renamed, "update_node", { node: "nanoBanana-3", title: "Hero" })).ok).toBe(true);
    expect((await call(renamed, "update_node", { node: "llmGenerate-2", settings: { comment: "writes the prompt" } })).ok).toBe(true);
    expect(renamed.runOffer!()).toBeNull();

    const retuned = runtimeFor(chain());
    await call(retuned, "update_node", { node: "nanoBanana-3", title: "Hero", settings: { aspectRatio: "16:9" } });
    expect(retuned.runOffer!()?.primary).toMatchObject({ label: "Run Hero", nodeIds: ["nanoBanana-3", "output-4"] });
  });

  it("counts the node a new wire feeds as changed", async () => {
    const rewired = runtimeFor(chain());
    await call(rewired, "edit_workflow", {
      operations: [
        { op: "add_node", ref: "p", type: "prompt", settings: { prompt: "a wolf" } },
        { op: "connect", from: "p", to: "nanoBanana-3" },
      ],
    });
    expect(rewired.runOffer!()?.primary.nodeIds).toEqual(["prompt-ag1", "nanoBanana-3", "output-4"]);
  });

  it("forgets nodes removed later in the turn", async () => {
    const runtime = runtimeFor(chain());
    await call(runtime, "edit_workflow", {
      operations: [
        { op: "add_node", ref: "g", type: "nanoBanana" },
        { op: "connect", from: "llmGenerate-2", to: "g" },
        { op: "update_node", node: "nanoBanana-3", settings: { aspectRatio: "16:9" } },
      ],
    });
    await call(runtime, "edit_workflow", { operations: [{ op: "remove_node", node: "nanoBanana-ag1" }] });
    expect(runtime.runOffer!()?.primary).toEqual({
      scope: { kind: "nodes", nodeIds: ["nanoBanana-3", "output-4"] },
      label: `Run ${GENERATE}`,
      nodeIds: ["nanoBanana-3", "output-4"],
    });
  });

  it("offers nothing once the turn started a run, or while one was going", async () => {
    const runtime = runtimeFor(chain());
    await call(runtime, "update_node", { node: "nanoBanana-3", settings: { aspectRatio: "16:9" } });
    expect(runtime.runOffer!()).not.toBeNull();
    expect((await call(runtime, "run_workflow", { scope: "nodes", nodeIds: ["nanoBanana-3"] })).ok).toBe(true);
    expect(runtime.runOffer!()).toBeNull();

    const running = runtimeFor(chain(), { running: true });
    await call(running, "update_node", { node: "nanoBanana-3", settings: { aspectRatio: "16:9" } });
    expect(running.runOffer!()).toBeNull();
  });

  it("is for the tab the turn ended in", async () => {
    const tabs: AgentTabSummary[] = [
      { id: "tab-a", name: "Chain", active: true, nodeCount: 4, saved: true },
      { id: "tab-b", name: "Haiku", nodeCount: 1 },
    ];
    const haiku: StoreState = { nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a haiku" }), storeNode("llmGenerate-2", "llmGenerate", { x: 400, y: 0 })], edges: [storeEdge("prompt-1", "text", "llmGenerate-2", "text")] };
    const make = () =>
      createAgentToolRuntime(snapshotOf(chain(), { tabId: "tab-a", workflowName: "Chain" }), {
        randomId: sequentialIds(),
        tabs,
        parkedWorkflows: { "tab-b": snapshotOf(haiku, { tabId: "tab-b", workflowName: "Haiku" }) },
      });

    const runtime = make();
    await call(runtime, "update_node", { node: "nanoBanana-3", settings: { aspectRatio: "16:9" } });
    expect(runtime.runOffer!()).toMatchObject({ tabId: "tab-a", workflowName: "Chain" });
    await call(runtime, "switch_workflow", { tab: "tab-b" });
    // Nothing changed in the tab it ended in.
    expect(runtime.runOffer!()).toBeNull();
    await call(runtime, "update_node", { node: "prompt-1", settings: { prompt: "a haiku about rain" } });
    expect(runtime.runOffer!()).toMatchObject({ tabId: "tab-b", workflowName: "Haiku", primary: { scope: { kind: "all" } } });

    const fresh = make();
    const opened = await call(fresh, "new_workflow", { name: "Posters" });
    await call(fresh, "create_workflow", { nodes: [{ ref: "p", type: "prompt", settings: { prompt: "a poster" } }, { ref: "g", type: "nanoBanana" }], connections: [{ from: "p", to: "g" }] });
    expect(fresh.runOffer!()).toMatchObject({
      tabId: opened.tabId,
      workflowName: "Posters",
      primary: { scope: { kind: "all" }, label: "Run workflow", nodeIds: ["prompt-ag1", "nanoBanana-ag2"] },
    });
  });
});
