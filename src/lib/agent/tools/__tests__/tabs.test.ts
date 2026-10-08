/**
 * The open workflows: switch_workflow, new_workflow and save_workflow, one
 * draft per tab, and every result naming the tab it worked in.
 */

import { describe, expect, it } from "vitest";
import type { AgentTabSummary, AgentToolResult, AgentWorkflowSnapshot } from "../../types";
import type { ModelSource } from "../modelSearch";
import { createAgentToolRuntime, type AgentToolRuntimeOptions } from "../runtime";
import { call, emptySnapshot, sequentialIds, snapshotOf, storeEdge, storeNode, type StoreState } from "./testUtils";

const VIEWPORT = { x: 5000, y: 3000, width: 1600, height: 900, zoom: 1 };

/** Tab A (live, saved): a prompt feeding a generator. */
const A: StoreState = {
  nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: "a fox" }), storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 })],
  edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
};
/** Tab B (parked, never saved): one LLM node. */
const B: StoreState = { nodes: [storeNode("llmGenerate-7", "llmGenerate", { x: 0, y: 0 }, { outputText: "a haiku" })], edges: [] };

const TABS: AgentTabSummary[] = [
  { id: "tab-a", name: "Fox portraits", active: true, nodeCount: 2, saved: true },
  { id: "tab-b", name: "Haiku", nodeCount: 1, unsaved: true },
  { id: "tab-c", nodeCount: 0 },
];

function workspace(
  options: { live?: Partial<AgentWorkflowSnapshot>; tabs?: AgentTabSummary[]; parked?: Record<string, AgentWorkflowSnapshot> } & Partial<AgentToolRuntimeOptions> = {},
) {
  const { live, tabs = TABS, parked, ...rest } = options;
  return createAgentToolRuntime(
    { ...snapshotOf(A, { tabId: "tab-a", workflowName: "Fox portraits", viewport: VIEWPORT }), ...live },
    { randomId: sequentialIds(), tabs, parkedWorkflows: parked ?? { "tab-b": snapshotOf(B, { tabId: "tab-b", workflowName: "Haiku" }) }, ...rest },
  );
}

/** A model source whose every lookup waits for `release`, then finds nothing. */
function gatedSource(): { source: ModelSource; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const offline = async () => {
    await gate;
    return { ok: false as const, error: "offline", status: 503 };
  };
  return { source: { listModels: offline, getModelSchema: offline }, release };
}

const slowEdit = { node: "nanoBanana-2", settings: { model: { provider: "fal", modelId: "fal-ai/flux" } } };

describe("switch_workflow", () => {
  it("makes another tab live, describes it, and later calls work there", async () => {
    const runtime = workspace();
    const switched = await call(runtime, "switch_workflow", { tab: "tab-b" });
    expect(switched.ok, switched.text).toBe(true);
    expect(switched).toMatchObject({ ops: [], workspace: { op: "switchTab", tabId: "tab-b" }, tabId: "tab-b", summary: "Switched to Haiku" });
    expect(switched.text).toContain('Switched to "Haiku" (tab-b)');
    expect(switched.text).toContain('Workflow "Haiku": 1 node, 0 connections.');
    expect(switched.text).toContain("llmGenerate-7 llmGenerate");

    const read = await call(runtime, "get_workflow", {});
    expect(read.tabId).toBe("tab-b");
    expect(read.text).toContain("llmGenerate-7");
    expect(read.text).not.toContain("prompt-1");
    const added = await call(runtime, "create_workflow", { nodes: [{ ref: "p", type: "prompt", settings: { prompt: "rain" } }], connections: [{ from: "p", to: "llmGenerate-7" }] });
    expect(added.ok, added.text).toBe(true);
    expect(added.tabId).toBe("tab-b");
    // The edit cannot reach tab A's nodes any more.
    expect((await call(runtime, "update_node", { node: "prompt-1", settings: { prompt: "a wolf" } })).ok).toBe(false);
  });

  it("keeps one draft per tab across switches", async () => {
    const runtime = workspace();
    expect((await call(runtime, "update_node", { node: "prompt-1", settings: { prompt: "a wolf" } })).tabId).toBe("tab-a");
    await call(runtime, "switch_workflow", { tab: "tab-b" });
    await call(runtime, "update_node", { node: "llmGenerate-7", title: "Poet" });
    const back = await call(runtime, "switch_workflow", { tab: "Fox portraits" });
    expect(back).toMatchObject({ ok: true, tabId: "tab-a", workspace: { op: "switchTab", tabId: "tab-a" } });
    // Tab A as this turn left it, not as the snapshot had it.
    expect(back.text).toContain('prompt: "a wolf"');
    const again = await call(runtime, "switch_workflow", { tab: "tab-b" });
    expect(again.text).toContain('"Poet"');
  });

  it("finds a tab by its name in any case, and refuses a name two tabs share", async () => {
    expect((await call(workspace(), "switch_workflow", { tab: "  haiku " })).tabId).toBe("tab-b");
    const twins = workspace({ tabs: [...TABS, { id: "tab-d", name: "HAIKU", nodeCount: 0 }] });
    const refused = await call(twins, "switch_workflow", { tab: "haiku" });
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('2 open workflows are named "haiku": tab-b, tab-d. Pass the id of the one you mean.');
    expect(refused.tabId).toBe("tab-a");
  });

  it("refuses an unknown tab with the open ones, and a tab whose nodes the browser did not describe", async () => {
    const unknown = await call(workspace(), "switch_workflow", { tab: "Cats" });
    expect(unknown.ok).toBe(false);
    expect(unknown.summary).toBe("No such workflow");
    expect(unknown.text).toContain('No open workflow "Cats". Open workflows: tab-a "Fox portraits", tab-b "Haiku", tab-c untitled.');
    const blind = await call(workspace({ parked: {} }), "switch_workflow", { tab: "tab-b" });
    expect(blind.ok).toBe(false);
    expect(blind.summary).toBe("Could not read that workflow");
    expect(blind.workspace).toBeUndefined();
    // An empty tab needs no picture.
    const empty = await call(workspace({ parked: {} }), "switch_workflow", { tab: "tab-c" });
    expect(empty).toMatchObject({ ok: true, tabId: "tab-c", summary: "Switched to an untitled workflow" });
    expect(empty.text).toContain("The canvas is empty.");
  });

  it("does nothing when the tab is already live", async () => {
    const same = await call(workspace(), "switch_workflow", { tab: "tab-a" });
    expect(same).toMatchObject({ ok: true, ops: [], tabId: "tab-a", summary: "Already in Fox portraits" });
    expect(same.workspace).toBeUndefined();
  });

  it("is refused while a run is going, after this turn started one, and without the tab list", async () => {
    const running = await call(workspace({ live: { running: true } }), "switch_workflow", { tab: "tab-b" });
    expect(running).toMatchObject({ ok: false, summary: "Not changed: a run is going", tabId: "tab-a" });
    expect(running.workspace).toBeUndefined();

    const runtime = workspace();
    expect((await call(runtime, "run_workflow", { scope: "all" })).ok).toBe(true);
    const afterRun = await call(runtime, "switch_workflow", { tab: "tab-b" });
    expect(afterRun).toMatchObject({ ok: false, summary: "Not changed: a run started this turn" });
    expect((await call(runtime, "new_workflow", {})).summary).toBe("Not changed: a run started this turn");

    const old = createAgentToolRuntime(snapshotOf(A), { randomId: sequentialIds() });
    for (const [tool, args] of [["switch_workflow", { tab: "tab-b" }], ["new_workflow", {}], ["save_workflow", { name: "Fox" }]] as const) {
      const refused = await call(old, tool, args);
      expect(refused, tool).toMatchObject({ ok: false, summary: "Open workflows unavailable", ops: [] });
      expect(refused.tabId, tool).toBeUndefined();
    }
    // Everything else still works as before, unstamped.
    const edited = await call(old, "update_node", { node: "prompt-1", settings: { prompt: "a wolf" } });
    expect(edited.ok).toBe(true);
    expect(edited).not.toHaveProperty("tabId");
  });
});

describe("new_workflow", () => {
  it("opens an empty, named tab with a fresh id, and builds there", async () => {
    const runtime = workspace({ live: { nodeDefaults: { nanoBanana: { aspectRatio: "16:9" } } } });
    const opened = await call(runtime, "new_workflow", { name: "  Cat posters " });
    expect(opened.ok, opened.text).toBe(true);
    const id = opened.tabId!;
    expect(id).toMatch(/^tab-ag[a-z0-9]+$/);
    expect(opened).toMatchObject({ ops: [], summary: "Opened Cat posters", workspace: { op: "newTab", tabId: id, name: "Cat posters" } });
    expect(opened.text).toContain(`Opened a new, empty workflow "Cat posters" in tab ${id}.`);
    expect(opened.text).toContain("The workflow you were in stays open in tab tab-a.");

    const read = await call(runtime, "get_workflow", {});
    expect(read.text).toBe("The canvas is empty.");
    const built = await call(runtime, "create_workflow", { nodes: [{ ref: "g", type: "nanoBanana" }] });
    expect(built.ok, built.text).toBe(true);
    expect(built.tabId).toBe(id);
    // The user's saved defaults, and the live tab's view to place nodes in.
    expect(built.text).toContain("has the user's saved default aspectRatio 16:9");
    const add = built.ops.find((op) => op.op === "addNode") as { position: { x: number; y: number } };
    expect(add.position.x).toBeGreaterThanOrEqual(VIEWPORT.x);
    expect(add.position.x).toBeLessThan(VIEWPORT.x + VIEWPORT.width);
    // Agent ids start over in the new tab's own draft.
    expect(built.ops[0]).toMatchObject({ op: "addNode", id: "nanoBanana-ag1" });

    // It can be found again by id or name, and the tab it left by its own.
    expect((await call(runtime, "switch_workflow", { tab: "tab-a" })).tabId).toBe("tab-a");
    const back = await call(runtime, "switch_workflow", { tab: "cat posters" });
    expect(back.tabId).toBe(id);
    expect(back.text).toContain("nanoBanana-ag1");
  });

  it("gives every new tab its own id, untitled when no name is given", async () => {
    const runtime = workspace();
    const first = await call(runtime, "new_workflow", {});
    const second = await call(runtime, "new_workflow", { name: " " });
    expect(first).toMatchObject({ ok: true, summary: "Opened a new workflow" });
    expect(first.workspace).toEqual({ op: "newTab", tabId: first.tabId });
    expect(second.tabId).not.toBe(first.tabId);
    expect(second.workspace).toEqual({ op: "newTab", tabId: second.tabId });
  });

  it("is refused while a run is going", async () => {
    const refused = await call(workspace({ live: { running: true } }), "new_workflow", { name: "Cats" });
    expect(refused).toMatchObject({ ok: false, summary: "Not changed: a run is going", tabId: "tab-a" });
  });
});

describe("save_workflow", () => {
  it("saves a saved workflow into its folder, never renaming it", async () => {
    const saved = await call(workspace(), "save_workflow", {});
    expect(saved).toMatchObject({ ok: true, ops: [], tabId: "tab-a", workspace: { op: "save" }, summary: "Saving Fox portraits" });
    expect(saved.text).toContain('Saving "Fox portraits" into its project folder.');
    expect(saved.text).toContain("The app saves it now, after your earlier edits, and tells the user itself if the save fails.");
    expect(saved.text).toContain("don't ask them to check");
    const renamed = await call(workspace(), "save_workflow", { name: "Wolf portraits" });
    expect(renamed.workspace).toEqual({ op: "save" });
    expect(renamed.text).toContain("It keeps its name: saving never renames a workflow.");
  });

  it("needs a name the first time, from the call or the workflow", async () => {
    const runtime = workspace();
    await call(runtime, "switch_workflow", { tab: "tab-c" });
    const refused = await call(runtime, "save_workflow", {});
    expect(refused).toMatchObject({ ok: false, summary: "Needs a name to save", tabId: "tab-c" });
    expect(refused.workspace).toBeUndefined();
    const first = await call(runtime, "save_workflow", { name: "Moodboard" });
    expect(first).toMatchObject({ ok: true, tabId: "tab-c", workspace: { op: "save", name: "Moodboard" }, summary: "Saving Moodboard" });
    expect(first.text).toContain('Saving "Moodboard" as a new project.');
    // Saved now, under that name.
    const later = await call(runtime, "save_workflow", {});
    expect(later).toMatchObject({ ok: true, workspace: { op: "save" }, summary: "Saving Moodboard" });
    expect((await call(runtime, "switch_workflow", { tab: "moodboard" })).summary).toBe("Already in Moodboard");

    // A named workflow never saved takes its own name.
    await call(runtime, "switch_workflow", { tab: "tab-b" });
    expect(await call(runtime, "save_workflow", {})).toMatchObject({ ok: true, tabId: "tab-b", workspace: { op: "save" }, summary: "Saving Haiku" });
  });

  it("is allowed after a run started this turn", async () => {
    const runtime = workspace();
    await call(runtime, "run_workflow", { scope: "all" });
    expect((await call(runtime, "save_workflow", {})).ok).toBe(true);
  });
});

describe("tab steps in order with the edits around them", () => {
  it("waits for an edit still being resolved, and holds back an edit sent after it", async () => {
    const { source, release } = gatedSource();
    const runtime = workspace({ providerKeys: { fal: "fal-key" }, modelSource: source });
    const finished: string[] = [];
    const results: Record<string, AgentToolResult> = {};
    const track = (name: string, promise: Promise<AgentToolResult>) =>
      promise.then((result) => {
        finished.push(name);
        results[name] = result;
      });
    const slow = track("slow edit", runtime.execute("update_node", slowEdit));
    const switched = track("switch", runtime.execute("switch_workflow", { tab: "tab-b" }));
    // Sent after the switch: it must wait for it, then edit tab B (where llmGenerate-7 lives).
    const next = track("next edit", runtime.execute("update_node", { node: "llmGenerate-7", title: "Poet" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toEqual([]);
    release();
    await Promise.all([slow, switched, next]);
    expect(finished).toEqual(["slow edit", "switch", "next edit"]);
    expect(results["slow edit"].tabId).toBe("tab-a");
    expect(results.switch.tabId).toBe("tab-b");
    expect(results["next edit"]).toMatchObject({ ok: true, tabId: "tab-b" });
    expect(results["next edit"].ops).toEqual([{ op: "updateNode", id: "llmGenerate-7", data: { customTitle: "Poet" } }]);
  });

  it("saves after the edits sent before it", async () => {
    const { source, release } = gatedSource();
    const runtime = workspace({ providerKeys: { fal: "fal-key" }, modelSource: source });
    const finished: string[] = [];
    const slow = runtime.execute("update_node", slowEdit).then(() => finished.push("edit"));
    const save = runtime.execute("save_workflow", {}).then(() => finished.push("save"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toEqual([]);
    release();
    await Promise.all([slow, save]);
    expect(finished).toEqual(["edit", "save"]);
  });

  it("runs the tab a pending switch leads to", async () => {
    const runtime = workspace();
    const [switched, run] = await Promise.all([
      runtime.execute("switch_workflow", { tab: "tab-b" }),
      runtime.execute("run_workflow", { scope: "nodes", nodeIds: ["llmGenerate-7"] }),
    ]);
    expect(switched.ok).toBe(true);
    expect(run).toMatchObject({ ok: true, tabId: "tab-b", ops: [{ op: "run", scope: { kind: "nodes", nodeIds: ["llmGenerate-7"] }, runs: 1 }] });
  });

  it("stamps every result with the tab it worked in", async () => {
    const runtime = workspace();
    for (const [tool, args] of [
      ["get_workflow", {}],
      ["describe_node_types", { types: ["prompt"] }],
      ["update_node", { node: "ghost-1", settings: {} }],
      ["edit_workflow", { operations: "not a list" }],
      ["no_such_tool", {}],
      ["arrange_workflow", {}],
    ] as const) {
      expect((await call(runtime, tool, args)).tabId, tool).toBe("tab-a");
    }
  });

  it("starts tabs with an empty snapshot when the request has none", async () => {
    const runtime = createAgentToolRuntime(emptySnapshot({ tabId: "tab-a" }), { tabs: [{ id: "tab-a", active: true, nodeCount: 0 }] });
    const opened = await call(runtime, "new_workflow", {});
    expect(opened.ok, opened.text).toBe(true);
  });
});
