import { describe, expect, it } from "vitest";
import type { SplitGridNodeData } from "@/types";
import { buildCellTemplate } from "../../graph/splitGridCells";
import { resolveSettings } from "../../graph/settings";
import { applyResult, call, edgeKeys, runtimeFor, sequentialIds, snapshotOf, type StoreState } from "./testUtils";
import { createAgentToolRuntime } from "../runtime";

const empty: StoreState = { nodes: [], edges: [], groups: {} };

// The request that used to stop halfway: a 3×3 grid, every cell upscaled, all into one gallery.
const chickenSuitGrid = {
  nodes: [
    { ref: "p", type: "prompt", settings: { prompt: "A 3x3 grid of nine photos of a man in a chicken suit" } },
    { ref: "g", type: "nanoBanana", settings: { aspectRatio: "1:1" } },
    {
      ref: "s",
      type: "splitGrid",
      settings: {
        gridRows: 3,
        gridCols: 3,
        cells: {
          nodes: [
            { ref: "ask", type: "prompt", settings: { prompt: "Upscale this image: keep it identical, sharper" } },
            { ref: "up", type: "nanoBanana", settings: { resolution: "4K" } },
          ],
          connections: [
            { from: "cell", to: "up" },
            { from: "ask", to: "up" },
          ],
          collect: [{ from: "up" }],
          into: "gallery",
        },
      },
    },
    { ref: "gallery", type: "outputGallery" },
  ],
  connections: [
    { from: "p", to: "g" },
    { from: "g", to: "s" },
  ],
};

describe("Split Grid cells", () => {
  it("builds the per-cell template, a shared Router, and wires the Router into the gallery in one call", async () => {
    const result = await call(runtimeFor(empty), "create_workflow", chickenSuitGrid);
    expect(result.ok, result.text).toBe(true);

    const state = applyResult(empty, result);
    const grid = state.nodes.find((n) => n.type === "splitGrid")!;
    const router = state.nodes.find((n) => n.type === "router")!;
    const gallery = state.nodes.find((n) => n.type === "outputGallery")!;
    const data = grid.data as SplitGridNodeData;

    expect(data.gridRows).toBe(3);
    expect(data.template?.nodes.map((n) => [n.id, n.type])).toEqual([
      ["cell-image", "imageInput"],
      ["cell-ask", "prompt"],
      ["cell-up", "nanoBanana"],
    ]);
    expect(data.template?.edges.map((e) => `${e.source}.${e.sourceHandle} -> ${e.target}.${e.targetHandle}`)).toEqual([
      "cell-image.image -> cell-up.image",
      "cell-ask.text -> cell-up.text",
    ]);
    expect(data.template?.router).toEqual([{ source: "cell-up", sourceHandle: "image", targetHandle: "image" }]);
    expect(data.template?.nodes[2].data).toMatchObject({ resolution: "4K" });
    expect(data.routerNodeId).toBe(router.id);
    expect(edgeKeys(state.edges)).toContain(`${router.id}.image -> ${gallery.id}.image`);
  });

  it("describes the grid's cells and Router to the agent next turn", async () => {
    const result = await call(runtimeFor(empty), "create_workflow", chickenSuitGrid);
    const state = applyResult(empty, result);
    const runtime = createAgentToolRuntime(snapshotOf(state), { randomId: sequentialIds() });
    const view = await call(runtime, "get_workflow", {});
    expect(view.text).toMatch(/each cell: ask \(Prompt\), up \(Generate Image\)/);
    expect(view.text).toMatch(/collected into the shared Router: up\.image/);
  });

  it("rejects a cell pipeline it cannot build, with the reason", () => {
    const context = { newId: sequentialIds() };
    const bad = buildCellTemplate(
      { nodes: [{ ref: "cell", type: "prompt" }, { ref: "x", type: "splitGrid" }], connections: [{ from: "cell", to: "nope" }] },
      context,
      resolveSettings,
      "splitGrid-1",
    );
    expect(bad.ok).toBe(false);
    const errors = (bad as { errors: string[] }).errors.join("\n");
    expect(errors).toMatch(/reserved for the cell's image slice/);
    expect(errors).toMatch(/Split Grid nodes cannot go in a cell/);
    expect(errors).toMatch(/"nope" is not "cell" or a ref/);
  });

  it("clears the cells with null", async () => {
    const created = applyResult(empty, await call(runtimeFor(empty), "create_workflow", chickenSuitGrid));
    const grid = created.nodes.find((n) => n.type === "splitGrid")!;
    const cleared = await call(runtimeFor(created), "update_node", { node: grid.id, settings: { cells: null } });
    expect(cleared.ok, cleared.text).toBe(true);
    const after = applyResult(created, cleared).nodes.find((n) => n.id === grid.id)!.data as SplitGridNodeData;
    expect(after.template?.nodes).toHaveLength(1);
    expect(after.template?.router).toBeUndefined();
  });
});
