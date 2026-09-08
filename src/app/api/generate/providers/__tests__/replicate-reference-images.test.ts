import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationInput } from "@/lib/providers/types";
import reveSchema from "@/lib/providers/__fixtures__/reve-2.1-schema.json";
import { generateWithReplicate } from "../replicate";

// Live Replicate schema, retrieved 2026-09-08, version b80beec96b7c28035d1ed3e169ebf3e9a47cf50cd88296665f852ed9b18ec139.
// It advertises default:null + nullable:true, but prediction validation rejects null arrays.
describe("Replicate Reve 2.1 reference images", () => {
  let submitted: Record<string, unknown>;
  beforeEach(() => {
    submitted = {};
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ latest_version: { id: "reve-version", openapi_schema: reveSchema } })))
      .mockImplementationOnce(async (_url, init) => {
        submitted = JSON.parse(init.body).input;
        return new Response(JSON.stringify({ id: "prediction", status: "succeeded", output: "https://replicate.delivery/test.png" }));
      })
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function generate(overrides: Partial<GenerationInput>) {
    const result = await generateWithReplicate("test", "synthetic-key", {
      model: { id: "reve/reve-2.1", name: "reve-2.1", provider: "replicate", description: null, capabilities: ["text-to-image"] },
      prompt: "A banana on a dark table", images: [], parameters: { reference_images: null, aspect_ratio: "auto" },
      ...overrides,
    });
    expect(result.success).toBe(true);
    expect(submitted.prompt).toBe("A banana on a dark table");
    expect(submitted.aspect_ratio).toBe("auto");
  }

  it("does not overwrite a connected image with the saved null default", async () => {
    await generate({ images: ["https://example.com/connected.png"] });
    expect(submitted.reference_images).toEqual(["https://example.com/connected.png"]);
  });

  it("keeps connected images in order ahead of stale saved parameters", async () => {
    await generate({ images: ["https://example.com/first.png", "https://example.com/second.png"], parameters: { reference_images: ["https://example.com/stale.png"], aspect_ratio: "auto" } });
    expect(submitted.reference_images).toEqual(["https://example.com/first.png", "https://example.com/second.png"]);
  });

  it("omits a null array for prompt-only requests", async () => {
    await generate({});
    expect(submitted).not.toHaveProperty("reference_images");
  });

  it("omits a null array when other dynamic inputs exist", async () => {
    await generate({ dynamicInputs: { prompt: "A banana on a dark table" } });
    expect(submitted).not.toHaveProperty("reference_images");
  });

  it("wraps a single dynamically connected reference image in an array", async () => {
    await generate({ dynamicInputs: { reference_images: "https://example.com/connected.png" } });
    expect(submitted.reference_images).toEqual(["https://example.com/connected.png"]);
  });

  it("preserves explicit reference arrays when no connection overrides them", async () => {
    await generate({ parameters: { reference_images: ["https://example.com/saved.png"], aspect_ratio: "auto" } });
    expect(submitted.reference_images).toEqual(["https://example.com/saved.png"]);
  });
});
