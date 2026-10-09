import { describe, expect, it } from "vitest";
import { GraphDraft } from "../draft";
import { GRAPH_PREVIEW_MAX_NODES, graphPreview } from "../preview";
import { snapshotOf, storeEdge, storeNode } from "../../tools/__tests__/testUtils";

describe("graphPreview", () => {
  it("keeps each node's type and box, the connections as indexes, and the name", () => {
    const draft = new GraphDraft(
      snapshotOf(
        {
          nodes: [
            storeNode("prompt-1", "prompt", { x: 10.4, y: -20 }),
            storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 }, {}, { measured: { width: 300, height: 512 } }),
          ],
          edges: [storeEdge("prompt-1", "text", "nanoBanana-2", "text")],
        },
        { workflowName: "Fox portraits" },
      ),
    );
    const graph = graphPreview(draft)!;
    expect(graph.name).toBe("Fox portraits");
    expect(graph.edges).toEqual([[0, 1]]);
    expect(graph.nodes[0].slice(0, 3)).toEqual(["prompt", 10, -20]);
    expect(graph.nodes[1]).toEqual(["nanoBanana", 400, 0, 300, 512]);
    // A node the canvas never measured still gets a height to draw.
    expect(graph.nodes[0][4]).toBeGreaterThan(0);
  });

  it("draws nothing for an empty canvas or one too big to read at minimap size", () => {
    expect(graphPreview(new GraphDraft(snapshotOf({ nodes: [], edges: [] })))).toBeUndefined();
    const many = Array.from({ length: GRAPH_PREVIEW_MAX_NODES + 1 }, (_, i) => storeNode(`prompt-${i}`, "prompt", { x: i * 10, y: 0 }));
    expect(graphPreview(new GraphDraft(snapshotOf({ nodes: many, edges: [] })))).toBeUndefined();
  });
});
