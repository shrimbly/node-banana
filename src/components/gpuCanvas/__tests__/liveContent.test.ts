import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@/types";
import { showsAnimation } from "../liveContent";

const node = (type: string, data: Record<string, unknown>) => ({ id: "n", type, position: { x: 0, y: 0 }, data }) as unknown as WorkflowNode;

describe("showsAnimation", () => {
  it("keeps a GIF Encoder live while it holds its GIF", () => {
    expect(showsAnimation(node("gifEncoder", { outputGif: "data:image/gif;base64,R0lG" }))).toBe(true);
    expect(showsAnimation(node("gifEncoder", { outputGif: null }))).toBe(false);
    expect(showsAnimation(node("imageInput", { outputGif: "x" }))).toBe(false);
  });
});
