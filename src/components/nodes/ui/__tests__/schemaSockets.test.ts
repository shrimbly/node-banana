import { describe, it, expect } from "vitest";
import { schemaSockets, sameInputSchema } from "../schemaSockets";

describe("schemaSockets", () => {
  it("gives defaults when there is no schema", () => {
    expect(schemaSockets(undefined).map((s) => s.id)).toEqual(["image", "text"]);
    expect(schemaSockets([], { videoPlaceholder: true }).map((s) => s.id)).toEqual(["image", "video", "text"]);
  });

  it("indexes by type in image/video/audio/text order and keeps un-indexed ids hidden", () => {
    const sockets = schemaSockets([
      { name: "prompt", type: "text", required: true, label: "Motion Prompt" },
      { name: "start_image", type: "image", required: true, label: "Start Frame" },
      { name: "end_image", type: "image", required: false, label: "End Frame" },
      { name: "soundtrack", type: "audio", required: false, label: "Soundtrack" },
    ], { videoPlaceholder: true });
    const visible = sockets.filter((s) => !s.hidden);
    expect(visible.map((s) => s.id)).toEqual(["image-0", "image-1", "video", "audio-0", "text-0"]);
    expect(visible.map((s) => s.label)).toEqual(["Start Frame", "End Frame", "Video", "Soundtrack", "Motion Prompt"]);
    expect(visible[0].schemaName).toBe("start_image");
    expect(visible[2].placeholder).toBe(true);
    expect(visible[2].title).toBe("Not used by this model");
    expect(sockets.filter((s) => s.hidden).map((s) => s.id)).toEqual(["image", "audio", "text"]);
  });

  it("adds image and text placeholders when the schema lacks them", () => {
    const sockets = schemaSockets([{ name: "prompt", type: "text", required: true, label: "Prompt" }]);
    expect(sockets.filter((s) => !s.hidden).map((s) => [s.id, s.placeholder ?? false])).toEqual([["image", true], ["text-0", false]]);
  });

  it("can be limited to the types a node takes", () => {
    const sockets = schemaSockets([
      { name: "clip", type: "video", required: true, label: "Clip" },
      { name: "prompt", type: "text", required: true, label: "Prompt" },
    ], { types: ["image", "text"] });
    expect(sockets.filter((s) => !s.hidden).map((s) => s.id)).toEqual(["image", "text-0"]);
  });
});

describe("sameInputSchema", () => {
  const image = { name: "image", type: "image", required: true, label: "Input Image" } as const;
  const prompt = { name: "prompt", type: "text", required: true, label: "Prompt" } as const;

  it("treats a missing schema as empty", () => {
    expect(sameInputSchema(undefined, [])).toBe(true);
    expect(sameInputSchema([], undefined)).toBe(true);
    expect(sameInputSchema(undefined, [prompt])).toBe(false);
  });

  it("compares by content, not identity", () => {
    expect(sameInputSchema([image, prompt], [{ ...image }, { ...prompt }])).toBe(true);
  });

  it("notices a changed, added, or reordered input", () => {
    expect(sameInputSchema([image, prompt], [prompt, image])).toBe(false);
    expect(sameInputSchema([image, prompt], [image])).toBe(false);
    expect(sameInputSchema([image, prompt], [image, { ...prompt, required: false }])).toBe(false);
    expect(sameInputSchema([image, prompt], [image, { ...prompt, description: "A prompt" }])).toBe(false);
  });
});
