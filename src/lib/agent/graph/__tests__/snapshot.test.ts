import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@/types";
import { buildAgentSnapshot } from "../snapshot";
import { containsMedia } from "../scrub";
import { storeEdge, storeNode } from "../../tools/__tests__/testUtils";

const PNG = `data:image/png;base64,${"iVBORw0KGgo".repeat(400)}`;
const BLOB = "blob:http://localhost:3000/6b1f5c2e-0000-4000-8000-000000000000";

describe("buildAgentSnapshot", () => {
  it("keeps settings and structure, turns media into content flags", () => {
    const nodes: WorkflowNode[] = [
      storeNode("imageInput-1", "imageInput", { x: 10.4, y: 20.6 }, { image: PNG, imageRef: "gen/123.png", filename: "cat.png", dimensions: { width: 1, height: 1 } }, { selected: true }),
      storeNode("nanoBanana-2", "nanoBanana", { x: 400, y: 0 }, {
        outputImage: PNG,
        inputImages: [PNG, PNG],
        imageHistory: [{ id: "h1" }],
        status: "complete",
        customTitle: "Hero",
        aspectRatio: "16:9",
      }),
      storeNode("llmGenerate-3", "llmGenerate", { x: 0, y: 400 }, { outputText: "A poem", status: "error", error: "quota exceeded" }),
      storeNode("videoInput-4", "videoInput", { x: 0, y: 800 }, { video: BLOB }),
    ];
    const snapshot = buildAgentSnapshot({
      nodes,
      edges: [storeEdge("imageInput-1", "image", "nanoBanana-2", "image"), storeEdge("ghost", "image", "nanoBanana-2", "image")],
      groups: { g1: { id: "g1", name: "Inputs", color: "blue", position: { x: 0, y: 0 }, size: { width: 1, height: 1 } } },
      viewport: { x: -10.2, y: 5.5, width: 1600, height: 900, zoom: 0.75 },
      workflowName: "Demo",
    });

    expect(containsMedia(snapshot)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain("base64");
    expect(JSON.stringify(snapshot)).not.toContain("blob:");

    const [image, gen, llm, video] = snapshot.nodes;
    expect(image).toEqual({
      id: "imageInput-1",
      type: "imageInput",
      position: { x: 10, y: 21 },
      width: 300,
      height: 280,
      data: {},
      content: { image: true },
    });
    expect(gen.title).toBe("Hero");
    expect(gen.data).toEqual({
      model: "nano-banana-pro",
      selectedModel: { provider: "gemini", modelId: "nano-banana-pro", displayName: "Nano Banana Pro" },
      aspectRatio: "16:9",
      resolution: "1K",
      useGoogleSearch: false,
      useImageSearch: false,
    });
    expect(gen.content).toEqual({ image: true });
    expect(gen.status).toBe("complete");
    expect(llm).toMatchObject({ content: { text: "A poem" }, status: "error", error: "quota exceeded" });
    expect(video.content).toEqual({ video: true });

    expect(snapshot.edges).toEqual([
      { id: "edge-imageInput-1-nanoBanana-2-image-image", source: "imageInput-1", sourceHandle: "image", target: "nanoBanana-2", targetHandle: "image" },
    ]);
    expect(snapshot.groups).toEqual([{ id: "g1", name: "Inputs", color: "blue", position: { x: 0, y: 0 }, size: { width: 1, height: 1 } }]);
    expect(snapshot.selectedNodeIds).toEqual(["imageInput-1"]);
    expect(snapshot.viewport).toEqual({ x: -10, y: 6, width: 1600, height: 900, zoom: 0.75 });
    expect(snapshot.workflowName).toBe("Demo");
  });

  it("keeps long prompts whole, and caps only past what a setting can hold", () => {
    const long = "word ".repeat(2000);
    const whole = buildAgentSnapshot({ nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: long })], edges: [], groups: {} });
    expect(whole.nodes[0].data.prompt).toBe(long);

    const huge = "word ".repeat(12_000);
    const snapshot = buildAgentSnapshot({ nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, { prompt: huge })], edges: [], groups: {} });
    const prompt = snapshot.nodes[0].data.prompt as string;
    expect(prompt.length).toBeLessThan(50_200);
    expect(prompt).toContain("[truncated: 10000 more characters; the full text is on the canvas]");
  });

  it("keeps edge data the agent needs and nothing else", () => {
    const snapshot = buildAgentSnapshot({
      nodes: [storeNode("array-1", "array", { x: 0, y: 0 }, { outputItems: ["a", "b"] }), storeNode("prompt-2", "prompt", { x: 400, y: 0 })],
      edges: [storeEdge("array-1", "text", "prompt-2", "text", { arrayItemIndex: 1, hasPause: true, isLoop: true, loopCount: 3 })],
      groups: {},
    });
    expect(snapshot.edges[0].data).toEqual({ isLoop: true, hasPause: true, arrayItemIndex: 1, loopCount: 3 });
    expect(snapshot.nodes[0].data.outputItems).toEqual(["a", "b"]);
  });

  it("sends each group's box and lock state (review C8)", () => {
    const snapshot = buildAgentSnapshot({
      nodes: [storeNode("prompt-1", "prompt", { x: 0, y: 0 }, {}, { groupId: "g1" })],
      edges: [],
      groups: { g1: { id: "g1", name: "Inputs", color: "neutral", position: { x: -20.4, y: -19.6 }, size: { width: 360.2, height: 260 }, locked: true } },
    });
    expect(snapshot.groups).toEqual([{ id: "g1", name: "Inputs", color: "neutral", position: { x: -20, y: -20 }, size: { width: 360, height: 260 }, locked: true }]);
    expect(snapshot.nodes[0].groupId).toBe("g1");
  });

  it("keeps every ComfyUI combo option, past scrubDeep's list cap (review C11)", () => {
    const options = Array.from({ length: 320 }, (_, i) => `model_${i}.safetensors`);
    const snapshot = buildAgentSnapshot({
      nodes: [storeNode("comfyApp-1", "comfyApp", { x: 0, y: 0 }, { app: { name: "x", params: [{ id: "4:ckpt", label: "Checkpoint", type: "string", enum: options }], inputs: [], outputs: [] } })],
      edges: [],
      groups: {},
    });
    const params = (snapshot.nodes[0].data.app as { params: Array<{ enum: string[] }> }).params;
    expect(params[0].enum).toEqual(options);
  });

  it("summarises ComfyUI apps without their graph", () => {
    const snapshot = buildAgentSnapshot({
      nodes: [
        storeNode("comfyApp-1", "comfyApp", { x: 0, y: 0 }, {
          app: {
            id: "a",
            name: "Upscale",
            description: "Upscales",
            source: "upload",
            graph: { "1": { class_type: "LoadImage", inputs: { image: PNG } } },
            inputs: [{ id: "1:image", name: "image", label: "Image", type: "image", nodeId: "1", inputKey: "image", required: true }],
            params: [{ id: "3:steps", label: "Steps", type: "integer", minimum: 1, maximum: 50, default: 20, nodeId: "3", inputKey: "steps" }],
            outputs: [{ id: "9", label: "Save", type: "image", nodeId: "9", classType: "SaveImage" }],
            classTypes: ["LoadImage"],
            nodeCount: 3,
            createdAt: 1,
            thumbnail: PNG,
          },
          inputSchema: [{ name: "image", type: "image", required: true, label: "Image" }],
          paramValues: { "3:steps": 30 },
          outputs: { "9": PNG },
        }),
      ],
      edges: [],
      groups: {},
    });
    const data = snapshot.nodes[0].data;
    expect(data.app).toEqual({
      name: "Upscale",
      description: "Upscales",
      inputs: [{ name: "image", label: "Image", type: "image", required: true }],
      params: [{ id: "3:steps", label: "Steps", type: "integer", minimum: 1, maximum: 50, default: 20 }],
      outputs: [{ id: "9", label: "Save", type: "image" }],
    });
    expect(data.paramValues).toEqual({ "3:steps": 30 });
    expect(data).not.toHaveProperty("outputs");
    expect(containsMedia(snapshot)).toBe(false);
  });

  it("scrubs media hidden in unexpected places as a safety net", () => {
    const snapshot = buildAgentSnapshot({
      nodes: [
        storeNode("generateVideo-1", "generateVideo", { x: 0, y: 0 }, { parameters: { first_frame: PNG, nested: { list: [BLOB] } } }),
        storeNode("prompt-2", "prompt", { x: 0, y: 0 }, { comment: PNG }),
      ],
      edges: [],
      groups: {},
      workflowName: "x",
    });
    expect(containsMedia(snapshot)).toBe(false);
    expect(snapshot.nodes[0].data.parameters).toEqual({ first_frame: "[media omitted]", nested: { list: ["[media omitted]"] } });
  });

  it("skips unknown node types and their edges, and drops invalid viewports", () => {
    const odd = { ...storeNode("x-1", "prompt", { x: 0, y: 0 }), type: "legacyThing" } as unknown as WorkflowNode;
    const snapshot = buildAgentSnapshot({
      nodes: [odd, storeNode("prompt-2", "prompt", { x: 0, y: 0 })],
      edges: [storeEdge("x-1", "text", "prompt-2", "text")],
      groups: {},
      viewport: { x: 0, y: 0, width: 0, height: 900, zoom: 1 },
    });
    expect(snapshot.nodes.map((n) => n.id)).toEqual(["prompt-2"]);
    expect(snapshot.edges).toEqual([]);
    expect(snapshot.viewport).toBeUndefined();
  });

  it("carries the user's saved defaults for new generator nodes, whitelisted and media-free", () => {
    const createDefaultNodeData = (type: string) => {
      if (type === "nanoBanana") {
        return {
          model: "nano-banana-pro",
          selectedModel: { provider: "gemini", modelId: "nano-banana-2", displayName: "Nano Banana 2", extra: "x" },
          aspectRatio: "16:9",
          resolution: "2K",
          outputImage: PNG,
          imageHistory: [],
          status: "idle",
        };
      }
      if (type === "llmGenerate") throw new Error("corrupt saved defaults");
      return {};
    };
    const snapshot = buildAgentSnapshot({ nodes: [], edges: [], groups: {}, createDefaultNodeData });
    expect(snapshot.nodeDefaults).toEqual({
      nanoBanana: {
        model: "nano-banana-pro",
        selectedModel: { provider: "gemini", modelId: "nano-banana-2", displayName: "Nano Banana 2" },
        aspectRatio: "16:9",
        resolution: "2K",
      },
    });
    expect(containsMedia(snapshot)).toBe(false);
    expect(buildAgentSnapshot({ nodes: [], edges: [], groups: {} }).nodeDefaults).toBeUndefined();
  });

  it("uses the size the canvas draws: the given width and the measured height", () => {
    // Rendered: the height React Flow measured from the node's content.
    const rendered = storeNode("prompt-1", "prompt", { x: 0, y: 0 }, {}, { measured: { width: 320, height: 244 } });
    // Resized but not measured yet: the new width; the type's default height stands in.
    const resized = storeNode("prompt-2", "prompt", { x: 0, y: 0 }, {}, { width: 500, style: { width: 500 } });
    // Only measured (no stored width): both from the measurement.
    const measuredOnly = storeNode("nanoBanana-3", "nanoBanana", { x: 0, y: 0 }, {}, { width: undefined, style: undefined, measured: { width: 333, height: 452.4 } });
    const snapshot = buildAgentSnapshot({ nodes: [rendered, resized, measuredOnly], edges: [], groups: {} });
    expect(snapshot.nodes.map((n) => [n.width, n.height])).toEqual([[320, 244], [500, 220], [333, 452]]);
  });
});
