import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "../../types";
import { claudeToolContent } from "../claudeHarness";
import { toolReply } from "../codexHarness";

const result: AgentToolResult = {
  ok: true,
  text: "2 images from 1 node follow, each after its caption.",
  summary: "Looked at 2 images from 1 node",
  ops: [],
  images: [
    { mime: "image/webp", data: "AAAA", caption: "Image 1: Scene 1" },
    { mime: "image/png", data: "BBBB", caption: "Image 2: Scene 1, an earlier take" },
  ],
};

describe("tool images", () => {
  it("reach Claude as MCP image blocks, each after its caption", () => {
    expect(claudeToolContent(result)).toEqual([
      { type: "text", text: result.text },
      { type: "text", text: "Image 1: Scene 1" },
      { type: "image", data: "AAAA", mimeType: "image/webp" },
      { type: "text", text: "Image 2: Scene 1, an earlier take" },
      { type: "image", data: "BBBB", mimeType: "image/png" },
    ]);
    expect(claudeToolContent({ ...result, images: undefined })).toEqual([{ type: "text", text: result.text }]);
  });

  it("reach Codex as inputImage data URLs, each after its caption", () => {
    expect(toolReply(result.text, true, result.images)).toEqual({
      success: true,
      contentItems: [
        { type: "inputText", text: result.text },
        { type: "inputText", text: "Image 1: Scene 1" },
        { type: "inputImage", imageUrl: "data:image/webp;base64,AAAA" },
        { type: "inputText", text: "Image 2: Scene 1, an earlier take" },
        { type: "inputImage", imageUrl: "data:image/png;base64,BBBB" },
      ],
    });
  });
});
