/**
 * TTS (Text-to-Speech) API Route
 *
 * Handles text-to-speech generation for various providers.
 * Routes requests to appropriate TTS providers based on the selected model.
 */

import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60; // 1 minute timeout
export const dynamic = 'force-dynamic';

interface TTSRequest {
  text: string;
  selectedModel?: {
    provider: string;
    modelId: string;
    displayName: string;
  };
  parameters?: Record<string, unknown>;
}

interface TTSResponse {
  success: boolean;
  audio?: string; // Base64 data URL
  error?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body: TTSRequest = await request.json();
    const { text, selectedModel, parameters } = body;

    if (!text) {
      return NextResponse.json<TTSResponse>(
        { success: false, error: "Text is required" },
        { status: 400 }
      );
    }

    if (!selectedModel) {
      return NextResponse.json<TTSResponse>(
        { success: false, error: "Model selection is required" },
        { status: 400 }
      );
    }

    const provider = selectedModel.provider;

    // Route to appropriate provider
    if (provider === "openai") {
      return await generateWithOpenAI(text, selectedModel.modelId, parameters, request);
    } else {
      return NextResponse.json<TTSResponse>(
        { success: false, error: `Provider ${provider} not yet implemented` },
        { status: 501 }
      );
    }
  } catch (error) {
    console.error("TTS API error:", error);
    return NextResponse.json<TTSResponse>(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

async function generateWithOpenAI(
  text: string,
  modelId: string,
  parameters: Record<string, unknown> | undefined,
  request: NextRequest
): Promise<NextResponse<TTSResponse>> {
  const apiKey = request.headers.get("X-OpenAI-Key") || process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json<TTSResponse>(
      { success: false, error: "OpenAI API key not configured" },
      { status: 401 }
    );
  }

  try {
    // Extract model name from ID (e.g., "openai/tts-1" -> "tts-1")
    const model = modelId.split("/").pop() || "tts-1";

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: parameters?.voice || "alloy",
        speed: parameters?.speed || 1.0,
        response_format: parameters?.format || "mp3",
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }

    // Convert audio blob to base64 data URL
    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString("base64");
    const format = parameters?.format || "mp3";
    const dataUrl = `data:audio/${format};base64,${base64Audio}`;

    return NextResponse.json<TTSResponse>({
      success: true,
      audio: dataUrl,
    });
  } catch (error) {
    console.error("OpenAI TTS error:", error);
    return NextResponse.json<TTSResponse>(
      { success: false, error: error instanceof Error ? error.message : "OpenAI generation failed" },
      { status: 500 }
    );
  }
}
