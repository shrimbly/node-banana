import { describe, expect, it } from "vitest";
import type { NodeType } from "@/types";
import { createDefaultNodeData } from "@/store/utils/nodeDefaults";
import { getEasingBezier } from "@/lib/easing-presets";
import { LLM_MODELS, defaultLLMModel } from "@/lib/llm/catalog";
import { pickAgentData } from "../nodeData";
import { resolveSettings } from "../settings";

let counter = 0;
const context = { newId: () => `n${(counter++).toString().padStart(6, "0")}` };

function nodeOf(type: NodeType, data: Record<string, unknown> = {}) {
  return { id: `${type}-1`, type, data: { ...pickAgentData(type, createDefaultNodeData(type) as Record<string, unknown>), ...data } };
}

describe("resolveSettings", () => {
  it("whitelists fields and names the valid ones", () => {
    const out = resolveSettings(nodeOf("prompt"), { prompt: "hi", colour: "red" }, context);
    expect(out.errors).toEqual(['prompt-1 (Prompt) has no setting "colour". Settable: prompt, promptEdit, replaceWholeText, variableName, isOptional, comment.']);
  });

  it("explains runtime fields and prompt-like fields on generators", () => {
    const out = resolveSettings(nodeOf("nanoBanana"), { outputImage: "x", prompt: "a cat", selectedModel: {} }, context);
    expect(out.errors).toHaveLength(3);
    expect(out.errors[0]).toContain('"outputImage" cannot be set (produced when the workflow runs)');
    expect(out.errors[1]).toContain("its prompt comes from the node connected to its text input");
    expect(out.errors[2]).toContain('"selectedModel" cannot be set (set `model` instead)');
  });

  it("maps title into customTitle and clears it with an empty string", () => {
    expect(resolveSettings(nodeOf("prompt"), { title: "  Hero prompt " }, context).patch).toEqual({ customTitle: "Hero prompt" });
    expect(resolveSettings(nodeOf("prompt"), { title: "" }, context).patch).toEqual({ customTitle: null });
  });

  it("coerces numbers, booleans and enums leniently but checks ranges", () => {
    const out = resolveSettings(nodeOf("imageResize"), { mode: "MaxEdge", maxEdge: "1024", format: "JPEG", quality: 2 }, context);
    expect(out.patch).toEqual({ mode: "maxEdge", maxEdge: 1024, format: "jpeg" });
    expect(out.errors).toEqual(["imageResize-1 (Image Resize): quality must be between 0.1 and 1 (got 2)."]);
    const ints = resolveSettings(nodeOf("gifEncoder"), { fps: 12.5, dither: "true", targetMaxBytes: null }, context);
    expect(ints.errors[0]).toContain("fps must be a whole number between 1 and 30");
    expect(ints.patch).toEqual({ dither: true, targetMaxBytes: null });
  });

  it("refuses media data in text settings", () => {
    const out = resolveSettings(nodeOf("prompt"), { prompt: "data:image/png;base64,AAAA" }, context);
    expect(out.errors[0]).toContain("cannot hold media data");
  });

  describe("Generate Image", () => {
    it("writes model and selectedModel together", () => {
      const out = resolveSettings(nodeOf("nanoBanana"), { model: "gemini-2.5-flash-image" }, context);
      expect(out.errors).toEqual([]);
      expect(out.patch).toEqual({ model: "nano-banana", selectedModel: { provider: "gemini", modelId: "nano-banana", displayName: "Nano Banana" } });
    });

    it("validates aspect ratio and resolution against the target model", () => {
      const out = resolveSettings(nodeOf("nanoBanana"), { model: "nano-banana-2", aspectRatio: "8x1", resolution: "512px", useImageSearch: true }, context);
      expect(out.errors).toEqual([]);
      expect(out.patch).toMatchObject({ aspectRatio: "8:1", resolution: "512", useImageSearch: true });

      const lite = resolveSettings(nodeOf("nanoBanana"), { model: "nano-banana-2-lite", resolution: "2K", useGoogleSearch: true }, context);
      expect(lite.errors).toEqual([
        "nanoBanana-1 (Generate Image): nano-banana-2-lite has no resolution setting (only nano-banana-pro and nano-banana-2 do). Change model too, or leave resolution out.",
        "nanoBanana-1 (Generate Image): useGoogleSearch is not available on nano-banana-2-lite (nano-banana-pro and nano-banana-2 only).",
      ]);
    });

    it("refuses Gemini options on another provider's model and lists the models on a bad id", () => {
      const fal = nodeOf("nanoBanana", { selectedModel: { provider: "fal", modelId: "fal-ai/flux", displayName: "FLUX" } });
      expect(resolveSettings(fal, { aspectRatio: "16:9" }, context).errors[0]).toContain("uses FLUX (fal); aspectRatio, resolution and the search options apply to Gemini models only");
      const switched = resolveSettings(fal, { model: "nano-banana-pro", aspectRatio: "16:9" }, context);
      expect(switched.errors).toEqual([]);
      expect(switched.patch).toMatchObject({ parameters: {}, inputSchema: [], aspectRatio: "16:9" });
      // Generate Image's sockets do not depend on the model.
      expect(switched.handlesMayChange).toBe(false);
      expect(resolveSettings(fal, { model: "flux-pro" }, context).errors[0]).toContain("Use one of: nano-banana, nano-banana-2, nano-banana-2-lite, nano-banana-pro");
    });
  });

  describe("Generate Video", () => {
    it("sets the Veo model with its schema and parameters", () => {
      const out = resolveSettings(nodeOf("generateVideo"), { model: "veo-3.1 t2v", resolution: "1080P", aspectRatio: "9:16" }, context);
      expect(out.errors).toEqual([]);
      expect(out.patch.selectedModel).toEqual({ provider: "gemini", modelId: "veo-3.1/text-to-video", displayName: "Veo 3.1" });
      expect(out.patch.parameters).toEqual({ resolution: "1080p", aspectRatio: "9:16" });
      expect(out.handlesMayChange).toBe(true);
    });

    it("merges Veo parameters into the existing ones when the model stays", () => {
      const veo = nodeOf("generateVideo", {
        selectedModel: { provider: "gemini", modelId: "veo-3.1/image-to-video", displayName: "Veo 3.1 I2V" },
        parameters: { aspectRatio: "16:9", seed: 7 },
      });
      const out = resolveSettings(veo, { durationSeconds: 4 }, context);
      expect(out.patch).toEqual({ parameters: { aspectRatio: "16:9", seed: 7, durationSeconds: "4" } });
      expect(resolveSettings(veo, { durationSeconds: 5 }, context).errors[0]).toContain("durationSeconds must be one of: 4, 6, 8");
    });

    it("will not write back parameters it could only partly see", () => {
      const veo = nodeOf("generateVideo", {
        selectedModel: { provider: "gemini", modelId: "veo-3.1/image-to-video", displayName: "Veo 3.1 I2V" },
        parameters: { note: "[omitted: 90000 characters]" },
      });
      expect(resolveSettings(veo, { aspectRatio: "9:16" }, context).errors[0]).toContain("too large to edit safely");
    });

    it("sends 3D and audio models to search_models when nothing was looked up", () => {
      expect(resolveSettings(nodeOf("generate3d"), { model: "trellis" }, context).errors[0]).toContain('find one with search_models (nodeType "generate3d")');
      expect(resolveSettings(nodeOf("generateAudio"), { provider: "fal" }, context).errors[0]).toContain('set "model" instead');
    });
  });

  describe("LLM Generate", () => {
    it("starts new nodes on the LLM catalogue's default", () => {
      expect(nodeOf("llmGenerate").data).toMatchObject({ provider: "google", model: "gemini-3.8-flash" });
    });

    it("offers exactly the models the node's menu lists", () => {
      for (const model of LLM_MODELS) {
        const node = nodeOf("llmGenerate");
        const out = resolveSettings(node, { model: model.id }, context);
        expect(out.errors, model.id).toEqual([]);
        // The default model is already the node's: nothing to write.
        expect(out.patch.model ?? node.data.model).toBe(model.id);
      }
    });

    it("moves to the provider's first model and clamps temperature for anthropic", () => {
      const out = resolveSettings(nodeOf("llmGenerate", { temperature: 1.5 }), { provider: "claude" }, context);
      expect(out.patch).toEqual({ model: defaultLLMModel("anthropic"), provider: "anthropic", temperature: 1 });
      expect(out.patch.model).toBe("claude-sonnet-5");
      expect(out.warnings.join(" ")).toContain("temperature lowered to 1");
    });

    it("rejects a model of another provider when both are given", () => {
      const out = resolveSettings(nodeOf("llmGenerate"), { provider: "openai", model: "claude-opus-5" }, context);
      expect(out.errors[0]).toContain("model claude-opus-5 belongs to provider anthropic, not openai");
    });

    it("checks temperature against the provider's range", () => {
      const out = resolveSettings(nodeOf("llmGenerate", { provider: "anthropic", model: "claude-haiku-4-5" }), { temperature: 1.4 }, context);
      expect(out.errors[0]).toContain("temperature must be between 0 and 1 (got 1.4) (anthropic allows 0-1).");
    });

    it("moves a retired id to its replacement and refuses ids the menu no longer offers", () => {
      const retired = resolveSettings(nodeOf("llmGenerate"), { model: "gemini-3-pro-preview" }, context);
      expect(retired.errors).toEqual([]);
      expect(retired.patch).toEqual({ model: "gemini-3.1-pro-preview" });
      expect(retired.warnings.join(" ")).toContain("Gemini 3 Pro (preview) (gemini-3-pro-preview) is retired; used Gemini 3.1 Pro (preview) (gemini-3.1-pro-preview) instead.");
      // The old dotted spelling of a current id finds that id.
      expect(resolveSettings(nodeOf("llmGenerate"), { model: "claude-haiku-4.5" }, context).patch).toMatchObject({ model: "claude-haiku-4-5", provider: "anthropic" });

      const served = resolveSettings(nodeOf("llmGenerate"), { model: "gpt-4.1-mini" }, context);
      expect(served.errors[0]).toContain("gpt-4.1-mini is an older model the node no longer offers. Use one of: google: gemini-3.8-flash");

      // A node already on an older id keeps it when the call names it again.
      const kept = resolveSettings(nodeOf("llmGenerate", { provider: "openai", model: "gpt-4.1-mini" }), { model: "gpt-4.1-mini", temperature: 0.2 }, context);
      expect(kept.errors).toEqual([]);
      expect(kept.patch).toEqual({ temperature: 0.2 });
    });
  });

  it("validates prompt variable names", () => {
    expect(resolveSettings(nodeOf("prompt"), { variableName: "@subject" }, context).patch).toEqual({ variableName: "subject" });
    expect(resolveSettings(nodeOf("prompt"), { variableName: "" }, context).patch).toEqual({ variableName: null });
    expect(resolveSettings(nodeOf("prompt"), { variableName: "my var" }, context).errors[0]).toContain('for example "myvar"');
  });

  it("sets easing presets together with their bezier handles", () => {
    const out = resolveSettings(nodeOf("easeCurve"), { easingPreset: "easeoutexpo", outputDuration: 3 }, context);
    expect(out.patch).toEqual({ easingPreset: "easeOutExpo", bezierHandles: getEasingBezier("easeOutExpo"), outputDuration: 3 });
    const custom = resolveSettings(nodeOf("easeCurve"), { bezierHandles: [0.1, 0.2, 0.3, 1.4] }, context);
    expect(custom.patch).toEqual({ bezierHandles: [0.1, 0.2, 0.3, 1.4], easingPreset: null });
    expect(resolveSettings(nodeOf("easeCurve"), { bezierHandles: [2, 0, 0, 1] }, context).errors).toHaveLength(1);
  });

  it("checks trim ranges and resets split-grid offsets when the grid changes", () => {
    expect(resolveSettings(nodeOf("videoTrim"), { startTime: 5, endTime: 3 }, context).errors[0]).toContain("endTime (3s) must be after startTime (5s)");
    expect(resolveSettings(nodeOf("splitGrid"), { gridCols: 4 }, context).patch).toEqual({ gridCols: 4, colOffsets: null });
    expect(resolveSettings(nodeOf("splitGrid"), { gridRows: 20 }, context).errors[0]).toContain("gridRows must be between 1 and 16");
  });

  it("keeps switch output ids for matched entries and adds new ones", () => {
    const sw = nodeOf("switch", { switches: [{ id: "keep001", name: "Main", enabled: true }, { id: "drop001", name: "Old", enabled: true }] });
    const out = resolveSettings(sw, { switches: [{ name: "main", enabled: false }, "Extra"] }, context);
    expect(out.errors).toEqual([]);
    expect(out.patch.switches).toEqual([
      { id: "keep001", name: "main", enabled: false },
      { id: expect.stringMatching(/^n\d{6}$/), name: "Extra", enabled: true },
    ]);
    expect(out.handlesMayChange).toBe(true);
    expect(resolveSettings(sw, { switches: [] }, context).errors[0]).toContain("keeps at least one output");
    expect(resolveSettings(sw, { switches: [{ id: "nope", name: "x" }] }, context).errors[0]).toContain('has id "nope", which is not one of this switch\'s outputs');
  });

  it("builds conditional rules with rule- ids, modes and OR values", () => {
    const cs = nodeOf("conditionalSwitch", { rules: [{ id: "rule-keep001", label: "Cats", value: "cat", mode: "contains" }] });
    const out = resolveSettings(cs, { rules: [{ label: "cats", value: ["cat", "kitten"] }, { label: "Dogs", value: "dog", mode: "starts with" }] }, context);
    expect(out.errors).toEqual([]);
    expect(out.patch.rules).toEqual([
      { id: "rule-keep001", value: "cat, kitten", mode: "contains", label: "cats", isMatched: false },
      { id: expect.stringMatching(/^rule-n\d{6}$/), value: "dog", mode: "starts-with", label: "Dogs", isMatched: false },
    ]);
    expect(resolveSettings(cs, { rules: [{ label: "x", value: "y", mode: "regex" }] }, context).errors[0]).toContain("mode must be one of: exact, contains, starts-with, ends-with");
  });

  it("keeps at least one rule, and resumes paused evaluation when a rule changes, as the node does", () => {
    const cs = nodeOf("conditionalSwitch", { rules: [{ id: "rule-keep001", label: "Cats", value: "cat", mode: "contains" }], evaluationPaused: true });
    expect(resolveSettings(cs, { rules: [] }, context).errors[0]).toContain("rules must be a non-empty list");

    const edited = resolveSettings(cs, { rules: [{ label: "Cats", value: "cat, kitten" }] }, context);
    expect(edited.patch.evaluationPaused).toBe(false);
    expect(edited.warnings.join(" ")).toContain("rule evaluation resumed");
    // Renaming changes no match, and an explicit evaluationPaused wins.
    expect(resolveSettings(cs, { rules: [{ id: "rule-keep001", label: "Kittens" }] }, context).patch).not.toHaveProperty("evaluationPaused");
    expect(resolveSettings(cs, { rules: [{ label: "Cats", value: "dog" }], evaluationPaused: true }, context).patch.evaluationPaused).toBe(true);
  });

  it("drops the previous result when Remove Background's model or Frame Grab's frame changes, as the node does", () => {
    const bg = nodeOf("removeBackground");
    expect(resolveSettings(bg, { model: "Quality" }, context).patch).toEqual({ model: "isnet", outputImage: null, status: "idle", progress: 0 });
    expect(resolveSettings(bg, { model: "isnet_fp16" }, context).patch).toEqual({ model: "isnet_fp16" });
    const grab = nodeOf("videoFrameGrab");
    expect(resolveSettings(grab, { framePosition: "last" }, context).patch).toEqual({ framePosition: "last", outputImage: null });
    expect(resolveSettings(grab, { framePosition: "middle" }, context).errors[0]).toContain("framePosition must be one of: first, last");
  });

  it("takes whole percentages for Image Resize's scale, as its field does", () => {
    expect(resolveSettings(nodeOf("imageResize"), { scalePct: 50 }, context).patch).toEqual({ scalePct: 50 });
    expect(resolveSettings(nodeOf("imageResize"), { scalePct: 12.5 }, context).errors[0]).toContain("scalePct must be a whole number between 1 and 400");
  });

  it("validates ComfyUI app parameters against the app contract", () => {
    const app = nodeOf("comfyApp", {
      app: {
        name: "Upscale",
        params: [
          { id: "3:steps", label: "Steps", type: "integer", minimum: 1, maximum: 50 },
          { id: "4:sampler", label: "Sampler", type: "string", enum: ["euler", "dpmpp_2m"] },
        ],
        outputs: [],
      },
      paramValues: { "3:steps": 20 },
    });
    const out = resolveSettings(app, { paramValues: { steps: 30, "4:sampler": "DPMPP_2M" } }, context);
    expect(out.errors).toEqual([]);
    expect(out.patch).toEqual({ paramValues: { "3:steps": 30, "4:sampler": "dpmpp_2m" } });
    const bad = resolveSettings(app, { paramValues: { steps: 99, cfg: 7 } }, context);
    expect(bad.errors).toEqual([
      "comfyApp-1 (ComfyUI App): Steps must be between 1 and 50 (got 99).",
      'comfyApp-1 (ComfyUI App): no parameter "cfg". Parameters: 3:steps "Steps", 4:sampler "Sampler".',
    ]);
    expect(resolveSettings(nodeOf("comfyApp"), { paramValues: { a: 1 } }, context).errors[0]).toContain("has no workflow attached");
  });
});

describe("long prompt text (review C7)", () => {
  const long = `The scene: ${"a quiet harbour at dawn, fishing boats, gulls, soft mist, ".repeat(96)}and the lighthouse at the end.`;
  const prompt = (text = long) => ({ id: "prompt-1", type: "prompt" as NodeType, data: { prompt: text } });

  it("refuses a value that still carries a cut view's marker", () => {
    const seen = `${long.slice(0, 4000)}… [truncated: ${long.length - 4000} more characters; the full text is on the canvas]`;
    const out = resolveSettings(prompt(), { prompt: `${seen} Watercolor.` }, context);
    expect(out.errors[0]).toContain('still contains the "… [truncated: …]" marker');
    expect(out.patch).toEqual({});
    for (const marker of ["[media omitted]", "[omitted: 3 more items]"]) {
      expect(resolveSettings(nodeOf("output"), { outputFilename: `x ${marker}` }, context).errors[0]).toContain("placeholder");
    }
  });

  it("refuses a rewrite made from the start of a long prompt unless the loss is confirmed", () => {
    const fromPreview = `${long.slice(0, 400)} in watercolor`;
    const out = resolveSettings(prompt(), { prompt: fromPreview }, context);
    expect(out.errors[0]).toContain("keeps the start of the current one but drops its last");
    expect(out.errors[0]).toContain("promptEdit");
    const confirmed = resolveSettings(prompt(), { prompt: fromPreview, replaceWholeText: true }, context);
    expect(confirmed.errors).toEqual([]);
    expect(confirmed.patch).toEqual({ prompt: fromPreview });
  });

  it("accepts edits made from the whole text and brand-new text", () => {
    const edited = long.replace("The scene:", "The watercolor scene:");
    expect(resolveSettings(prompt(), { prompt: edited }, context).patch).toEqual({ prompt: edited });
    const shorter = long.replace("soft mist, ", "");
    expect(resolveSettings(prompt(), { prompt: shorter }, context).errors).toEqual([]);
    expect(resolveSettings(prompt(), { prompt: "a wolf in snow" }, context).patch).toEqual({ prompt: "a wolf in snow" });
  });

  it("applies promptEdit to the whole text", () => {
    const out = resolveSettings(prompt(), { promptEdit: { find: "The scene:", replace: "The watercolor scene:" } }, context);
    expect(out.errors).toEqual([]);
    expect(out.patch.prompt).toBe(long.replace("The scene:", "The watercolor scene:"));
    expect((out.patch.prompt as string).length).toBe(long.length + 11);
    expect((out.patch.prompt as string).endsWith("and the lighthouse at the end.")).toBe(true);

    const list = resolveSettings(prompt(), { promptEdit: [{ append: " Oil painting." }, { prepend: "Wide shot. " }] }, context);
    expect(list.patch.prompt).toBe(`Wide shot. ${long} Oil painting.`);

    const missing = resolveSettings(prompt(), { promptEdit: { find: "a castle", replace: "x" } }, context);
    expect(missing.errors[0]).toContain('does not occur in the prompt');
    const ambiguous = resolveSettings(prompt(), { promptEdit: { find: "gulls", replace: "herons" } }, context);
    expect(ambiguous.errors[0]).toContain("occurs 96 times");
    const both = resolveSettings(prompt(), { prompt: "x", promptEdit: { append: "y" } }, context);
    expect(both.errors[0]).toContain("not both");
  });

  it("will not edit a prompt too long to hold whole", () => {
    const cut = `${long.slice(0, 4000)}… [truncated: 60000 more characters; the full text is on the canvas]`;
    expect(resolveSettings(prompt(cut), { promptEdit: { append: "x" } }, context).errors[0]).toContain("64000 characters, longer than you can edit here");
    expect(resolveSettings(prompt(cut), { prompt: "a new prompt" }, context).errors[0]).toContain("replaceWholeText: true");
    expect(resolveSettings(prompt(cut), { prompt: "a new prompt", replaceWholeText: true }, context).patch).toEqual({ prompt: "a new prompt" });
  });

  it("guards a Prompt Constructor template the same way", () => {
    const template = { id: "promptConstructor-1", type: "promptConstructor" as NodeType, data: { template: long } };
    expect(resolveSettings(template, { template: long.slice(0, 500) }, context).errors[0]).toContain("templateEdit");
    expect(resolveSettings(template, { templateEdit: { append: " @style" } }, context).patch).toEqual({ template: `${long} @style` });
  });
});

describe("long ComfyUI option lists (review C11)", () => {
  const options = Array.from({ length: 320 }, (_, i) => `model_${i}.safetensors`);
  const app = () =>
    ({
      id: "comfyApp-1",
      type: "comfyApp" as NodeType,
      data: pickAgentData("comfyApp", {
        app: {
          name: "Checkpoints",
          params: [
            { id: "4:ckpt_name", label: "Checkpoint", type: "string", enum: options },
            { id: "5:sampler", label: "Sampler", type: "string", enum: options.slice(0, 10) },
          ],
          outputs: [],
        },
        paramValues: {},
      }),
    });

  it("accepts any option, including ones past the first 200", () => {
    const out = resolveSettings(app(), { paramValues: { Checkpoint: "model_250.safetensors" } }, context);
    expect(out.errors).toEqual([]);
    expect(out.patch).toEqual({ paramValues: { "4:ckpt_name": "model_250.safetensors" } });
  });

  it("never takes a list placeholder as a value", () => {
    for (const value of ["[omitted: 120 more items]", "[OMITTED: 120 more items]"]) {
      const out = resolveSettings(app(), { paramValues: { Checkpoint: value } }, context);
      expect(out.errors).toHaveLength(1);
      expect(out.errors[0]).toContain("is a placeholder for options you were not shown");
    }
  });

  it("still rejects a value that is not an option", () => {
    expect(resolveSettings(app(), { paramValues: { Sampler: "bogus" } }, context).errors[0]).toContain("Sampler must be one of: model_0.safetensors");
  });

  it("is lenient only when the list it has was cut", () => {
    const cut = { id: "comfyApp-1", type: "comfyApp" as NodeType, data: { app: { params: [{ id: "4:ckpt_name", label: "Checkpoint", type: "string", enum: [...options.slice(0, 5), "[omitted: 315 more items]"] }] }, paramValues: {} } };
    const out = resolveSettings(cut, { paramValues: { Checkpoint: "model_300.safetensors" } }, context);
    expect(out.errors).toEqual([]);
    expect(out.warnings[0]).toContain("ComfyUI will check it when the workflow runs");
  });
});
