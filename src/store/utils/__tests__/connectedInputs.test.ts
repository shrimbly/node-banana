import { describe, it, expect } from "vitest";
import { getConnectedInputsPure, validateWorkflowPure } from "../connectedInputs";
import type { WorkflowNode, WorkflowEdge } from "@/types";

function makeNode(id: string, type: string, data: Record<string, unknown> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data } as WorkflowNode;
}

function makeEdge(source: string, target: string, targetHandle?: string): WorkflowEdge {
  return {
    id: `${source}-${target}`,
    source,
    target,
    sourceHandle: "image",
    targetHandle: targetHandle || "image",
  } as WorkflowEdge;
}

describe("getConnectedInputsPure", () => {
  it("should return empty arrays when no edges connect to node", () => {
    const nodes = [makeNode("a", "prompt")];
    const result = getConnectedInputsPure("a", nodes, []);
    expect(result.images).toEqual([]);
    expect(result.videos).toEqual([]);
    expect(result.audio).toEqual([]);
    expect(result.text).toBeNull();
    expect(result.dynamicInputs).toEqual({});
    expect(result.easeCurve).toBeNull();
  });

  it("should extract image from imageInput source", () => {
    const nodes = [
      makeNode("img", "imageInput", { image: "data:image/png;base64,abc" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("img", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,abc"]);
  });

  it("should extract text from prompt source", () => {
    const nodes = [
      makeNode("p", "prompt", { prompt: "hello world" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("p", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("hello world");
  });

  it("should extract image from annotation output", () => {
    const nodes = [
      makeNode("ann", "annotation", { outputImage: "data:image/png;base64,xyz" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("ann", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,xyz"]);
  });

  it("should extract image from nanoBanana output", () => {
    const nodes = [
      makeNode("nb", "nanoBanana", { outputImage: "data:image/png;base64,nb" }),
      makeNode("out", "output"),
    ];
    const edges = [makeEdge("nb", "out", "image")];
    const result = getConnectedInputsPure("out", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,nb"]);
  });

  it("should extract video from generateVideo source", () => {
    const nodes = [
      makeNode("vid", "generateVideo", { outputVideo: "data:video/mp4;base64,vid" }),
      makeNode("out", "output"),
    ];
    const edges = [makeEdge("vid", "out", "image")];
    const result = getConnectedInputsPure("out", nodes, edges);
    expect(result.videos).toEqual(["data:video/mp4;base64,vid"]);
  });

  it("should extract text from llmGenerate source", () => {
    const nodes = [
      makeNode("llm", "llmGenerate", { outputText: "generated text" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("llm", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("generated text");
  });

  it("should extract text from promptConstructor outputText", () => {
    const nodes = [
      makeNode("pc", "promptConstructor", { outputText: "constructed", template: "tmpl" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("pc", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("constructed");
  });

  it("should fallback to template when promptConstructor has no outputText", () => {
    const nodes = [
      makeNode("pc", "promptConstructor", { outputText: null, template: "tmpl" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("pc", "gen", "text")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.text).toBe("tmpl");
  });

  it("should skip source nodes with null output", () => {
    const nodes = [
      makeNode("img", "imageInput", { image: null }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("img", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual([]);
  });

  it("should handle multiple image inputs", () => {
    const nodes = [
      makeNode("img1", "imageInput", { image: "data:image/png;base64,a" }),
      makeNode("img2", "imageInput", { image: "data:image/png;base64,b" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [
      makeEdge("img1", "gen", "image"),
      makeEdge("img2", "gen", "image"),
    ];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,a", "data:image/png;base64,b"]);
  });

  it("should populate dynamicInputs with schema mapping", () => {
    const nodes = [
      makeNode("img", "imageInput", { image: "data:image/png;base64,a" }),
      makeNode("gen", "nanoBanana", {
        inputSchema: [{ name: "image_url", type: "image" }],
      }),
    ];
    const edges = [makeEdge("img", "gen", "image-0")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.dynamicInputs).toEqual({ image_url: "data:image/png;base64,a" });
  });

  it("should extract easeCurve data", () => {
    const nodes = [
      makeNode("ec", "easeCurve", {
        bezierHandles: [0.25, 0.1, 0.25, 1.0],
        easingPreset: "ease-in-out",
        outputVideo: null,
      }),
      makeNode("vs", "videoStitch"),
    ];
    const edges = [{
      id: "ec-vs",
      source: "ec",
      target: "vs",
      sourceHandle: "easeCurve",
      targetHandle: "easeCurve",
    }] as WorkflowEdge[];
    const result = getConnectedInputsPure("vs", nodes, edges);
    expect(result.easeCurve).toEqual({
      bezierHandles: [0.25, 0.1, 0.25, 1.0],
      easingPreset: "ease-in-out",
    });
  });

  it("should extract capturedImage from glbViewer source", () => {
    const nodes = [
      makeNode("glb", "glbViewer", { capturedImage: "data:image/png;base64,snap" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("glb", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual(["data:image/png;base64,snap"]);
  });

  it("should return empty images when glbViewer has no capture", () => {
    const nodes = [
      makeNode("glb", "glbViewer", { capturedImage: null }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("glb", "gen", "image")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.images).toEqual([]);
  });

  it("should extract audio from audioInput source", () => {
    const nodes = [
      makeNode("aud", "audioInput", { audioFile: "data:audio/wav;base64,abc" }),
      makeNode("gen", "nanoBanana"),
    ];
    const edges = [makeEdge("aud", "gen", "audio")];
    const result = getConnectedInputsPure("gen", nodes, edges);
    expect(result.audio).toEqual(["data:audio/wav;base64,abc"]);
  });
});

describe("validateWorkflowPure", () => {
  it("should fail for empty workflow", () => {
    const result = validateWorkflowPure([], []);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Workflow is empty");
  });

  it("should pass for valid workflow", () => {
    const nodes = [
      makeNode("p", "prompt"),
      makeNode("gen", "nanoBanana"),
      makeNode("out", "output"),
    ];
    const edges = [
      makeEdge("p", "gen", "text"),
      makeEdge("gen", "out"),
    ];
    const result = validateWorkflowPure(nodes, edges);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("should detect missing text input on nanoBanana", () => {
    const nodes = [makeNode("gen", "nanoBanana")];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing text input");
  });

  it("should detect missing text input on generateVideo", () => {
    const nodes = [makeNode("vid", "generateVideo")];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing text input");
  });

  it("should detect missing image input on annotation without manual image", () => {
    const nodes = [makeNode("ann", "annotation", { sourceImage: null })];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing image input");
  });

  it("should pass annotation with manual image", () => {
    const nodes = [makeNode("ann", "annotation", { sourceImage: "data:image/png;base64,x" })];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(true);
  });

  it("should detect missing image input on output", () => {
    const nodes = [makeNode("out", "output")];
    const result = validateWorkflowPure(nodes, []);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing image input");
  });

  it("should accept text-0 handle for nanoBanana", () => {
    const nodes = [makeNode("p", "prompt"), makeNode("gen", "nanoBanana")];
    const edges = [makeEdge("p", "gen", "text-0")];
    const result = validateWorkflowPure(nodes, edges);
    expect(result.valid).toBe(true);
  });
});
