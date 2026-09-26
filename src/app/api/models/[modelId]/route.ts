/**
 * Model Schema API Endpoint
 *
 * Fetches parameter schema for a specific model from its provider.
 * Returns simplified parameter list for UI rendering. The lookup itself
 * lives in `src/lib/providers/schema.ts` (`getModelSchema`) so other server
 * code can call it; this route reads the request and shapes the response.
 *
 * GET /api/models/:modelId?provider=replicate|fal|kie|wavespeed|gemini|openai|comfy
 *
 * Headers (each falls back to its env variable; see src/lib/providers/keys.ts):
 *   - X-Replicate-Key: Required for Replicate models
 *   - X-Fal-Key: Optional for fal.ai models
 *   - X-WaveSpeed-Key: Optional for WaveSpeed models
 *
 * Kie.ai, OpenAI, Gemini and Comfy Router schemas are static; no key or API
 * call is needed. Comfy Router ids contain a slash and arrive URL-encoded.
 *
 * Response:
 *   {
 *     success: true,
 *     parameters: ModelParameter[],
 *     cached: boolean
 *   }
 *
 * WaveSpeed models fetch schemas dynamically from the /api/v3/models endpoint,
 * with fallback to static definitions for models without api_schema.
 */

import { NextRequest, NextResponse } from "next/server";
import { ModelParameter, ModelInput } from "@/lib/providers/types";
import { providerKeysFromHeaders } from "@/lib/providers/keys";
import { getModelSchema } from "@/lib/providers/schema";

interface SchemaSuccessResponse {
  success: true;
  parameters: ModelParameter[];
  inputs: ModelInput[];
  cached: boolean;
}

interface SchemaErrorResponse {
  success: false;
  error: string;
}

type SchemaResponse = SchemaSuccessResponse | SchemaErrorResponse;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ modelId: string }> }
): Promise<NextResponse<SchemaResponse>> {
  // Await params before accessing properties
  const { modelId } = await params;
  const decodedModelId = decodeURIComponent(modelId);
  const provider = request.nextUrl.searchParams.get("provider");

  const result = await getModelSchema(
    provider,
    decodedModelId,
    providerKeysFromHeaders(request.headers)
  );

  if (!result.ok) {
    return NextResponse.json<SchemaErrorResponse>(
      { success: false, error: result.error },
      { status: result.status }
    );
  }

  return NextResponse.json<SchemaSuccessResponse>({
    success: true,
    parameters: result.parameters,
    inputs: result.inputs,
    cached: result.cached,
  });
}
