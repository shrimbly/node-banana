/**
 * Builds examples/kitchen-sink.json: one of every node type, every handle
 * type wired at least once, and the generate nodes in each of their states
 * (empty, loading, error, history with the settings open). Load it in the
 * app to eyeball the node chrome after a change.
 *
 *   npx tsx scripts/make-kitchen-sink.mts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

// nodeDefaults reads sticky settings from localStorage; there is none here.
const memory = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => void memory.set(k, v),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: () => null,
  length: 0,
} as Storage;

const { createDefaultNodeData, defaultNodeDimensions } = await import("../src/store/utils/nodeDefaults");
type NodeType = keyof typeof defaultNodeDimensions;

/** An SVG placeholder image at a given size, as a data URL. */
function svgImage(w: number, h: number, hue: number, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},45%,38%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},45%,22%)"/>` +
    `</linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<circle cx="${w * 0.7}" cy="${h * 0.35}" r="${Math.min(w, h) * 0.18}" fill="hsl(${(hue + 180) % 360},50%,70%)" opacity=".8"/>` +
    `<text x="${w / 2}" y="${h / 2}" font-family="system-ui" font-size="${Math.min(w, h) / 9}" fill="white" fill-opacity=".85" text-anchor="middle" dominant-baseline="middle">${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const IMG = {
  wide: svgImage(640, 360, 200, "16:9"),
  square: svgImage(512, 512, 30, "1:1"),
  tall: svgImage(360, 640, 300, "9:16"),
  photo: svgImage(600, 450, 120, "4:3"),
  cut: svgImage(400, 400, 80, "cut-out"),
};

const history = (n: number, ratio: string) =>
  Array.from({ length: n }, (_, i) => ({
    id: `hist-${ratio.replace(":", "x")}-${i + 1}`,
    timestamp: 1_756_000_000_000 + i * 60_000,
    prompt: `Variation ${i + 1}`,
    aspectRatio: ratio,
    model: "nano-banana-pro",
  }));

type N = { id: string; type: NodeType; position: { x: number; y: number }; data: Record<string, unknown>; width: number; style: { width: number } };
const nodes: N[] = [];
const edges: Array<{ id: string; source: string; sourceHandle: string; target: string; targetHandle: string }> = [];

const COL = 440;
const ROW = 560;
let counter = 0;

function add(type: NodeType, col: number, row: number, data: Record<string, unknown> = {}, width?: number): string {
  const id = `${type}-${++counter}`;
  const w = width ?? defaultNodeDimensions[type].width;
  nodes.push({
    id,
    type,
    position: { x: col * COL, y: row * ROW },
    data: { ...(createDefaultNodeData(type) as Record<string, unknown>), ...data },
    width: w,
    style: { width: w },
  });
  return id;
}

function wire(source: string, sourceHandle: string, target: string, targetHandle: string) {
  edges.push({ id: `edge-${source}-${target}-${sourceHandle}-${targetHandle}`, source, sourceHandle, target, targetHandle });
}

// ---- column 0: inputs
const imageIn = add("imageInput", 0, 0, { image: IMG.photo, filename: "house-lake.jpg" });
const imageInEmpty = add("imageInput", 0, 1);
const prompt = add("prompt", 0, 2, { prompt: "A lakeside house at golden hour, {{style}}, shot on medium format film" });
const videoIn = add("videoInput", 0, 3);
const audioIn = add("audioInput", 0, 4);

// ---- column 1: annotation, prompt constructor, LLM, array
const annotation = add("annotation", 1, 0, { inputImage: IMG.photo, outputImage: IMG.photo });
const constructor_ = add("promptConstructor", 1, 1, { template: "Portrait of {{subject}} in {{style}}", variables: { subject: "a donkey", style: "oil paint" } });
const llm = add("llmGenerate", 1, 2, { outputText: "A weathered lakeside cabin, warm windows, mist over still water.", status: "idle" });
const array = add("array", 1, 3, { inputText: "red, green, blue", outputItems: ["red", "green", "blue"] });

// ---- column 2: generate image in each state
const genEmpty = add("nanoBanana", 2, 0, { aspectRatio: "16:9", resolution: "2K", parametersExpanded: false });
const genLoading = add("nanoBanana", 2, 1, { status: "loading", aspectRatio: "1:1", parametersExpanded: false });
const genError = add("nanoBanana", 2, 2, { status: "error", error: "Rate limit exceeded. Try again in a minute.", aspectRatio: "3:2", parametersExpanded: false });
const genHistory = add(
  "nanoBanana",
  2,
  3,
  {
    outputImage: IMG.wide,
    aspectRatio: "16:9",
    resolution: "2K",
    imageHistory: history(5, "16:9"),
    selectedHistoryIndex: 2,
    parametersExpanded: true,
    useGoogleSearch: true,
  },
  360
);
const genExternal = add(
  "nanoBanana",
  2,
  4,
  {
    outputImage: IMG.tall,
    selectedModel: { provider: "fal", modelId: "fal-ai/flux-pro/v1.1-ultra", displayName: "FLUX 1.1 Pro Ultra" },
    parameters: { aspect_ratio: "9:16", num_images: 1, safety_tolerance: "2", output_format: "jpeg", seed: 1234, raw: false },
    imageHistory: history(2, "9:16"),
    selectedHistoryIndex: 1,
    parametersExpanded: true,
  },
  240
);
const genLarge = add("nanoBanana", 2, 6, { outputImage: IMG.square, aspectRatio: "1:1", imageHistory: history(1, "1:1"), selectedHistoryIndex: 0, parametersExpanded: false }, 520);

// ---- column 3: video / audio / 3d generation
const genVideo = add("generateVideo", 3, 0, {
  selectedModel: { provider: "kie", modelId: "wan/2-2-i2v-14b", displayName: "Wan 2.2 Image-to-Video 14B" },
  parameters: { duration: 5, resolution: "720p" },
  parametersExpanded: true,
});
const genVideoLoading = add("generateVideo", 3, 1, {
  selectedModel: { provider: "fal", modelId: "fal-ai/kling-video/v2.1", displayName: "Kling 2.1 Pro" },
  status: "loading",
  parametersExpanded: false,
});
const genAudio = add("generateAudio", 3, 2, { status: "error", error: "Voice not found", parametersExpanded: false });
const gen3d = add("generate3d", 3, 3, { parametersExpanded: false });
const comfy = add("comfyApp", 3, 4, {
  app: {
    id: "app-kitchen",
    name: "Upscale Pass",
    description: "A two-node upscale",
    source: "upload",
    graph: { "1": { class_type: "LoadImage", inputs: { image: "example.png" } } },
    inputs: [{ id: "1:image", name: "image", label: "Image", type: "image", nodeId: "1", inputKey: "image", required: true }],
    params: [
      { id: "2:steps", label: "KSampler · steps", type: "integer", default: 20, minimum: 1, maximum: 100, nodeId: "2", inputKey: "steps" },
      { id: "2:sampler", label: "KSampler · sampler_name", type: "string", enum: ["euler", "dpmpp_2m"], default: "euler", nodeId: "2", inputKey: "sampler_name" },
      { id: "2:seed", label: "KSampler · seed", type: "integer", default: 42, isSeed: true, nodeId: "2", inputKey: "seed" },
    ],
    outputs: [{ id: "9", label: "Result", type: "image", nodeId: "9", classType: "SaveImage" }],
    classTypes: ["LoadImage", "KSampler", "SaveImage"],
    nodeCount: 3,
    createdAt: 1_756_000_000_000,
  },
  paramValues: { "2:steps": 28 },
  parametersExpanded: true,
});

// ---- column 4: processing
const resize = add("imageResize", 4, 0, { inputImage: IMG.photo, outputImage: IMG.photo, targetWidth: 1024, targetHeight: 768 });
const removeBg = add("removeBackground", 4, 1, { inputImage: IMG.cut, outputImage: IMG.cut });
const frameGrab = add("videoFrameGrab", 4, 2);
const trim = add("videoTrim", 4, 3);
const stitch = add("videoStitch", 4, 4);
const gif = add("gifEncoder", 4, 5);
const ease = add("easeCurve", 4, 6);

// ---- column 5: comparison / display
const compare = add("imageCompare", 5, 0, { imageA: IMG.wide, imageB: IMG.wide });
const splitGrid = add("splitGrid", 5, 1, { inputImage: IMG.square, gridRows: 2, gridCols: 2 });
const glb = add("glbViewer", 5, 2);
const output = add("output", 5, 3, { inputImage: IMG.wide });
const outputEmpty = add("output", 5, 4);
const gallery = add("outputGallery", 5, 5, { images: [IMG.wide, IMG.square, IMG.tall] });

// ---- column 6: logic
const router = add("router", 6, 0);
const sw = add("switch", 6, 1, {
  inputType: "text",
  switches: [
    { id: "sw-a", name: "Warm", enabled: true },
    { id: "sw-b", name: "Cool", enabled: false },
    { id: "sw-c", name: "Mono", enabled: true },
  ],
});
const cond = add("conditionalSwitch", 6, 2, {
  incomingText: "night scene, neon",
  rules: [
    { id: "rule-night", value: "night", mode: "contains", label: "Night", isMatched: true },
    { id: "rule-day", value: "day", mode: "contains", label: "Day", isMatched: false },
  ],
});

// ---- edges: every handle type at least once
wire(imageIn, "image", annotation, "image");
wire(annotation, "image", genHistory, "image");
wire(prompt, "text", genHistory, "text");
wire(genHistory, "image", output, "image");
wire(prompt, "text", llm, "text");
wire(imageIn, "image", llm, "image");
wire(llm, "text", genLoading, "text");
wire(prompt, "text", constructor_, "text");
wire(constructor_, "text", genError, "text");
wire(imageIn, "image", genVideo, "image");
wire(prompt, "text", genVideo, "text");
wire(genVideo, "video", trim, "video");
wire(trim, "video", frameGrab, "video");
wire(frameGrab, "image", removeBg, "image");
wire(removeBg, "image", resize, "image");
wire(resize, "image", gif, "image");
wire(videoIn, "video", stitch, "video-0");
wire(audioIn, "audio", stitch, "audio");
wire(videoIn, "video", ease, "video");
wire(ease, "video", gallery, "video");
wire(prompt, "text", genAudio, "text");
wire(genAudio, "audio", outputEmpty, "audio");
wire(imageIn, "image", gen3d, "image");
wire(gen3d, "3d", glb, "3d");
wire(glb, "image", compare, "image");
wire(genLarge, "image", compare, "image-1");
wire(imageIn, "image", splitGrid, "image");
wire(splitGrid, "reference", imageInEmpty, "reference");
wire(imageIn, "image", router, "generic-input");
wire(router, "image", gallery, "image");
wire(prompt, "text", sw, "generic-input");
wire(sw, "sw-a", array, "text");
wire(llm, "text", cond, "text");
wire(cond, "rule-night", genExternal, "text");
wire(imageIn, "image", comfy, "1:image");
wire(comfy, "9", genVideoLoading, "image");

const workflow = {
  version: 1,
  id: "wf_kitchen_sink",
  name: "Kitchen sink",
  directoryPath: "",
  nodes,
  edges,
  edgeStyle: "angular",
  groups: {},
};

const out = resolve(process.cwd(), "examples/kitchen-sink.json");
writeFileSync(out, JSON.stringify(workflow, null, 2) + "\n");
console.log(`wrote ${out}: ${nodes.length} nodes, ${edges.length} edges, ${new Set(nodes.map((n) => n.type)).size} node types`);
