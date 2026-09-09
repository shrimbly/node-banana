import { describe, it, expect } from "vitest";
import {
  buildVeoInputSchema,
  capabilityForGenerateNode,
  isGenerateNodeType,
  modelSelectionData,
  sharedGenerateType,
} from "../modelSelection";
import type { ProviderModel } from "@/lib/providers/types";

const model: ProviderModel = {
  id: "wan/3.0",
  name: "Wan 3.0",
  provider: "fal",
  capabilities: ["image-to-video"],
} as ProviderModel;

describe("modelSelectionData", () => {
  it("writes the selection and clears the old model's parameters", () => {
    expect(modelSelectionData("generate3d", model)).toEqual({
      selectedModel: { provider: "fal", modelId: "wan/3.0", displayName: "Wan 3.0" },
      parameters: {},
    });
  });

  it("keeps the capabilities on an image node, which uses them for its controls", () => {
    expect(modelSelectionData("nanoBanana", model).selectedModel).toMatchObject({ capabilities: ["image-to-video"] });
    expect(modelSelectionData("generateAudio", model).selectedModel).not.toHaveProperty("capabilities");
  });

  it("gives a video node a Veo model's fixed input schema, and clears it otherwise", () => {
    const veo = modelSelectionData("generateVideo", { ...model, id: "veo-3-image-to-video" });
    expect((veo as { inputSchema?: unknown[] }).inputSchema?.map((i) => (i as { name: string }).name)).toEqual([
      "image",
      "prompt",
      "negative_prompt",
    ]);
    expect(modelSelectionData("generateVideo", model)).toHaveProperty("inputSchema", undefined);
    expect(buildVeoInputSchema("veo-3")?.map((i) => i.name)).toEqual(["prompt", "negative_prompt"]);
  });
});

describe("sharedGenerateType", () => {
  it("names the type when every selected node is the same generator", () => {
    expect(sharedGenerateType([{ type: "generateVideo" }, { type: "generateVideo" }])).toBe("generateVideo");
  });

  it("is null for mixed generators, non-generators, or nothing", () => {
    expect(sharedGenerateType([{ type: "generateVideo" }, { type: "nanoBanana" }])).toBeNull();
    expect(sharedGenerateType([{ type: "prompt" }, { type: "prompt" }])).toBeNull();
    expect(sharedGenerateType([])).toBeNull();
  });

  it("maps each generator to the dialog's capability filter", () => {
    expect(capabilityForGenerateNode("nanoBanana")).toBe("image");
    expect(capabilityForGenerateNode("generateVideo")).toBe("video");
    expect(capabilityForGenerateNode("generate3d")).toBe("3d");
    expect(capabilityForGenerateNode("generateAudio")).toBe("audio");
    expect(isGenerateNodeType("llmGenerate")).toBe(false);
  });
});
