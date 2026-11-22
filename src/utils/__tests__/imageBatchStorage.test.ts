/**
 * An Image Input's batch is saved like other media: each image written once
 * into the workflow's inputs and kept as its file's id, then read back on load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { externalizeWorkflowMedia, hydrateWorkflowMedia } from "../mediaStorage";
import type { ImageInputNodeData, WorkflowNode } from "@/types";
import type { WorkflowFile } from "@/store/workflowStore";

const A = "data:image/png;base64,QUFB";
const B = "data:image/png;base64,QkJC";

const stored = new Map<string, string>();

beforeEach(() => {
  stored.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("/api/workflow-images?")) {
        const id = new URL(String(url), "http://x").searchParams.get("imageId") ?? "";
        return { ok: true, json: async () => (stored.has(id) ? { success: true, image: stored.get(id) } : { success: false }) };
      }
      const body = JSON.parse(String(init?.body)) as { imageId: string; imageData: string };
      stored.set(body.imageId, body.imageData);
      return { ok: true, status: 200, json: async () => ({ success: true, imageId: body.imageId }) };
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const node = (data: Partial<ImageInputNodeData>): WorkflowNode =>
  ({ id: "in", type: "imageInput", position: { x: 0, y: 0 }, data: { filename: null, dimensions: null, ...data } }) as unknown as WorkflowNode;

describe("an Image Input's batch, saved and loaded", () => {
  it("writes each image once, keeps file ids instead of bytes, and reads them back", async () => {
    const workflow = { nodes: [node({ image: B, batchImages: [A, B], batchFilenames: ["a.png", "b.png"], batchIndex: 1 })], edges: [] } as unknown as WorkflowFile;
    const saved = await externalizeWorkflowMedia(workflow, "/projects/demo");
    const data = saved.nodes[0]!.data as ImageInputNodeData;

    expect(stored.size).toBe(2);
    expect(data.image).toBeNull();
    expect(data.batchImages).toEqual(["", ""]);
    expect(data.batchImageRefs).toHaveLength(2);
    expect(data.batchImageRefs![1]).toBe(data.imageRef);

    const loaded = await hydrateWorkflowMedia(saved, "/projects/demo");
    const back = loaded.nodes[0]!.data as ImageInputNodeData;
    expect(back.batchImages).toEqual([A, B]);
    expect(back.image).toBe(B);
  });

  it("does not write an image again that already has its file", async () => {
    const workflow = { nodes: [node({ image: A, imageRef: "img-a", batchImages: [A, B], batchImageRefs: ["img-a", ""] })], edges: [] } as unknown as WorkflowFile;
    const saved = await externalizeWorkflowMedia(workflow, "/projects/demo");
    expect([...stored.values()]).toEqual([B]);
    expect((saved.nodes[0]!.data as ImageInputNodeData).batchImageRefs![0]).toBe("img-a");
  });
});
