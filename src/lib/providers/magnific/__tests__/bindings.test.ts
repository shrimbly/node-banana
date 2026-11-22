/**
 * Magnific's models as the app reads them from the recorded API description.
 *
 * Hermetic: spec.json is checked in (`npm run magnific:sync` rewrites it).
 * After a sync this suite says what changed: an endpoint in a group the app
 * has not met, a name two models now share, an endpoint that dropped out
 * (the exclusions are pinned), or a bound request its own schema refuses.
 */
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

import type { ComfyMediaValue } from "../../comfyRouter/template";
import {
  buildMagnificBody,
  magnificBinding,
  magnificBindings,
  magnificExcluded,
  magnificNodeSchema,
  magnificProviderModels,
  magnificSpecEndpoints,
  magnificUnplaced,
  type MagnificBinding,
  type MagnificRequestInput,
} from "../bindings";

function binding(id: string): MagnificBinding {
  const found = magnificBinding(id);
  if (!found) throw new Error(`no binding for ${id}`);
  return found;
}

const PNG: ComfyMediaValue = { base64: "iVBORw0KGgo=", dataUrl: "data:image/png;base64,iVBORw0KGgo=", url: "https://example.com/a.png", mime: "image/png" };
const MP4: ComfyMediaValue = { base64: "AAAAIGZ0eXA=", dataUrl: "data:video/mp4;base64,AAAAIGZ0eXA=", url: "https://example.com/a.mp4", mime: "video/mp4" };
const MP3: ComfyMediaValue = { base64: "SUQzBAA=", dataUrl: "data:audio/mpeg;base64,SUQzBAA=", url: "https://example.com/a.mp3", mime: "audio/mpeg" };
const SAMPLE = { image: PNG, video: MP4, audio: MP3 } as const;

describe("coverage of the recorded API", () => {
  it("places every endpoint: bound, or excluded for a reason", () => {
    expect(magnificUnplaced()).toEqual([]);
    const bound = new Set(magnificBindings().map((b) => b.id));
    const excluded = magnificExcluded();
    for (const endpoint of magnificSpecEndpoints()) {
      expect(bound.has(endpoint.id) !== endpoint.id in excluded, endpoint.id).toBe(true);
    }
    expect(bound.size + Object.keys(excluded).length).toBe(magnificSpecEndpoints().length);
  });

  it("leaves out exactly these, each for its reason", () => {
    expect(magnificExcluded()).toMatchInlineSnapshot(`
      {
        "audio-isolation": "Takes an audio or video file and a description of the sound to pull out; the audio node has no media handle.",
        "beta/remove-background": "Answers in one request from a form-encoded body, not as a task.",
        "beta/text-to-image/reimagine-flux": "Beta endpoint that answers in one request, not as a task.",
        "classifier/image": "Returns a classification, not media.",
        "flows/{flow-id}/run": "Runs a flow saved in the user's Magnific account, not a model.",
        "image-to-prompt": "Returns text, not media.",
        "improve-prompt": "Returns text, not media.",
        "loras/characters": "Trains a LoRA; it produces no media.",
        "loras/styles": "Trains a LoRA; it produces no media.",
        "text-to-icon": "Two-step: the icon is rendered by a second request once the task is done.",
        "text-to-icon/preview": "Two-step: the icon is rendered by a second request once the task is done.",
        "text-to-icon/{task-id}/render/{format}": "The second step of icon generation.",
        "text-to-image": "The classic model answers in one request with inline images, not as a task.",
        "uploads/request-url": "The app's own upload step, not a model.",
        "video/kling-advanced-custom-elements": "Creates a reusable element, not a video.",
        "video/kling-v2-6-motion-control-pro": "Has no status route in the API description, so a run could not be followed.",
        "video/kling-v2-6-motion-control-std": "Has no status route in the API description, so a run could not be followed.",
        "video/runway-act-two": "Requires "character" and "reference", which no handle or setting can fill.",
        "video/seedance-2-fast-1080p": "Deprecated by Magnific.",
      }
    `);
  });

  it("gives every model its own name, a description and a capability", () => {
    const names = new Map<string, string>();
    for (const b of magnificBindings()) {
      expect(names.get(b.name), `${b.name}: ${names.get(b.name)} and ${b.id}`).toBeUndefined();
      names.set(b.name, b.id);
      expect(b.name.length, b.id).toBeGreaterThan(2);
      expect(b.description.length, b.id).toBeGreaterThan(10);
      expect(b.capabilities.length, b.id).toBeGreaterThan(0);
    }
  });

  it("lists them as provider models", () => {
    const models = magnificProviderModels();
    expect(models).toHaveLength(magnificBindings().length);
    expect(models.find((m) => m.id === "text-to-image/flux-2-pro")).toMatchObject({
      name: "Flux 2 Pro",
      provider: "magnific",
      capabilities: ["text-to-image", "image-to-image"],
    });
  });
});

describe("what the description says of a model", () => {
  it("names a model for itself, and for what its endpoint does where that is the point", () => {
    expect(binding("text-to-image/seedream-v5-pro").name).toBe("Seedream 5.0 Pro");
    expect(binding("text-to-image/seedream-v5-pro-edit").name).toBe("Seedream 5.0 Pro Edit");
    expect(binding("image-expand/flux-pro").name).toBe("Flux Pro Expand");
    expect(binding("text-to-video/happy-horse-1").name).toBe("Happy Horse 1.0 Text to Video");
    expect(binding("image-to-video/happy-horse-1").name).toBe("Happy Horse 1.0 Image to Video");
    // One endpoint for the model: no mode in the name.
    expect(binding("image-to-video/kling-v2-5-pro").name).toBe("Kling 2.5 Pro");
    expect(binding("text-to-image/gpt-image-2-5").name).toBe("GPT Image 2.5");
  });

  it("reads a task where its family is read, not always where it was made", () => {
    expect(binding("text-to-image/flux-2-pro").poll).toBe("text-to-image/flux-2-pro");
    expect(binding("video/kling-v3-pro").poll).toBe("video/kling-v3");
    expect(binding("video/kling-v3-std").poll).toBe("video/kling-v3");
    expect(binding("video/seedance-2-pro-720p").poll).toBe("video/seedance-2-pro");
    expect(binding("video/seedance-2-5-pro-720p").poll).toBe("video/seedance-2-5-pro-720p");
    expect(binding("video-upscaler/turbo").poll).toBe("video-upscaler");
    expect(binding("skin-enhancer/faithful").poll).toBe("skin-enhancer");
  });

  it("tells base64 fields from URL fields from those that take either", () => {
    const encodings = (id: string) => Object.fromEntries(binding(id).inputs.filter((i) => i.type !== "text").map((i) => [i.name, i.encoding]));
    expect(encodings("image-upscaler")).toEqual({ image: "base64" });
    expect(encodings("mystic")).toEqual({ structure_reference: "base64", style_reference: "base64" });
    expect(encodings("video-upscaler")).toEqual({ video: "url" });
    expect(encodings("video/kling-v3-pro")).toEqual({ start_image_url: "url", end_image_url: "url" });
    expect(encodings("text-to-image/nano-banana-pro")).toEqual({ reference_images: "url" });
    expect(encodings("text-to-image/seedream-v5-pro-edit")).toEqual({ reference_images: "either" });
    expect(encodings("image-upscaler-precision-v2")).toEqual({ image: "either" });
  });

  it("sorts models into capabilities by what they need", () => {
    expect(binding("image-upscaler").capabilities).toEqual(["image-to-image"]);
    expect(binding("text-to-image/flux-dev").capabilities).toEqual(["text-to-image"]);
    expect(binding("video/kling-v3-pro").capabilities).toEqual(["text-to-video", "image-to-video"]);
    expect(binding("image-to-video/ltx-2-pro").capabilities).toEqual(["image-to-video"]);
    expect(binding("video-upscaler").capabilities).toEqual(["video-to-video"]);
    expect(binding("lip-sync/latent-sync").capabilities).toEqual(["audio-to-video"]);
    expect(binding("voiceover/elevenlabs-v3").capabilities).toEqual(["text-to-audio"]);
  });

  it("gives the node its handles and settings", () => {
    const schema = magnificNodeSchema("image-upscaler")!;
    expect(schema.inputs).toEqual([
      { name: "prompt", type: "text", required: false, label: "Prompt" },
      expect.objectContaining({ name: "image", type: "image", required: true, label: "Image" }),
    ]);
    const scale = schema.parameters.find((p) => p.name === "scale_factor");
    expect(scale).toMatchObject({ type: "string", enum: ["2x", "4x", "8x", "16x"], default: "2x" });
    // Not settings: the callback URL, and anything a handle fills.
    expect(schema.parameters.map((p) => p.name)).not.toContain("webhook_url");
    expect(schema.parameters.map((p) => p.name)).not.toContain("image");
    expect(magnificNodeSchema("text-to-image/gpt-image-2")!.parameters.map((p) => p.name)).not.toContain("num_images");
    // A list handle takes several connections.
    expect(magnificNodeSchema("text-to-image/nano-banana-pro")!.inputs.find((i) => i.name === "reference_images")).toMatchObject({ isArray: true });
    expect(magnificNodeSchema("nope")).toBeNull();
  });
});

describe("request bodies", () => {
  const request = (overrides: Partial<MagnificRequestInput>): MagnificRequestInput => ({ prompt: "a cat", media: {}, encodings: {}, ...overrides });

  it("Flux 2 Pro: base64 into input_image, input_image_2; empty settings dropped", () => {
    const body = buildMagnificBody(
      binding("text-to-image/flux-2-pro"),
      request({ media: { input_image: [PNG, { ...PNG, base64: "AAAA" }] }, encodings: { input_image: "base64" }, parameters: { width: 1024, seed: "" } })
    );
    expect(body).toEqual({ prompt: "a cat", input_image: "iVBORw0KGgo=", input_image_2: "AAAA", width: 1024 });
  });

  it("Nano Banana Pro: reference images as objects, by URL, each with its type", () => {
    const body = buildMagnificBody(
      binding("text-to-image/nano-banana-pro"),
      request({ media: { reference_images: [PNG] }, encodings: { reference_images: "url" }, parameters: { aspect_ratio: "16:9" } })
    );
    expect(body).toEqual({ prompt: "a cat", aspect_ratio: "16:9", reference_images: [{ image: "https://example.com/a.png", mime_type: "image/png" }] });
  });

  it("Seedream edit: a plain list, in whichever encoding the request chose", () => {
    const b = binding("text-to-image/seedream-v5-pro-edit");
    expect(buildMagnificBody(b, request({ media: { reference_images: [PNG] }, encodings: { reference_images: "base64" } })).reference_images).toEqual(["iVBORw0KGgo="]);
    expect(buildMagnificBody(b, request({ media: { reference_images: [PNG] }, encodings: { reference_images: "url" } })).reference_images).toEqual(["https://example.com/a.png"]);
  });

  it("Kling 3: frames by URL under their own names, the prompt beside them", () => {
    const body = buildMagnificBody(
      binding("video/kling-v3-pro"),
      request({ negativePrompt: "blur", media: { start_image_url: [PNG] }, encodings: { start_image_url: "url" }, parameters: { duration: "10" } })
    );
    expect(body).toEqual({ prompt: "a cat", negative_prompt: "blur", start_image_url: "https://example.com/a.png", duration: "10" });
  });

  it("a voiceover's prompt is its text", () => {
    const body = buildMagnificBody(binding("voiceover/elevenlabs-v3"), request({ prompt: "Hello there", parameters: { voice_id: "abc" } }));
    expect(body).toEqual({ text: "Hello there", voice_id: "abc" });
  });

  it("the upscaler needs no prompt, and never sends an empty one", () => {
    const body = buildMagnificBody(binding("image-upscaler"), request({ prompt: "", media: { image: [PNG] }, encodings: { image: "base64" } }));
    expect(body).toEqual({ image: "iVBORw0KGgo=" });
  });
});

/**
 * The recorded schema as Ajv takes it: OpenAPI `nullable` becomes a union,
 * and `oneOf` is read as `anyOf`. The description offers a body's variants
 * as `oneOf` without closing them (Hailuo's text request is its image
 * request minus the frames), so a full image request matches both and
 * "exactly one" can never hold for it.
 */
function toJsonSchema(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(toJsonSchema);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "nullable") continue;
    out[key === "oneOf" ? "anyOf" : key] = toJsonSchema(value);
  }
  return (node as { nullable?: boolean }).nullable === true ? { anyOf: [out, { type: "null" }] } : out;
}

/** A value for a required setting the description gives no default: what a user would have to fill in. */
function filled(b: MagnificBinding): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const param of b.params) {
    if (!param.required || param.default !== undefined) continue;
    values[param.name] = param.type === "string" ? "abc" : param.type === "boolean" ? true : (param.minimum ?? 1);
  }
  return values;
}

function sampleInput(b: MagnificBinding, full: boolean): MagnificRequestInput {
  const media: MagnificRequestInput["media"] = {};
  const encodings: MagnificRequestInput["encodings"] = {};
  for (const handle of b.inputs) {
    if (handle.type === "text") continue;
    if (!full && !handle.required) continue;
    const count = full ? Math.min(handle.max ?? 1, 2) : 1;
    media[handle.name] = Array.from({ length: count }, () => SAMPLE[handle.type as keyof typeof SAMPLE]);
    // A field that takes either is sent inline in one body and by URL in the other.
    encodings[handle.name] = handle.encoding === "either" ? (full ? "url" : "base64") : handle.encoding!;
  }
  return { prompt: "a lighthouse at dusk", negativePrompt: full ? "blurry" : undefined, parameters: filled(b), media, encodings };
}

describe("bound requests match the recorded schemas", () => {
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
  const schemas = new Map(magnificSpecEndpoints().map((endpoint) => [endpoint.id, endpoint.schema]));

  for (const b of magnificBindings()) {
    it(b.id, () => {
      const validate = ajv.compile(toJsonSchema(schemas.get(b.id)) as object);
      const problems: string[] = [];
      for (const full of [false, true]) {
        const body = buildMagnificBody(b, sampleInput(b, full));
        if (!validate(body)) {
          problems.push(`${full ? "full" : "minimal"}: ${ajv.errorsText(validate.errors, { separator: "; " })}\n  body: ${JSON.stringify(body).slice(0, 400)}`);
        }
      }
      expect(problems, problems.join("\n")).toEqual([]);
    });
  }
});
