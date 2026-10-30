/**
 * Poll API Route
 *
 * Handles status polling for long-running Kie.ai and Comfy Router tasks.
 * The client calls this endpoint repeatedly with short-lived requests
 * instead of holding a single connection open for minutes.
 *
 * Headers:
 *   - X-Kie-Key: Kie.ai API key (provider "kie")
 *   - X-Comfy-Router-Key: Comfy API key (provider "comfy")
 *
 * Answers (pollGenerateTask reads them this way):
 *   - 200 with `polling: true`: still running; with the media: done
 *   - 422: the provider failed the run; `error` is its reason, and final
 *   - 401, 402, 403: the provider refused this check (a missing or rejected
 *     key), which says nothing about the run: the client stops waiting and
 *     keeps the request to pick up again
 *   - 408, 429, 5xx: no answer this time; the client polls again
 *   - any other 4xx: the request cannot be answered (expired, unknown)
 */
import { NextRequest, NextResponse } from "next/server";
import type { GenerateResponse } from "@/types";
import { checkKieTaskOnce, fetchKieMediaResult, isVeoModel } from "../providers/kie";
import {
  COMFY_ROUTER_HEADER,
  checkComfyTaskOnce,
  fetchComfyMediaResult,
  resolveComfyRouterKey,
} from "../providers/comfy";
import { buildMediaResponse } from "../shared";

export const maxDuration = 120; // 2 min — enough for media fetch, not for polling
export const dynamic = 'force-dynamic';

// Router answers about the key or the workspace, not about the run
const ACCESS_REFUSED = new Set([401, 402, 403]);

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

    if (provider === 'comfy') {
      // Same key resolution as route.ts: header, then COMFY_API_KEY / COMFY_CLOUD_API_KEY
      const apiKey = resolveComfyRouterKey(request.headers.get(COMFY_ROUTER_HEADER));
      if (!apiKey) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: "Comfy API key not configured" },
          { status: 401 }
        );
      }

      const pollResult = await checkComfyTaskOnce(requestId, apiKey, modelId, taskId);

      if (pollResult.status === "processing") {
        return NextResponse.json<GenerateResponse>({
          success: true,
          polling: true,
          taskId,
          pollProvider: provider,
          pollModelId: modelId,
          pollModelName: modelName,
          pollMediaType: mediaType,
          ...(pollResult.retryAfterMs ? { retryAfterMs: pollResult.retryAfterMs } : {}),
        });
      }

      if (pollResult.status === "failed") {
        if (pollResult.statusCode && ACCESS_REFUSED.has(pollResult.statusCode)) {
          return NextResponse.json<GenerateResponse>(
            { success: false, error: pollResult.error },
            { status: pollResult.statusCode }
          );
        }
        return NextResponse.json<GenerateResponse>(
          { success: false, error: `${modelName}: ${pollResult.error}` },
          { status: 422 }
        );
      }

      // completed — collect the native result and return the media
      const result = await fetchComfyMediaResult(requestId, apiKey, modelId, taskId, mediaType);

      if (!result.success) {
        return NextResponse.json<GenerateResponse>(
          { success: false, error: result.error || "Failed to fetch result" },
          { status: result.statusCode ?? 500 }
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
        { status: 422 }
      );
    }

    // completed — fetch media and return final result
    const capabilityMap: Record<string, string[]> = {
      video: ["text-to-video"],
      audio: ["text-to-audio"],
      image: ["text-to-image"],
      "3d": ["text-to-3d"],
    };

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
