import { describe, it, expect } from "vitest";
import { validateOpenAIImageParameters, validateOpenAIImageSize } from "../openaiImages";

describe("OpenAI image settings validation", () => {
  it.each(["auto", "1024x1024", "1536x864", "2048x1152", "3840x2160", "2160x3840"])("accepts supported size %s", size => {
    expect(validateOpenAIImageSize(size)).toBeNull();
  });
  it.each(["1025x1024", "0x1024", "4096x2048", "512x512", "3840x3840", "3072x768", "1024×1024", "bad", null])("rejects invalid size %s", size => {
    expect(validateOpenAIImageSize(size)).toBeTruthy();
  });
  it("restricts higher quality to 2.5 and rejects unsupported combinations", () => {
    expect(validateOpenAIImageParameters("gpt-image-2.5-flare", { quality: "max" })).toBeNull();
    expect(validateOpenAIImageParameters("gpt-image-1", { quality: "max" })).toBeTruthy();
    expect(validateOpenAIImageParameters("gpt-image-2.5-flare", { background: "transparent", output_format: "jpeg" })).toContain("PNG or WebP");
    expect(validateOpenAIImageParameters("gpt-image-2.5-flare", { n: 2 })).toContain("one output");
    expect(validateOpenAIImageParameters("gpt-image-2.5-flare", { output_compression: 101 })).toBeTruthy();
  });
});
