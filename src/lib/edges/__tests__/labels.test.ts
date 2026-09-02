import { describe, it, expect } from "vitest";
import { edgeTypeLabel, edgeAutoLabel, edgeAutoLabelById, hiddenSiblingIndex } from "../labels";
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
    expect(edgeAutoLabelById("first", edges)).toBe("Image 1");
  });

  it("falls back to the type name", () => {
    const lone = edge("e", { sourceHandle: "text", targetHandle: "text" });
    expect(edgeAutoLabel(lone, [lone])).toBe("Text");
    expect(edgeAutoLabelById("missing", [lone])).toBe("");
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
