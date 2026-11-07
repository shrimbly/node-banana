import { describe, expect, it } from "vitest";
import { clipName, formatFps, nodeKindLabel, nodeModelLabel } from "../labels";

describe("clipName", () => {
  it("counts from one", () => {
    expect(clipName(0)).toBe("Clip 1");
    expect(clipName(2)).toBe("Clip 3");
  });
});

describe("nodeKindLabel", () => {
  it("puts the node's kind in sentence case", () => {
    expect(nodeKindLabel({ type: "generateVideo", data: {} })).toBe("Generate video");
    expect(nodeKindLabel({ type: "easeCurve", data: {} })).toBe("Ease curve");
  });

  it("keeps acronyms and 3D", () => {
    expect(nodeKindLabel({ type: "llmGenerate", data: {} })).toBe("LLM generate");
    expect(nodeKindLabel({ type: "generate3d", data: {} })).toBe("Generate 3D");
  });

  it("prefers the node's own title", () => {
    expect(nodeKindLabel({ type: "generateVideo", data: { customTitle: "Hero shot" } })).toBe("Hero shot");
  });

  it("falls back for an unknown type", () => {
    expect(nodeKindLabel({ type: "mystery", data: {} })).toBe("Node");
  });
});

describe("nodeModelLabel", () => {
  it("reads the selected model's display name, then its id", () => {
    expect(nodeModelLabel({ data: { selectedModel: { displayName: "Veo 3.1", modelId: "veo-3.1" } } })).toBe("Veo 3.1");
    expect(nodeModelLabel({ data: { selectedModel: { displayName: "", modelId: "kling-3" } } })).toBe("kling-3");
  });

  it("is null without a model", () => {
    expect(nodeModelLabel({ data: {} })).toBeNull();
    expect(nodeModelLabel({ data: null })).toBeNull();
  });
});

describe("formatFps", () => {
  it("shows a rate every clip shares", () => {
    expect(formatFps([24, 24])).toBe("24 fps");
    expect(formatFps([30, 29.8])).toBe("30 fps");
  });

  it("keeps two decimals for NTSC rates", () => {
    expect(formatFps([29.97, 29.97])).toBe("29.97 fps");
    expect(formatFps([23.976])).toBe("23.98 fps");
  });

  it("shows nothing for mixed or unknown rates", () => {
    expect(formatFps([24, 30])).toBeNull();
    expect(formatFps([24, null])).toBeNull();
    expect(formatFps([])).toBeNull();
  });
});
