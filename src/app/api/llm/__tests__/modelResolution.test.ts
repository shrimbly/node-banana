import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGenerateContent, MockGoogleGenAI } = vi.hoisted(() => {
  const mockGenerateContent = vi.fn();
  class MockGoogleGenAI {
    models = { generateContent: mockGenerateContent };
  }
  return { mockGenerateContent, MockGoogleGenAI };
});

vi.mock("@google/genai", () => ({ GoogleGenAI: MockGoogleGenAI }));

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "../route";

const originalEnv = { ...process.env };

function post(body: unknown): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers(),
  } as unknown as NextRequest;
}

describe("/api/llm model resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, GEMINI_API_KEY: "test-key" };
    mockGenerateContent.mockResolvedValue({ text: "hello" });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("rejects a model id the catalogue does not know", async () => {
    const response = await POST(post({ prompt: "hi", provider: "google", model: "gemini-9-ultra" }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Unknown model "gemini-9-ultra" for provider google');
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("rejects a model that belongs to another provider", async () => {
    const response = await POST(post({ prompt: "hi", provider: "google", model: "gpt-5.6-terra" }));

    expect(response.status).toBe(400);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it("reports the model that ran", async () => {
    const response = await POST(post({ prompt: "hi", provider: "google", model: "gemini-2.5-flash" }));
    const data = await response.json();

    expect(data).toMatchObject({ success: true, text: "hello", model: "gemini-2.5-flash" });
    expect(data.note).toBeUndefined();
  });

  it("moves a retired id to its replacement and says so", async () => {
    const response = await POST(post({ prompt: "hi", provider: "google", model: "gemini-3-pro-preview" }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mockGenerateContent).toHaveBeenCalledWith(expect.objectContaining({ model: "gemini-3.1-pro-preview" }));
    expect(data.model).toBe("gemini-3.1-pro-preview");
    expect(data.note).toContain("gemini-3-pro-preview");
    expect(data.note).toContain("gemini-3.1-pro-preview");
  });
});
