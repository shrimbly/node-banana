import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "../route";

function request(modelId = "MiniMax-H3"): NextRequest {
  const url = new URL(`http://localhost:3000/api/models/${encodeURIComponent(modelId)}?provider=metaso`);
  return { nextUrl: url, headers: new Headers() } as unknown as NextRequest;
}

describe("metaso model schema", () => {
  it("exposes H3 V2 parameters and all supported dynamic media handles", async () => {
    const response = await GET(request(), { params: Promise.resolve({ modelId: "MiniMax-H3" }) });
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "resolution", enum: ["768P", "2K"], default: "768P" }),
        expect.objectContaining({ name: "duration", minimum: 4, maximum: 15, default: 5 }),
        expect.objectContaining({ name: "ratio", enum: expect.arrayContaining(["adaptive", "16:9", "9:16"]) }),
      ])
    );
    expect(data.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "prompt", type: "text", required: true }),
        expect.objectContaining({ name: "first_frame", type: "image" }),
        expect.objectContaining({ name: "last_frame", type: "image" }),
        expect.objectContaining({ name: "reference_images", type: "image", isArray: true }),
        expect.objectContaining({ name: "reference_videos", type: "video", isArray: true }),
        expect.objectContaining({ name: "reference_audios", type: "audio", isArray: true }),
      ])
    );
  });
});
