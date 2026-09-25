import { describe, expect, it } from "vitest";
import { arrangeNodes, COLUMN_GAP, placeNewNodes, ROW_GAP, type LayoutBox } from "../layout";

const box = (id: string, x: number, y: number, width = 300, height = 300): LayoutBox => ({ id, x, y, width, height });
const size = (id: string, width = 300, height = 300) => ({ id, width, height });

function overlap(a: LayoutBox, b: LayoutBox): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function boxesOf(positions: Map<string, { x: number; y: number }>, sizes: Array<{ id: string; width: number; height: number }>): LayoutBox[] {
  return sizes.map((s) => ({ ...s, ...positions.get(s.id)! }));
}

describe("placeNewNodes", () => {
  it("lays a chain out in columns, centred in the viewport on an empty canvas", () => {
    const sizes = [size("p", 320, 220), size("g"), size("o", 320, 320)];
    const positions = placeNewNodes({
      place: sizes,
      fixed: [],
      edges: [{ source: "p", target: "g" }, { source: "g", target: "o" }],
      viewport: { x: 1000, y: 500, width: 2000, height: 1000 },
    });
    const [p, g, o] = boxesOf(positions, sizes);
    expect(g.x).toBe(p.x + 320 + COLUMN_GAP);
    expect(o.x).toBe(g.x + 300 + COLUMN_GAP);
    const width = o.x + o.width - p.x;
    expect(p.x).toBe(Math.round(1000 + (2000 - width) / 2));
    // Columns are centred on the tallest one.
    expect(p.y + p.height / 2).toBe(o.y + o.height / 2);
  });

  it("stacks siblings in one column with the row gap, ordered to avoid crossings", () => {
    const sizes = [size("arr"), size("a"), size("b"), size("c"), size("oa"), size("ob"), size("oc")];
    const positions = placeNewNodes({
      place: sizes,
      fixed: [],
      edges: [
        { source: "arr", target: "a" },
        { source: "arr", target: "b" },
        { source: "arr", target: "c" },
        { source: "c", target: "oc" },
        { source: "a", target: "oa" },
        { source: "b", target: "ob" },
      ],
    });
    const byId = new Map(boxesOf(positions, sizes).map((b) => [b.id, b]));
    expect(byId.get("b")!.y).toBe(byId.get("a")!.y + 300 + ROW_GAP);
    expect(byId.get("c")!.y).toBe(byId.get("b")!.y + 300 + ROW_GAP);
    // Each output sits level with its own generator.
    for (const [gen, out] of [["a", "oa"], ["b", "ob"], ["c", "oc"]]) {
      expect(byId.get(out)!.y).toBe(byId.get(gen)!.y);
    }
  });

  it("puts nodes fed by existing ones to their right, and feeders to the left of their target", () => {
    const fixed = [box("gen", 400, 100)];
    const after = placeNewNodes({ place: [size("out")], fixed, edges: [{ source: "gen", target: "out" }] });
    expect(after.get("out")).toEqual({ x: 400 + 300 + COLUMN_GAP, y: 100 });

    const before = placeNewNodes({ place: [size("prompt", 320, 220)], fixed, edges: [{ source: "prompt", target: "gen" }] });
    expect(before.get("prompt")).toEqual({ x: 400 - COLUMN_GAP - 320, y: 100 });
  });

  it("places an unrelated cluster right of the existing canvas", () => {
    const fixed = [box("a", 0, 0), box("b", 0, 400, 500, 300)];
    const positions = placeNewNodes({ place: [size("x")], fixed, edges: [] });
    expect(positions.get("x")).toEqual({ x: 500 + 200, y: 0 });
  });

  it("slides a cluster down until it overlaps nothing", () => {
    const fixed = [box("gen", 0, 0), box("blocker", 400, 0, 300, 500)];
    const sizes = [size("out")];
    const positions = placeNewNodes({ place: sizes, fixed, edges: [{ source: "gen", target: "out" }] });
    const placed = boxesOf(positions, sizes)[0];
    expect(placed.x).toBe(400);
    expect(overlap(placed, fixed[1])).toBe(false);
    expect(placed.y).toBeGreaterThanOrEqual(500);
  });

  it("ignores loop edges when computing columns", () => {
    const sizes = [size("a"), size("b")];
    const positions = placeNewNodes({
      place: sizes,
      fixed: [],
      edges: [{ source: "a", target: "b" }, { source: "b", target: "a", isLoop: true }],
    });
    expect(positions.get("b")!.x).toBeGreaterThan(positions.get("a")!.x);
  });

  it("never overlaps existing nodes or other new clusters", () => {
    const fixed = [box("f1", 0, 0), box("f2", 0, 350), box("f3", 400, 200)];
    const sizes = [size("a"), size("b"), size("c"), size("d")];
    const positions = placeNewNodes({
      place: sizes,
      fixed,
      edges: [{ source: "f1", target: "a" }, { source: "f2", target: "b" }, { source: "c", target: "f3" }],
    });
    const placed = boxesOf(positions, sizes);
    const all = [...fixed, ...placed];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(overlap(all[i], all[j]), `${all[i].id} × ${all[j].id}`).toBe(false);
    }
  });
});

describe("placeNewNodes with the heights the node shell renders", () => {
  // Nodes are width-driven: a rendered node's height is what React Flow
  // measured from its content, which strays far from the type defaults (a
  // Generate Image with its settings open is ~450 tall, an empty Output ~170).
  // New nodes have no measurement yet and are placed with the default heights.
  const measured = { prompt: 206, generateImage: 452, llm: 318, output: 170 };

  it("stacks new siblings by their own heights, clear of tall measured neighbours", () => {
    const fixed = [
      box("prompt", 0, 0, 320, measured.prompt),
      box("llm", 420, 0, 320, measured.llm),
      box("tallGen", 840, 0, 300, measured.generateImage),
      box("tallGen2", 840, measured.generateImage + ROW_GAP, 300, measured.generateImage),
    ];
    const sizes = [size("gen1", 300, 300), size("gen2", 300, 300), size("out1", 320, 320), size("out2", 320, 320)];
    const positions = placeNewNodes({
      place: sizes,
      fixed,
      edges: [
        { source: "llm", target: "gen1" },
        { source: "llm", target: "gen2" },
        { source: "gen1", target: "out1" },
        { source: "gen2", target: "out2" },
      ],
    });
    const placed = boxesOf(positions, sizes);
    const byId = new Map(placed.map((b) => [b.id, b]));
    // The column lands right of the LLM, which sits where the tall generators are: it slides below them.
    expect(byId.get("gen1")!.x).toBe(420 + 320 + COLUMN_GAP);
    expect(byId.get("gen1")!.y).toBeGreaterThanOrEqual(2 * measured.generateImage + ROW_GAP);
    // Each generator + output pair is its own cluster; the second stacks below the first.
    expect(byId.get("gen2")!.y).toBeGreaterThanOrEqual(byId.get("gen1")!.y + 300 + ROW_GAP);
    const all = [...fixed, ...placed];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) expect(overlap(all[i], all[j]), `${all[i].id} × ${all[j].id}`).toBe(false);
    }
  });

  it("anchors a feeder to the top of a tall measured target and keeps it clear of the node above", () => {
    // "above" was measured taller than its type default: its real bottom reaches below the target's top.
    const fixed = [box("gen", 500, 0, 300, measured.generateImage), box("above", 0, -200, 320, measured.prompt)];
    const positions = placeNewNodes({ place: [size("prompt", 320, 220)], fixed, edges: [{ source: "prompt", target: "gen" }] });
    const placed = boxesOf(positions, [size("prompt", 320, 220)])[0];
    expect(placed.x).toBe(500 - COLUMN_GAP - 320);
    expect(overlap(placed, fixed[1])).toBe(false);
    expect(placed.y).toBeGreaterThanOrEqual(-200 + measured.prompt);
  });
});

describe("arrangeNodes", () => {
  it("re-lays a tangled chain into columns from its top-left corner", () => {
    const nodes = [box("o", 50, 900), box("p", 800, 40), box("g", 10, 400)];
    const positions = arrangeNodes(nodes, [{ source: "p", target: "g" }, { source: "g", target: "o" }]);
    expect(positions.get("p")).toEqual({ x: 10, y: 40 });
    expect(positions.get("g")).toEqual({ x: 10 + 300 + COLUMN_GAP, y: 40 });
    expect(positions.get("o")).toEqual({ x: 10 + 2 * (300 + COLUMN_GAP), y: 40 });
  });

  it("stacks separate clusters vertically", () => {
    const nodes = [box("a", 0, 0), box("b", 500, 0), box("c", 0, 600)];
    const positions = arrangeNodes(nodes, [{ source: "a", target: "b" }]);
    expect(positions.get("c")!.y).toBeGreaterThanOrEqual(300 + 80);
  });
});
