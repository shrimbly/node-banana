/**
 * Poll API Route
 *
 * Handles status polling for long-running Kie.ai and fal.ai queue tasks.
 * The client calls this endpoint repeatedly with short-lived requests
 * instead of holding a single connection open for minutes. Because each poll
 * is stateless and keyed by the provider's own task id, a generation survives
 * a page reload.
 */
import { NextRequest, NextResponse } from "next/server";
import type { GenerateResponse } from "@/types";
import { checkKieTaskOnce, fetchKieMediaResult, isVeoModel } from "../providers/kie";
import { checkFalTaskOnce, fetchFalMediaResult } from "../providers/fal";
import { buildMediaResponse } from "../shared";

export const maxDuration = 120; // 2 min — enough for media fetch, not for polling
export const dynamic = 'force-dynamic';

interface PollRequest {
  taskId: string;
  provider: string;
  modelId: string;
  modelName: string;
  mediaType: string;
}

export async function POST(request: NextRequest) {
  const requestId = Math.random().toString(36).substring(7);

  try {
    const body: PollRequest = await request.json();
    const { taskId, provider, modelId, modelName, mediaType } = body;

    if (!taskId || !provider) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: "taskId and provider are required" },
        { status: 400 }
      );
    }

    const capabilityMap: Record<string, string[]> = {
      video: ["text-to-video"],
      audio: ["text-to-audio"],
      image: ["text-to-image"],
      "3d": ["text-to-3d"],
    };

    if (provider === 'fal') {
      const falApiKey = request.headers.get("X-Fal-API-Key") || process.env.FAL_API_KEY || null;
      const pollResult = await checkFalTaskOnce(requestId, falApiKey, taskId);

      if (pollResult.status === "processing") {
        return NextResponse.json<GenerateResponse>({
          success: true,
          polling: true,
          taskId,
          pollProvider: provider,
          pollModelId: modelId,
          pollModelName: modelName,
          pollMediaType: mediaType,
        });
      }

      if (pollResult.status === "failed") {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: `${modelName}: ${pollResult.error || "Generation failed"}` },
          { status: 500 }
        );
      }

      const falResult = await fetchFalMediaResult(requestId, falApiKey, {
        taskId,
        modelName,
        capabilities: capabilityMap[mediaType] || ["text-to-image"],
      });

      if (!falResult.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: falResult.error || "Failed to fetch result" },
          { status: 500 }
        );
      }

      const falOutput = falResult.outputs?.[0];
      if (!falOutput?.data && !falOutput?.url) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "No output in generation result" },
          { status: 500 }
        );
      }

      return buildMediaResponse(falOutput, falResult.generationCost);
    }

    if (provider !== 'kie') {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: `Unsupported poll provider: ${provider}` },
        { status: 400 }
      );
    }

    // Get API key (same pattern as route.ts)
    const apiKey = request.headers.get("X-Kie-Key") || process.env.KIE_API_KEY;
    if (!apiKey) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: "Kie.ai API key not configured" },
        { status: 401 }
      );
    }

    const isVeo = isVeoModel(modelId);
    const pollResult = await checkKieTaskOnce(requestId, apiKey, taskId, isVeo);

    if (pollResult.status === "processing") {
      return NextResponse.json<GenerateResponse>({
        success: true,
        polling: true,
        taskId,
        pollProvider: provider,
        pollModelId: modelId,
        pollModelName: modelName,
        pollMediaType: mediaType,
      });
    }

    if (pollResult.status === "failed") {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: `${modelName}: ${pollResult.error}` },
        { status: 500 }
      );
    }

    // completed — fetch media and return final result
    const result = await fetchKieMediaResult(requestId, {
      pollData: pollResult.data!,
      isVeo,
      modelName,
      capabilities: capabilityMap[mediaType] || ["text-to-image"],
    });

    if (!result.success) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: result.error || "Failed to fetch result" },
        { status: 500 }
      );
    }

    const output = result.outputs?.[0];
    if (!output?.data && !output?.url) {
      return NextResponse.json<GenerateResponse>(
        { success: false, error: "No output in generation result" },
        { status: 500 }
      );
    }

    return buildMediaResponse(output);
  } catch (error) {
    console.error(`[API:${requestId}] Poll error:`, error);
    return NextResponse.json<GenerateResponse>(
      { success: false, error: error instanceof Error ? error.message : "Poll failed" },
      { status: 500 }
    );
  }
}
