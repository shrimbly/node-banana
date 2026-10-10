import { describe, it, expect } from "vitest";

import { ComfyRouteError, comfyRunHistoryEntry, outputsToNodeData, readError, recordedIntoHistory } from "../comfyAppExecutor";

describe("outputsToNodeData", () => {
  const declared = [
    { id: "9", type: "image" },
    { id: "12", type: "image" },
    { id: "20", type: "text" },
    { id: "30", type: "video" },
  ];

  it("keys every result by its handle", () => {
    const data = outputsToNodeData(declared, [
      { handleId: "9", type: "image", value: "data:image/png;base64,AAA" },
      { handleId: "20", type: "text", value: "a caption" },
    ]);
    expect(data.outputs).toEqual({
      "9": "data:image/png;base64,AAA",
      "20": "a caption",
    });
  });

  it("mirrors the first result of each type for downstream consumers", () => {
    const data = outputsToNodeData(declared, [
      { handleId: "12", type: "image", value: "second" },
      { handleId: "9", type: "image", value: "first" },
      { handleId: "20", type: "text", value: "a caption" },
    ]);
    // Declared order decides which is "first", not the order results arrived —
    // otherwise the same run could mirror a different output each time.
    expect(data.outputImage).toBe("first");
    expect(data.outputText).toBe("a caption");
  });

  it("nulls the mirrors for types this run produced nothing for", () => {
    const data = outputsToNodeData(declared, [
      { handleId: "9", type: "image", value: "only-image" },
    ]);
    expect(data.outputVideo).toBeNull();
    expect(data.outputAudio).toBeNull();
    expect(data.outputText).toBeNull();
    expect(data.output3dUrl).toBeNull();
  });

  it("skips a declared handle that produced nothing when picking the mirror", () => {
    const data = outputsToNodeData(declared, [
      { handleId: "12", type: "image", value: "second-only" },
    ]);
    expect(data.outputImage).toBe("second-only");
  });

  it("handles a run that produced nothing at all", () => {
    const data = outputsToNodeData(declared, []);
    expect(data.outputs).toEqual({});
    expect(data.outputImage).toBeNull();
  });
});

describe("readError", () => {
  const response = (body: unknown, status: number) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

  it("treats a route's own failure as the engine's verdict", async () => {
    const error = await readError(
      response({ success: false, error: "Comfy Cloud rejected the API key" }, 401),
      "ComfyUI run failed"
    );
    expect(error).toBeInstanceOf(ComfyRouteError);
    expect(error.message).toBe("Comfy Cloud rejected the API key");
  });

  it("treats an unreachable engine as worth another poll", async () => {
    // The route answered, but only to say it could not ask — the render it was
    // asked about is very likely still going.
    const error = await readError(
      response(
        { success: false, error: "Could not reach Comfy Cloud: fetch failed", transient: true },
        503
      ),
      "ComfyUI run failed"
    );
    expect(error).not.toBeInstanceOf(ComfyRouteError);
    expect(error.message).toContain("Could not reach Comfy Cloud");
  });

  it("treats a gateway error with no route body as worth another poll", async () => {
    const error = await readError(response("<html>502 Bad Gateway</html>", 502), "ComfyUI run failed");
    expect(error).not.toBeInstanceOf(ComfyRouteError);
  });

  it("treats a 4xx with no route body as terminal", async () => {
    const error = await readError(response("Payload too large", 413), "ComfyUI run failed");
    expect(error).toBeInstanceOf(ComfyRouteError);
  });
});

describe("run history", () => {
  const outputs = [
    { handleId: "9", type: "image" as const, value: "data:image/png;base64,AAA" },
    { handleId: "20", type: "text" as const, value: "a caption" },
    { handleId: "30", type: "video" as const, value: "data:video/mp4;base64,BBB" },
    { handleId: "40", type: "3d" as const, value: "https://cdn.example.com/model.glb" },
  ];

  it("keeps every reloadable output of a run by its handle, text as it is, and nothing for 3D", () => {
    const entry = comfyRunHistoryEntry({
      outputs, timestamp: 1700, prompt: "p", model: "My app", batch: { id: "b", index: 1, count: 2 },
      assetIds: { "9": "asset-img", "30": "asset-vid" }, folderImageId: "1700", primaryImage: outputs[0].value,
    });
    expect(entry).toEqual({
      id: "1700", timestamp: 1700, prompt: "p", model: "My app", batch: { id: "b", index: 1, count: 2 },
      outputs: {
        "9": { type: "image", assetId: "asset-img", id: "1700" },
        "20": { type: "text", text: "a caption" },
        "30": { type: "video", assetId: "asset-vid" },
      },
    });
  });

  it("makes no entry for a run nothing can reload", () => {
    expect(comfyRunHistoryEntry({ outputs, timestamp: 1, prompt: "p", model: "m", assetIds: {} })).toBeNull();
    expect(comfyRunHistoryEntry({ outputs: [outputs[1]], timestamp: 1, prompt: "p", model: "m", assetIds: { "20": "x" } })).toBeNull();
  });

  it("gives an output its folder file name once recorded, drops a failed asset id, and drops an entry left with no media", () => {
    const history = [
      { id: "2", timestamp: 2, prompt: "", model: "m", outputs: { "9": { type: "image" as const, assetId: "a2" }, "20": { type: "text" as const, text: "t" } } },
      { id: "1", timestamp: 1, prompt: "", model: "m", outputs: { "9": { type: "image" as const, assetId: "a1", id: "1" } } },
    ];
    const updates: unknown[] = [];
    let data: Record<string, unknown> = { runHistory: history, selectedRunHistoryIndex: 0 };
    const ctx = {
      node: { id: "n" },
      getFreshNode: () => ({ data }),
      updateNodeData: (_id: string, patch: Record<string, unknown>) => { updates.push(patch); data = { ...data, ...patch }; },
    } as unknown as Parameters<typeof recordedIntoHistory>[0];

    recordedIntoHistory(ctx, "1", "9", { assetId: "a1", legacyId: "1-named.png" } as never);
    expect((data.runHistory as typeof history)[1].outputs["9"]).toEqual({ type: "image", assetId: "a1", id: "1-named.png" });

    recordedIntoHistory(ctx, "2", "9", null);
    expect((data.runHistory as typeof history).map((e) => e.id)).toEqual(["1"]);
    expect(data.selectedRunHistoryIndex).toBe(-1);

    recordedIntoHistory(ctx, "missing", "9", null);
    expect(updates).toHaveLength(2);
  });
});
