import { describe, it, expect } from "vitest";
import { edgeBundles, bundleMembership, shareHandle } from "../bundles";
import type { WorkflowEdge } from "@/types";

// Fan-out from a's image handle by default; each edge lands on its own node
const edge = (id: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id,
  source: "a",
  sourceHandle: "image",
  target: `t-${id}`,
  targetHandle: "image",
  data: { createdAt: Number(id.replace(/\D/g, "")) || 0 },
  ...overrides,
});

describe("edgeBundles", () => {
  const fanOut = [edge("e1"), edge("e2"), edge("e3")];

  it("does not bundle when bundling is off and there is no manual bundle", () => {
    expect(edgeBundles("e1", fanOut, "off")).toEqual({ source: null, target: null });
  });

  it("bundles a fan-out at the shared output handle", () => {
    const { source, target } = edgeBundles("e2", fanOut, "auto");
    expect(source).toMatchObject({ end: "source", index: 1, count: 3, manual: false, key: "source:a:image" });
    expect(target).toBeNull();
  });

  it("bundles a fan-in at the shared input handle", () => {
    const fanIn = [edge("e1", { source: "x", target: "gen" }), edge("e2", { source: "y", target: "gen" })];
    const { source, target } = edgeBundles("e1", fanIn, "on");
    expect(source).toBeNull();
    expect(target).toMatchObject({ end: "target", index: 0, count: 2, key: "target:gen:image" });
  });

  it("needs two connections when on and three when auto", () => {
    const two = fanOut.slice(0, 2);
    expect(edgeBundles("e1", two, "on").source?.count).toBe(2);
    expect(edgeBundles("e1", two, "auto").source).toBeNull();
  });

  it("orders members by creation and reports the index", () => {
    const m = edgeBundles("e3", fanOut, "on").source;
    expect(m?.members).toEqual(["e1", "e2", "e3"]);
    expect(m?.index).toBe(2);
  });

  it("treats different handles on one node as different bundles", () => {
    const edges = [edge("e1"), edge("e2"), edge("e3", { sourceHandle: "text" })];
    expect(edgeBundles("e1", edges, "on").source?.count).toBe(2);
    expect(edgeBundles("e3", edges, "on").source).toBeNull();
  });

  it("keeps hidden and reference edges out", () => {
    const edges = [edge("e1"), edge("e2", { data: { hidden: true } }), edge("e3", { type: "reference" })];
    expect(edgeBundles("e1", edges, "on").source).toBeNull();
    expect(edgeBundles("e2", edges, "on").source).toBeNull();
  });

  it("honours manual bundles regardless of the setting", () => {
    const edges = [edge("e1", { data: { bundleId: "x", createdAt: 1 } }), edge("e2", { data: { bundleId: "x", createdAt: 2 } }), edge("e3")];
    expect(edgeBundles("e2", edges, "off").source).toMatchObject({ key: "source:x", index: 1, count: 2, manual: true });
    expect(edgeBundles("e3", edges, "on").source).toBeNull();
  });

  it("drops a manual bundle with a single remaining member", () => {
    const edges = [edge("e1", { data: { bundleId: "x" } }), edge("e2")];
    expect(edgeBundles("e1", edges, "off").source).toBeNull();
  });
});

describe("bundleMembership", () => {
  it("prefers the source end for the toolbar", () => {
    const edges = [edge("e1", { target: "gen" }), edge("e2", { target: "gen" }), edge("e3", { source: "b", target: "gen" })];
    expect(bundleMembership("e1", edges, "on")?.end).toBe("source");
    expect(bundleMembership("e3", edges, "on")?.end).toBe("target");
  });
});

describe("shareHandle", () => {
  it("is true when every edge leaves one output handle or arrives at one input handle", () => {
    expect(shareHandle([edge("e1"), edge("e2")])).toBe(true);
    expect(shareHandle([edge("e1", { source: "x", target: "gen" }), edge("e2", { source: "y", target: "gen" })])).toBe(true);
    expect(shareHandle([edge("e1"), edge("e2", { sourceHandle: "text" })])).toBe(false);
    expect(shareHandle([edge("e1")])).toBe(false);
  });
});
