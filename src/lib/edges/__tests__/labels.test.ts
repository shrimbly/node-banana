import { describe, it, expect } from "vitest";
import { edgeTypeLabel, edgeAutoLabel, edgeDisplayLabelById, hiddenSiblingIndex } from "../labels";
import type { WorkflowEdge } from "@/types";

const edge = (id: string, overrides: Partial<WorkflowEdge> = {}): WorkflowEdge => ({
  id,
  source: "a",
  sourceHandle: "image",
  target: "b",
  targetHandle: "image",
  data: {},
  ...overrides,
});

describe("edgeTypeLabel", () => {
  it("names the data types", () => {
    expect(edgeTypeLabel("image-2")).toBe("Image");
    expect(edgeTypeLabel("prompt")).toBe("Text");
    expect(edgeTypeLabel("video")).toBe("Video");
    expect(edgeTypeLabel("audio")).toBe("Audio");
    expect(edgeTypeLabel("3d")).toBe("3D");
    expect(edgeTypeLabel("easeCurve")).toBe("Ease curve");
    expect(edgeTypeLabel(null)).toBe("Connection");
  });
});

describe("edgeAutoLabel", () => {
  it("uses the image order when several images feed one handle", () => {
    const edges = [edge("first", { data: { createdAt: 1 } }), edge("second", { source: "c", data: { createdAt: 2 } })];
    expect(edgeAutoLabel(edges[1], edges)).toBe("Image 2");
    expect(edgeDisplayLabelById("first", edges)).toBe("Image 1");
  });

  it("falls back to the type name", () => {
    const lone = edge("e", { sourceHandle: "text", targetHandle: "text" });
    expect(edgeAutoLabel(lone, [lone])).toBe("Text");
    expect(edgeDisplayLabelById("missing", [lone])).toBe("");
  });
});

describe("hiddenSiblingIndex", () => {
  const edges = [
    edge("late", { data: { hidden: true, createdAt: 30 } }),
    edge("early", { source: "c", data: { hidden: true, createdAt: 10 } }),
    edge("visible", { source: "d", data: { createdAt: 20 } }),
    edge("elsewhere", { source: "c", target: "z", data: { hidden: true, createdAt: 5 } }),
  ];

  it("stacks hidden edges sharing a target handle in creation order", () => {
    expect(hiddenSiblingIndex("early", edges, "target")).toBe(0);
    expect(hiddenSiblingIndex("late", edges, "target")).toBe(1);
  });

  it("counts only hidden edges on the same source handle", () => {
    // "early" and "elsewhere" both leave c's image handle; "elsewhere" was made first
    expect(hiddenSiblingIndex("elsewhere", edges, "source")).toBe(0);
    expect(hiddenSiblingIndex("early", edges, "source")).toBe(1);
    expect(hiddenSiblingIndex("late", edges, "source")).toBe(0);
  });

  it("is zero for unknown edges", () => {
    expect(hiddenSiblingIndex("nope", edges, "target")).toBe(0);
  });
});

describe("edgeDisplayLabel", () => {
  it("prefers the user's own label, trimmed", async () => {
    const { edgeDisplayLabel, edgeDisplayLabelById } = await import("../labels");
    const own = edge("own", { data: { label: "  hero shot " } });
    expect(edgeDisplayLabel(own, [own])).toBe("hero shot");
    expect(edgeDisplayLabelById("own", [own])).toBe("hero shot");
  });

  it("falls back to the automatic label when the own label is blank", async () => {
    const { edgeDisplayLabel } = await import("../labels");
    const blank = edge("blank", { data: { label: "   " } });
    expect(edgeDisplayLabel(blank, [blank])).toBe("Image");
  });
});

describe("parallelEdgePosition", () => {
  it("orders visible edges between the same nodes by creation time", async () => {
    const { parallelEdgePosition } = await import("../labels");
    const edges = [
      edge("second", { targetHandle: "image-1", data: { createdAt: 2 } }),
      edge("first", { data: { createdAt: 1 } }),
      edge("hidden", { targetHandle: "image-2", data: { createdAt: 0, hidden: true } }),
      edge("other", { target: "z", data: { createdAt: 3 } }),
    ];
    expect(parallelEdgePosition("first", edges)).toEqual({ index: 0, count: 2 });
    expect(parallelEdgePosition("second", edges)).toEqual({ index: 1, count: 2 });
    expect(parallelEdgePosition("other", edges)).toEqual({ index: 0, count: 1 });
    expect(parallelEdgePosition("missing", edges)).toEqual({ index: 0, count: 1 });
  });
});
