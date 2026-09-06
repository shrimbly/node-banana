import { describe, it, expect } from "vitest";
import { edgeBundles, bundleMembership, shareHandle, sharedEnd, edgesOnHandle } from "../bundles";
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
const bundled = (id: string, bundleId: string, overrides: Partial<WorkflowEdge> = {}, end: "source" | "target" = "source") =>
  edge(id, {
    ...overrides,
    data: { createdAt: Number(id.replace(/\D/g, "")) || 0, [`${end}BundleId`]: bundleId, ...(overrides.data ?? {}) },
  });

describe("edgeBundles", () => {
  it("is empty for connections without a bundle id", () => {
    expect(edgeBundles("e1", [edge("e1"), edge("e2"), edge("e3")])).toEqual({ source: null, target: null });
  });

  it("bundles a fan-out at the shared output handle", () => {
    const fanOut = [bundled("e1", "x"), bundled("e2", "x"), bundled("e3", "x")];
    const { source, target } = edgeBundles("e2", fanOut);
    expect(source).toMatchObject({ end: "source", index: 1, count: 3, key: "source:x" });
    expect(target).toBeNull();
  });

  it("bundles a fan-in at the shared input handle", () => {
    const fanIn = [bundled("e1", "in", { source: "x", target: "gen" }, "target"), bundled("e2", "in", { source: "y", target: "gen" }, "target")];
    const { source, target } = edgeBundles("e1", fanIn);
    expect(source).toBeNull();
    expect(target).toMatchObject({ end: "target", index: 0, count: 2, key: "target:in" });
  });

  it("orders members by creation and reports the index", () => {
    const m = edgeBundles("e3", [bundled("e3", "x"), bundled("e1", "x"), bundled("e2", "x")]).source;
    expect(m?.members).toEqual(["e1", "e2", "e3"]);
    expect(m?.index).toBe(2);
  });

  it("only groups members that actually share the handle", () => {
    const edges = [bundled("e1", "x"), bundled("e2", "x"), bundled("e3", "x", { sourceHandle: "text" })];
    expect(edgeBundles("e1", edges).source?.count).toBe(2);
    expect(edgeBundles("e3", edges).source).toBeNull();
  });

  it("keeps hidden and reference edges out", () => {
    const edges = [bundled("e1", "x"), bundled("e2", "x", { data: { hidden: true } }), bundled("e3", "x", { type: "reference" })];
    expect(edgeBundles("e1", edges).source).toBeNull();
    expect(edgeBundles("e2", edges).source).toBeNull();
  });

  it("keeps a bundle at each end independently", () => {
    // e1 fans out from a with e2, and fans in to gen with e9
    const edges = [
      bundled("e1", "out", { target: "gen", data: { targetBundleId: "in" } }),
      bundled("e2", "out"),
      bundled("e9", "in", { source: "z", target: "gen" }, "target"),
    ];
    const { source, target } = edgeBundles("e1", edges);
    expect(source).toMatchObject({ end: "source", key: "source:out", count: 2 });
    expect(target).toMatchObject({ end: "target", key: "target:in", count: 2 });
  });

  it("drops a bundle with a single remaining member", () => {
    expect(edgeBundles("e1", [bundled("e1", "x"), edge("e2")]).source).toBeNull();
  });
});

describe("bundleMembership", () => {
  it("prefers the source end for the toolbar", () => {
    const edges = [bundled("e1", "x", { target: "gen" }), bundled("e2", "x", { target: "gen" }), bundled("e3", "y", { source: "b", target: "gen" }, "target")];
    expect(bundleMembership("e1", edges)?.end).toBe("source");
    expect(bundleMembership("e3", [...edges, bundled("e4", "y", { source: "c", target: "gen" }, "target")])?.end).toBe("target");
  });
});

describe("shareHandle", () => {
  it("is true when every edge leaves one output handle or arrives at one input handle", () => {
    expect(shareHandle([edge("e1"), edge("e2")])).toBe(true);
    expect(shareHandle([edge("e1", { source: "x", target: "gen" }), edge("e2", { source: "y", target: "gen" })])).toBe(true);
    expect(shareHandle([edge("e1"), edge("e2", { sourceHandle: "text" })])).toBe(false);
    expect(shareHandle([edge("e1")])).toBe(false);
  });

  it("names the shared end, output first", () => {
    expect(sharedEnd([edge("e1"), edge("e2")])).toBe("source");
    expect(sharedEnd([edge("e1", { source: "x", target: "gen" }), edge("e2", { source: "y", target: "gen" })])).toBe("target");
    expect(sharedEnd([edge("e1"), edge("e2", { sourceHandle: "text" })])).toBeNull();
  });
});

describe("edgesOnHandle", () => {
  const edges = [edge("e2"), edge("e1"), edge("e3", { sourceHandle: "text" }), edge("e4", { source: "b" })];

  it("lists the connections on one output handle in creation order", () => {
    expect(edgesOnHandle(edges, "a", "source", "image").map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(edgesOnHandle(edges, "a", "source", "text").map((e) => e.id)).toEqual(["e3"]);
  });

  it("lists the connections on one input handle", () => {
    expect(edgesOnHandle(edges, "t-e1", "target", "image").map((e) => e.id)).toEqual(["e1"]);
    expect(edgesOnHandle(edges, "nope", "target", "image")).toEqual([]);
  });
});
