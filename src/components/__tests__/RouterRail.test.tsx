import { describe, expect, it } from "vitest";
import type { InternalNode } from "@xyflow/react";
import { routerWireGeoms } from "../splitgrid/RouterRail";
import type { TemplateRFNode } from "../splitgrid/TemplateNodes";

const node: TemplateRFNode = {
  id: "video", type: "splitGridTemplateNode", position: { x: 100, y: 200 },
  measured: { width: 300, height: 600 },
  data: { nodeType: "generateVideo", overrides: {}, isBase: false },
};
const wires = [{ source: node.id, sourceHandle: "video" }];
const size = { width: 1000, height: 700 };
const viewport = { x: 0, y: 0, zoom: 1 };
const start = (path: string) => path.match(/^M ([\d.-]+) ([\d.-]+) /)?.slice(1).map(Number);

describe("router wire source socket", () => {
  it("anchors to the output row before measurement, independently of controls height", () => {
    const compact = { ...node, measured: { width: 300, height: 200 } };
    const expanded = routerWireGeoms(wires, [node], size, viewport);
    expect(start(expanded[0].path)).toEqual([405, 225]);
    expect(routerWireGeoms(wires, [compact], size, viewport)[0].path).toBe(expanded[0].path);
  });

  it("uses the matching measured socket and follows absolute position, pan and zoom", () => {
    const measured = {
      ...node,
      internals: {
        positionAbsolute: { x: 500, y: 100 },
        handleBounds: { source: [
          { id: "image", x: 296, y: 80, width: 18, height: 28 },
          { id: "video", x: 296, y: 11, width: 18, height: 28 },
        ] },
      },
    } as InternalNode<TemplateRFNode>;
    const sources = new Map([[node.id, measured]]);
    const geoms = routerWireGeoms(wires, [node], size, { x: 20, y: -10, zoom: 0.5 }, sources);
    expect(start(geoms[0].path)).toEqual([422.5, 52.5]);
  });

  it("omits wires whose source node or output socket no longer exists", () => {
    expect(routerWireGeoms(wires, [], size, viewport)).toEqual([]);
    expect(routerWireGeoms([{ source: node.id, sourceHandle: "image" }], [node], size, viewport)).toEqual([]);
  });
});
