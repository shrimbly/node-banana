import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { generateWithGeminiOmni } from "../providers/gemini-omni";

vi.mock("../providers/gemini-omni", () => ({ generateWithGeminiOmni: vi.fn() }));
const generate = vi.mocked(generateWithGeminiOmni);
beforeEach(() => vi.clearAllMocks());

function request() {
  return new NextRequest("http://localhost/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Gemini-API-Key": "user-gemini-key" },
    body: JSON.stringify({
      selectedModel: { provider: "gemini", modelId: "gemini-omni-1.1-flash" },
      images: [], prompt: "", dynamicInputs: { prompt: "Edit the lighting", video: "data:video/mp4;base64,YQ==" },
      parameters: { task: "edit" }, mediaType: "video",
    }),
  });
}

it("routes Omni video edits through Interactions with the user's Gemini key", async () => {
  generate.mockResolvedValue({ success: true, outputs: [{ type: "video", data: "data:video/mp4;base64,Yg==" }] });
  const response = await POST(request());
  expect(await response.json()).toMatchObject({ success: true, contentType: "video", video: "data:video/mp4;base64,Yg==" });
  expect(generate).toHaveBeenCalledWith("user-gemini-key", "gemini-omni-1.1-flash", "Edit the lighting", [], { task: "edit" }, expect.objectContaining({ video: expect.any(String) }), expect.any(AbortSignal));
});

it("returns provider errors with their original status", async () => {
  generate.mockResolvedValue({ success: false, statusCode: 403, error: "This project does not have access" });
  const response = await POST(request());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ success: false, error: "This project does not have access" });
});
