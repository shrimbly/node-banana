import { describe, it, expect } from "vitest";
import {
  edgeTypeLabel,
  edgeAutoLabel,
  edgeDisplayLabelById,
  stackHiddenStubs,
  hiddenStubOffset,
  hiddenStubGroup,
  hiddenStubRole,
  pluralTypeLabel,
  stubGroupKey,
} from "../labels";
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

describe("stackHiddenStubs", () => {
  const edges = [
    edge("img1", { data: { hidden: true, createdAt: 10 } }),
    edge("img2", { source: "c", data: { hidden: true, createdAt: 20 } }),
    edge("img3", { source: "d", data: { hidden: true, createdAt: 30 } }),
    edge("txt1", { source: "p", sourceHandle: "text", targetHandle: "text", data: { hidden: true, createdAt: 5 } }),
    edge("shown", { source: "e", data: { createdAt: 1 } }),
    edge("elsewhere", { source: "c", target: "z", data: { hidden: true, createdAt: 2 } }),
  ];
  const handleY = (handleId: string | null) => (handleId === "image" ? 100 : handleId === "text" ? 130 : undefined);

  const imageGroup = stubGroupKey("b", "target", "image");

  it("gives a handle with several hidden connections one row when collapsed", () => {
    const placed = stackHiddenStubs(edges, "b", "target", handleY);
    expect(placed.get("img1")).toBe(100);
    expect(placed.get("img2")).toBe(100);
    expect(placed.get("img3")).toBe(100);
    // The text handle at 130 is clear of the single image row
    expect(placed.get("txt1")).toBe(130);
  });

  it("pushes stubs down when the ones above them are too close", () => {
    const placed = stackHiddenStubs(edges, "b", "target", handleY, 0, imageGroup);
    expect(placed.get("img1")).toBe(100);
    expect(placed.get("img2")).toBe(122);
    expect(placed.get("img3")).toBe(144);
    // The text handle sits at 130 but the image stack runs past it
    expect(placed.get("txt1")).toBe(166);
  });

  it("leaves a stub at its handle when there is room", () => {
    const roomy = (handleId: string | null) => (handleId === "image" ? 100 : 300);
    const placed = stackHiddenStubs(edges, "b", "target", roomy, 0, imageGroup);
    expect(placed.get("txt1")).toBe(300);
  });

  it("ignores visible edges and other nodes", () => {
    const placed = stackHiddenStubs(edges, "b", "target", handleY);
    expect(placed.has("shown")).toBe(false);
    expect(placed.has("elsewhere")).toBe(false);
  });

  it("orders by creation on the source side when handles are level", () => {
    const placed = stackHiddenStubs(edges, "c", "source", () => 50, 0, stubGroupKey("c", "source", "image"));
    expect(placed.get("elsewhere")).toBe(50);
    expect(placed.get("img2")).toBe(72);
  });
});

describe("hiddenStubOffset", () => {
  const edges = [
    edge("a1", { data: { hidden: true, createdAt: 1 } }),
    edge("a2", { source: "c", data: { hidden: true, createdAt: 2 } }),
    edge("t", { source: "p", sourceHandle: "text", targetHandle: "text", data: { hidden: true, createdAt: 3 } }),
  ];
  const handleY = (handleId: string | null) => (handleId === "image" ? 100 : 110);

  const expanded = stubGroupKey("b", "target", "image");

  it("is the distance a stub was pushed below its own handle", () => {
    expect(hiddenStubOffset("a1", edges, "target", handleY, 100, expanded)).toBe(0);
    expect(hiddenStubOffset("a2", edges, "target", handleY, 100, expanded)).toBe(22);
    expect(hiddenStubOffset("t", edges, "target", handleY, 110, expanded)).toBe(34);
  });

  it("keeps collapsed members level with their handle", () => {
    expect(hiddenStubOffset("a2", edges, "target", handleY, 100)).toBe(0);
    expect(hiddenStubOffset("t", edges, "target", handleY, 110)).toBe(12);
  });

  it("falls back to the caller's y when handle positions are unknown", () => {
    expect(hiddenStubOffset("a2", edges, "target", () => undefined, 100, expanded)).toBe(22);
  });

  it("is zero for unknown edges", () => {
    expect(hiddenStubOffset("nope", edges, "target", handleY, 0)).toBe(0);
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

describe("hidden stub groups", () => {
  const edges = [
    edge("a1", { data: { hidden: true, createdAt: 2 } }),
    edge("a2", { source: "c", data: { hidden: true, createdAt: 1 } }),
    edge("t", { source: "p", sourceHandle: "text", targetHandle: "text", data: { hidden: true, createdAt: 3 } }),
    edge("shown", { source: "d", data: {} }),
  ];
  const key = stubGroupKey("b", "target", "image");

  it("groups the hidden connections on one handle in creation order", () => {
    expect(hiddenStubGroup("a1", edges, "target")).toEqual({ key, members: ["a2", "a1"] });
    expect(hiddenStubGroup("a1", edges, "source")).toEqual({ key: stubGroupKey("a", "source", "image"), members: ["a1"] });
    expect(hiddenStubGroup("shown", edges, "target")).toBeNull();
    expect(hiddenStubGroup("nope", edges, "target")).toBeNull();
  });

  it("makes the first member the leader of a collapsed group", () => {
    expect(hiddenStubRole("a2", edges, "target", null)).toBe("collapsed-leader");
    expect(hiddenStubRole("a1", edges, "target", null)).toBe("collapsed-member");
    expect(hiddenStubRole("a1", edges, "target", key)).toBe("expanded");
    expect(hiddenStubRole("t", edges, "target", null)).toBe("single");
    expect(hiddenStubRole("a1", edges, "source", null)).toBe("single");
  });

  it("pluralises the type label, except where the word has no plural", () => {
    expect(pluralTypeLabel("image")).toBe("Images");
    expect(pluralTypeLabel("text")).toBe("Texts");
    expect(pluralTypeLabel("audio")).toBe("Audio");
    expect(pluralTypeLabel("3d")).toBe("3D");
  });
});
