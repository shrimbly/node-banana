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

describe("GPT Image 2.5 usage cost", () => {
  it.each(["sunburst", "flare"])("estimates %s from usage with the documented token rates", async variant => {
    const { estimateOpenAIImage25Cost } = await import("../openaiImages");
    const cost = estimateOpenAIImage25Cost(`gpt-image-2.5-${variant}`, { textInputTokens: 100, imageInputTokens: 250, imageOutputTokens: 1000 });
    expect(cost).toEqual({ amount: 0.0325, currency: "USD", estimated: true });
  });
  it("does not invent zero cost for missing or invalid usage, or reprice legacy models", async () => {
    const { estimateOpenAIImage25Cost } = await import("../openaiImages");
    expect(estimateOpenAIImage25Cost("gpt-image-2.5-flare")).toBeUndefined();
    expect(estimateOpenAIImage25Cost("gpt-image-2.5-flare", { textInputTokens: NaN, imageInputTokens: 0, imageOutputTokens: 0 })).toBeUndefined();
    expect(estimateOpenAIImage25Cost("gpt-image-1", { textInputTokens: 100, imageInputTokens: 0, imageOutputTokens: 1000 })).toBeUndefined();
    expect(estimateOpenAIImage25Cost("gpt-image-2.5-flare", { textInputTokens: 0, imageInputTokens: 0, imageOutputTokens: 0 })?.amount).toBe(0);
  });
});
