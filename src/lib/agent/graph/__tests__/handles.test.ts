import { describe, expect, it } from "vitest";
import type { NodeType } from "@/types";
import { buildVeoInputSchema } from "@/store/utils/modelSelection";
import { getVideoModel } from "../catalog";
import {
  edgeHandlesExist,
  edgeState,
  getHandleType,
  getInputHandles,
  getOutputHandles,
  isValidConnectionPort,
  planConnection,
  wouldCreateCycle,
  type GraphEdgeLike,
  type GraphNodeLike,
} from "../handles";

function node(id: string, type: NodeType, data: Record<string, unknown> = {}): GraphNodeLike {
  return { id, type, data };
}
function edge(source: string, sourceHandle: string, target: string, targetHandle: string, data?: GraphEdgeLike["data"]): GraphEdgeLike {
  return { id: `edge-${source}-${target}-${sourceHandle}-${targetHandle}`, source, sourceHandle, target, targetHandle, ...(data ? { data } : {}) };
}
function graph(nodes: GraphNodeLike[]) {
  return new Map(nodes.map((n) => [n.id, n]));
}
const ids = (handles: Array<{ id: string; hidden?: boolean }>) => handles.filter((h) => !h.hidden).map((h) => h.id);

describe("getHandleType (port of the canvas rule)", () => {
  it.each([
    ["image", "image"],
    ["image-0", "image"],
    ["image-1", "image"],
    ["text", "text"],
    ["text-1", "text"],
    ["prompt", "text"],
    ["negative_prompt", "text"],
    ["video", "video"],
    ["video-3", "video"],
    ["audio", "audio"],
    ["audio-0", "audio"],
    ["3d", "3d"],
    ["easeCurve", "easeCurve"],
    ["first_frame", "image"],
    ["generic-input", null],
    ["reference", null],
    ["rule-abc1234", null],
    ["9", null],
    [null, null],
  ])("%s → %s", (id, type) => {
    expect(getHandleType(id)).toBe(type);
  });
});

describe("rendered handles", () => {
  it("generateVideo follows its schema, with placeholders and hidden legacy ids", () => {
    const none = node("v", "generateVideo");
    expect(ids(getInputHandles(none, []))).toEqual(["image", "video", "text"]);

    const i2v = node("v", "generateVideo", { inputSchema: buildVeoInputSchema("veo-3.1/image-to-video") });
    const handles = getInputHandles(i2v, []);
    expect(ids(handles)).toEqual(["image-0", "video", "text-0", "text-1"]);
    expect(handles.find((h) => h.id === "video")?.unused).toBe(true);
    expect(handles.filter((h) => h.hidden).map((h) => h.id)).toEqual(["image", "text"]);

    const t2v = node("v", "generateVideo", { inputSchema: buildVeoInputSchema("veo-3.1/text-to-video") });
    expect(ids(getInputHandles(t2v, []))).toEqual(["image", "video", "text-0", "text-1"]);
  });

  it("generateVideo with Gemini Omni: every media type indexed, reference images collected", () => {
    const omni = node("v", "generateVideo", { inputSchema: getVideoModel("gemini-omni-1.1-flash")!.inputSchema });
    const handles = getInputHandles(omni, []);
    expect(ids(handles)).toEqual(["image-0", "video-0", "audio-0", "text-0"]);
    expect(handles.find((h) => h.id === "image-0")).toMatchObject({ label: "Reference images", multi: true });
    expect(handles.find((h) => h.id === "text-0")).toMatchObject({ label: "Prompt", multi: false });
    expect(handles.filter((h) => h.hidden).map((h) => h.id)).toEqual(["image", "video", "audio", "text"]);
  });

  it("generate3d keeps to image and text sockets", () => {
    expect(ids(getInputHandles(node("d", "generate3d"), []))).toEqual(["image", "text"]);
    const schema = [{ name: "image_url", type: "image", label: "Image" }, { name: "video", type: "video", label: "Video" }];
    expect(ids(getInputHandles(node("d", "generate3d", { inputSchema: schema }), []))).toEqual(["image-0", "text"]);
  });

  it("nanoBanana renders image and prompt whatever the model", () => {
    const schema = [
      { name: "image", type: "image", label: "Garment" },
      { name: "mask", type: "image", label: "Mask" },
      { name: "prompt", type: "text", label: "Prompt" },
    ];
    expect(ids(getInputHandles(node("g", "nanoBanana", { selectedModel: { provider: "fal" }, inputSchema: schema }), []))).toEqual(["image", "text"]);
    const comfy = getInputHandles(node("g", "nanoBanana", { selectedModel: { provider: "comfy" }, inputSchema: schema }), []);
    expect(comfy.map((h) => `${h.id}:${h.label}:${h.multi}`)).toEqual(["image:Image:true", "text:Prompt:false"]);
  });

  it("labels handles as the node sockets do", () => {
    const label = (type: NodeType, direction: "in" | "out") =>
      (direction === "in" ? getInputHandles(node("n", type), []) : getOutputHandles(node("n", type), [])).map((h) => h.label);
    expect(label("imageCompare", "in")).toEqual(["A", "B"]);
    expect(label("outputGallery", "in")).toEqual(["Image", "Video"]);
    expect(label("videoTrim", "in")).toEqual(["Video In"]);
    expect(label("videoTrim", "out")).toEqual(["Video Out"]);
    expect(label("imageResize", "out")).toEqual(["Image Out"]);
    expect(label("gifEncoder", "out")).toEqual(["GIF Out"]);
    expect(label("array", "out")).toEqual(["Items"]);
    expect(label("generateAudio", "in")).toEqual(["Prompt"]);
    expect(label("glbViewer", "out")).toEqual(["Image"]);
    const cs = node("c", "conditionalSwitch", { rules: [{ id: "rule-1", label: "Cats", value: "cat", mode: "contains" }] });
    expect(getOutputHandles(cs, []).map((h) => h.label)).toEqual(["Cats", "Fallback"]);
    const routed = getOutputHandles(node("r", "router"), [edge("e", "easeCurve", "r", "easeCurve"), edge("m", "3d", "r", "3d")]);
    expect(routed.map((h) => `${h.id}:${h.label}`)).toEqual(["3d:3D", "easeCurve:Ease curve"]);
  });

  it("generateAudio uses schema names as handle ids", () => {
    const audio = node("a", "generateAudio", { inputSchema: [{ name: "text", type: "text", label: "Script" }, { name: "voice_sample", type: "audio", label: "Voice" }] });
    expect(getInputHandles(audio, []).map((h) => `${h.id}:${h.type}`)).toEqual(["text:text", "voice_sample:audio"]);
  });

  it("videoStitch and gifEncoder render one more slot than they use", () => {
    const stitch = node("s", "videoStitch");
    expect(ids(getInputHandles(stitch, []))).toEqual(["video-0", "video-1", "audio"]);
    const withClips = [edge("a", "video", "s", "video-0"), edge("b", "video", "s", "video-1")];
    expect(ids(getInputHandles(stitch, withClips))).toEqual(["video-0", "video-1", "video-2", "audio"]);

    const gif = node("g", "gifEncoder");
    expect(ids(getInputHandles(gif, [edge("a", "image", "g", "image-3")]))).toEqual(["image-0", "image-1", "image-2", "image-3", "image-4"]);
  });

  it("router exposes only connected types; switch and conditionalSwitch outputs follow their data", () => {
    const router = node("r", "router");
    expect(getInputHandles(router, [])).toEqual([]);
    expect(getOutputHandles(router, [])).toEqual([]);
    const routed = [edge("p", "text", "r", "text"), edge("i", "image", "r", "image")];
    expect(ids(getOutputHandles(router, routed))).toEqual(["image", "text"]);

    const sw = node("s", "switch", { inputType: null, switches: [{ id: "aaaaaaa", name: "A", enabled: true }, { id: "bbbbbbb", name: "B", enabled: false }] });
    expect(getOutputHandles(sw, [])).toEqual([]);
    const connected = [edge("i", "image", "s", "image")];
    const outs = getOutputHandles(sw, connected);
    expect(outs.map((h) => `${h.id}:${h.type}:${h.label}`)).toEqual(["aaaaaaa:image:A", "bbbbbbb:image:B"]);
    expect(outs[1].unused).toBe(true);

    const cs = node("c", "conditionalSwitch", { rules: [{ id: "rule-1", label: "Cats", value: "cat", mode: "contains" }] });
    expect(ids(getOutputHandles(cs, []))).toEqual(["rule-1", "default"]);
  });

  it("comfyApp handles come from the attached workflow's contract", () => {
    const inputs = [{ name: "photo", type: "image", label: "Photo" }, { name: "style", type: "image", label: "Style" }, { name: "prompt", type: "text", label: "Prompt" }];
    const app = node("c", "comfyApp", {
      inputSchema: inputs,
      app: { inputs, outputs: [{ id: "9", type: "image", label: "Save" }, { id: "12", type: "video", label: "Clip" }] },
    });
    expect(getInputHandles(app, []).map((h) => `${h.id}:${h.label}`)).toEqual(["image-0:Photo", "image-1:Style", "text-0:Prompt"]);
    expect(getOutputHandles(app, []).map((h) => `${h.id}:${h.type}`)).toEqual(["9:image", "12:video"]);
    // No workflow attached: the node renders no handles, whatever inputSchema says.
    expect(getInputHandles(node("c", "comfyApp", { app: null, inputSchema: inputs }), [])).toEqual([]);
  });
});

describe("isValidConnectionPort", () => {
  const nodes = graph([
    node("v", "generateVideo"),
    node("g", "nanoBanana"),
    node("o", "output"),
    node("p", "prompt"),
    node("e", "easeCurve"),
    node("cs", "conditionalSwitch"),
    node("s", "switch", { inputType: "image" }),
    node("c", "comfyApp", { inputSchema: [{ name: "x", type: "image" }], app: { outputs: [{ id: "9", type: "image" }] } }),
  ]);
  const ok = (source: string, sh: string, target: string, th: string) => isValidConnectionPort({ source, sourceHandle: sh, target, targetHandle: th }, nodes);

  it("mirrors the canvas rules", () => {
    expect(ok("p", "text", "g", "text")).toBe(true);
    expect(ok("p", "text", "g", "image")).toBe(false);
    expect(ok("v", "video", "o", "video")).toBe(true);
    expect(ok("v", "video", "g", "image")).toBe(false);
    expect(ok("e", "easeCurve", "g", "image")).toBe(false);
    expect(ok("g", "image", "cs", "text")).toBe(false);
    expect(ok("s", "aaaaaaa", "g", "text")).toBe(false);
    expect(ok("s", "aaaaaaa", "g", "image")).toBe(true);
    expect(ok("g", "image", "c", "image-0")).toBe(true);
    expect(ok("g", "image", "c", "image-1")).toBe(false);
    expect(ok("c", "9", "o", "image")).toBe(true);
    expect(ok("c", "10", "o", "image")).toBe(false);
  });
});

describe("wouldCreateCycle", () => {
  it("finds direct, indirect and self loops", () => {
    const edges = [edge("a", "text", "b", "text"), edge("b", "text", "c", "text")];
    expect(wouldCreateCycle("c", "a", edges)).toBe(true);
    expect(wouldCreateCycle("a", "a", edges)).toBe(true);
    expect(wouldCreateCycle("a", "c", edges)).toBe(false);
  });
});

describe("planConnection", () => {
  const plan = (nodes: GraphNodeLike[], edges: GraphEdgeLike[], from: string, to: string, fromHandle?: string, toHandle?: string) => {
    const map = graph(nodes);
    return planConnection({ source: map.get(from)!, target: map.get(to)!, fromHandle, toHandle, nodes: map, edges });
  };

  it("picks handles by type and reports replacements on single inputs", () => {
    const nodes = [node("p1", "prompt"), node("p2", "prompt"), node("g", "nanoBanana")];
    const first = plan(nodes, [], "p1", "g");
    expect(first).toMatchObject({ ok: true, sourceHandle: { id: "text" }, targetHandle: { id: "text" }, replaces: [] });
    const existing = [edge("p1", "text", "g", "text")];
    const second = plan(nodes, existing, "p2", "g");
    expect(second).toMatchObject({ ok: true, replaces: [existing[0]] });
    const again = plan(nodes, existing, "p1", "g");
    expect(again).toMatchObject({ ok: true, duplicate: existing[0] });
  });

  it("accepts handle labels, schema names and hidden legacy ids", () => {
    const v = node("v", "generateVideo", { inputSchema: buildVeoInputSchema("veo-3.1/image-to-video") });
    const nodes = [node("p", "prompt"), node("i", "imageInput"), v];
    expect(plan(nodes, [], "p", "v", undefined, "negative_prompt")).toMatchObject({ ok: true, targetHandle: { id: "text-1" } });
    expect(plan(nodes, [], "p", "v", undefined, "Neg. Prompt")).toMatchObject({ ok: true, targetHandle: { id: "text-1" } });
    expect(plan(nodes, [], "p", "v", undefined, "text")).toMatchObject({ ok: true, targetHandle: { id: "text-0" } });
    expect(plan(nodes, [], "i", "v")).toMatchObject({ ok: true, targetHandle: { id: "image-0" } });
  });

  it("refuses inputs the current model ignores", () => {
    const t2v = node("v", "generateVideo", { inputSchema: buildVeoInputSchema("veo-3.1/text-to-video") });
    const result = plan([node("i", "imageInput"), t2v], [], "i", "v");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not used by its current model");
  });

  it("fills imageCompare, videoStitch and gifEncoder slots in order", () => {
    const nodes = [node("a", "imageInput"), node("b", "imageInput"), node("c", "imageInput"), node("cmp", "imageCompare"), node("gif", "gifEncoder")];
    expect(plan(nodes, [], "a", "cmp")).toMatchObject({ ok: true, targetHandle: { id: "image" } });
    const one = [edge("a", "image", "cmp", "image")];
    expect(plan(nodes, one, "b", "cmp")).toMatchObject({ ok: true, targetHandle: { id: "image-1" } });
    const full = plan(nodes, [...one, edge("b", "image", "cmp", "image-1")], "c", "cmp");
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error).toContain("every image input of cmp is taken");

    const frames = [edge("a", "image", "gif", "image-0")];
    expect(plan(nodes, frames, "b", "gif")).toMatchObject({ ok: true, targetHandle: { id: "image-1" } });
    const taken = plan(nodes, frames, "b", "gif", undefined, "image-0");
    expect(taken.ok).toBe(false);
    if (!taken.ok) expect(taken.error).toContain("Use image-1 (the next free slot)");
  });

  it("types switch inputs from the source and keeps one input", () => {
    const nodes = [node("i", "imageInput"), node("p", "prompt"), node("s", "switch", { inputType: null, switches: [] })];
    expect(plan(nodes, [], "i", "s")).toMatchObject({ ok: true, targetHandle: { id: "image" }, switchInputType: "image" });
    const typed = [edge("i", "image", "s", "image")];
    const other = plan(nodes, typed, "p", "s");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toContain("already routes image");
  });

  it("asks which output when a router could feed several types", () => {
    const nodes = [node("r", "router"), node("g", "nanoBanana")];
    const edges = [edge("p", "text", "r", "text"), edge("i", "image", "r", "image")];
    const result = plan(nodes, edges, "r", "g");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("say which with fromHandle");
    expect(plan(nodes, edges, "r", "g", "text")).toMatchObject({ ok: true, sourceHandle: { id: "text" }, targetHandle: { id: "text" } });
  });

  it("suggests the node that converts between types", () => {
    const nodes = [node("v", "generateVideo"), node("g", "nanoBanana"), node("p", "prompt"), node("o", "output")];
    const video = plan(nodes, [], "v", "g");
    expect(video.ok).toBe(false);
    if (!video.ok) expect(video.error).toContain("put a Frame Grab (videoFrameGrab) node in between");
    const text = plan([...nodes, node("r", "removeBackground")], [], "p", "r");
    if (!text.ok) expect(text.error).toContain("put a Generate Image (nanoBanana) node in between");
  });

  it("explains type mismatches and dead ends", () => {
    const nodes = [node("p", "prompt"), node("o", "output"), node("i", "imageInput"), node("g", "nanoBanana")];
    const mismatch = plan(nodes, [], "p", "o");
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error).toContain("Types never convert on a connection");
    const intoUpload = plan(nodes, [], "g", "i");
    expect(intoUpload.ok).toBe(false);
    if (!intoUpload.ok) expect(intoUpload.error).toContain("takes no connections");
    const fromEnd = plan(nodes, [], "o", "g");
    expect(fromEnd.ok).toBe(false);
    const explicit = plan(nodes, [], "p", "g", undefined, "image");
    expect(explicit.ok).toBe(false);
    if (!explicit.ok) expect(explicit.error).toContain("type mismatch");
  });
});

describe("edgeHandlesExist", () => {
  it("flags edges whose handles vanished", () => {
    const sw = node("s", "switch", { inputType: "image", switches: [{ id: "aaaaaaa", name: "A", enabled: true }] });
    const nodes = graph([node("i", "imageInput"), sw, node("o", "output")]);
    const edges = [edge("i", "image", "s", "image"), edge("s", "aaaaaaa", "o", "image"), edge("s", "gone", "o", "image")];
    expect(edgeHandlesExist(edges[1], nodes, edges)).toBe(true);
    expect(edgeHandlesExist(edges[2], nodes, edges)).toBe(false);
  });
});

describe("loop edges (review C6)", () => {
  it("never count as the occupant a new connection replaces", () => {
    const nodes = graph([node("p", "prompt"), node("g", "nanoBanana"), node("l", "llmGenerate")]);
    const loop = edge("l", "text", "g", "text", { isLoop: true });
    const plan = planConnection({ source: nodes.get("p")!, target: nodes.get("g")!, nodes, edges: [edge("g", "image", "l", "image"), loop] });
    expect(plan).toMatchObject({ ok: true, replaces: [] });
    // The same handles as an existing loop edge is still a duplicate (edge ids ignore loop status).
    const again = planConnection({ source: nodes.get("l")!, target: nodes.get("g")!, nodes, edges: [loop] });
    expect(again).toMatchObject({ ok: true, duplicate: loop });
  });

  it("leave numbered slots free", () => {
    const nodes = graph([node("a", "imageInput"), node("b", "imageInput"), node("gif", "gifEncoder")]);
    const plan = planConnection({ source: nodes.get("b")!, target: nodes.get("gif")!, nodes, edges: [edge("a", "image", "gif", "image-0", { isLoop: true })] });
    expect(plan).toMatchObject({ ok: true, targetHandle: { id: "image-0" }, replaces: [] });
  });
});

describe("edgeState (review C9, C10)", () => {
  it("treats Router and Switch outputs whose input went as dormant, and a retyped Switch output as mistyped", () => {
    const router = node("r", "router");
    const idle = node("s", "switch", { inputType: null, switches: [{ id: "aaaaaaa", name: "A", enabled: true }] });
    const nodes = graph([router, idle, node("l", "llmGenerate"), node("g", "nanoBanana"), node("i", "imageInput")]);
    expect(edgeState(edge("r", "text", "l", "text"), nodes, [edge("r", "text", "l", "text")])).toBe("dormant");
    expect(edgeState(edge("s", "aaaaaaa", "g", "text"), nodes, [])).toBe("dormant");
    expect(edgeState(edge("s", "gone", "g", "text"), nodes, [])).toBe("missing");
    const imageIn = edge("i", "image", "s", "image");
    expect(edgeState(edge("s", "aaaaaaa", "g", "text"), nodes, [imageIn])).toBe("mistyped");
    expect(edgeState(edge("s", "aaaaaaa", "g", "image"), nodes, [imageIn])).toBe("live");
    expect(edgeState(edge("r", "text", "l", "text"), nodes, [edge("p", "text", "r", "text")])).toBe("live");
  });
});

describe("end nodes as sources (review C32)", () => {
  it.each([
    ["output", "Output"],
    ["outputGallery", "Output Gallery"],
    ["imageCompare", "Image Compare"],
  ] as const)("%s explains what to connect instead, without suggesting a removal", (type, name) => {
    const nodes = graph([node("x", type), node("o", "output")]);
    const plan = planConnection({ source: nodes.get("x")!, target: nodes.get("o")!, nodes, edges: [] });
    expect(plan.ok).toBe(false);
    const error = (plan as { error: string }).error;
    expect(error).toContain(`x (${name}) is an end node`);
    expect(error).toContain("Connect the node that feeds it");
    expect(error).not.toMatch(/\bremove it\b|remove_node/);
  });
});
