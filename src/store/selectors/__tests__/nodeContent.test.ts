import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@/types";
import { selectNodeContent } from "../nodeContent";
import { nodeReadinessPure } from "@/store/utils/connectedInputs";
import { calculatePredictedCost } from "@/utils/costCalculator";

const makeNodes = (): WorkflowNode[] => [
  { id: "prompt", type: "prompt", position: { x: 0, y: 0 }, data: { prompt: "Landscape" } },
  { id: "generate", type: "nanoBanana", position: { x: 400, y: 0 }, data: { model: "nano-banana", status: "idle", outputImage: null } },
] as WorkflowNode[];

describe("content-only node subscriptions", () => {
  it("retains content through dragging, measuring, resizing and selection", () => {
    let nodes = makeNodes();
    const content = selectNodeContent({ nodes });
    for (let i = 0; i < 100; i++) {
      nodes = nodes.map(node => ({ ...node, position: { x: i, y: i * 2 }, dragging: true, selected: true, measured: { width: 300, height: 200 }, style: { width: 400 } }));
      expect(selectNodeContent({ nodes })).toBe(content);
    }
    expect(content[0]).not.toHaveProperty("position");
    expect(content[0]).not.toHaveProperty("selected");
  });

  it("invalidates on content changes, deletion, addition, order and type changes", () => {
    const nodes = makeNodes();
    const first = selectNodeContent({ nodes });
    for (const changed of [
      [{ ...nodes[0], data: { ...nodes[0].data, customTitle: "New name" } }, nodes[1]],
      nodes.slice(1),
      [...nodes, { ...nodes[0], id: "another" }],
      [...nodes].reverse(),
      [{ ...nodes[0], type: "output" }, nodes[1]],
    ] as WorkflowNode[][]) {
      const content = selectNodeContent({ nodes: changed });
      expect(content).not.toBe(first);
      expect(content).toEqual(changed.map(({ id, type, data }) => ({ id, type, data })));
    }
  });

  it("keeps cached snapshots correct when switching workflows with reused IDs", () => {
    const a = makeNodes();
    const b = makeNodes();
    b[0] = { ...b[0], data: { ...b[0].data, customTitle: "Different workflow" } };
    const contentA = selectNodeContent({ nodes: a });
    const contentB = selectNodeContent({ nodes: b });
    expect(selectNodeContent({ nodes: a })).toBe(contentA);
    expect(selectNodeContent({ nodes: b })).toBe(contentB);
    expect(contentB[0].data.customTitle).toBe("Different workflow");
  });

  it("preserves costs and readiness while responding to new settings and wiring", () => {
    const nodes = makeNodes();
    const content = selectNodeContent({ nodes });
    expect(calculatePredictedCost(content)).toEqual(calculatePredictedCost(nodes));
    expect(nodeReadinessPure(content, [])).toEqual(nodeReadinessPure(nodes, []));
    expect(nodeReadinessPure(content, []).generate.hint).toBe("needs a prompt");
    expect(nodeReadinessPure(content, [{ id: "edge", source: "prompt", target: "generate", targetHandle: "text" }])).toEqual({});
    const updated = selectNodeContent({ nodes: [nodes[0], { ...nodes[1], data: { ...nodes[1].data, model: "nano-banana-pro" } } as WorkflowNode] });
    expect(calculatePredictedCost(updated).totalCost).not.toBe(calculatePredictedCost(content).totalCost);
  });
});
