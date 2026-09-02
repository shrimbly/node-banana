import { describe, it, expect } from "vitest";
import { bundleMembership, shareNodePair } from "../bundles";
import type { WorkflowEdge } from "@/types";

const edge = (id: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id,
  source: "a",
  sourceHandle: "image",
  target: "b",
  targetHandle: `image-${id}`,
  data: { createdAt: Number(id.replace(/\D/g, "")) || 0 },
  ...overrides,
});

describe("bundleMembership", () => {
  const three = [edge("e1"), edge("e2"), edge("e3")];

  it("does not bundle when bundling is off and there is no manual bundle", () => {
    expect(bundleMembership("e1", three, "off")).toBeNull();
  });

  it("bundles two or more parallel connections when on, three or more when auto", () => {
    const two = three.slice(0, 2);
    expect(bundleMembership("e1", two, "on")?.count).toBe(2);
    expect(bundleMembership("e1", two, "auto")).toBeNull();
    expect(bundleMembership("e2", three, "auto")).toMatchObject({ index: 1, count: 3, manual: false, key: "a->b" });
  });

  it("orders members by creation and reports the index", () => {
    const m = bundleMembership("e3", three, "on");
    expect(m?.members).toEqual(["e1", "e2", "e3"]);
    expect(m?.index).toBe(2);
  });

  it("keeps hidden and reference edges out", () => {
    const edges = [edge("e1"), edge("e2", { data: { hidden: true } }), edge("e3", { type: "reference" })];
    expect(bundleMembership("e1", edges, "on")).toBeNull();
    expect(bundleMembership("e2", edges, "on")).toBeNull();
  });

  it("only groups connections between the same two nodes", () => {
    const edges = [edge("e1"), edge("e2", { target: "c" })];
    expect(bundleMembership("e1", edges, "on")).toBeNull();
  });

  it("honours manual bundles regardless of the setting", () => {
    const edges = [edge("e1", { data: { bundleId: "x", createdAt: 1 } }), edge("e2", { data: { bundleId: "x", createdAt: 2 } }), edge("e3")];
    const m = bundleMembership("e2", edges, "off");
    expect(m).toMatchObject({ key: "x", index: 1, count: 2, manual: true });
    // The third edge is not in the manual bundle and is alone for auto bundling
    expect(bundleMembership("e3", edges, "on")).toBeNull();
  });

  it("drops a manual bundle with a single remaining member", () => {
    const edges = [edge("e1", { data: { bundleId: "x" } }), edge("e2")];
    expect(bundleMembership("e1", edges, "off")).toBeNull();
  });
});

describe("shareNodePair", () => {
  it("is true only when every edge joins the same two nodes", () => {
    expect(shareNodePair([edge("e1"), edge("e2")])).toBe(true);
    expect(shareNodePair([edge("e1"), edge("e2", { source: "z" })])).toBe(false);
    expect(shareNodePair([])).toBe(false);
  });
});
