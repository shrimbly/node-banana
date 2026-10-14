import { describe, expect, it } from "vitest";
import type { HandleAnchor, SceneNode } from "../graph";
import { connectCandidates } from "../connectCandidates";

const node = (id: string, x: number, handles: [string, Partial<HandleAnchor>][] = []): SceneNode =>
  ({ id, type: "prompt", x, y: 0, w: 100, h: 100, handles: new Map(handles.map(([k, a]) => [k, { x: 0, y: 0, ...a }])) }) as unknown as SceneNode;

describe("connectCandidates", () => {
  const nodes = [
    node("from", 0, [["source:text", {}]]),
    node("near", 150),
    node("takes", 600, [["target:text", {}]]),
    node("hidden", 300, [["target:image", { connectableEnd: false }]]),
  ];

  it("ranks nodes that take the connection first, then by distance, leaving out the one it starts from", () => {
    expect(connectCandidates({ nodes }, [0, 1, 2, 3], { x: 120, y: 50 }, "target", "from")).toEqual(["takes", "near", "hidden"]);
  });

  it("keeps to the nodes on screen and the cap", () => {
    expect(connectCandidates({ nodes }, [1, 3], { x: 120, y: 50 }, "target", "from", 1)).toEqual(["near"]);
  });
});
