import { afterEach, describe, expect, it, vi } from "vitest";
import { externalizeWorkflowMedia, hydrateWorkflowMedia } from "../mediaStorage";
import type { WorkflowFile } from "@/store/workflowStore";

describe("generation carousel workflow hydration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("hydrates the image selected by history index instead of a stale output ref", async () => {
    const requestedIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const params = new URLSearchParams(url.split("?")[1]);
      const imageId = params.get("imageId")!;
      requestedIds.push(imageId);
      return new Response(JSON.stringify({
        success: true,
        image: `data:image/png;base64,${imageId}`,
      }));
    }));

    const workflow = {
      nodes: [{
        id: "generate-1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          outputImage: null,
          outputImageRef: "latest",
          imageHistory: [{ id: "latest" }, { id: "older" }],
          selectedHistoryIndex: 1,
          inputImages: [],
        },
      }],
      edges: [],
    } as unknown as WorkflowFile;

    const hydrated = await hydrateWorkflowMedia(workflow, "/tmp/project");
    const data = hydrated.nodes[0].data as Record<string, unknown>;

    expect(requestedIds).toEqual(["older"]);
    expect(data.outputImage).toBe("data:image/png;base64,older");
    expect(data.outputImageRef).toBe("older");
    expect(data.selectedHistoryIndex).toBe(1);
  });

  it("externalizes the active image under its selected history ID", async () => {
    const writes: Record<string, string>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      writes.push(body);
      return new Response(JSON.stringify({ success: true, imageId: body.imageId }));
    }));

    const activeImage = "data:image/png;base64,b2xkZXI=";
    const workflow = {
      nodes: [{
        id: "generate-1",
        type: "nanoBanana",
        position: { x: 0, y: 0 },
        data: {
          outputImage: activeImage,
          outputImageRef: "latest",
          imageHistory: [{ id: "latest" }, { id: "older" }],
          selectedHistoryIndex: 1,
          inputImages: [],
        },
      }],
      edges: [],
    } as unknown as WorkflowFile;

    const saved = await externalizeWorkflowMedia(workflow, "/tmp/project");
    const data = saved.nodes[0].data as Record<string, unknown>;

    expect(writes).toContainEqual(expect.objectContaining({
      imageId: "older",
      imageData: activeImage,
      folder: "generations",
    }));
    expect(data.outputImage).toBeNull();
    expect(data.outputImageRef).toBe("older");
    expect(data.selectedHistoryIndex).toBe(1);
  });
});
