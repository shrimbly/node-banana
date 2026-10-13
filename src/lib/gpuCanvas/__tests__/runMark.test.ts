import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowNode } from "@/types";
import { READS_RUN_IN_PROGRESS, runMark, withRunMark } from "../paintKey";

// Each node component and the node type it draws.
const COMPONENT_TYPES: Record<string, string> = {
  AnnotationNode: "annotation", ArrayNode: "array", AudioInputNode: "audioInput", ComfyAppNode: "comfyApp",
  ConditionalSwitchNode: "conditionalSwitch", EaseCurveNode: "easeCurve", GLBViewerNode: "glbViewer", Generate3DNode: "generate3d",
  GenerateAudioNode: "generateAudio", GenerateImageNode: "nanoBanana", GenerateVideoNode: "generateVideo", GifEncoderNode: "gifEncoder",
  ImageCompareNode: "imageCompare", ImageInputNode: "imageInput", ImageResizeNode: "imageResize", LLMGenerateNode: "llmGenerate",
  OutputGalleryNode: "outputGallery", OutputNode: "output", PromptConstructorNode: "promptConstructor", PromptNode: "prompt",
  RemoveBackgroundNode: "removeBackground", RouterNode: "router", SplitGridNode: "splitGrid", SwitchNode: "switch",
  VideoFrameGrabNode: "videoFrameGrab", VideoInputNode: "videoInput", VideoStitchNode: "videoStitch", VideoTrimNode: "videoTrim",
};

describe("run marks", () => {
  it("name exactly the node types whose component reads whether a run is in progress", () => {
    const dir = path.resolve(__dirname, "../../../components/nodes");
    const reading = Object.entries(COMPONENT_TYPES)
      .filter(([file]) => /state\.isRunning\b|s\.isRunning\b/.test(fs.readFileSync(path.join(dir, `${file}.tsx`), "utf8")))
      .map(([, type]) => type)
      .sort();
    expect(reading).toEqual([...READS_RUN_IN_PROGRESS].sort());
    // Every node component is listed above.
    const files = fs.readdirSync(dir).filter((f) => /Node\.tsx$/.test(f) && !["FloatingNodeHeader.tsx"].includes(f)).map((f) => f.replace(/\.tsx$/, ""));
    expect(files.sort()).toEqual(Object.keys(COMPONENT_TYPES).sort());
  });

  it("mark a node the run is on, and a run in progress for the types that show it", () => {
    const node = (id: string, type: string) => ({ id, type, data: {} }) as unknown as WorkflowNode;
    const idle = { isRunning: false, currentNodeIds: [] };
    const running = { isRunning: true, currentNodeIds: ["a"] };
    expect(runMark(node("a", "prompt"), idle)).toBe("");
    expect(runMark(node("a", "prompt"), running)).toBe("n");
    expect(runMark(node("b", "prompt"), running)).toBe("");
    expect(runMark(node("b", "nanoBanana"), running)).toBe("r");
    expect(runMark(node("a", "nanoBanana"), running)).toBe("nr");
    expect(withRunMark("k", "")).toBe("k");
    expect(withRunMark("k", "nr")).not.toBe("k");
  });
});
