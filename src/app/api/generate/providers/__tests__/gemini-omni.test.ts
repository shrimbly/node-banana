import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateWithGeminiOmni } from "../gemini-omni";

const files = vi.hoisted(() => ({ upload: vi.fn(), get: vi.fn(), delete: vi.fn() }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class { files = files; } }));
const fetchMock = vi.fn();
const video = { type: "video", mime_type: "video/mp4", data: "dmlkZW8=" };
const completed = { status: "completed", steps: [{ type: "model_output", content: [video] }] };
const modelId = "gemini-omni-1.1-flash";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify(completed)));
  files.upload.mockResolvedValue({ name: "files/input", uri: "https://generativelanguage.googleapis.com/v1beta/files/input", state: "ACTIVE" });
  files.delete.mockResolvedValue({});
});
afterEach(() => vi.unstubAllGlobals());

describe("Gemini Omni Interactions", () => {
  it.each([modelId, "gemini-omni-flash-preview"])("generates video using %s and the REST steps response", async (model) => {
    const result = await generateWithGeminiOmni("test-key", model, "A kiwi walking, 5 seconds", [], { aspectRatio: "9:16", resolution: "1080p" });
    expect(result).toEqual({ success: true, outputs: [{ type: "video", data: "data:video/mp4;base64,dmlkZW8=" }] });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(request.headers["x-goog-api-key"]).toBe("test-key");
    expect(JSON.parse(request.body)).toEqual({ model, input: [{ type: "text", text: "A kiwi walking, 5 seconds" }], store: false, response_format: { type: "video", aspect_ratio: "9:16", resolution: "1080p" } });
  });

  it("preserves ordered reference images without duplicating top-level inputs", async () => {
    const images = ["data:image/png;base64,YQ==", "data:image/jpeg;base64,Yg=="];
    await generateWithGeminiOmni("key", modelId, "Animate between these frames", images, { task: "image_to_video" }, { image: images });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input.slice(0, 2)).toEqual([
      { type: "image", mime_type: "image/png", data: "YQ==" },
      { type: "image", mime_type: "image/jpeg", data: "Yg==" },
    ]);
    expect(body.input).toHaveLength(3);
    expect(body.generation_config.video_config.task).toBe("image_to_video");
    expect(files.upload).not.toHaveBeenCalled();
  });

  it("uploads video/audio and cleans up the uploaded files after generation", async () => {
    files.upload.mockResolvedValueOnce({ name: "files/video", uri: "https://generativelanguage.googleapis.com/v1beta/files/video", state: "ACTIVE" });
    const result = await generateWithGeminiOmni("key", modelId, "Match the music", [], { task: "edit" }, {
      video: "data:video/mp4;base64,dmlkZW8=", audio: "data:audio/wav;base64,YQ==",
    });
    expect(result.success).toBe(true);
    expect(files.upload).toHaveBeenCalledTimes(2);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.input[0]).toMatchObject({ type: "video", uri: "https://generativelanguage.googleapis.com/v1beta/files/video" });
    expect(body.input[1]).toMatchObject({ type: "audio", mime_type: "audio/wav" });
    expect(files.delete).toHaveBeenCalledTimes(2);
  });

  it("cleans up and reports failed input processing before requesting generation", async () => {
    files.upload.mockResolvedValue({ name: "files/bad", state: "FAILED" });
    const result = await generateWithGeminiOmni("key", modelId, "Edit this", [], {}, { video: "data:video/mp4;base64,YQ==" });
    expect(result.error).toContain("could not process");
    expect(files.delete).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves Google's permission and quota errors", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), { status: 429 }));
    expect(await generateWithGeminiOmni("key", modelId, "A kiwi")).toMatchObject({ success: false, statusCode: 429, error: "Quota exceeded" });
  });

  it("never returns an input video when generation produces no video", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "completed", steps: [{ type: "user_input", content: [video] }, { type: "model_output", content: [{ type: "text", text: "Unable to generate" }] }] })));
    expect(await generateWithGeminiOmni("key", modelId, "A kiwi")).toMatchObject({ success: false, error: expect.stringContaining("no video") });
  });

  it("validates settings before contacting Google", async () => {
    expect(await generateWithGeminiOmni("key", modelId, "A kiwi", [], { resolution: "8k" })).toMatchObject({ success: false, statusCode: 400 });
    expect(await generateWithGeminiOmni("key", modelId, " ")).toMatchObject({ success: false, statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours cancellation before uploading or generating", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await generateWithGeminiOmni("key", modelId, "A kiwi", [], {}, {}, controller.signal)).toMatchObject({ success: false, statusCode: 499 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
