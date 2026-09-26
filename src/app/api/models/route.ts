/**
 * Unified Models API Endpoint
 *
 * Aggregates models from all configured providers (Replicate, fal.ai, Gemini, WaveSpeed,
 * Kie.ai, OpenAI, Comfy Router). The listing itself lives in
 * `src/lib/providers/registry.ts` (`listModels`) so other server code can
 * call it; this route reads the request and shapes the response.
 * Uses in-memory caching to reduce external API calls.
 *
 * GET /api/models
 *
 * Query params:
 *   - provider: Optional, filter to specific provider ("replicate" | "fal" | "gemini" | "wavespeed" | "kie" | "openai" | "comfy")
 *   - search: Optional, search query
 *   - refresh: Optional, bypass cache if "true"
 *   - capabilities: Optional, filter by capabilities (comma-separated)
 *
 * Headers (each falls back to its env variable; see src/lib/providers/keys.ts):
 *   - X-Replicate-Key: Replicate API key
 *   - X-Fal-Key: fal.ai API key (optional, works without but rate limited)
 *   - X-WaveSpeed-Key: WaveSpeed API key
 *   - X-Kie-Key: Kie.ai API key
 *   - X-OpenAI-API-Key: OpenAI API key
 *   - X-Comfy-Router-Key: Comfy API key (falls back to COMFY_API_KEY / COMFY_CLOUD_API_KEY)
 *
 * Response:
 *   {
 *     success: true,
 *     models: ProviderModel[],
 *     cached: boolean,
 *     providers: { [provider]: { success, count, cached?, error? } },
 *     errors?: string[]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { ProviderModel, ModelCapability } from "@/lib/providers/types";
import { providerKeysFromHeaders } from "@/lib/providers/keys";
import { listModels, type ProviderListResult } from "@/lib/providers/registry";

interface ModelsSuccessResponse {
  success: true;
  models: ProviderModel[];
  cached: boolean;
  providers: Record<string, ProviderListResult>;
  /** All providers that have API keys configured (env or client header) */
  availableProviders: string[];
  errors?: string[];
}

interface ModelsErrorResponse {
  success: false;
  error: string;
}

type ModelsResponse = ModelsSuccessResponse | ModelsErrorResponse;

export async function GET(
  request: NextRequest
): Promise<NextResponse<ModelsResponse>> {
  const params = request.nextUrl.searchParams;
  const capabilitiesParam = params.get("capabilities");

  const result = await listModels(
    {
      provider: params.get("provider"),
      search: params.get("search") || undefined,
      refresh: params.get("refresh") === "true",
      capabilities: capabilitiesParam
        ? (capabilitiesParam.split(",") as ModelCapability[])
        : null,
    },
    providerKeysFromHeaders(request.headers)
  );

  if (!result.ok) {
    return NextResponse.json<ModelsErrorResponse>(
      { success: false, error: result.error },
      { status: result.status }
    );
  }

  const response: ModelsSuccessResponse = {
    success: true,
    models: result.models,
    cached: result.cached,
    providers: result.providers,
    availableProviders: result.availableProviders,
  };

  if (result.errors) {
    response.errors = result.errors;
  }

  return NextResponse.json<ModelsSuccessResponse>(response);
}
