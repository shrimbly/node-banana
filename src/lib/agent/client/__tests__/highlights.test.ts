import { describe, expect, it } from "vitest";
import { agentTouchedNodeIds } from "../highlights";
import type { AgentGraphOpBatch } from "../../types";

function batch(ops: AgentGraphOpBatch["ops"]): AgentGraphOpBatch {
  return { batchId: "b1", toolCallId: "t1", ops, summary: "" };
}

describe("agentTouchedNodeIds", () => {
  it("marks added, edited, moved and regrouped nodes, and the node a new wire feeds", () => {
    expect(
      agentTouchedNodeIds(
        batch([
          { op: "addNode", id: "gen", nodeType: "nanoBanana", position: { x: 0, y: 0 }, data: {} },
          { op: "updateNode", id: "prompt", data: { prompt: "x" } },
          { op: "moveNode", id: "out", position: { x: 10, y: 0 } },
          { op: "addEdge", id: "e1", source: "prompt", sourceHandle: "text", target: "gen", targetHandle: "text" },
          { op: "setNodeGroup", id: "img", groupId: null },
        ]),
      ).sort(),
    ).toEqual(["gen", "img", "out", "prompt"]);
  });

  it("skips removed nodes and edge-only removals", () => {
    expect(
      agentTouchedNodeIds(
        batch([
          { op: "updateNode", id: "a", data: {} },
          { op: "removeNode", id: "a" },
          { op: "removeEdge", id: "e1" },
        ]),
      ),
    ).toEqual([]);
  });

  it("marks the nodes a new group gathers", () => {
    expect(
      agentTouchedNodeIds(
        batch([
          {
            op: "addGroup",
            id: "g",
            name: "Hero",
            color: "blue",
            position: { x: 0, y: 0 },
            size: { width: 10, height: 10 },
            nodeIds: ["a", "b"],
          },
        ]),
      ),
    ).toEqual(["a", "b"]);
  });
});
